#!/usr/bin/env node
// PreToolUse hard-gate: governs SKILL and SCHEDULED-TASK writes across the
// fleet. First layer of the injection-defense package (Yoda spec, msg_id:364).
//
// THREAT MODEL: an injected instruction (hidden in an email/calendar item a
// sub-agent processes) that tries to plant a backdoor by writing a GLOBAL skill
// (~/.claude/skills/**) or a scheduled task (~/.claude/scheduled-tasks/**) --
// both of which auto-load/run fleet-wide -- or by tampering with this guard's
// own approval-token / audit-log. Self-improvement into an agent's OWN skills
// dir stays allowed (an explicitly wanted capability), but is now LOGGED so the
// K2 diff-audit can reconcile every change against an approved reason.
//
// RULES (path-based, create+modify+delete all count as a "skill write"):
//   - GLOBAL skill (~/.claude/skills/**) or scheduled-tasks (~/.claude/
//     scheduled-tasks/**): BLOCKED, unless a valid, unexpired approval grant in
//     store/.skill-write-approval covers the target path. Approved -> ALLOW +
//     append to store/skill-audit.log.
//   - LOCAL / agent-own skill (…/agents/<name>/.claude/skills/**): ALLOWED, but
//     every write appended to store/skill-audit.log (ts/agent/tool/path/action/
//     sha256).
//   - The guard's OWN files (store/.skill-write-approval, store/skill-audit.log):
//     ALL agent tool-writes BLOCKED, unconditionally. This is deliberately
//     IDENTITY-FREE: EliteAI provisions the approval token OUT OF BAND (direct
//     fs / a path this hook does not guard), and the guard itself maintains the
//     audit log via its own fs append below (NOT a tool call, so never gated).
//     An agent can therefore never forge its own approval nor rewrite the audit
//     trail through a tool call -- and there is no spoofable "am I EliteAI?"
//     cwd/identity check to defeat (a sub-agent cannot `cd` its way past this).
//   - Anything else: not a skill write -> ALLOW, no log.
//
// Catches BOTH the native file tools (Write/Edit/NotebookEdit) AND Bash
// write-intent routes (redirect/tee/cp/mv/sed -i/install/mkdir+…/rm). The
// settings.json matcher MUST list all of them ("Bash|Edit|Write|NotebookEdit")
// -- a Bash-only matcher would let a native Write call sail past unseen
// (the constitution-guard lesson, 2026-07-11).
//
// Shape mirrors the sibling guards (nano-worktree-guard.mjs, destructive-op-
// guard.mjs, claude-constitution-guard.mjs): pure exported decision logic +
// a thin isInvokedDirectly() CLI shell; malformed payload FAILS OPEN (never
// break a tool call we cannot classify), a guard-logic error FAILS CLOSED
// (block until fixed). Decisions logged to store/self-audit/guard.log.
//
// TEST HOOKS (never agent-controllable -- the hook runs in a process Claude
// Code spawns, not in the agent's shell; a Bash tool's own command runs only
// AFTER this hook allows it, and Write/Edit have no shell at all): the two root
// paths may be redirected via SKILL_GUARD_HOME / SKILL_GUARD_ROOT so the
// isolated acceptance test can point them at a throwaway tree. In production
// both are unset and the real HOME / marveen root are used.

import { readFileSync, appendFileSync, realpathSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const MARVEEN_ROOT = process.env.SKILL_GUARD_ROOT || '/home/kapucnis/marveen'
const HOME = process.env.SKILL_GUARD_HOME || homedir()
const GLOBAL_SKILLS_DIR = `${HOME}/.claude/skills`
const SCHEDULED_TASKS_DIR = `${HOME}/.claude/scheduled-tasks`
const APPROVAL_PATH = `${MARVEEN_ROOT}/store/.skill-write-approval`
const AUDIT_LOG_PATH = `${MARVEEN_ROOT}/store/skill-audit.log`
const GUARD_LOG_PATH = `${MARVEEN_ROOT}/store/self-audit/guard.log`

// --- best-effort agent tag (LOGGING ONLY, never a security decision) --------
function currentAgentTag(payloadCwd) {
  try {
    const cwd = String(payloadCwd ?? process.cwd())
    const m = cwd.match(/\/agents\/([^/]+)(?:\/|$)/)
    if (m) return m[1]
    if (cwd === MARVEEN_ROOT || cwd.startsWith(MARVEEN_ROOT + '/')) return 'eliteai'
  } catch { /* fall through */ }
  return 'unknown'
}

function guardLog(kind, detail) {
  try { appendFileSync(GUARD_LOG_PATH, `${new Date().toISOString()}\tskill-guard\t${kind}\t${(detail || '').slice(0, 400)}\n`) } catch { /* ignore */ }
}

// --- symlink-aware path resolution (from nano-worktree-guard.mjs) -----------
function resolveReal(p) {
  const abs = resolve(String(p ?? ''))
  try {
    return realpathSync(abs)
  } catch {
    let dir = dirname(abs)
    for (let i = 0; i < 20 && dir !== '/'; i++) {
      if (existsSync(dir)) {
        try { return realpathSync(dir) + abs.slice(dir.length) } catch { /* fall through */ }
      }
      dir = dirname(dir)
    }
    return abs
  }
}

// --- Bash payload sanitizers (from destructive-op-guard.mjs) -----------------
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    .map((s) => s.trim())
}

