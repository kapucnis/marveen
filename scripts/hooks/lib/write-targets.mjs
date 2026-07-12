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
// APPROACH: a real char-by-char shell-word tokenizer (tokenizeWords) that
//   - reconstructs each word's UNQUOTED VALUE, so adjacent quoted+unquoted spans
//     that bash CONCATENATES into one word collapse correctly (`>"/a/"b` -> `/a/b`).
//     A first attempt that MASKED (blanked) quoted spans lost the leading `/a/`
//     and let `>"/main/src/"evil.ts` slip through (c54aa473 follow-up, found by
//     EliteAI's adversarial pass) -- reconstruction, not masking, is required.
//   - treats a quoted `>` (python `print('-> x')`, `grep ">" f`) as ordinary word
//     content, NOT a redirect -- this subsumes the old arrow/operator exclusion.
//   - splits at unquoted redirect operators (`>`/`<` runs incl. `>>`,`2>`,`<>`,
//     `>|`,`n>&m`), which are EXPLICIT boundaries, so a left arg/read-source and a
//     right redirect target can never fuse into one token.
// Then a word is a target iff its value is an absolute path (skip /dev/* sinks).
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

// Tokenize a command segment into shell-ish WORDS, reconstructing each word's
// UNQUOTED VALUE, and splitting at unquoted whitespace and unquoted redirect
// operators. This is a real char-by-char tokenizer -- NOT a mask/regex -- because
// bash CONCATENATES adjacent quoted and unquoted spans into ONE word:
//   >"/home/x/"evil.ts   is the single word  /home/x/evil.ts
// A masking approach blanked the quoted `/home/x/` and left `evil.ts` looking
// non-absolute -> bypass (c54aa473 follow-up, found by EliteAI adversarial pass).
// Reconstructing the value (drop only the quote DELIMITERS, keep their content)
// makes concatenation, leading-quote, and mixed-quote forms all collapse to the
// real word. Redirect operators (`>`/`<` runs, incl. `>>`,`2>`,`<>`,`>|`,`n>&m`)
// are explicit boundaries so a left arg and a right target never fuse.
// uncertain: unbalanced quote, trailing unquoted `\`, or a WRITE redirect with no
// following word operand (target invisible) -> caller fails closed.
function tokenizeWords(seg) {
  const s = String(seg ?? '')
  const words = []
  let cur = ''
  let started = false            // an empty-quoted "" still counts as a word
  let quote = null
  let uncertain = false
  let pendingWrite = false       // last op was a write redirect (> / >>)
  let gotOperand = true          // has the pending write redirect gotten a word yet
  let sawWrite = false           // any write redirect seen in this segment
  const endWord = () => {
    if (started) { words.push(cur); if (pendingWrite) gotOperand = true }
    cur = ''; started = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < s.length) { cur += s[++i]; started = true; continue }
      if (c === quote) { quote = null; started = true; continue } // delimiter dropped, content kept
      cur += c; started = true
      continue
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '\\') {
      if (i + 1 < s.length) { cur += s[++i]; started = true } else uncertain = true
      continue
    }
    if (c === '>' || c === '<') {
      endWord()
      let op = c, j = i + 1
      while (j < s.length && (s[j] === '>' || s[j] === '<')) op += s[j++]
      if (s[j] === '&') { op += s[j++]; while (j < s.length && /[\d-]/.test(s[j])) op += s[j++] } // n>&m dup
      else if (s[j] === '|') op += s[j++]                                                          // >| clobber
      i = j - 1
      const isWrite = op.includes('>') && !op.includes('&')
      if (isWrite) {
        if (pendingWrite && !gotOperand) uncertain = true
        pendingWrite = true; gotOperand = false; sawWrite = true
      }
      continue
    }
    if (/\s/.test(c)) { endWord(); continue }
    cur += c; started = true
  }
  endWord()
  if (quote) uncertain = true
  if (pendingWrite && !gotOperand) uncertain = true
  return { words, uncertain, hadWriteRedirect: sawWrite }
}

// LAYER 1 -- FAIL-CLOSED ON UNCERTAINTY (architecture pivot, kanban c54aa473).
// The security decision must NOT depend on the tokenizer being complete. If the
// segment carries write-intent (the caller's WRITE_INTENT_RX gate, passed as
// opts.writeIntent, or a write redirect the tokenizer itself saw) but NO absolute
// target could be proven, that is treated as UNCERTAIN -> the caller denies.
// This INVERTS the failure mode: a future unknown shell construction the tokenizer
// mis-parses yields empty targets -> over-block (safe), never a silent bypass.
// KNOWN, ACCEPTED OVER-BLOCK (documented for the T3 decision list): a legitimate
// RELATIVE / $VAR / ~ write (`echo x > out.txt`, `mkdir build`, `touch x`) has
// write-intent and no ABSOLUTE target -> now uncertain -> DENY.
export function extractAbsoluteTargets(seg, opts = {}) {
  const { words, uncertain: tokUncertain, hadWriteRedirect } = tokenizeWords(seg)
  const targets = []
  let sawDeviceTarget = false
  for (const w of words) {
    // A word is a write/arg target iff its reconstructed value is an absolute
    // path. Device sinks (/dev/null ...) are not gateable targets.
    if (!w.startsWith('/')) continue
    if (DEVICE_PATH_RX.test(w)) { sawDeviceTarget = true; continue }
    targets.push(w)
  }
  let uncertain = tokUncertain
  // Layer 1 -- OPT-IN (opts.writeIntent) fail-closed on a REAL write redirect
  // whose target we could NOT resolve to an absolute non-device path. It keys
  // off the tokenizer's QUOTE-AWARE hadWriteRedirect (so a quoted `>` in a pure
  // read like `grep ">" f` does NOT count) and ignores device-only writes
  // (`cat a>/dev/null`), so the fail-closed inverts the failure mode for a HIDDEN
  // real target without FP-ing on reads/device-noise. nano-worktree-guard opts in
  // (its relative writes are replaceable with absolute paths); skill-write-guard
  // does NOT (blanket fail-close would deny every relative write on all 5 agents)
  // and relies on the tokenizer + raw-substring layer 2. See the T3 over-block
  // list in the handoff.
  if (opts.writeIntent === true && hadWriteRedirect && targets.length === 0 && !sawDeviceTarget) {
    uncertain = true
  }
  return { targets, uncertain }
}
