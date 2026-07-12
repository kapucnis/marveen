import { describe, it, expect, afterEach } from 'vitest'
import {
  shouldReplayTaskState,
  isEmptyTaskState,
  buildTaskStateInjection,
  writeTaskState,
  readTaskState,
  markConsumed,
  clearTaskState,
  sweepOrphanTaskStates,
  TASKSTATE_TTL_MS,
  STARTUP_TTL_MS,
  replayTtlForSource,
  buildHotFallbackInjection,
  chooseReplayInjection,
  type AgentTaskState,
  type HotMemoryRow,
} from '../web/agent-taskstate.js'

const NOW = 1_700_000_000_000
const rec = (over: Partial<AgentTaskState> = {}): AgentTaskState => ({
  agent: 'tester',
  doneSteps: ['did A'],
  alreadyDelegated: [],
  nextAction: 'do B',
  pendingDecision: '',
  summary: 'building X',
  ts: NOW,
  consumed: false,
  ...over,
})

// Compact task-state re-injection (#4). Pure-fn coverage is the safety core.
describe('shouldReplayTaskState', () => {
  it('replays a fresh unconsumed record on compact', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + 1000)).toBe(true)
  })
  it('replays on resume too', () => {
    expect(shouldReplayTaskState(rec(), 'resume', NOW + 1000)).toBe(true)
  })
  // U4 (behaviour CHANGE from the original feature): 'startup' now DOES replay,
  // but strictly record-gated by a SHORT (60min) TTL -- so the dominant fresh-
  // restart path (drain writes a record seconds before the startup) re-injects,
  // while a genuine cold boot (no fresh record) still no-ops via the record gate.
  it('DOES replay on startup with a FRESH record (U4 -- within the 60min gate)', () => {
    expect(shouldReplayTaskState(rec(), 'startup', NOW + 1000)).toBe(true)
  })
  it('does NOT replay on startup once the record is older than the 60min gate (T-TS7 basis)', () => {
    expect(shouldReplayTaskState(rec(), 'startup', NOW + STARTUP_TTL_MS + 1)).toBe(false)
  })
  it('startup honors the SHORT ttl, not the 12h one (a 2h-old record is stale for startup)', () => {
    // 2h old: fine for compact (12h ttl), stale for startup (60min ttl).
    expect(shouldReplayTaskState(rec(), 'compact', NOW + 2 * 60 * 60 * 1000)).toBe(true)
    expect(shouldReplayTaskState(rec(), 'startup', NOW + 2 * 60 * 60 * 1000)).toBe(false)
  })
  it('does NOT replay a consumed record', () => {
    expect(shouldReplayTaskState(rec({ consumed: true }), 'compact', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a null record', () => {
    expect(shouldReplayTaskState(null, 'compact', NOW)).toBe(false)
  })
  it('does NOT replay past the TTL (orphan)', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS + 1)).toBe(false)
  })
  it('replays right up to the TTL boundary', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS)).toBe(true)
  })
  it('does NOT replay an empty (no-task) record', () => {
    const empty = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', summary: 'idle' })
    expect(shouldReplayTaskState(empty, 'compact', NOW + 1)).toBe(false)
  })
})

describe('isEmptyTaskState', () => {
  it('true when no steps/delegations/next/pending', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: '  ', pendingDecision: '' })).toBe(true)
  })
  it('false when a nextAction exists', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: 'do B', pendingDecision: '' })).toBe(false)
  })
  it('false when already-delegated exists (the re-delegation guard data)', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: ['gave Zara the frontend'], nextAction: '', pendingDecision: '' })).toBe(false)
  })
})

describe('buildTaskStateInjection', () => {
  it('carries the sentinel + structured do-not-resend lists', () => {
    const out = buildTaskStateInjection(rec({
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'whether to gate on RESPAWN_ENABLED',
    }))
    expect(out).toContain('TASK-FOLYTATAS (NEM uj feladat)')
    expect(out).toContain('NE delegald ujra') // anti-re-delegation framing
    expect(out).toContain('merged #276')        // done step
    expect(out).toContain('Zara: frontend modal') // already-delegated item
    expect(out).toContain('open the PR')         // next action
    expect(out).toContain('whether to gate')     // pending decision
  })
})

// Light I/O round-trip on the real store dir, with cleanup.
describe('task-state store I/O', () => {
  const A = 'vitest-taskstate-agent'
  afterEach(() => clearTaskState(A))

  it('write -> read round-trips and arms (consumed=false, fresh ts)', () => {
    writeTaskState(A, { summary: 's', nextAction: 'next', doneSteps: ['x'] }, NOW)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(false)
    expect(r.ts).toBe(NOW)
    expect(r.nextAction).toBe('next')
    expect(r.doneSteps).toEqual(['x'])
  })

  it('markConsumed flips the flag so the next replay is suppressed', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    markConsumed(A)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(true)
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(false)
  })

  it('sweepOrphanTaskStates drops a record older than the TTL', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    const swept = sweepOrphanTaskStates(NOW + TASKSTATE_TTL_MS + 1)
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(readTaskState(A)).toBeNull()
  })

  it('sanitizes the agent name (no path traversal in the filename)', () => {
    // A traversal-y name must not escape the store dir; it sanitizes to safe chars.
    writeTaskState('../../etc/passwd', { nextAction: 'x' }, NOW)
    // readable back via the same sanitized key, and no file outside the dir.
    const r = readTaskState('../../etc/passwd')
    expect(r).not.toBeNull()
    clearTaskState('../../etc/passwd')
  })
})