export function stripHeredocBodies(command) {
  const lines = String(command ?? '').split(/\r?\n/)
  const out = []
  let term = null
  for (const line of lines) {
    if (term === null) {
      out.push(line)
      const m = line.match(/<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
      if (m) term = m[2]
    } else {
      if (line.trim() === term || line.trim() === `${term};`) { out.push(line); term = null }
    }
  }
  return out.join('\n')
}

export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
}

// --- path classification ----------------------------------------------------
// Returns the kind of protected target a resolved absolute path represents.
export function classifyTarget(realPath, roots = {}) {
  const home = roots.home || HOME
  const root = roots.root || MARVEEN_ROOT
  const globalSkills = `${home}/.claude/skills`
  const scheduled = `${home}/.claude/scheduled-tasks`
  const approval = `${root}/store/.skill-write-approval`
  const auditLog = `${root}/store/skill-audit.log`
  const p = String(realPath ?? '')
  if (!p) return null
  if (p === approval) return 'guard-token'
  if (p === auditLog) return 'guard-log'
  if (p === globalSkills || p.startsWith(globalSkills + '/')) return 'global-skill'
  if (p === scheduled || p.startsWith(scheduled + '/')) return 'scheduled-task'
  // Agent-own skills: …/agents/<name>/.claude/skills/**
  if (/\/agents\/[^/]+\/\.claude\/skills(?:\/|$)/.test(p)) return 'local-skill'
  return null
}

// --- approval token ---------------------------------------------------------
// glob -> anchored RegExp. Supports ** (any, incl. /) and * (any except /).
export function globToRegExp(glob) {
  let re = ''
  const g = String(glob ?? '')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++ } else { re += '[^/]*' }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export function parseApproval(raw) {
  if (!raw) return []
  let data
  try { data = JSON.parse(raw) } catch { return [] }
  const arr = Array.isArray(data) ? data : Array.isArray(data?.grants) ? data.grants : [data]
  return arr.filter((g) => g && typeof g === 'object' && g.pathGlob)
}

