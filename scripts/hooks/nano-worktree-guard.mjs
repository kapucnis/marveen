#!/usr/bin/env node
// PreToolUse hard-gate: enforces nano's platform-code sandbox boundary.
//
// Context (2026-07-10, Flotta-szabaly-4 finomitas): the old rule was an
// ABSOLUTE ban on nano touching eliteai's own code (the marveen platform
// src/). Yoda's fleet-operations review found this left every platform-level
// fix piling up on eliteai (18 planned kanban cards) while nano -- the
// fleet's strongest coder, on Opus -- sat idle (0 planned). Laci approved a
// refinement: nano may PREPARE platform changes in an ISOLATED git worktree
// (/home/kapucnis/marveen-nano-worktree, branch nano/sandbox), but the
// running system stays eliteai-only. Non-negotiable boundaries (Yoda's
// framing, GPT-crosscheck 2026-07-10):
//   - nano NEVER touches the live dist/ or the main marveen working tree.
//   - nano NEVER pushes, merges, rebases, or force-touches shared branches.
//   - nano NEVER restarts/stops/starts any systemd service.
//   - nano NEVER symlinks out of its sandbox to bypass the path checks.
// eliteai reviews the FULL diff, merges into the main tree, and runs the
// normal marveen-deploy flow (build + restart) itself -- nothing here changes
// that; this hook only bounds what nano itself can directly execute.
//
// WORKTREE PROVISIONING NOTE (2026-07-11, root-caused after nano silently
// stalled mid-task): store/ is gitignored, so a git worktree checkout does
// NOT inherit store/.dashboard-token from the main tree -- it starts empty.
// Nano needs that token to authenticate its own inter-agent-message/kanban
// API calls when reporting a finished task, and (correctly, per this hook's
// intent) did NOT reach outside the sandbox with an absolute path to fetch
// it from the main tree -- it just silently sat blocked instead of escalating
// clearly. Fix: `cp /home/kapucnis/marveen/store/.dashboard-token
// /home/kapucnis/marveen-nano-worktree/store/.dashboard-token` (chmod 600) --
// a ONE-TIME step, done 2026-07-11. If the worktree is ever deleted/recreated,
// redo this step BEFORE assigning nano its next platform-code task, or it will
// stall again the same way. This file's own logic never blocked the read (a
// plain cat/curl of that path is not a write-intent token) -- the file was
// simply missing.
//
// OPERATIONAL INVARIANT (GPT-crosscheck 2026-07-10): the worktree MUST stay a
// SIBLING directory of the main repo (/home/kapucnis/marveen-nano-worktree,
// not nested under /home/kapucnis/marveen/...). The Bash write-intent scan
// only resolves ABSOLUTE-path tokens (documented limitation above) -- a
// worktree nested inside the main tree would let a relative-path write from
// inside the sandbox land in the main tree via `../`, which this hook cannot
// see. Never move/recreate the worktree under the main repo.
//
// SCOPE: this hook is nano-specific (wired only into agents/nano/.claude/
// settings.json), NOT the shared destructive-op-guard.mjs -- other agents
// (muszaki/besanyi/yoda) have no legitimate reason for git/systemctl access
// at all, adding nano's rules to the shared module would just be unused
// complexity for them. Composes with nano's existing hooks (constitution-
// guard, runner-script-guard, email-send-gate, self-pace-gate, and the
// shared destructive-op-guard) -- any ONE hook denying blocks the tool call.
//
// Decisions are logged to store/self-audit/guard.log (agent tag: nano).

