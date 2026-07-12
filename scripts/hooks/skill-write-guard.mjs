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
// HARDENING (Yoda adversarial review 2026-07-11):
//   - SYMLINK: resolveReal() runs realpathSync AT HOOK TIME, so a write aimed
//     through a symlink into the skills tree resolves to the REAL skills path
//     and is classified/denied correctly (verified by Yoda's own isolated
//     probe). The only residual is a CONCURRENT symlink swap performed BETWEEN
//     the resolve and the actual write -- that requires a running Bash process,
//     which K3 removes from the external-content agent; K1 does not (and cannot
//     race-freely) defend it. Documented, not code.
//   - TOKEN-REPLAY: approval grants are ONE-TIME. A grant's nonce is spent into
//     store/.skill-write-consumed on first use (matchingGrant skips any spent
//     nonce), so a single wide-glob/future-expiry grant can authorize exactly
//     one write, not many. (Gap found by Yoda: the token was time-windowed, not
//     single-use.) The consumed ledger is a guard-own file: agent tool-writes
//     to it are blocked like the token/audit-log.
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
const CONSUMED_PATH = `${MARVEEN_ROOT}/store/.skill-write-consumed`
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

// Blank redirects to a DEVICE SINK (`/dev/null`, `/dev/std{out,err}`, `/dev/tty`,
// `/dev/fd/N`) BEFORE write-intent scanning. `cat …/scheduled-tasks/x.json
// 2>/dev/null` is a pure READ -- the `2>/dev/null` must not make the guard treat
// the scheduled-task path as a WRITE target. A redirect to a REAL file is left
// intact, so no real-file write detection is weakened (no bypass). (FP-fix #1.)
export function stripDeviceRedirects(command) {
  return String(command ?? '')
    // redirect to a device sink: `2>/dev/null`, `>/dev/null`, `&>/dev/null`, ...
    .replace(/(?:^|\s)(?:&|\d)*>>?\s*\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)\b/gi, ' ')
    // fd-duplication -- NEVER a file write: `2>&1`, `>&2` (splitSegments cuts on
    // `&`, so `2>&1` would orphan a bare `2>` fragment; `>/dev/null 2>&1` idiom).
    .replace(/(?:^|\s)\d*>&[\d-]+/g, ' ')
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
  const consumed = `${root}/store/.skill-write-consumed`
  const p = String(realPath ?? '')
  if (!p) return null
  if (p === approval) return 'guard-token'
  if (p === auditLog) return 'guard-log'
  if (p === consumed) return 'guard-consumed'
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

