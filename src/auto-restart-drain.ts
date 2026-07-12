// F1: graceful pre-restart DRAIN -- pure/injectable logic.
//
// Before the auto-restart-runner does a FRESH restart (which drops the
// conversation), we give the agent a chance to persist its in-flight task-state
// so the freshly-started session can replay it (see src/web/agent-taskstate.ts,
// U4 startup replay). This module holds the dependency-free decision + the
// injectable orchestration; the real tmux/process/store wiring lives in
// src/web/auto-restart-runner.ts (the auto-restart.ts pure/runner split, mirrored).
//
// Design constraints (Yoda final spec, kanban 5ced1967 sibling task 95cf1ffb):
//   A1  hard timeout -- on expiry the restart proceeds UNCONDITIONALLY.
//   A2  freshness -- only a record written AFTER the drain baseline counts.
//   A4  idempotent -- the caller guards against overlapping drains; the store
//       POST is an upsert, so a double-run cannot corrupt state.
//   A5  the drain prompt is COMPLETELY STATIC (no interpolation) -- a dynamic
//       payload injected into a live session would be an injection surface.
//   A6  every drain event / timeout / store error is logged.
//   U1  persistence is EXCLUSIVELY the network POST /api/agent-taskstate/:agent,
//       never a file tool -- so a write-guarded session (skill-write-guard /
//       yoda-write-guard) still succeeds (the guards ignore network calls).

import { logger } from './logger.js'
import type { AutoRestartConfig } from './auto-restart.js'
import type { AgentTaskState } from './web/agent-taskstate.js'

// A1: hard ceiling on how long we wait for the agent to persist before
// restarting anyway (spec range 60-90s; D2). A2: we poll the store for a record
// written AFTER the drain injection.
export const DRAIN_TIMEOUT_MS = 75_000
export const DRAIN_POLL_MS = 2_000

// A5 (HARD): completely static text. The agent substitutes its OWN name (it
// knows it), exactly as the PreCompact capture prompt does. U1: network POST
// only, never a file tool.
export const DRAIN_PROMPT = [
  '[RENDSZER -- pre-restart taskstate-mentes]',
  'A sessionod mindjart FRISS ujrainditasra kerul es a kontextusod el fog veszni. HA egy feladat KOZBEN vagy, mentsd el a task-allapotodat MOST -- KIZAROLAG halozati POST-tal, SOHA fajl-irassal:',
  'curl -s -X POST http://localhost:3420/api/agent-taskstate/SAJAT_NEVED -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d \'{"summary":"egysoros mit-csinalok","doneSteps":["mar kesz lepesek"],"alreadyDelegated":["mar atadva masnak"],"nextAction":"innen folytasd","pendingDecision":"nyitott dontes/blokkolo"}\'',
  'Csereld a SAJAT_NEVED-et a sajat agent-nevedre. HA NINCS folyamatban feladatod (idle vagy), NE csinalj semmit es NE irj ures rekordot. Csak ezt az egy POST-ot futtasd le, ha kell -- ne valaszolj mast.',
].join('\n')

/**
 * Pure gate: should we run the graceful pre-restart drain for this restart?
 * Only for a non-main agent doing a FRESH restart (a --continue restart keeps
 * the conversation, so nothing to persist) with handoff enabled (opt-in, the
 * pre-wired src/auto-restart.ts `handoff` flag).
 */
export function shouldDrainBeforeRestart(cfg: AutoRestartConfig, isMain: boolean): boolean {
  return !isMain && cfg.mode === 'fresh' && cfg.handoff === true
}

/**
 * Pure A2 freshness check: the drain counts as successful only if a task-state
 * record exists that was written STRICTLY AFTER the drain baseline timestamp (an
 * unchanged pre-existing record does not count).
 */
export function drainAccepted(tsBefore: number, record: AgentTaskState | null): boolean {
  return !!record && typeof record.ts === 'number' && record.ts > tsBefore
}

export interface DrainDeps {
  sendPrompt: (session: string, text: string, host: string | null) => void
  restart: (name: string, cfg: AutoRestartConfig) => void
  readState: (agent: string) => AgentTaskState | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  timeoutMs: number
  pollMs: number
  session: string
  host: string | null
}

/**
 * F1: inject the static drain prompt, poll the store for a fresh task-state
 * record (A2) up to the hard timeout (A1), then restart UNCONDITIONALLY whether
 * the drain succeeded or timed out. Async + non-blocking: the caller fires this
 * and moves on (an initial `await sleep(0)` yields before any blocking send-keys
 * I/O), and the poll uses async sleeps so a slow/non-responsive agent never
 * blocks the event loop for the whole timeout. Every branch is logged (A6). All
 * I/O is injected via `deps` so the logic is unit-testable without tmux/processes.
 */
export async function performDrainAndRestart(
  name: string,
  cfg: AutoRestartConfig,
  deps: DrainDeps,
): Promise<void> {
  const { sendPrompt, restart, readState, now, sleep, timeoutMs, pollMs, session, host } = deps
  // Yield so the caller's sweep returns before we do blocking send-keys I/O.
  await sleep(0)

  // A2 baseline: an existing record's ts if any, else the drain-start time. A
  // store read error here must NOT crash the drain (T-TS8) -- fall back to now.
  let tsBefore: number
  try {
    tsBefore = readState(name)?.ts ?? now()
  } catch (err) {
    logger.warn({ err, name }, 'auto-restart drain: taskstate read error at baseline; using drain-start time')
    tsBefore = now()
  }
  logger.info({ name, session }, 'auto-restart drain: injecting pre-restart taskstate drain prompt')
  try {
    sendPrompt(session, DRAIN_PROMPT, host)
  } catch (err) {
    // A6: a failed injection is logged; we still fall through to the restart
    // (the drain is a best-effort safety net, never a restart blocker -- A1).
    logger.warn({ err, name }, 'auto-restart drain: drain-prompt injection failed; restarting anyway')
  }

  const deadline = now() + timeoutMs
  let drained = false
  while (now() < deadline) {
    await sleep(pollMs)
    let rec: AgentTaskState | null = null
    try {
      rec = readState(name)
    } catch (err) {
      // A6 / T-TS8: a store read/write error surfaces as a poll miss -> timeout.
      logger.warn({ err, name }, 'auto-restart drain: taskstate read error during poll')
    }
    if (drainAccepted(tsBefore, rec)) { drained = true; break }
  }
  if (drained) {
    logger.info({ name }, 'auto-restart drain: fresh taskstate persisted; proceeding to restart')
  } else {
    // A6: non-responsive session OR store-write failure (T-TS8). The next start
    // is covered by the F2 hot-memory net.
    logger.warn({ name }, 'auto-restart drain: no fresh taskstate within timeout; restarting anyway (F2 net covers next start)')
  }

  // A1: the restart proceeds UNCONDITIONALLY.
  try {
    restart(name, cfg)
    logger.info({ name, mode: cfg.mode, drained }, 'auto-restart: restarted session (post-drain)')
  } catch (err) {
    logger.warn({ err, name }, 'auto-restart: post-drain restart failed')
  }
}
