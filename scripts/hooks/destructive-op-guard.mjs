#!/usr/bin/env node
// PreToolUse hard-gate: blocks IRREVERSIBLE, DESTRUCTIVE Bash operations.
//
// Shared, agent-agnostic core (2026-07-10 guard-unification). Extracted from
// scripts/hooks/eliteai-guard.mjs (which built and validated this logic for
// the main agent only) so EVERY agent in the fleet gets the same protection --
// the sub-agents previously carried only email-send-gate + self-pace-gate,
// neither of which covers destructive rm/SQL/DB/filesystem operations. nano in
// particular runs on Opus, actually builds and executes code, and is the
// fleet's highest-risk executor -- it had ZERO destructive-op coverage before
// this. Found independently by two reviews (Yoda's fleet audit + a direct
// file-level check) on the same day.
//
// SCOPE (deliberately narrow -> zero false-positives on legit operator-directed
// work): only IRREVERSIBLE, DESTRUCTIVE operations that have no place in the
// normal orchestration workflow are denied. Agents mutate data through the
// dashboard API (kanban/memory/messages), not through raw destructive SQL or
// broad rm -rf, so those are red flags.
//
//   1. rm -rf against a catastrophic target (/, /home, ~, $HOME, the marveen
//      root or its critical subdirs .git/store/src/agents/.claude, a bare * or
//      an unexpanded $VAR). Legit cleanups target a specific safe subdir
//      (/tmp, scratchpad, dist_backup, node_modules) -> allowed.
//   2. git push --force / -f (a --force-with-lease is allowed).
//   3. Destructive SQL: DROP/TRUNCATE, or DELETE/UPDATE with NO WHERE clause.
//   4. Overwriting/truncating the sqlite DB file (> / tee / dd of=).
//   5. Filesystem-destroying ops: mkfs, dd to a block device, chmod -R 777 /.
//
// NOT guarded (documented limitation): writes to governance files (CLAUDE.md,
// .claude/settings.json, rules) are NOT auto-denied here -- for the main agent
// these are legitimate, operator-directed edits; for sub-agents, the SEPARATE
// claude-constitution-guard.mjs hook (nano) covers that. A confused-agent
// self-modification risk beyond that remains operator-trust-based.
// The gate also cannot stop a direct filesystem edit made OUTSIDE Claude Code.
//
// LIMITATION (documented, per GPT crosscheck 2026-07-10): this gate matches
// EXPLICIT command text. It does NOT defend against shell ALIASES/wrappers/
// functions that rename a destructive binary, nor arbitrary obfuscation beyond
// the common curl|bash / base64|sh / eval $() routes it does catch. It is a
// second layer over operator trust, not a sandbox.
//
// Decisions (DENY + FAILOPEN) are logged to store/self-audit/guard.log, tagged
// with a best-effort agent name derived from cwd (logging only -- never a
// security decision input).