function grantExpiry(g) {
  const v = g.expiresAt
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

// A grant covers a path if it is unexpired AND its glob matches the path.
export function approvalCovers(grants, realPath, now) {
  for (const g of grants || []) {
    if (grantExpiry(g) <= now) continue
    let rx
    try { rx = globToRegExp(g.pathGlob) } catch { continue }
    if (rx.test(realPath)) return true
  }
  return false
}

// --- pure decision ----------------------------------------------------------
// kind: classifyTarget result; grants: parseApproval result; now: epoch ms.
// Returns { deny, why?, audit? } where audit=true means "allowed skill write,
// record it in the audit log".
export function evaluate({ kind, realPath, grants, now }) {
  if (!kind) return { deny: false }
  if (kind === 'guard-token' || kind === 'guard-log') {
    return { deny: true, why: `a skill-guard sajat ${kind === 'guard-token' ? 'jovahagyas-tokenje' : 'audit-logja'} (${realPath}) tool-hivasbol NEM irhato -- EliteAI provisionalja out-of-band, a guard csak olvassa` }
  }
  if (kind === 'global-skill' || kind === 'scheduled-task') {
    if (approvalCovers(grants, realPath, now)) return { deny: false, audit: true }
    const label = kind === 'global-skill' ? 'globalis skill (~/.claude/skills/**)' : 'utemezett feladat (~/.claude/scheduled-tasks/**)'
    return { deny: true, why: `${label} irasa jovahagyas-token nelkul TILTOTT (${realPath}). Kerd EliteAI-tol a store/.skill-write-approval grantot (nonce+lejarat+path-glob), vagy irj a sajat agent-skills mappadba` }
  }
  if (kind === 'local-skill') return { deny: false, audit: true }
  return { deny: false }
}

// --- Bash write-intent target extraction ------------------------------------
// Absolute-path tokens that a write-intent command targets (redirect/tee/cp/
// mv/sed -i/install/mkdir/rm). Same "absolute-tokens only" limitation as the
// sibling guards: a bare/relative token is not resolved (the hook subprocess
// cwd is not reliably the agent's shell cwd) -- the Write/Edit path is the
// robust check, this is the best-effort second layer.
const WRITE_INTENT_RX = /(>>?(?!&)|\btee\b|\bsed\b[\s\S]*\s-i|\bcp\b|\bmv\b|\binstall\b|\bmkdir\b|\brm\b|\btouch\b|\bln\b)/i

export function bashSkillTargets(command, roots = {}) {
  const cmd = stripDataPayloads(stripHeredocBodies(String(command ?? '')))
  const hits = []
  for (const seg of splitSegments(cmd)) {
    if (!WRITE_INTENT_RX.test(seg)) continue
    const isDelete = /\brm\b/.test(seg)
    const tokens = seg.match(/(?:^|\s)(\/[^\s'"]+)/g) || []
    for (const t of tokens) {
      const real = resolveReal(t.trim())
      const kind = classifyTarget(real, roots)
      if (kind) hits.push({ real, kind, action: isDelete ? 'delete' : 'modify' })
    }
  }
  return hits
}

// --- audit log --------------------------------------------------------------
function sha256(s) {
  try { return createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex') } catch { return '-' }
}

function auditLine(agent, tool, path, action, hash) {
  try {
    appendFileSync(AUDIT_LOG_PATH, `${new Date().toISOString()}\t${agent}\t${tool}\t${path}\t${action}\t${hash}\n`)
  } catch (err) {
    guardLog('AUDIT-WRITE-FAIL', String(err))
  }
}

// --- CLI --------------------------------------------------------------------
function allow() { process.exit(0) }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

const GATE_MSG_TAIL =
  ' (Guardrail: scripts/hooks/skill-write-guard.mjs -- injekcio-vedelem K1). ' +
  'Ha ez jogos, kerd EliteAI-tol a megfelelo store/.skill-write-approval grantot inter-agent uzenetben.'

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch { return false }
}

// Build the list of { real, kind, action, tool, hash } targets a tool call
// writes. Returns [] for a non-write tool.
export function collectTargets(payload) {
  const tool = String(payload?.tool_name ?? '')
  const ti = payload?.tool_input || {}
  const targets = []
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const fp = String(ti.file_path ?? ti.notebook_path ?? '')
    if (!fp) return []
    const real = resolveReal(fp)
    const kind = classifyTarget(real)
    if (!kind) return []
    const content = ti.content ?? ti.new_string ?? ti.new_source ?? ''
    const action = tool === 'Write' ? (existsSync(real) ? 'modify' : 'create') : 'modify'
    targets.push({ real, kind, action, tool, hash: sha256(content) })
  } else if (tool === 'Bash') {
    for (const h of bashSkillTargets(ti.command)) {
      targets.push({ real: h.real, kind: h.kind, action: h.action, tool: 'Bash', hash: '-' })
    }
  }
  return targets
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    guardLog('FAILOPEN', 'malformed/empty payload -> allow')
    allow()
  }

  let targets, grants
  try {
    targets = collectTargets(payload)
    if (targets.length === 0) allow()
    grants = parseApproval(existsSync(APPROVAL_PATH) ? readFileSync(APPROVAL_PATH, 'utf-8') : '')
  } catch (err) {
    guardLog('GUARD-ERROR', String(err))
    deny('Skill-write guardrail HIBA: a logika hibara futott, ezert ez a muvelet blokkolva van amig ez nincs javitva. Szolj EliteAI-nak.' + GATE_MSG_TAIL)
  }

  const now = Date.now()
  const agent = currentAgentTag(payload?.cwd)

  // Deny on the FIRST denied target (a single bad path fails the whole call).
  for (const t of targets) {
    let d
    try {
      d = evaluate({ kind: t.kind, realPath: t.real, grants, now })
    } catch (err) {
      guardLog('GUARD-ERROR', String(err))
      deny('Skill-write guardrail HIBA (evaluate): blokkolva amig javitva nincs.' + GATE_MSG_TAIL)
    }
    if (d.deny) {
      guardLog('DENY', `${agent}\t${t.tool}\t${t.kind}\t${t.real}\t:: ${d.why}`)
      deny(d.why + GATE_MSG_TAIL)
    }
  }

  // All targets allowed -> audit every skill write, then allow.
  for (const t of targets) {
    auditLine(agent, t.tool, t.real, t.action, t.hash)
  }
  allow()
}