import { readFileSync, appendFileSync, realpathSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { extractAbsoluteTargets } from './lib/write-targets.mjs'

const MARVEEN_ROOT = '/home/kapucnis/marveen'
const NANO_WORKTREE = '/home/kapucnis/marveen-nano-worktree'
const NANO_AGENT_DIR = '/home/kapucnis/marveen/agents/nano'
// Pre-existing, legitimate nano write location OUTSIDE the worktree/agent-dir
// (the daily fleet-dev-coordination task's DEV-PLAN.md/archive/sent-log.md,
// running since before this guard existed). 2026-07-11: nano's own fleet-dev
// scheduled task got blocked by this guard's first cut -- it only allow-listed
// the worktree/agent-dir/tmp and had no notion of nano's OTHER, older
// responsibilities. Found by nano itself (self-reported, did not patch around
// the guard), fixed same morning. Add further pre-existing nano store/ paths
// here if more turn up, rather than loosening the general write-intent scan.
const NANO_FLEET_DEV_DIR = '/home/kapucnis/marveen/store/fleet-dev'
const NANO_SANDBOX_BRANCH_PREFIX = 'nano/'
const LOG_PATH = MARVEEN_ROOT + '/store/self-audit/guard.log'

function logLine(kind, detail) {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()}\tnano\t${kind}\t${(detail || '').slice(0, 300)}\n`) } catch { /* ignore */ }
}

// --- path resolution (symlink-aware) ----------------------------------------

// Resolve a path to its real (symlink-followed) absolute location. Only ever
// called on paths already known to be absolute (see callers) -- this hook does
// NOT attempt to resolve bare relative Bash tokens (`cp a b`), because the
// hook subprocess's own cwd is not reliably nano's shell cwd (a documented,
// deliberate limitation: the Write/Edit/NotebookEdit path is the ROBUST check,
// since Claude Code itself resolves file_path to an absolute path before the
// hook runs; the Bash-command scan below is a best-effort secondary layer,
// same "operator-trust, not a sandbox" posture as destructive-op-guard.mjs).
function resolveReal(p) {
  const abs = resolve(String(p ?? ''))
  try {
    return realpathSync(abs)
  } catch {
    // Target doesn't exist yet (about to be created) -- resolve the nearest
    // existing ancestor directory instead, so a symlinked parent dir is caught.
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

// Is this real (symlink-resolved) path inside one of nano's allowed roots?
export function isAllowedPath(realPath) {
  return (
    realPath === NANO_WORKTREE || realPath.startsWith(NANO_WORKTREE + '/') ||
    realPath === NANO_AGENT_DIR || realPath.startsWith(NANO_AGENT_DIR + '/') ||
    realPath === NANO_FLEET_DEV_DIR || realPath.startsWith(NANO_FLEET_DEV_DIR + '/') ||
    realPath.startsWith('/tmp/')
  )
}

// --- Bash command helpers (mirrors destructive-op-guard.mjs shape) ---------

export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    .map((s) => s.trim())
}

// Blank redirects to a DEVICE SINK (`2>/dev/null`, `>/dev/null`, `&>/dev/null`,
// …) and fd-duplications (`2>&1`, `>&2`) BEFORE the write-intent scan below.
// These are the shell's discard/mux idioms that pervade nano's read-only probing
// of the MAIN tree (`cat /home/kapucnis/marveen/x 2>/dev/null`) -- the redirect
// writes nothing to a real path, so it must NOT register as an out-of-sandbox
// write-intent. A redirect to a REAL file (`> /home/…/src/x`, `2>/home/…/y`) is
// left INTACT -> still caught -> NO sandbox-escape route opened. This is the
// SAME, twice-proven sanitizer shipped in yoda/skill/constitution-guard (msg
// 501, GPT GO msg 514). Applied to the whole command BEFORE splitSegments so
// the `&` in `2>&1` cannot orphan a bare `2>` fragment; it removes only device/
// dup redirect substrings, so the systemctl/git branches are behaviorally
// unaffected (they match command names, never redirects).
export function stripDeviceRedirects(command) {
  return String(command ?? '')
    .replace(/(?:^|\s)(?:&|\d)*>>?\s*\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)\b/gi, ' ')
    .replace(/(?:^|\s)\d*>&[\d-]+/g, ' ')
}

const SYSTEMCTL_RX = /\bsystemctl\b/i
// journalctl is read-only and useful for nano to check service logs while
// debugging -- explicitly NOT blocked. launchctl (macOS) is blocked alongside
// systemctl for the same reason (service lifecycle control).
const LAUNCHCTL_RX = /\blaunchctl\b/i
const SYMLINK_RX = /\bln\s+(?:-\S*\s+)*-\S*s\S*/i // `ln -s` / `ln -fs` / any -*s* combo
const GIT_PUSH_RX = /\bgit\s+push\b/i
const GIT_MERGE_RX = /\bgit\s+(?:merge|rebase|cherry-pick)\b/i
const GIT_RESET_HARD_RX = /\bgit\s+reset\b[\s\S]*--hard\b/i
// `git worktree` (any subcommand, incl. `add`) is blocked entirely: nano has
// no legitimate need to manage worktrees, and `worktree add` on a not-yet-
// checked-out branch (e.g. develop) would otherwise be a way around the
// checkout guard below (a second worktree pointed at a shared branch).
// `branch -D`/`-d <flags> main|develop` (any flag tokens before the name).
const GIT_REF_MUTATION_RX = /\bgit\s+(?:update-ref|symbolic-ref|worktree\b|branch\s+(?:-\S+\s+)*(?:main|develop)\b)/i
const GIT_REMOTE_WRITE_RX = /\bgit\s+remote\s+(?:add|set-url|remove|rm)\b/i

// `git checkout <ref>` / `git switch <ref>` where ref is NOT a nano/* branch.
// Token-walked (not a single regex) so `--` (end-of-options, "everything after
// is a pathspec") and flag tokens are handled correctly -- a single regex
// mis-consumed `--` itself as a flag in testing (2026-07-10).
function gitCheckoutTargetsProtectedRef(seg) {
  const tokens = seg.trim().split(/\s+/)
  const cmdIdx = tokens.findIndex((t) => t === 'checkout' || t === 'switch')
  if (cmdIdx === -1 || tokens[cmdIdx - 1] !== 'git') return false
  for (let i = cmdIdx + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') return false // everything after is a pathspec, not a ref
    if (t === '.') return false // checkout of cwd (restore) -- not a branch switch
    if (t === '-b' || t === '-c' || t === '-B') {
      // Next token is the NEW branch name being created -- must be nano/*.
      const branchName = tokens[i + 1]
      if (branchName && branchName.startsWith(NANO_SANDBOX_BRANCH_PREFIX)) return false
      return true // creating a non-nano/-prefixed branch is suspect too
    }
    if (t.startsWith('-')) continue // skip other flags
    // First non-flag token = the ref/pathspec being checked out.
    if (t.startsWith(NANO_SANDBOX_BRANCH_PREFIX)) return false
    if (t.startsWith('./') || t.startsWith('/')) return false // explicit path, not a ref
    return true
  }
  return false // no target token at all -- nothing to switch to
}

// --- decision ----------------------------------------------------------------

// Bash write-intent (redirect / in-place edit / tee / cp / mv / install). Used
// both per-segment and (LAYER 2) on the raw command.
export const WRITE_INTENT_RX = /((?<![-=])>>?(?![=&])|\btee\b|\bsed\b[\s\S]*\s-i|\bcp\b|\bmv\b|\binstall\b)/i

// LAYER 2 protected roots -- NARROW, definitely-protected prefixes only (GPT:
// not `/home/` or `/agents/` broadly, to limit prose-mention false-positives).
// These are main-tree/global roots with NO nano-allowed sub-path, so a raw
// literal mention in a write-intent command is a protected write regardless of
// tokenization (catches quote-concatenation + future parser misses).
export const NANO_PROTECTED_RAW_RX = /\/home\/kapucnis\/marveen\/(?:src|scripts|dist|\.git|node_modules|\.claude)\/|\/home\/kapucnis\/\.claude\/(?:skills\/|scheduled-tasks\/|settings\.json|CLAUDE\.md)/

export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')

  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (!fp) return { deny: false }
    // Claude Code always resolves file_path to an absolute path before the
    // tool (and this hook) sees it, so no cwd is needed here.
    const real = resolveReal(fp)
    if (!isAllowedPath(real)) {
      return { deny: true, why: `iras a sandbox-on kivulre (${real}) -- nano csak a sajat worktree-jeben (${NANO_WORKTREE}) vagy agent-konyvtaraban irhat` }
    }
    return { deny: false }
  }

  if (name !== 'Bash') return { deny: false }
  const raw = String(toolInput?.command ?? '')
  // LAYER 2 (raw-substring backstop, tokenization-INDEPENDENT, c54aa473 pivot):
  // a write-intent command whose RAW text literally contains a definitely-
  // protected root is denied regardless of how the tokenizer splits it. Runs on
  // the TRULY raw string (before any device-strip/split), so quote-concatenation
  // and future parser misses cannot hide the protected prefix. (Prose-mention FP
  // class is documented in the T3 list.)
  if (WRITE_INTENT_RX.test(raw) && NANO_PROTECTED_RAW_RX.test(raw)) {
    return { deny: true, why: 'vedett fo-fa/globalis gyoker a NYERS parancs-stringben (layer-2 substring backstop) -- fail-closed' }
  }
  // Device/dup redirects blanked first (FP-fix, msg 512 scope-lock): they are
  // not writes, and their `&` would otherwise be split by splitSegments.
  const cmd = stripDeviceRedirects(raw)

  for (const seg of splitSegments(cmd)) {
    if (SYSTEMCTL_RX.test(seg) || LAUNCHCTL_RX.test(seg)) {
      return { deny: true, why: 'systemctl/launchctl -- szolgaltatas-eletciklus tiltva nano-nak' }
    }
    if (SYMLINK_RX.test(seg)) {
      return { deny: true, why: 'symlink letrehozasa tiltva (sandbox-kikerules elleni vedelem)' }
    }
    if (GIT_PUSH_RX.test(seg)) {
      return { deny: true, why: 'git push tiltva nano-nak -- eliteai push-ol/mergel a review utan' }
    }
    if (GIT_MERGE_RX.test(seg)) {
      return { deny: true, why: 'git merge/rebase/cherry-pick tiltva nano-nak' }
    }
    if (GIT_RESET_HARD_RX.test(seg)) {
      return { deny: true, why: 'git reset --hard tiltva nano-nak' }
    }
    if (GIT_REF_MUTATION_RX.test(seg)) {
      return { deny: true, why: 'git ref-mutacio (update-ref/symbolic-ref/worktree remove/vedett branch torlese) tiltva nano-nak' }
    }
    if (GIT_REMOTE_WRITE_RX.test(seg)) {
      return { deny: true, why: 'git remote iras (add/set-url/remove) tiltva nano-nak' }
    }
    if (gitCheckoutTargetsProtectedRef(seg)) {
      return { deny: true, why: 'git checkout/switch csak nano/*-branch-re engedelyezett nano-nak' }
    }
    // Write-intent Bash routes (redirect/tee/cp/mv/sed -i) outside the sandbox.
    // Mirrors destructive-op-guard.mjs's WRITE_INTENT_RX shape. ONLY checks
    // ABSOLUTE-path tokens (see resolveReal's doc comment for why bare/relative
    // tokens are not resolved here) -- an absolute path outside the sandbox is
    // caught; a relative one is not, by documented design, not an oversight.
    if (WRITE_INTENT_RX.test(seg)) {
      // Shared extractor, redirect-boundary-aware, { targets, uncertain }.
      // LAYER 1 opt-in ({writeIntent:true}): fail-closed when a write-intent
      // segment yields NO absolute target -- a parser miss becomes over-block,
      // never a bypass. (Over-blocks relative/$VAR writes -> T3 list.)
      const { targets, uncertain } = extractAbsoluteTargets(seg, { writeIntent: true })
      if (uncertain) {
        return { deny: true, why: 'bizonytalan write-target (redirect-hatar nem parse-olhato, vagy write-intent abszolut cel nelkul) -- fail-closed a sandbox-hataron' }
      }
      for (const t of targets) {
        const p = t.trim()
        const real = resolveReal(p)
        if (!isAllowedPath(real)) {
          return { deny: true, why: `fajl-iras a sandbox-on kivulre (${real})` }
        }
      }
    }
  }
  return { deny: false }
}

const GATE_MSG_TAIL =
  '. Nano platform-kod-elokeszitesi sandbox-hatar (2026-07-10, Flotta-szabaly-4 finomitas). ' +
  'Dolgozz a sajat worktree-dben (/home/kapucnis/marveen-nano-worktree, branch nano/sandbox), ' +
  'jelentsd EliteAI-nak ha kesz -- O reviewol, mergel, deployol. ' +
  '(Guardrail: scripts/hooks/nano-worktree-guard.mjs)'

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
  } catch { return false }
}

if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    logLine('FAILOPEN', 'malformed/empty payload -> allow')
    allow()
  }
  let d
  try {
    d = gateDecision(payload?.tool_name, payload?.tool_input)
  } catch (err) {
    logLine('GUARD-ERROR', String(err))
    deny('Nano-sandbox guardrail HIBA: a logika hibara futott, ezert ez a muvelet blokkolva van amig ez nincs javitva. Szolj EliteAI-nak.')
  }
  if (d.deny) {
    logLine('DENY', `${d.why} :: ${String(payload?.tool_input?.command ?? payload?.tool_input?.file_path ?? '')}`)
    deny(d.why + GATE_MSG_TAIL)
  }
  allow()
}