// Consumed-nonce ledger: newline-delimited nonce strings (append-only). The
// guard maintains it via its own fs append (NOT a tool call), the same way it
// maintains the audit log -- so an agent can neither read-around nor forge it.
export function parseConsumed(raw) {
  return new Set(String(raw ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

// The first grant that ACTUALLY authorizes this write: has a non-empty nonce
// (a grant with no nonce is not one-time-enforceable -> unusable), is unexpired,
// its nonce has NOT already been consumed, and its glob matches the path.
// Returns the grant (so the caller can consume its nonce) or null.
export function matchingGrant(grants, realPath, now, consumed) {
  const used = consumed instanceof Set ? consumed : new Set(consumed || [])
  for (const g of grants || []) {
    const nonce = typeof g.nonce === 'string' ? g.nonce.trim() : ''
    if (!nonce) continue                 // no nonce -> cannot enforce one-time use
    if (used.has(nonce)) continue        // TOKEN-REPLAY: nonce already spent
    if (grantExpiry(g) <= now) continue
    let rx
    try { rx = globToRegExp(g.pathGlob) } catch { continue }
    if (rx.test(realPath)) return g
  }
  return null
}

// Back-compat boolean wrapper (consumed optional).
export function approvalCovers(grants, realPath, now, consumed = []) {
  return matchingGrant(grants, realPath, now, consumed) != null
}

// --- pure decision ----------------------------------------------------------
// kind: classifyTarget result; grants: parseApproval result; now: epoch ms.
// Returns { deny, why?, audit? } where audit=true means "allowed skill write,
// record it in the audit log".
export function evaluate({ kind, realPath, grants, consumed, now }) {
  if (!kind) return { deny: false }
  if (kind === 'guard-token' || kind === 'guard-log' || kind === 'guard-consumed') {
    const which = kind === 'guard-token' ? 'jovahagyas-tokenje' : kind === 'guard-log' ? 'audit-logja' : 'nonce-ledgerje'
    return { deny: true, why: `a skill-guard sajat ${which} (${realPath}) tool-hivasbol NEM irhato -- EliteAI provisionalja out-of-band, a guard csak olvassa/vezeti` }
  }
  if (kind === 'global-skill' || kind === 'scheduled-task') {
    const g = matchingGrant(grants, realPath, now, consumed)
    if (g) return { deny: false, audit: true, consumeNonce: (g.nonce || '').trim() }
    const label = kind === 'global-skill' ? 'globalis skill (~/.claude/skills/**)' : 'utemezett feladat (~/.claude/scheduled-tasks/**)'
    return { deny: true, why: `${label} irasa ervenyes (egyszer-hasznalatos, le-nem-jart, meg-nem-konszumalt) jovahagyas-token nelkul TILTOTT (${realPath}). Kerd EliteAI-tol a store/.skill-write-approval grantot (nonce+lejarat+path-glob), vagy irj a sajat agent-skills mappadba` }
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
//
// KNOWN RESIDUAL BYPASSES (Yoda adversarial review 2026-07-11 -- deliberately
// NOT patched by heuristic expansion, which is a losing game like content-
// sanitization; the REAL guarantee is K3: the agent that processes untrusted
// external content will have NO Bash tool at all, so none of these routes are
// reachable from the actual threat surface):
//   R1: a RELATIVE-path Bash write (e.g. `cd ~/.claude/skills && echo x > f`)
//       -- the write-intent scan only resolves ABSOLUTE-path tokens, so a
//       relative redirect after a cd is not seen here.
//   R2: an INTERPRETER write (e.g. `python3 -c 'open("…/skills/x","w")…'`,
//       `node -e`, `perl -e`) -- the file write happens inside the interpreter,
//       not via a shell redirect/cp/tee token, so the regex does not match.
// Both are Bash-only gaps; the native Write/Edit/NotebookEdit path (the robust
// check above) is unaffected, and K3 removes Bash from the threat path entirely.
// Redirect token excludes operator/arrow forms that merely contain a `>` in
// code/prose (`->`, `=>`, `>=`, `2>&1`) via lookbehind `(?<![-=])` + lookahead
// `(?![=&])`; a bare `>`/`>>` to a real file still matches -> no bypass. (FP-fix
// #2: a `'-> …'` label in a read-only one-liner was misread as write-intent.)
const WRITE_INTENT_RX = /((?<![-=])>>?(?![=&])|\btee\b|\bsed\b[\s\S]*\s-i|\bcp\b|\bmv\b|\binstall\b|\bmkdir\b|\brm\b|\btouch\b|\bln\b)/i

export function bashSkillTargets(command, roots = {}) {
  const cmd = stripDeviceRedirects(stripDataPayloads(stripHeredocBodies(String(command ?? ''))))
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

// Spend approval-grant nonces so they can never authorize a second write
// (one grant = one write). Same fs-append posture as the audit log -- the
// guard writes this itself, it is never an agent tool call.
function appendConsumed(nonces) {
  const uniq = [...new Set(nonces)].filter(Boolean)
  if (!uniq.length) return
  try {
    appendFileSync(CONSUMED_PATH, uniq.join('\n') + '\n')
  } catch (err) {
    guardLog('CONSUME-WRITE-FAIL', String(err))
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

  let targets, grants, consumedSet
  try {
    targets = collectTargets(payload)
    if (targets.length === 0) allow()
    grants = parseApproval(existsSync(APPROVAL_PATH) ? readFileSync(APPROVAL_PATH, 'utf-8') : '')
    consumedSet = parseConsumed(existsSync(CONSUMED_PATH) ? readFileSync(CONSUMED_PATH, 'utf-8') : '')
  } catch (err) {
    guardLog('GUARD-ERROR', String(err))
    deny('Skill-write guardrail HIBA: a logika hibara futott, ezert ez a muvelet blokkolva van amig ez nincs javitva. Szolj EliteAI-nak.' + GATE_MSG_TAIL)
  }

  const now = Date.now()
  const agent = currentAgentTag(payload?.cwd)

  // Pass 1: evaluate every target with a LIVE consumed set (a nonce matched by
  // one target in this call cannot re-authorize another target in the same
  // call). Deny on the FIRST denied target -- no side effects until the whole
  // call is known-allowed. Nothing is written on a deny.
  const consumedLive = new Set(consumedSet)
  const toConsume = []
  for (const t of targets) {
    let d
    try {
      d = evaluate({ kind: t.kind, realPath: t.real, grants, consumed: consumedLive, now })
    } catch (err) {
      guardLog('GUARD-ERROR', String(err))
      deny('Skill-write guardrail HIBA (evaluate): blokkolva amig javitva nincs.' + GATE_MSG_TAIL)
    }
    if (d.deny) {
      guardLog('DENY', `${agent}\t${t.tool}\t${t.kind}\t${t.real}\t:: ${d.why}`)
      deny(d.why + GATE_MSG_TAIL)
    }
    if (d.consumeNonce) { consumedLive.add(d.consumeNonce); toConsume.push(d.consumeNonce) }
  }

  // Pass 2 (all targets allowed): spend the used nonces, then audit, then allow.
  appendConsumed(toConsume)
  for (const t of targets) {
    auditLine(agent, t.tool, t.real, t.action, t.hash)
  }
  allow()
}
