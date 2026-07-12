import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SERVICE_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
  sendPromptToSession,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readAutoRestartConfig } from './auto-restart-store.js'
import { restartDue, dailyDueAtMs, parseHHMM, type AutoRestartConfig } from '../auto-restart.js'
import { readTaskState } from './agent-taskstate.js'
import {
  DRAIN_TIMEOUT_MS,
  DRAIN_POLL_MS,
  shouldDrainBeforeRestart,
  performDrainAndRestart,
  type DrainDeps,
} from '../auto-restart-drain.js'

// Drives per-agent scheduled restarts (see src/auto-restart.ts for the why and
// the pure due-logic). Mirrors the other watcher loops: a 60s sweep, started
// after the others to avoid piling tmux calls onto one tick.
//
// Two hard safety rules:
//   - IDLE-GUARD: never restart a session mid-turn (a busy pane), including the
//     main channels session -- that would cut off a live conversation. We defer
//     to the next tick until the pane is idle.
//   - SEED-ON-FIRST-SIGHT: on the first sweep we record "last restart = now" for
//     each enabled agent without acting, so a daily time that already passed
//     before the dashboard started does not trigger a spurious restart on boot.

const INITIAL_DELAY_MS = 40_000
const INTERVAL_MS = 60_000

// agent name -> last auto-restart time (ms). Also seeded on first sight (no
// restart) so a past-due daily slot does not fire at startup. In-memory: a
// dashboard restart re-seeds, at worst skipping one slot -- never double-fires.
const lastRestart = new Map<string, number>()

// F1 pre-restart drain: agents currently mid-drain (A4 -- never run two
// overlapping drains for the same agent; overlapping sweeps would double-inject).
// The drain decision + orchestration are pure/injectable in ../auto-restart-drain.js;
// this runner only wires the real tmux/process/store deps.
const draining = new Set<string>()

function defaultDrainDeps(name: string): DrainDeps {
  return {
    sendPrompt: (session, text, host) => sendPromptToSession(session, text, host),
    restart: (n, c) => restartAgentProcess(n, { fresh: c.mode === 'fresh' }),
    readState: readTaskState,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    timeoutMs: DRAIN_TIMEOUT_MS,
    pollMs: DRAIN_POLL_MS,
    session: sessionFor(name),
    host: readAgentRemoteHost(name),
  }
}

function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function computeDueAt(cfg: AutoRestartConfig, name: string, nowMs: number): number | null {
  if (cfg.dailyTime) {
    const mins = parseHHMM(cfg.dailyTime)
    if (mins === null) return null
    return dailyDueAtMs(localMidnightMs(nowMs), mins)
  }
  if (cfg.intervalHours) {
    const base = lastRestart.get(name) ?? nowMs
    return base + cfg.intervalHours * 3_600_000
  }
  return null
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function paneIsIdle(session: string, host: string | null): boolean {
  const pane = capturePane(session, host)
  if (pane == null) return false
  return paneLooksIdle(pane)
}

function performRestart(name: string, cfg: AutoRestartConfig): void {
  if (name === MAIN_AGENT_ID) {
    // The main channels session is launchd-managed and channels.sh always
    // starts a fresh conversation, so 'continue' is not applicable here -- a
    // kickstart is always a fresh restart. KeepAlive brings it straight back.
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    // Label keys off SERVICE_ID (defaults to MAIN_AGENT_ID) so it matches the
    // launchd label the installer wrote.
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/com.${SERVICE_ID}.channels`], { timeout: 10_000 })
  } else {
    restartAgentProcess(name, { fresh: cfg.mode === 'fresh' })
  }
}

function checkAgent(name: string, nowMs: number): void {
  const cfg = readAutoRestartConfig(name)
  if (!cfg.enabled) {
    lastRestart.delete(name) // re-seed cleanly if re-enabled later
    return
  }
  // Sub-agents must be up to be restarted; the main session is launchd-managed
  // (always considered present). Branch explicitly on the tri-state run state:
  // ONLY 'running' is eligible. 'unreachable' (remote laptop briefly out of
  // reach) is never auto-restarted -- the agent is almost certainly still alive
  // on the laptop, and restarting would be wrong AND risk a duplicate session
  // (the core SSH-independence invariant). 'stopped' is also left alone (auto-
  // restart cycles running sessions on a schedule; it does not resurrect dead
  // ones, matching the prior local behavior).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  // Seed on first sight so a daily slot that already elapsed before boot does
  // not fire now.
  if (!lastRestart.has(name)) {
    lastRestart.set(name, nowMs)
    return
  }

  const dueAt = computeDueAt(cfg, name, nowMs)
  if (dueAt === null) return
  if (!restartDue(lastRestart.get(name) ?? null, nowMs, dueAt)) return

  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  if (!paneIsIdle(session, host)) {
    logger.info({ name, session }, 'auto-restart: due but pane is busy, deferring to next tick')
    return
  }

  // A3 -- idle-guard ORDER is fixed: idle-check -> restart-decision -> [drain]
  // -> kill. The drain below makes the pane BUSY while the agent persists its
  // task-state; that busy state MUST NOT be re-evaluated as the idle-guard (the
  // restart decision is already made here). Do NOT move the idle-check after the
  // drain and do NOT add an idle re-check inside the drain -- either would
  // deadlock the very restart the drain was asked to protect. (Nano, A3.)
  if (shouldDrainBeforeRestart(cfg, name === MAIN_AGENT_ID)) {
    // A4: never overlap two drains for the same agent.
    if (draining.has(name)) return
    draining.add(name)
    // Optimistic: record the restart time NOW so restartDue does not re-fire
    // while the async drain+restart is in flight (belt with the draining flag).
    lastRestart.set(name, nowMs)
    logger.info({ name }, 'auto-restart: draining before fresh restart')
    void performDrainAndRestart(name, cfg, defaultDrainDeps(name)).finally(() => draining.delete(name))
    return
  }

  try {
    performRestart(name, cfg)
    lastRestart.set(name, nowMs)
    logger.info({ name, mode: name === MAIN_AGENT_ID ? 'fresh(main)' : cfg.mode }, 'auto-restart: restarted session')
  } catch (err) {
    logger.warn({ err, name }, 'auto-restart: restart failed')
  }
}

export function startAutoRestartRunner(): NodeJS.Timeout {
  function sweep() {
    const now = Date.now()
    try { checkAgent(MAIN_AGENT_ID, now) } catch (err) { logger.debug({ err }, 'auto-restart: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now) } catch (err) { logger.debug({ err, agent: name }, 'auto-restart: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
