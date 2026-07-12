#!/usr/bin/env node
// PreToolUse hard-gate: DEFAULT-DENY write-ban for YODA's own session.
// Wired EXCLUSIVELY into agents/yoda/.claude/settings.json (governanced by
// EliteAI). Because it is installed only in Yoda's session, the mere fact that
// this hook runs implies "this is Yoda" -- there is NO spoofable identity/cwd
// check to defeat (unlike a fleet-wide guard, a sub-agent cannot `cd` its way
// in or out of scope here; it is either wired into a session or it is not).
//
// PURPOSE (Laci L1, kanban 5ced1967): Yoda is the fleet's REVIEWER. He must be
// read/review-only by default; any file write requires an explicit, time-
// limited, one-time approval token issued OUT OF BAND by EliteAI on Laci's
// behalf. This is a POLICY/workflow guard (honest-agent discipline), not a
// hostile-sandbox -- see KNOWN RESIDUALS below for what an adversarial /
// injected Yoda could still do (documented, not whack-a-mole'd).
//
// RULES:
//   - ANY write-intent in Yoda's session is BLOCKED by default:
//       * native Write / Edit / NotebookEdit (always a file write), and
//       * Bash write-intent (redirect/tee/cp/mv/sed -i/install/mkdir/rm/touch/
//         ln) -- reusing the sibling guards' write-intent detection.
//     ALLOWED only if an unexpired, not-yet-consumed approval grant in
//     store/.yoda-write-approval covers the target (optional path-glob).
//   - The guard's OWN files (store/.yoda-write-approval, store/yoda-write-
//     audit.log, store/.yoda-write-consumed): ALL tool-writes BLOCKED
//     UNCONDITIONALLY -- even a wide-glob `**` token cannot authorize a write
//     to them (that would let Yoda forge his own next token = permanent write
//     escalation). EliteAI provisions/rotates the token OUT OF BAND (direct fs,
//     never a tool call); the guard maintains the audit-log + consumed-ledger
//     via its own fs append (never a gated tool call).
//   - NETWORK calls are NOT file writes: a `curl -X POST .../api/...` (Yoda's
//     mandatory daily messages/memories/daily-log outputs) has no write-intent
//     token and is ALLOWED. (-d payloads are stripped before scanning, so a
//     JSON body that merely CONTAINS a '>' or the word 'mv' never false-fires.)
//   - Everything that is not a write attempt -> ALLOW (reads, greps, GET/POST
//     curls, web fetches; those tools aren't even in the matcher).
//
// AUDIT: EVERY write attempt -- allowed AND denied -- is appended to
// store/yoda-write-audit.log (ts / tool / path-or-command / decision / detail)
// by the guard's own fs append (not a tool call, never gated).
//
// REVOCABLE: EliteAI deleting/overwriting/expiring the token file instantly
// invalidates approval -- no separate revoke path is needed.
//
// AGENT-OWN SKILLS EXCEPTION (Laci decision, option 2 -- EliteAI msg 430, K1
// parity): Yoda writing his OWN agent skills dir (…/agents/yoda/.claude/
// skills/**) is a real file write his CLAUDE.md expects for self-improvement.
// Exactly as skill-write-guard (K1) treats agent-own skill writes, these are
// ALLOWED WITHOUT a token, but STILL AUDITED (decision=allow, detail=agent-own-
// skill) so the K2 diff-audit can reconcile every change. Everything else stays
// default-deny. (GLOBAL/shared skills are not writable from Yoda's session at
// all -- that surface is covered by K1, not here.) Matched by AGENT_OWN_SKILL_RX
// on the RESOLVED absolute path; a relative-path Bash write cannot be resolved
// and thus falls to default-deny -- self-improvement should use the native
// Write/Edit tool (absolute path), which is matched and allowed.
//
// Shape mirrors skill-write-guard.mjs (injection-defense K1): pure exported
// decision logic + a thin isInvokedDirectly() CLI shell. Malformed payload
// FAILS OPEN (an unclassifiable/empty payload is a Claude Code artifact, NOT
// agent-controllable, so allowing it is not a bypass route); a guard-logic
// error FAILS CLOSED (deny until fixed).
//
// KNOWN RESIDUAL BYPASSES (adversarial case only; deliberately NOT patched by
// heuristic expansion -- the K1 lesson: this is a losing arms race like content
// sanitization). Yoda, unlike the K3 external-content agent, KEEPS his Bash
// tool, so for a hypothetically injected/hostile Yoda these remain reachable:
//   R1: a RELATIVE-path Bash write after a cd (`cd /x && echo y > f`) -- the
//       write-target scan resolves ABSOLUTE-path tokens only. MITIGATED for the
//       critical case: guard-own files are also matched by BASENAME substring in
//       any write-intent segment (guardOwnMentioned), so a relative reference to
//       the token/audit/consumed file is still denied.
//   R2: an INTERPRETER write (`python3 -c 'open("f","w")…'`, `node -e`, `perl
//       -e`) -- the write happens inside the interpreter, not via a shell
//       redirect/cp/tee token. Not matched. (Denying all `-c/-e` would break
//       Yoda's legitimate read-only analysis one-liners, so it is not done.)
// Both are Bash-only. The native Write/Edit/NotebookEdit path is fully covered.
// For the POLICY goal (honest Yoda needs a token to edit) these residuals are
// immaterial; for an adversarial Yoda they are real and are called out here so
// EliteAI/Laci can weigh them.
//
// TEST HOOK (never agent-controllable -- the hook runs in a process Claude Code
// spawns, not in the agent's shell): YODA_GUARD_ROOT redirects the marveen root
// so the isolated acceptance test points the store/ files at a throwaway tree.
// Unset in production.