import { readFileSync, realpathSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MARVEEN_ROOT = '/home/kapucnis/marveen'
const LOG_PATH = MARVEEN_ROOT + '/store/self-audit/guard.log'

// Best-effort agent tag for the audit log. A sub-agent's cwd is
// <MARVEEN_ROOT>/agents/<name>; the main agent's cwd is MARVEEN_ROOT itself.
// Never a security decision -- purely so guard.log is legible across agents.
function currentAgentTag() {
  try {
    const cwd = process.cwd()
    const m = cwd.match(/\/agents\/([^/]+)(?:\/|$)/)
    if (m) return m[1]
    if (cwd === MARVEEN_ROOT || cwd.startsWith(MARVEEN_ROOT + '/')) return 'eliteai'
  } catch { /* fall through */ }
  return 'unknown'
}

// Best-effort decision log (deny + fail-open); never let logging break the hook.
function logLine(kind, detail) {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()}\t${currentAgentTag()}\t${kind}\t${(detail || '').slice(0, 300)}\n`) } catch { /* ignore */ }
}

// --- helpers (shape mirrored from self-pace-gate.mjs) -----------------------

// Split a compound command into simple segments so a token in one part never
// trips a pattern anchored in another. Line-continuations collapsed first.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    .map((s) => s.trim())
}

// Blank quoted -d/--data payloads (data sent over the wire is never a shell
// invocation) so a dangerous-looking token INSIDE an API body cannot false-deny
// (e.g. a memory-save curl whose JSON prose mentions "DROP TABLE" or "rm -rf").
// Only provably-literal payloads are blanked; a double-quoted body that can run
// a substitution ($()/backtick) is kept intact.
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

// Blank heredoc BODIES (the text between <<TAG / <<'TAG' and the terminator).
// A report/memory sent via a heredoc can contain prose that names a dangerous
// pattern ("DROP TABLE", ">> CLAUDE.md"); that prose is data, not a command.
// The heredoc INTRODUCER line is kept (a real command can follow `<<'EOF' >> x`).
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
      // inside heredoc body -> blank it; detect the terminator line
      if (line.trim() === term || line.trim() === `${term};`) { out.push(line); term = null }
      // else: drop the body line entirely
    }
  }
  return out.join('\n')
}

// --- destructive patterns ---------------------------------------------------

function flagChars(seg) {
  return (seg.match(/(?:^|\s)-[a-zA-Z]+/g) || []).join('')
}

// rm with BOTH recursive and force flags (any spelling: -rf, -fr, -r -f, -Rf).
function isRecursiveForceRm(seg) {
  if (!/\brm\b/.test(seg)) return false
  const f = flagChars(seg).toLowerCase()
  return (f.includes('r') && f.includes('f'))
}

// Catastrophic rm targets. Anchored so a safe subdir (/tmp, scratchpad,
// dist_backup, node_modules) does NOT match.
const RM_CATASTROPHIC_TARGET = new RegExp(
  String.raw`(?:^|\s)(?:` +
    String.raw`/(?:\s|$)` +                       // root
    String.raw`|/home(?:/\S*)?(?:\s|$)` +          // /home, /home/...
    String.raw`|~(?:/\S*)?(?:\s|$)` +              // ~ , ~/...
    String.raw`|\$\{?HOME\}?(?:/\S*)?(?:\s|$)` +   // $HOME
    String.raw`|\*(?:\s|$)` +                      // bare glob target
    String.raw`|` + MARVEEN_ROOT.replace(/[/]/g, '\\/') + String.raw`(?:/(?:\.git|store|src|agents|\.claude)\b)?(?:\s|$|/(?:\s|$))` +
  String.raw`)`,
)
// Unexpanded variable as an rm target (could expand to anything catastrophic).
const RM_VAR_TARGET = /(?:^|\s)-[a-zA-Z]*\s+.*\$\{?[A-Za-z_]\w*\}?(?:\/|\s|$)|(?:^|\s)\$\{?[A-Za-z_]\w*\}?(?:\s|$)/

const FORCE_PUSH_RX = /\bgit\s+push\b[\s\S]*?(?:--force(?!-with-lease)\b|(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b)/i

const SQL_DROP_RX = /\b(DROP\s+(TABLE|INDEX|DATABASE|TRIGGER|VIEW)|TRUNCATE(\s+TABLE)?)\b/i
const SQL_DELETE_NO_WHERE_RX = /\bDELETE\s+FROM\s+["'`\[]?\w+["'`\]]?\s*(?:;|$|"|')/i
const SQL_UPDATE_NO_WHERE_RX = /\bUPDATE\s+["'`\[]?\w+["'`\]]?\s+SET\b(?![\s\S]*\bWHERE\b)/i

const DB_FILE_OVERWRITE_RX = /(?:(?:^|\s)>(?!>)|(?:^|\s)>\||\btee\b|\bdd\b[\s\S]*\bof=)[\s\S]*claudeclaw\.db\b/i
// cp/mv/install with the DB as the DESTINATION (last path arg) truncates it;
// `cp /dev/null claudeclaw.db` is the classic zero-out. A cp with the DB as the
// SOURCE (a backup, `cp claudeclaw.db bak`) is safe -> only match db-at-end.
const DB_CP_OVERWRITE_RX = /\b(?:cp|mv|install)\b[\s\S]*(?:\/dev\/null[\s\S]*)?\bclaudeclaw\.db\s*$/i

const FS_DESTROY_RX = /\b(mkfs\b|dd\b[\s\S]*\bof=\/dev\/|chmod\s+-R\s+0*777\s+\/(?:\s|$))/i

// Obfuscation / remote-code-exec routes: piping a downloaded/decoded blob into a
// shell, or eval-ing a command substitution. No legit use in this workflow.
const PIPE_TO_SHELL_RX = /\b(?:curl|wget|fetch|base64)\b[\s\S]*\|\s*(?:ba|z|k|c)?sh\b/i
const EVAL_SUBST_RX = /\beval\b[\s\S]*(?:\$\(|`)/i

// --- decision ---------------------------------------------------------------

export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (name !== 'Bash') return { deny: false }
  let cmd = String(toolInput?.command ?? '')
  cmd = stripHeredocBodies(cmd)
  // Strip -d/--data payloads on the WHOLE command BEFORE splitting. splitSegments
  // is not quote-aware, so a `|`/`;` INSIDE a data payload (e.g. a memory-save
  // whose JSON prose literally contains "curl|bash" or "git push --force") would
  // otherwise orphan a fragment that then false-matches. Stripping first blanks
  // the payload body (incl. any separators in it); a separator OUTSIDE the
  // payload still splits, so a real `... -d '' ; rm -rf /` is still caught.
  const safe = stripDataPayloads(cmd)
  // Pipe-to-shell and eval-substitution span a `|` that splitSegments would cut
  // apart, so match them on the whole (payload-stripped) command.
  if (PIPE_TO_SHELL_RX.test(safe)) return { deny: true, why: 'letoltott/dekodolt tartalom shellbe pipe-olasa (curl|bash / base64|sh)' }
  if (EVAL_SUBST_RX.test(safe)) return { deny: true, why: 'eval command-substitution (obfuszkalt vegrehajtas)' }
  for (const seg of splitSegments(safe)) {
    if (isRecursiveForceRm(seg) && (RM_CATASTROPHIC_TARGET.test(seg) || RM_VAR_TARGET.test(seg))) {
      return { deny: true, why: 'rm -rf katasztrofalis/valtozo celra' }
    }
    if (FORCE_PUSH_RX.test(seg)) return { deny: true, why: 'git push --force / -f' }
    if (SQL_DROP_RX.test(seg)) return { deny: true, why: 'destruktiv SQL (DROP/TRUNCATE)' }
    if (SQL_DELETE_NO_WHERE_RX.test(seg)) return { deny: true, why: 'DELETE FROM WHERE nelkul' }
    if (SQL_UPDATE_NO_WHERE_RX.test(seg)) return { deny: true, why: 'UPDATE SET WHERE nelkul' }
    if (DB_FILE_OVERWRITE_RX.test(seg) || DB_CP_OVERWRITE_RX.test(seg)) return { deny: true, why: 'a claudeclaw.db felulirasa/csonkitasa' }
    if (FS_DESTROY_RX.test(seg)) return { deny: true, why: 'fajlrendszer-romboló muvelet (mkfs/dd/chmod 777 /)' }
  }
  return { deny: false }
}

const GATE_MSG_BASE =
  'Biztonsagi guardrail (PreToolUse hard-gate): VISSZAFORDITHATATLAN-DESTRUKTIV ' +
  'muvelet blokkolva. Ok: '
const GATE_MSG_TAIL =
  '. Ha ez TENYLEG szandekos es jogos, NE ezen a hook-utvonalon kerdd ki magad: szolj ' +
  'EliteAI-nak (vagy Laci-nak) inter-agent uzenetben/Telegramon, ird le pontosan mit es miert, ' +
  'es az O explicit jovahagyasaval hajtsd vegre kezzel (vagy o vegzi). A destruktiv adatmuveletet ' +
  'amugy is a dashboard API-n (kanban/memoria/messages) vegezd, ne nyers SQL-lel/rm-mel. ' +
  '(Guardrail: scripts/hooks/destructive-op-guard.mjs)'

export function allow() { process.exit(0) }
export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly(importMetaUrl) {
  try {
    const self = realpathSync(fileURLToPath(importMetaUrl))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch { return false }
}

// Shared CLI entrypoint, callable both from this file's own direct invocation
// and from a thin per-agent wrapper (e.g. eliteai-guard.mjs) that re-exports
// it. `importMetaUrl` must be the CALLER's import.meta.url so the "am I the
// directly-invoked script" check resolves against the right entry file.
export function runCli(importMetaUrl) {
  if (!isInvokedDirectly(importMetaUrl)) return
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    logLine('FAILOPEN', 'malformed/empty payload -> allow')
    allow() // never break the agent on a payload parse error (can't determine intent either way)
  }
  let d
  try {
    d = gateDecision(payload?.tool_name, payload?.tool_input)
  } catch (err) {
    // FAIL CLOSED: an unexpected error INSIDE the decision logic (not a payload
    // parse failure -- we know the intent, the guard itself is broken) must not
    // silently let a Bash command through. Block until fixed (per GPT-crosscheck
    // 2026-07-10, guard-unification review).
    logLine('GUARD-ERROR', String(err))
    deny('Biztonsagi guardrail HIBA: a destruktiv-muvelet-ellenorzo logika hibara futott, ezert ez a Bash-parancs blokkolva van amig ez nincs javitva. Reszletek: store/self-audit/guard.log. Ird meg EliteAI-nak/Lacinak.')
  }
  if (d.deny) {
    const cmd = String(payload?.tool_input?.command ?? '')
    logLine('DENY', `${d.why} :: ${cmd}`)
    deny(GATE_MSG_BASE + d.why + GATE_MSG_TAIL)
  }
  allow()
}

runCli(import.meta.url)
