#!/usr/bin/env node
// PreToolUse hard-gate: blocks direct Write/Edit (native tool or Bash escape)
// of the agent-constitution files -- project CLAUDE.md, project SOUL.md,
// project .claude/rules/**, and the global ~/.claude/CLAUDE.md +
// ~/.claude/settings.json.
//
// CANONICAL SOURCE (2026-07-11): this file is the tracked template that
// src/web/agent-scaffold.ts's injectConstitutionGuard() copies into every
// sub-agent's own agents/<name>/.claude/hooks/ dir on every settings
// regeneration (agents/ itself is gitignored -- runtime-generated instances
// -- so the canonical copy must live here, under the tracked scripts/hooks/,
// or a fresh install/clone would silently get NO constitution guard at all).
// Edit behavior HERE; the scaffold step re-propagates it to every agent.
//
// SOUL.md ADDED (2026-07-11, Yoda fleet-behavior audit + EliteAI follow-up):
// SOUL.md (personality/tone) is as much a governance file as CLAUDE.md -- an
// agent whose SOUL.md silently drifts from its CLAUDE.md (found live in
// muszaki's and besanyi's copies: stale hub-and-spoke text contradicting the
// already-updated peer-communication rules in CLAUDE.md) is exactly the kind
// of self-inconsistency this hook exists to prevent from being self-inflicted.
//
// Why a hook and not a permissions ask/deny-list: this agent runs on the
// "default" (permissive) security profile, which launches Claude Code with
// --dangerously-skip-permissions -- that flag BYPASSES the settings.json
// allow/deny/ask engine entirely. A PreToolUse hook runs regardless of
// permission mode, so it is the only reliable mode-independent gate (same
// reasoning as scripts/email-send-gate.mjs and scripts/self-pace-gate.mjs in
// the marveen root, which this file deliberately mirrors in shape).
//
// Why DENY and not ASK: there is no synchronous human-in-the-loop channel in
// this headless/tmux setup (no interactive terminal reaching the operator in
// real time). The practical equivalent of "ask" here is: hard-block the direct
// write, and redirect the agent to propose the change via inter-agent message
// to EliteAI (who relays to Laci) instead of writing the constitution directly.
//
// Scope: deliberately narrow. Does NOT touch ~/.claude/skills/** -- self-skill
// generation is an explicitly wanted autonomous capability (see CLAUDE.md
// "Ontanulas es Skill rendszer"), and must stay unblocked.
//
// SELF-PROTECTION (approved by Laci 2026-07-09, after explicit lock-out risk
// review): this agent's OWN .claude/settings.json (where this very hook is
// wired) is ALSO protected now. Risk analysis behind this: the hook only
// intercepts THIS agent's OWN Claude Code session tool calls -- it is not an
// OS-level file lock. EliteAI's own session runs under a different hook
// scope and can edit this file directly; Laci can always edit it outside any
// Claude Code session (SSH/editor). So this can never produce a system-wide,
// irreversible lock-out -- it only removes THIS agent's own ability to
// self-modify its own permission config via its own tool calls, which is the
// intended protective posture (the supervised process should not rewrite its
// own supervision config from inside itself).
//
// RECOVERY ROUTE if this agent's settings.json ever needs a legitimate update
// (new hook, bugfix, etc.) and this gate is in the way: ask EliteAI to make
// the edit (different hook scope, unaffected by this gate), or have Laci
// edit it directly outside of this agent's Claude Code session. This agent's
// own session cannot do it once this rule is in effect -- by design.
//
// Threat this addresses: an installed skill's automated promote/extract flow
// (e.g. a self-improving-agent-style /si:promote) auto-writing a project or
// global CLAUDE.md / rules file without human review.

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HOME = homedir()

// Derived, not hardcoded: "this agent's own settings.json" is always the
// sibling of this hook's own directory (agents/<name>/.claude/hooks/<this
// file> -> ../settings.json = agents/<name>/.claude/settings.json). Path-
// derived rather than a literal agent-name string so the SAME file, copied
// verbatim into every agent's hooks/ dir by injectConstitutionGuard(),
// automatically self-protects THAT agent's own settings.json too, with no
// per-copy edit.
const OWN_SETTINGS_PATH = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'settings.json'))