import { readFileSync, appendFileSync, realpathSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, basename } from 'node:path'

const MARVEEN_ROOT = process.env.YODA_GUARD_ROOT || '/home/kapucnis/marveen'
const APPROVAL_PATH = `${MARVEEN_ROOT}/store/.yoda-write-approval`
const AUDIT_LOG_PATH = `${MARVEEN_ROOT}/store/yoda-write-audit.log`
const CONSUMED_PATH = `${MARVEEN_ROOT}/store/.yoda-write-consumed`
const GUARD_LOG_PATH = `${MARVEEN_ROOT}/store/self-audit/guard.log`

// Agent-own skills exception (Laci option 2, K1 parity). Matches Yoda's OWN
// skills dir and anything under it, on the resolved absolute path. Writes here
// are allowed WITHOUT a token but still audited. Scoped to `yoda` on purpose
// (this guard only runs in Yoda's session; being explicit prevents an
// unexpected match if the path shape ever changes).
const AGENT_OWN_SKILL_RX = /\/agents\/yoda\/\.claude\/skills(?:\/|$)/

// YODA-OWN SCRATCHPAD EXCEPTION (Laci/EliteAI, FP-fix #3, msg 501). The harness
// gives every session a private throwaway temp tree at
//   /tmp/claude-<uid>/-home-kapucnis-marveen-agents-yoda/<session-id>/scratchpad/**
// (verified against Yoda's live path). Writing intermediate work there is a
// normal, ephemeral part of Yoda's analysis (e.g. drafting ebt-strategia-terv.md)
// and requires no token -- but it is STILL AUDITED (decision=allow, detail=
// yoda-scratchpad), exactly like the agent-own-skill exception, so K2 can
// reconcile it; never silently. Scoped DELIBERATELY NARROW to Yoda's OWN agent
// slug + a single session-id segment + the scratchpad subdir -- NOT `/tmp/**`,
// NOT another agent's tree, NOT the sibling `tasks/` dir -- matched on the
// RESOLVED absolute path (an unresolved/relative Bash target can never match).
const YODA_SCRATCHPAD_RX = /^\/tmp\/claude-\d+\/-home-kapucnis-marveen-agents-yoda\/[^/]+\/scratchpad(?:\/|$)/

