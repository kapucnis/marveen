import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// Compact task-state re-injection (Adam stability-fix #4, scoped 2026-06-03).
//
// When a sub-agent auto-compacts mid-task, Claude Code's own summary can lose
// the specific in-flight task-state and the agent "continues amnesically" --
// worst case RE-DELEGATING work already in flight. The PreCompact agent-hook
// (type:agent, already context-aware) writes a STRUCTURED record here; a
// SessionStart hook re-injects it on source=compact|resume.
//
// Fail-safe by design: if the PreCompact extraction fails (AUP/#209) no record
// is written -> re-injection no-ops -> Claude's own compact summary is used ->
// ZERO regression. The feature can only help, never harm.

const STORE_DIR = join(PROJECT_ROOT, 'store', 'agent-taskstate')

// Orphan hygiene only: the consumed flag is the PRIMARY single-replay guard, so
// the TTL can be generous -- a legitimate task may run many hours. 12h sweeps a
// truly abandoned record without risking dropping a real long-running task.
export const TASKSTATE_TTL_MS = 12 * 60 * 60 * 1000

// U4 (F1 precondition): 'startup' is a replay source too, because a graceful
// pre-restart DRAIN followed by a FRESH restart (no --continue) yields a new
// session whose SessionStart source is 'startup' -- NOT resume/compact. Without
// 'startup' here the dominant restart path could never re-inject.
//
// The "a cold start has no in-flight task" principle is NOT dropped -- it now
// rides on a TWO-LAYER RECORD GATE rather than a source exclusion:
//   layer 1: source must be in REPLAY_SOURCES,
//   layer 2: a FRESH, unconsumed, non-empty record must exist within the
//            source's TTL. For 'startup' the TTL is deliberately SHORT
//            (STARTUP_TTL_MS, 60 min) -- a drain writes the record seconds
//            before the fresh restart, so a genuine cold boot (no recent drain)
//            finds no fresh record and no-ops. compact/resume keep the generous
//            12h TTL (a long-running task may compact many hours in).
const REPLAY_SOURCES = new Set(['compact', 'resume', 'startup'])

// Short TTL for the 'startup' source only: the record must have been written by
// a drain in the last hour to count as an in-flight task on a fresh restart.
export const STARTUP_TTL_MS = 60 * 60 * 1000

/** The effective replay TTL for a SessionStart source (U4: startup is short). */
export function replayTtlForSource(source: string): number {
  return source === 'startup' ? STARTUP_TTL_MS : TASKSTATE_TTL_MS
}

// F2 hot-memory safety net tuning (see buildHotFallbackInjection).
export const HOT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000 // only "fresh" hot memories
export const HOT_REPLAY_LIMIT = 5                        // top-N most recent
export const HOT_REPLAY_CHAR_CAP = 2000                  // total injected chars cap

export interface AgentTaskState {
  agent: string
  doneSteps: string[]        // completed -- do NOT repeat
  alreadyDelegated: string[] // already handed to another agent -- do NOT re-send
  nextAction: string         // where to resume
  pendingDecision: string    // open decision/blocker, if any
  summary: string            // one-line what-am-I-doing
  ts: number                 // epoch ms, written at PreCompact
  consumed: boolean          // set true AFTER a successful replay injection
}

function sanitizeAgent(agent: string): string {
  // Defense: the agent name becomes a filename. Allow only the safe charset.
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function recordPath(agent: string): string {
  return join(STORE_DIR, `${sanitizeAgent(agent)}.json`)
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50)
}

/** True when the record carries no actual in-flight task (so nothing to replay). */
export function isEmptyTaskState(r: Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision'>): boolean {
  return (
    r.doneSteps.length === 0 &&
    r.alreadyDelegated.length === 0 &&
    !r.nextAction.trim() &&
    !r.pendingDecision.trim()
  )
}

/**
 * Pure decision: should this dedicated task-state record be re-injected at
 * SessionStart? Replays ONLY when: record exists, not yet consumed, source is
 * compact|resume|startup, within the SOURCE'S TTL (startup = 60 min, others =
 * 12h -- U4 two-layer record gate), and the record actually holds a task.
 *
 * When `ttlMs` is omitted the source-appropriate TTL is used; callers may pass
 * an explicit override (the existing compact/resume tests do).
 */
export function shouldReplayTaskState(
  record: AgentTaskState | null,
  source: string,
  nowMs: number,
  ttlMs: number = replayTtlForSource(source),
): boolean {
  if (!record) return false
  if (record.consumed) return false
  if (!REPLAY_SOURCES.has(source)) return false
  if (nowMs - record.ts > ttlMs) return false
  if (isEmptyTaskState(record)) return false
  return true
}