// Path-based match: true if this file path is a protected constitution file.
export function isProtectedPath(filePath) {
  const p = String(filePath ?? '')
  if (!p) return false
  if (/(^|\/)CLAUDE\.md$/.test(p)) return true
  if (/(^|\/)SOUL\.md$/.test(p)) return true
  if (/\/\.claude\/rules\//.test(p)) return true
  if (p === `${HOME}/.claude/CLAUDE.md`) return true
  if (p === `${HOME}/.claude/settings.json`) return true
  if (resolve(p) === OWN_SETTINGS_PATH) return true
  return false
}

// Bash write-intent tokens (redirect / in-place edit / tee / copy-move onto a
// protected path). Not quote-aware beyond stripLiteralPayloads below (same
// accepted limitation as the sibling self-pace-gate.mjs) -- defense-in-depth
// second layer, not the primary guard (the Write/Edit path-check above is).
// `(?!&)` after the redirect excludes fd-duplication forms (`2>&1`, `1>&2`),
// which duplicate a file descriptor and never write to a path -- a bare `cat
// file 2>&1` is a pure READ, not a write-intent, and must not match.
// Redirect token excludes operator/arrow forms that merely contain a `>` in
// code/prose (`->`, `=>`, `>=`, `2>&1`) via lookbehind `(?<![-=])` + lookahead
// `(?![=&])`. Without this a read-only one-liner like
//   python3 -c "... print('-> model:', d.get('model'))"   # over settings.json
// false-denied: the `->` matched write-intent and `.claude/settings.json`
// matched the protected-token below. A bare `>`/`>>` to a real path still
// matches, so `> CLAUDE.md` / `2>CLAUDE.md` (truncation) stay BLOCKED -- no
// bypass opened. (FP-fix #2, EliteAI msg 501 + Yoda repro.)
const WRITE_INTENT_RX = /((?<![-=])>>?(?![=&])|\btee\b|\bsed\b[\s\S]*\s-i|\bcp\b|\bmv\b)/i
const PROTECTED_TOKEN_RX = /CLAUDE\.md|SOUL\.md|\.claude\/rules\/|\.claude\/settings\.json/i

// Blank redirects to a DEVICE SINK (`2>/dev/null`, `>/dev/null`, `&>/dev/null`,
// …) BEFORE the write-intent test. A read that suppresses stderr while merely
// NAMING a protected path as an argument (e.g.
//   python3 -c "json.load(open('…/.claude/settings.json'))" 2>/dev/null )
// must not co-trigger write-intent + protected-token. A redirect to a REAL file
// (`2>CLAUDE.md`) is NOT a device sink -> left intact -> still blocked, so no
// governance write route is opened. (FP-fix #1, EliteAI msg 501.)
export function stripDeviceRedirects(command) {
  return String(command ?? '')
    // redirect to a device sink: `2>/dev/null`, `>/dev/null`, `&>/dev/null`, ...
    .replace(/(?:^|\s)(?:&|\d)*>>?\s*\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)\b/gi, ' ')
    // fd-duplication -- never a file write: `2>&1`, `>&2`, `1>&2`, `2>&-`.
    .replace(/(?:^|\s)\d*>&[\d-]+/g, ' ')
}

// Blank out literal payload bodies before pattern-matching, so PROSE that
// merely mentions ">> CLAUDE.md" or "sed -i ... CLAUDE.md" inside a quoted
// curl -d/--data argument or a heredoc body (e.g. this agent reporting its own
// test results via `curl ... -d @- <<'EOF' ... EOF`) is never mistaken for an
// actual shell write. Mirrors scripts/self-pace-gate.mjs's stripDataPayloads,
// extended to also strip heredoc bodies (this agent's own common pattern for
// posting inter-agent JSON messages).
export function stripLiteralPayloads(command) {
  let out = String(command ?? '')
  // Heredoc bodies: <<'TAG' / <<TAG / <<-'TAG' ... up to a line that is
  // exactly TAG (optionally indented, matching <<- semantics). Non-greedy so
  // multiple heredocs in one command are each closed at their own terminator.
  // The tag can be followed by MORE command text on the same line (e.g.
  // `<<'EOF' >> CLAUDE.md`) -- that trailing part is a real shell operation,
  // not heredoc body, so it is kept; only the body (from the next newline to
  // the terminator) is blanked.
  out = out.replace(
    /(<<-?\s*(['"]?)(\w+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3(?=\n|$)/g,
    '$1$4 <<HEREDOC',
  )
  // Quoted -d/--data payloads (single, double, ANSI-C) -- same literal-only
  // rule as self-pace-gate.mjs: a payload that can command-substitute
  // ($(...)/backtick) is left intact rather than risk hiding a real one.
  out = out.replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
  return out
}

export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (isProtectedPath(fp)) return { deny: true }
  }
  if (name === 'Bash') {
    const cmd = stripDeviceRedirects(stripLiteralPayloads(String(toolInput?.command ?? '')))
    if (WRITE_INTENT_RX.test(cmd) && PROTECTED_TOKEN_RX.test(cmd)) return { deny: true }
  }
  return { deny: false }
}

const GATE_MSG =
  'Agent-alkotmany direkt irasa TILTOTT (governance hard-gate). CLAUDE.md / SOUL.md / .claude/rules/** / ' +
  '~/.claude/CLAUDE.md / ~/.claude/settings.json / a sajat agent-settings.json csak johavagyassal ' +
  'modosithato. Kuldd a javasolt valtoztatast (FAJL + TELJES UJ TARTALOM vagy diff) EliteAI-nek ' +
  'inter-agent uzenetben (/api/messages), o relayeli Lacinak johavagyasra. Ne irj ezekbe a fajlokba ' +
  'direktben. Ha a SAJAT settings.json-t kell frissiteni (uj hook, bugfix): ezt a session sajat ' +
  'tool-hivasaival mar nem teheted meg -- kerd EliteAI-t (mas hook-szkopeban fut) vagy Laci direkt ' +
  '(Claude Code-on kivuli) szerkeszteset.'

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

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) deny(GATE_MSG)
  allow()
}