// Basenames of the guard's own files -- matched both by exact resolved path AND
// (belt-and-suspenders for R1 relative refs) as a substring in write-intent
// Bash segments.
const GUARD_OWN_BASENAMES = ['.yoda-write-approval', 'yoda-write-audit.log', '.yoda-write-consumed']

function guardLog(kind, detail) {
  try { appendFileSync(GUARD_LOG_PATH, `${new Date().toISOString()}\tyoda-guard\t${kind}\t${(detail || '').slice(0, 400)}\n`) } catch { /* ignore */ }
}

// --- symlink-aware path resolution (from skill-write-guard.mjs) --------------
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

// --- Bash payload sanitizers (from destructive-op-guard.mjs / K1) ------------
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
// `/dev/fd/N`). `cmd 2>/dev/null`, `>/dev/null`, `&>/dev/null` are the shell's
// discard/mux idioms that pervade Yoda's read-only analysis one-liners -- the
// redirect writes nothing to a file the guard should care about. Blanking it
// BEFORE write-intent scanning stops the `>` from registering as write-intent
// (and stops `/dev/null` being mistaken for a write target). A redirect to a
// REAL file (`2>errors.log`, `> f`) is left INTACT -- only the null/device sinks
// are exempted, so no real-file write detection is weakened (opens NO bypass:
// `2>/home/.../CLAUDE.md` and `> f` stay caught). (FP-fix #1, EliteAI msg 501.)
export function stripDeviceRedirects(command) {
  return String(command ?? '')
    // redirect to a device sink: `2>/dev/null`, `>/dev/null`, `&>/dev/null`, ...
    .replace(/(?:^|\s)(?:&|\d)*>>?\s*\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)\b/gi, ' ')
    // fd-duplication -- NEVER a file write: `2>&1`, `>&2`, `1>&2`, `2>&-`. Must be
    // blanked here too: splitSegments() cuts on `&`, so `2>&1` would otherwise
    // orphan a bare `2>` fragment that re-matches write-intent (the ubiquitous
    // `>/dev/null 2>&1` read idiom). A dup redirects a descriptor, not a path.
    .replace(/(?:^|\s)\d*>&[\d-]+/g, ' ')
}

// --- approval token (grant semantics identical to K1, pathGlob now OPTIONAL) -
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
  return arr.filter((g) => g && typeof g === 'object')
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