const SENTINEL = '=== TASK-FOLYTATAS (NEM uj feladat) ==='

/**
 * Build the additionalContext string. The structured do-not-resend lists are
 * the concrete defense against re-execution / re-delegation -- not the soft
 * framing alone (review hardening, Marveen 2026-06-03).
 */
export function buildTaskStateInjection(r: AgentTaskState): string {
  const lines: string[] = [
    SENTINEL,
    'A kontextusod tomoritodott egy FOLYAMATBAN LEVO feladat kozben. Ez NEM uj feladat -- FOLYTASD onnan ahol abbamaradt. NE INDITSD ujra a mar kesz lepeseket, es NE delegald ujra amit mar atadtal.',
  ]
  if (r.summary.trim()) lines.push(`FELADAT: ${r.summary.trim()}`)
  if (r.doneSteps.length) lines.push('MAR KESZ (NE ismeteld meg):\n' + r.doneSteps.map((s) => `  - ${s}`).join('\n'))
  if (r.alreadyDelegated.length) lines.push('MAR DELEGALVA (NE kuldd ujra):\n' + r.alreadyDelegated.map((s) => `  - ${s}`).join('\n'))
  if (r.nextAction.trim()) lines.push(`KOVETKEZO AKCIO (innen folytasd): ${r.nextAction.trim()}`)
  if (r.pendingDecision.trim()) lines.push(`NYITOTT DONTES / BLOKKOLO: ${r.pendingDecision.trim()}`)
  return lines.join('\n\n')
}

// --- F2: hot-memory safety net ----------------------------------------------
// When there is NO valid dedicated task-state record (e.g. a raw tmux kill with
// no drain, or the drain's POST failed), a fresh/resumed session would start
// context-blind. As a lower-confidence fallback we reconstruct an "open task"
// hint from the agent's most recent HOT-tier memories. This is DELIBERATELY
// labelled as reconstructed/uncertain so the agent verifies before acting.
//
// One recency timestamp per row (created_at, in ms -- NOT accessed_at, so a mere
// read never resurrects a stale hot memory; D1, Nano). The DB query pre-filters,
// but the builder ALSO enforces the window/limit/cap so the pure function is
// independently correct (a >24h row passed in is still dropped -- T-TS5).

export interface HotMemoryRow {
  content: string
  ts: number // recency (created_at), epoch MS
}

const HOT_SENTINEL = '=== REKONSTRUALT KONTEKSTUS (alacsonyabb konfidencia, NEM megerositett task-state) ==='

/**
 * Build the hot-memory fallback additionalContext, or null if there is nothing
 * fresh to say. Filters to non-empty rows within the window, most-recent first,
 * caps to `limit` rows and `charCap` total characters. 0 fresh rows -> null (an
 * empty block is never injected).
 */
export function buildHotFallbackInjection(
  memories: HotMemoryRow[],
  nowMs: number,
  opts: { windowMs?: number; limit?: number; charCap?: number } = {},
): string | null {
  const windowMs = opts.windowMs ?? HOT_REPLAY_WINDOW_MS
  const limit = opts.limit ?? HOT_REPLAY_LIMIT
  const charCap = opts.charCap ?? HOT_REPLAY_CHAR_CAP

  const fresh = (Array.isArray(memories) ? memories : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim() && typeof m.ts === 'number' && nowMs - m.ts <= windowMs)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
  if (fresh.length === 0) return null

  const header = [
    HOT_SENTINEL,
    'Nincs mentett task-state rekord (a mostani restart nem draint, vagy nyers kill volt). Az alabbi a legutobbi HOT-tier emlekekbol REKONSTRUALT nyitott-feladat kontextus -- alacsonyabb konfidencia. ELLENORIZD mielott folytatod, es NE indits ujra semmit pusztan ezek alapjan.',
  ].join('\n\n')

  const bullets: string[] = []
  let used = header.length
  for (const m of fresh) {
    const line = `  - ${m.content.trim().replace(/\s+/g, ' ')}`
    // +2 for the '\n\n' join separator between header/body and between bullets.
    if (used + line.length + 2 > charCap) break
    bullets.push(line)
    used += line.length + 1
  }
  if (bullets.length === 0) return null // header alone would exceed the cap
  return `${header}\n\nLEGUTOBBI HOT EMLEKEK:\n${bullets.join('\n')}`
}

