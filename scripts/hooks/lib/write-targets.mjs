// Shared Bash write-TARGET extraction for the fleet's write-gating guards
// (skill-write-guard.mjs, nano-worktree-guard.mjs). SINGLE maintenance point so
// a future guard cannot silently re-inherit the "no-space redirect" extraction
// gap (Yoda + GPT ideation, kanban 48957aec). Both guards run from the central
// scripts/hooks/ path (NOT copied per-agent), so a relative import resolves.
//
// THE GAP THIS CLOSES: the old per-guard token regex `(?:^|\s)(\/[^\s'"]+)`
// only matched an absolute path preceded by START or WHITESPACE. A "no-space"
// redirect (`echo payload>/abs/skill/path`, no space around `>`) leaves the
// path preceded by `>`, so the old regex never extracted it: write-intent
// matched (the `>`) but the target was invisible -> the guard could not gate it
// -> fail-open bypass (in skill-write-guard, a DEFAULT-ALLOW K1 injection-
// defense guard, that is a real skill-write-ban bypass; in nano-worktree-guard,
// a sandbox-escape route). yoda-write-guard (default-DENY) and constitution-
// guard (whole-string substring test, no extraction step) are immune and are
// intentionally NOT changed.

// Device sinks are never a real write target the guards must gate. Belt to the
// per-guard stripDeviceRedirects() suspenders: even a GLUED device redirect
// (`cat a>/dev/null`) that the anchored strip does not blank must not surface
// `/dev/null` as a write target here.
const DEVICE_PATH_RX = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/

// Extract the absolute-path write TARGETS from a single (already device-stripped,
// heredoc/payload-stripped) command segment. A path is a target if it is
// preceded by:
//   - START or WHITESPACE  (`cp a /abs`, `> /abs`, `tee /abs`)      -- old behavior
//   - a REDIRECT `>`/`>>`  (`echo x>/abs`, `x>>/abs`, `2>/abs`)     -- NEW: closes gap
// The redirect branch uses lookbehind `(?<![-=])` so an operator/arrow that
// merely contains a `>` (`->`, `=>`) does NOT get treated as a redirect and
// mis-grab a following path -- consistent with WRITE_INTENT_RX's own exclusion.
// Quoted paths (`open('/x')`) stay unextracted: `[^\s'"]` stops at the quote and
// the quote is not a valid preceding delimiter. Returns clean path strings (no
// leading delimiter), matching what the old `.match(...).trim()` yielded.
const TARGET_RX = /(?:^|\s|(?<![-=])>>?)(\/[^\s'"]+)/g

export function extractAbsoluteTargets(seg) {
  const out = []
  for (const m of String(seg ?? '').matchAll(TARGET_RX)) {
    const p = m[1]
    if (DEVICE_PATH_RX.test(p)) continue // device sink, not a gateable write target
    out.push(p)
  }
  return out
}