export function parseConsumed(raw) {
  return new Set(String(raw ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
}

// The first grant that ACTUALLY authorizes this write: non-empty nonce (a grant
// with no nonce is not one-time-enforceable -> unusable), unexpired, nonce not
// already consumed, and glob matches. pathGlob is OPTIONAL: if absent/empty the
// grant is a blanket one-write authorization that matches ANY target (including
// an unresolved Bash target, realPath === null). If pathGlob is present, the
// target must be a resolved absolute path that matches it (an unresolved target
// can never satisfy a scoped glob -> conservative deny).
export function matchingGrant(grants, realPath, now, consumed) {
  const used = consumed instanceof Set ? consumed : new Set(consumed || [])
  for (const g of grants || []) {
    const nonce = typeof g.nonce === 'string' ? g.nonce.trim() : ''
    if (!nonce) continue
    if (used.has(nonce)) continue          // TOKEN-REPLAY: nonce already spent
    if (grantExpiry(g) <= now) continue
    const glob = typeof g.pathGlob === 'string' ? g.pathGlob.trim() : ''
    if (!glob) return g                    // blanket grant -> matches anything
    if (realPath == null) continue         // scoped grant cannot cover an unresolved target
    let rx
    try { rx = globToRegExp(glob) } catch { continue }
    if (rx.test(realPath)) return g
  }
  return null
}

function isGuardOwnPath(realPath) {
  return realPath === APPROVAL_PATH || realPath === AUDIT_LOG_PATH || realPath === CONSUMED_PATH
}

function isYodaOwnSkill(realPath) {
  return realPath != null && AGENT_OWN_SKILL_RX.test(realPath)
}

function isYodaScratchpad(realPath) {
  return realPath != null && YODA_SCRATCHPAD_RX.test(realPath)
}

// --- Bash write-intent target extraction ------------------------------------
// Redirect token: a real output redirect `>`/`>>`, EXCLUDING operator/arrow
// forms that merely contain a `>` inside code/prose -- `->` (Python/JS arrow),
// `=>` (fat arrow), `>=` (comparison), `2>&1` (fd-dup). Lookbehind `(?<![-=])`
// drops `->`/`=>`; lookahead `(?![=&])` drops `>=` and the fd-dup `2>&1`. A bare
// `>`/`>>` to a real file (`> f`, `cmd>f`, `2>f`) still matches -> no bypass.
// (FP-fix #2, EliteAI msg 501 + Yoda repro: a `'-> model:'` label in a read-only
// python one-liner was falsely classified as a write.)
const WRITE_INTENT_RX = /((?<![-=])>>?(?![=&])|\btee\b|\bsed\b[\s\S]*\s-i|\bcp\b|\bmv\b|\binstall\b|\bmkdir\b|\brm\b|\btouch\b|\bln\b)/i

function guardOwnMentioned(seg) {
  const s = String(seg ?? '')
  return GUARD_OWN_BASENAMES.some((b) => s.includes(b))
}

// Returns a list of write attempts for a Bash command: one per resolvable
// absolute target in a write-intent segment, or a single unresolved-target
// attempt (real:null) if a write-intent segment has no absolute token. Empty
// list means "no write intent" -> the command is not a write (curl POST, grep,
// cat, git, etc.) and will be allowed.
export function bashWriteAttempts(command) {
  const cmd = stripDeviceRedirects(stripDataPayloads(stripHeredocBodies(String(command ?? ''))))
  const attempts = []
  for (const seg of splitSegments(cmd)) {
    if (!WRITE_INTENT_RX.test(seg)) continue
    const ownByName = guardOwnMentioned(seg)
    const tokens = seg.match(/(?:^|\s)(\/[^\s'"]+)/g) || []
    if (tokens.length === 0) {
      attempts.push({ real: null, guardOwn: ownByName })
      continue
    }
    for (const t of tokens) {
      const real = resolveReal(t.trim())
      attempts.push({ real, guardOwn: ownByName || isGuardOwnPath(real) })
    }
  }
  return attempts
}

// Build the list of write attempts a tool call makes. [] = not a write.
export function collectWriteAttempts(payload) {
  const tool = String(payload?.tool_name ?? '')
  const ti = payload?.tool_input || {}
  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const fp = String(ti.file_path ?? ti.notebook_path ?? '')
    if (!fp) return []                     // malformed native write -> fail open
    const real = resolveReal(fp)
    return [{ tool, real, pathOrCmd: real, guardOwn: isGuardOwnPath(real) }]
  }
  if (tool === 'Bash') {
    const cmd = String(ti.command ?? '')
    return bashWriteAttempts(cmd).map((a) => ({
      tool: 'Bash', real: a.real, pathOrCmd: cmd.slice(0, 300), guardOwn: a.guardOwn,
    }))
  }
  return []
}

// --- pure decision per attempt ----------------------------------------------
// Returns { deny, why?, consumeNonce? }. Guard-own is denied UNCONDITIONALLY,
// before any grant is even consulted.
export function decide({ attempt, grants, consumed, now }) {
  if (attempt.guardOwn) {
    return { deny: true, why: `a yoda-write-guard sajat token/audit/ledger fajlja (${attempt.pathOrCmd}) tool-hivasbol NEM irhato -- EliteAI kezeli out-of-band, meg ervenyes tokennel sem` }
  }
  // Yoda-own scratchpad exception (FP-fix #3): allowed WITHOUT a token, audited.
  if (isYodaScratchpad(attempt.real)) return { deny: false, reason: 'yoda-scratchpad' }
  // Agent-own skills exception (Laci option 2): allowed WITHOUT a token, audited.
  if (isYodaOwnSkill(attempt.real)) return { deny: false, reason: 'agent-own-skill' }
  const g = matchingGrant(grants, attempt.real, now, consumed)
  if (g) return { deny: false, consumeNonce: (g.nonce || '').trim() }
  return { deny: true, why: `Yoda write-ban: a(z) ${attempt.tool} iras (${attempt.pathOrCmd}) ervenyes (egyszer-hasznalatos, le-nem-jart, meg-nem-konszumalt) jovahagyas-token nelkul TILTOTT. Kerd Laci-tol EliteAI-n keresztul a store/.yoda-write-approval grantot (nonce + lejarat + opcionalis path-glob)` }
}

// --- audit + consumed ledger (guard-own fs appends, never gated) ------------
function auditAttempt(tool, pathOrCmd, decision, detail) {
  try {
    appendFileSync(AUDIT_LOG_PATH, `${new Date().toISOString()}\t${tool}\t${String(pathOrCmd).slice(0, 300)}\t${decision}\t${(detail || '').slice(0, 200)}\n`)
  } catch (err) {
    guardLog('AUDIT-WRITE-FAIL', String(err))
  }
}

function appendConsumed(nonces) {
  const uniq = [...new Set(nonces)].filter(Boolean)
  if (!uniq.length) return
  try { appendFileSync(CONSUMED_PATH, uniq.join('\n') + '\n') } catch (err) { guardLog('CONSUME-WRITE-FAIL', String(err)) }
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
  ' (Guardrail: scripts/hooks/yoda-write-guard.mjs -- Yoda write-ban, kanban 5ced1967). ' +
  'Ha ez jogos iras, kerd EliteAI-n keresztul a Laci-jovahagyta store/.yoda-write-approval grantot.'

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch { return false }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    guardLog('FAILOPEN', 'malformed/empty payload -> allow')
    allow()
  }

  let attempts, grants, consumedSet
  try {
    attempts = collectWriteAttempts(payload)
    if (attempts.length === 0) allow()     // not a write -> allow, no audit
    grants = parseApproval(existsSync(APPROVAL_PATH) ? readFileSync(APPROVAL_PATH, 'utf-8') : '')
    consumedSet = parseConsumed(existsSync(CONSUMED_PATH) ? readFileSync(CONSUMED_PATH, 'utf-8') : '')
  } catch (err) {
    guardLog('GUARD-ERROR', String(err))
    deny('Yoda-write guardrail HIBA: a logika hibara futott, ezert ez a muvelet blokkolva van amig javitva nincs. Szolj EliteAI-nak.' + GATE_MSG_TAIL)
  }

  const now = Date.now()

  // Pass 1: decide every attempt with a LIVE consumed set (a nonce spent by one
  // target in this call cannot re-authorize another). No side effects yet.
  const consumedLive = new Set(consumedSet)
  const toConsume = []
  const decisions = []
  for (const a of attempts) {
    let d
    try {
      d = decide({ attempt: a, grants, consumed: consumedLive, now })
    } catch (err) {
      guardLog('GUARD-ERROR', String(err))
      deny('Yoda-write guardrail HIBA (decide): blokkolva amig javitva nincs.' + GATE_MSG_TAIL)
    }
    decisions.push({ a, d })
    if (d.deny) {
      // Audit the denied attempt, then block the whole call (no allow side effects).
      auditAttempt(a.tool, a.pathOrCmd, 'deny', d.why)
      deny(d.why + GATE_MSG_TAIL)
    }
    if (d.consumeNonce) { consumedLive.add(d.consumeNonce); toConsume.push(d.consumeNonce) }
  }

  // Pass 2 (all attempts allowed): spend nonces, audit each as allow, allow.
  appendConsumed(toConsume)
  for (const { a, d } of decisions) {
    auditAttempt(a.tool, a.pathOrCmd, 'allow', d.consumeNonce ? `nonce=${d.consumeNonce}` : (d.reason || 'allow'))
  }
  allow()
}