export type ReplayKind = 'taskstate' | 'hot-fallback' | 'none'

/**
 * Single pure entry for the replay decision (makes the T-TS matrix directly
 * assertable): dedicated task-state is PRIMARY; the hot-memory net is a
 * secondary fallback ONLY when there is no valid task-state AND the source is
 * resume|startup (NEVER compact -- a compact keeps Claude's own summary).
 */
export function chooseReplayInjection(
  record: AgentTaskState | null,
  source: string,
  nowMs: number,
  hotMemories: HotMemoryRow[],
): { kind: ReplayKind; text: string | null } {
  if (shouldReplayTaskState(record, source, nowMs)) {
    return { kind: 'taskstate', text: buildTaskStateInjection(record!) }
  }
  if (source === 'resume' || source === 'startup') {
    const text = buildHotFallbackInjection(hotMemories, nowMs)
    return { kind: text ? 'hot-fallback' : 'none', text }
  }
  // compact with no valid record: keep Claude's own compact summary, no hot net.
  if (source === 'compact') return { kind: 'none', text: null }
  // 'clear' is a KNOWN source but an INTENTIONAL non-replay: /clear is an
  // explicit context wipe, so re-injecting the task-state would override the
  // user's intent. Log at INFO so the deliberate no-op is visible (GPT-crosscheck a).
  if (source === 'clear') {
    logger.info({ source }, 'taskstate replay: /clear is an explicit context wipe -- deliberately NOT replaying (re-injecting the task-state would override the intent)')
    return { kind: 'none', text: null }
  }
  // FAIL-SAFE: an unrecognised source (e.g. a future Claude Code SessionStart
  // value) must not slip through silently -- WARN so we notice and can extend
  // the handled set rather than mis-handle a new source.
  logger.warn({ source }, 'taskstate replay: unknown SessionStart source -- not replaying (fail-safe)')
  return { kind: 'none', text: null }
}

export function readTaskState(agent: string): AgentTaskState | null {
  const path = recordPath(agent)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentTaskState>
    return {
      agent: sanitizeAgent(agent),
      doneSteps: asStringArray(raw.doneSteps),
      alreadyDelegated: asStringArray(raw.alreadyDelegated),
      nextAction: String(raw.nextAction ?? '').trim(),
      pendingDecision: String(raw.pendingDecision ?? '').trim(),
      summary: String(raw.summary ?? '').trim(),
      ts: typeof raw.ts === 'number' ? raw.ts : 0,
      consumed: raw.consumed === true,
    }
  } catch (err) {
    logger.warn({ err, agent }, 'agent-taskstate: unreadable record')
    return null
  }
}

// Written by the PreCompact agent-hook. Always consumed:false + fresh ts, so a
// new compact's record supersedes (and re-arms) any prior one.
export function writeTaskState(
  agent: string,
  fields: Partial<Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision' | 'summary'>>,
  nowMs: number,
): AgentTaskState {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
  const record: AgentTaskState = {
    agent: sanitizeAgent(agent),
    doneSteps: asStringArray(fields.doneSteps),
    alreadyDelegated: asStringArray(fields.alreadyDelegated),
    nextAction: String(fields.nextAction ?? '').trim(),
    pendingDecision: String(fields.pendingDecision ?? '').trim(),
    summary: String(fields.summary ?? '').trim(),
    ts: nowMs,
    consumed: false,
  }
  atomicWriteFileSync(recordPath(agent), JSON.stringify(record, null, 2))
  return record
}

export function markConsumed(agent: string): void {
  const r = readTaskState(agent)
  if (!r) return
  r.consumed = true
  atomicWriteFileSync(recordPath(agent), JSON.stringify(r, null, 2))
}

// Explicit done-clear (secondary to the consumed flag). Best-effort.
export function clearTaskState(agent: string): void {
  const path = recordPath(agent)
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

// Orphan sweep: drop records older than the TTL. Cheap, opportunistic.
export function sweepOrphanTaskStates(nowMs: number, ttlMs: number = TASKSTATE_TTL_MS): number {
  if (!existsSync(STORE_DIR)) return 0
  let swept = 0
  for (const f of readdirSync(STORE_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(STORE_DIR, f), 'utf-8')) as Partial<AgentTaskState>
      if (typeof raw.ts !== 'number' || nowMs - raw.ts > ttlMs) {
        unlinkSync(join(STORE_DIR, f))
        swept++
      }
    } catch {
      try { unlinkSync(join(STORE_DIR, f)) ; swept++ } catch { /* ignore */ }
    }
  }
  return swept
}
