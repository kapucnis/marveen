// Shared Bash write-TARGET extraction for the fleet's write-gating guards
// (skill-write-guard.mjs, nano-worktree-guard.mjs). SINGLE maintenance point so
// a future guard cannot silently re-inherit a redirect-tokenization gap. Both
// guards run from the central scripts/hooks/ path (NOT copied per-agent), so a
// relative import resolves.
//
// WHY A STRUCTURAL TOKENIZER, NOT A REGEX (kanban c54aa473, Yoda triage): two
// bypasses in two hours came from the SAME root cause -- a monolithic regex
// character class that did not know the shell redirect-operator TOKEN BOUNDARY:
//   #1 (48957aec): a lone no-space redirect (`echo x>/skill/path`) was invisible
//      because the path was preceded by `>`, not whitespace -> fail-open.
//   #2 (c54aa473): a REAL absolute-path argument glued to a no-space redirect
//      (`cat /tmp/x>/home/.../evil.ts`) -- the greedy `[^\s'"]+` swallowed the
//      `>` and merged BOTH paths into one bogus token `/tmp/x>/home/.../evil.ts`
//      that text-starts with an allowed prefix (`/tmp`) -> the real main-tree
//      write target hid -> fail-open. (skill variant hid a /skill/ target the
//      same way.)
// Patching the character class again would just leave a 4th variant open
// (`>>`, `2>`, `<>`, `>|`, quotes around the redirect, multiple redirects).
//
// APPROACH (3 structural steps):
//   1. maskQuotes(): quote/escape-aware pass that blanks quoted spans. This is
//      what makes a quoted `>` (e.g. python `print('-> x')`, `grep ">" f`) NOT a
//      redirect and a quoted path not a target -- and it subsumes the old
//      arrow/operator exclusion for free (the morning `->` FP was a QUOTED arrow).
//   2. split on the redirect-operator family (any run of `<`/`>` incl. `>>`,
//      `2>`, `&>`, `<>`, `>|`, `>&`): the operator is an EXPLICIT boundary, so a
//      command-arg/read-source on the LEFT and a redirect target on the RIGHT can
//      never fuse into one token.
//   3. extract absolute-path targets from EACH resulting piece; skip /dev/*
//      device sinks.
//
// FAIL-CLOSED ON UNCERTAINTY (Yoda requirement): returns { targets, uncertain }.
// uncertain === true when the segment cannot be cleanly tokenized -- unbalanced
// quotes, or a WRITE redirect (`>`/`>>`) with no operand after it (target
// invisible). The two vulnerable guards are DEFAULT-ALLOW, so they cannot be
// fully default-deny, but they treat `uncertain` as DENY -- the same "do not
// allow-by-default when the target is unknowable" principle that already makes
// yoda-write-guard/constitution-guard immune. NOTE (documented residual, NOT
// closed here to avoid mass FPs): a redirect target that IS present but is
// RELATIVE or $VAR-interpolated is not `uncertain` (that would deny every
// `echo x > out.txt`); the guards' existing "absolute-tokens only" limitation
// stands for those, exactly as before.

const DEVICE_PATH_RX = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/

// Blank quoted spans (single, double, ANSI-C-ish) and unquoted backslash-escapes,
// length-preserving. A char inside quotes becomes a space so it can be neither a
// redirect operator nor part of a path. Unbalanced quote -> uncertain.
function maskQuotes(s) {
  let out = ''
  let quote = null
  let uncertain = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < s.length) { out += '  '; i++; continue }
      if (c === quote) { quote = null; out += ' '; continue }
      out += ' '
      continue
    }
    if (c === "'" || c === '"') { quote = c; out += ' '; continue }
    if (c === '\\') {
      if (i + 1 < s.length) { out += '  '; i++ } else { out += ' '; uncertain = true }
      continue
    }
    out += c
  }
  if (quote) uncertain = true
  return { masked: out, uncertain }
}

// A run of redirect-operator characters: `<`/`>` (covers >, >>, <, <<, <>, >&,
// <&) optionally followed by a single `|` (>| clobber). Digits/`&` that PREFIX
// an fd redirect (`2>`, `&>`) are left on the previous piece harmlessly -- they
// are not paths, and the real target after the operator is a separate piece.
const OP_RX = /[<>]+\|?/g

export function extractAbsoluteTargets(seg) {
  const { masked, uncertain: quoteUncertain } = maskQuotes(String(seg ?? ''))
  let uncertain = quoteUncertain

  const ops = masked.match(OP_RX) || []
  const pieces = masked.split(OP_RX)

  // A WRITE redirect (`>`/`>>`, incl. fd/`&`-prefixed -- any op containing `>`
  // except a pure fd-dup `>&`) must have a non-empty operand piece after it; if
  // not, the write target is invisible -> uncertain (fail-closed).
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    const isWrite = op.includes('>') && op !== '>&'
    if (isWrite) {
      const after = (pieces[k + 1] || '').trim()
      if (after === '') uncertain = true
    }
  }

  const targets = []
  for (const piece of pieces) {
    // piece has no quotes (masked) and no redirect operators (split out), so a
    // greedy non-space run cannot span an operator or a quote boundary.
    for (const m of piece.matchAll(/(?:^|\s)(\/\S+)/g)) {
      const p = m[1]
      if (!DEVICE_PATH_RX.test(p)) targets.push(p)
    }
  }
  return { targets, uncertain }
}