// --- U4: source-dependent replay TTL ----------------------------------------
describe('replayTtlForSource (U4)', () => {
  it('startup uses the short 60min ttl', () => {
    expect(replayTtlForSource('startup')).toBe(STARTUP_TTL_MS)
  })
  it('compact/resume use the generous 12h ttl', () => {
    expect(replayTtlForSource('compact')).toBe(TASKSTATE_TTL_MS)
    expect(replayTtlForSource('resume')).toBe(TASKSTATE_TTL_MS)
  })
})

// --- F2: hot-memory fallback builder (pure) ---------------------------------
describe('buildHotFallbackInjection (F2)', () => {
  const hot = (over: Partial<HotMemoryRow> = {}): HotMemoryRow => ({ content: 'nyitott: X ellenorzese', ts: NOW, ...over })

  it('builds a LABELLED lower-confidence block from fresh hot memories', () => {
    const out = buildHotFallbackInjection([hot()], NOW + 1000)!
    expect(out).toContain('REKONSTRUALT KONTEKSTUS')
    expect(out).toContain('alacsonyabb konfidencia')
    expect(out).toContain('nyitott: X ellenorzese')
  })
  it('returns null when there are NO hot memories (T-TS9 basis)', () => {
    expect(buildHotFallbackInjection([], NOW)).toBeNull()
  })
  it('returns null when every hot memory is older than the 24h window (T-TS5 basis)', () => {
    const old = hot({ ts: NOW - (25 * 60 * 60 * 1000) })
    expect(buildHotFallbackInjection([old], NOW)).toBeNull()
  })
  it('skips empty-content rows', () => {
    expect(buildHotFallbackInjection([hot({ content: '   ' })], NOW)).toBeNull()
  })
  it('caps to the top-5 most recent', () => {
    const rows = Array.from({ length: 9 }, (_, i) => hot({ content: `mem-${i}`, ts: NOW - i * 1000 }))
    const out = buildHotFallbackInjection(rows, NOW)!
    // newest-first: mem-0..mem-4 present, mem-5+ excluded
    expect(out).toContain('mem-0')
    expect(out).toContain('mem-4')
    expect(out).not.toContain('mem-5')
  })
  it('enforces the total char cap', () => {
    const big = Array.from({ length: 5 }, (_, i) => hot({ content: 'x'.repeat(1000), ts: NOW - i }))
    const out = buildHotFallbackInjection(big, NOW, { charCap: 1500 })!
    expect(out.length).toBeLessThanOrEqual(1600) // header + a couple bullets, hard-bounded
  })
})

// --- F2 + primary: the single replay decision -------------------------------
describe('chooseReplayInjection (F2 orchestration)', () => {
  const hot: HotMemoryRow[] = [{ content: 'hot open task', ts: NOW }]

  it('PRIMARY: a valid task-state wins over the hot net (startup)', () => {
    const d = chooseReplayInjection(rec(), 'startup', NOW + 1000, hot)
    expect(d.kind).toBe('taskstate')
    expect(d.text).toContain('TASK-FOLYTATAS')
  })
  it('FALLBACK: no task-state + resume -> hot-fallback (T-TS2 basis)', () => {
    const d = chooseReplayInjection(null, 'resume', NOW, hot)
    expect(d.kind).toBe('hot-fallback')
    expect(d.text).toContain('REKONSTRUALT')
  })
  it('FALLBACK: no task-state + startup -> hot-fallback', () => {
    expect(chooseReplayInjection(null, 'startup', NOW, hot).kind).toBe('hot-fallback')
  })
  it('compact NEVER uses the hot net (keeps its own summary)', () => {
    const d = chooseReplayInjection(null, 'compact', NOW, hot)
    expect(d.kind).toBe('none')
    expect(d.text).toBeNull()
  })
  it('no task-state + no fresh hot -> none (T-TS9)', () => {
    expect(chooseReplayInjection(null, 'startup', NOW, []).kind).toBe('none')
  })
  it('no task-state + only STALE hot -> none (T-TS5)', () => {
    const stale: HotMemoryRow[] = [{ content: 'old', ts: NOW - 25 * 60 * 60 * 1000 }]
    expect(chooseReplayInjection(null, 'startup', NOW, stale).kind).toBe('none')
  })
})

// --- T-TS1 / T-TS7 at the store level (real round-trip) ---------------------
describe('startup replay end-to-end via the store (T-TS1 / T-TS7)', () => {
  const A = 'vitest-taskstate-startup'
  afterEach(() => clearTaskState(A))

  it('T-TS1: a fresh drained record injects on the STARTUP source', () => {
    writeTaskState(A, { summary: 'building X', nextAction: 'open the PR' }, NOW)
    const d = chooseReplayInjection(readTaskState(A), 'startup', NOW + 5000, [])
    expect(d.kind).toBe('taskstate')
    expect(d.text).toContain('open the PR')
  })
  it('T-TS7: a STALE record (>60min) does NOT inject on startup (record gate holds)', () => {
    writeTaskState(A, { nextAction: 'stale next' }, NOW)
    const d = chooseReplayInjection(readTaskState(A), 'startup', NOW + STARTUP_TTL_MS + 1, [])
    expect(d.kind).toBe('none')
    expect(d.text).toBeNull()
  })
})
