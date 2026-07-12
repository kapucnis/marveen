import { describe, it, expect } from 'vitest'
import {
  DRAIN_PROMPT,
  shouldDrainBeforeRestart,
  drainAccepted,
  performDrainAndRestart,
  type DrainDeps,
} from '../auto-restart-drain.js'
import type { AutoRestartConfig } from '../auto-restart.js'
import type { AgentTaskState } from '../web/agent-taskstate.js'
import { PROJECT_ROOT } from '../config.js'

const cfg = (over: Partial<AutoRestartConfig> = {}): AutoRestartConfig => ({
  enabled: true, mode: 'fresh', dailyTime: null, intervalHours: null, handoff: true, ...over,
})

const record = (over: Partial<AgentTaskState> = {}): AgentTaskState => ({
  agent: 'a', doneSteps: [], alreadyDelegated: [], nextAction: 'go', pendingDecision: '', summary: 's', ts: 0, consumed: false, ...over,
})

// A fake-clock deps builder: `sleep` advances a synthetic clock so the poll loop
// runs deterministically with no real timers. `readState` is supplied per test.
function makeDeps(readState: DrainDeps['readState'], over: Partial<DrainDeps> = {}) {
  const clock = { t: 1000 }
  const sendCalls: Array<[string, string, string | null]> = []
  const restartCalls: Array<[string, AutoRestartConfig]> = []
  const deps: DrainDeps = {
    sendPrompt: (s, t, h) => { sendCalls.push([s, t, h]) },
    restart: (n, c) => { restartCalls.push([n, c]) },
    readState,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms },
    timeoutMs: 100,
    pollMs: 10,
    session: 'sess',
    host: null,
    ...over,
  }
  return { deps, sendCalls, restartCalls }
}

describe('shouldDrainBeforeRestart (F1 gate)', () => {
  it('true for a non-main FRESH restart with handoff enabled', () => {
    expect(shouldDrainBeforeRestart(cfg(), false)).toBe(true)
  })
  it('false for the main agent', () => {
    expect(shouldDrainBeforeRestart(cfg(), true)).toBe(false)
  })
  it('false for a continue-mode restart (keeps the conversation)', () => {
    expect(shouldDrainBeforeRestart(cfg({ mode: 'continue' }), false)).toBe(false)
  })
  it('false when handoff is off (opt-in)', () => {
    expect(shouldDrainBeforeRestart(cfg({ handoff: false }), false)).toBe(false)
  })
})

describe('drainAccepted (A2 freshness)', () => {
  it('true only for a record newer than the baseline', () => {
    expect(drainAccepted(1000, record({ ts: 1001 }))).toBe(true)
  })
  it('false for an unchanged (equal-ts) record', () => {
    expect(drainAccepted(1000, record({ ts: 1000 }))).toBe(false)
  })
  it('false for an older record and for null', () => {
    expect(drainAccepted(1000, record({ ts: 999 }))).toBe(false)
    expect(drainAccepted(1000, null)).toBe(false)
  })
})

describe('DRAIN_PROMPT (A5 static, U1 network-only)', () => {
  it('F-1: uses the ABSOLUTE PROJECT_ROOT token path (works from ANY agent cwd)', () => {
    // The token MUST be read via an absolute path -- a bare relative
    // `store/.dashboard-token` reads empty from a sub-agent cwd -> 401 -> the
    // drain would always time out on the dominant path (Yoda F-1).
    expect(DRAIN_PROMPT).toContain(`$(cat ${PROJECT_ROOT}/store/.dashboard-token)`)
    expect(DRAIN_PROMPT).not.toContain('$(cat store/.dashboard-token)') // no bare relative form
  })
  it('is otherwise static -- PROJECT_ROOT already resolved, only SAJAT_NEVED left for the agent', () => {
    expect(DRAIN_PROMPT).not.toContain('${') // the one allowed interpolation is resolved at module load
    expect(DRAIN_PROMPT).toContain('SAJAT_NEVED') // static placeholder the agent substitutes
  })
  it('persists via the network POST endpoint, not a file tool', () => {
    expect(DRAIN_PROMPT).toContain('POST http://localhost:3420/api/agent-taskstate/')
    expect(DRAIN_PROMPT).toContain('halozati POST')
  })
})

describe('performDrainAndRestart (F1 orchestration)', () => {
  it('SUCCESS: injects the drain prompt, detects a fresh record, then restarts (drained)', async () => {
    let n = 0
    // call 1 = tsBefore (null -> baseline = now); polls: null, null, then fresh
    const { deps, sendCalls, restartCalls } = makeDeps(() => (++n >= 4 ? record({ ts: 5000 }) : null))
    await performDrainAndRestart('a', cfg(), deps)
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0][1]).toBe(DRAIN_PROMPT) // A5: exactly the static prompt
    expect(restartCalls).toHaveLength(1)       // restarted after the fresh record
  })

  it('TIMEOUT: no fresh record ever -> restart STILL happens (A1 unconditional)', async () => {
    const { deps, restartCalls } = makeDeps(() => null)
    await performDrainAndRestart('a', cfg(), deps)
    expect(restartCalls).toHaveLength(1)
  })

  it('A2: an unchanged pre-existing record does NOT count as a drain -> timeout -> restart', async () => {
    // Every read returns the SAME old record; tsBefore picks up its ts, so it is
    // never "newer than the baseline". Restart still proceeds after the timeout.
    const { deps, restartCalls } = makeDeps(() => record({ ts: 500 }))
    await performDrainAndRestart('a', cfg(), deps)
    expect(restartCalls).toHaveLength(1)
  })

  it('injection failure still proceeds to poll + restart (best-effort, A1)', async () => {
    let n = 0
    const { deps, restartCalls } = makeDeps(() => (++n >= 3 ? record({ ts: 9000 }) : null), {
      sendPrompt: () => { throw new Error('tmux send failed') },
    })
    await performDrainAndRestart('a', cfg(), deps)
    expect(restartCalls).toHaveLength(1)
  })

  it('a store read error during a poll is swallowed and the restart still happens', async () => {
    const { deps, restartCalls } = makeDeps(() => { throw new Error('store read error') })
    await performDrainAndRestart('a', cfg(), deps)
    expect(restartCalls).toHaveLength(1)
  })
})
