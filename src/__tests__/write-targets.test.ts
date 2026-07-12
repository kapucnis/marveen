import { describe, it, expect } from 'vitest'
import { extractAbsoluteTargets } from '../../scripts/hooks/lib/write-targets.mjs'

// Shared redirect-boundary-aware write-target extractor used by skill-write-guard
// + nano-worktree-guard. Structural tokenizer (quote-mask -> split on redirect
// operators -> extract per piece) closing two bypasses:
//   #1 (48957aec) lone no-space redirect `x>/path`
//   #2 (c54aa473) a real path glued to a no-space redirect `/tmp/x>/main/path`
// plus fail-closed { uncertain } for un-tokenizable segments.
describe('extractAbsoluteTargets', () => {
  it('extracts whitespace/start-preceded absolute paths', () => {
    expect(extractAbsoluteTargets('cp /s/a /d/b').targets).toEqual(['/s/a', '/d/b'])
    expect(extractAbsoluteTargets('echo x > /a/b').targets).toEqual(['/a/b'])
  })

  it('extracts a lone NO-SPACE redirect target (gap #1)', () => {
    expect(extractAbsoluteTargets('echo x>/a/b').targets).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('echo x>>/a/b').targets).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('cmd 2>/a/b').targets).toEqual(['/a/b'])
  })

  it('SPLITS a real path glued to a no-space redirect (gap #2) -- BOTH sides seen', () => {
    // the greedy class used to fuse these into "/tmp/x>/home/evil.ts"
    expect(extractAbsoluteTargets('cat /tmp/x>/home/evil.ts').targets).toEqual(['/tmp/x', '/home/evil.ts'])
    expect(extractAbsoluteTargets('cat /a/r.md>>/b/w.md').targets).toEqual(['/a/r.md', '/b/w.md'])
  })

  it('handles the whole redirect-operator family as a boundary', () => {
    for (const op of ['>', '>>', '2>', '<>']) {
      const t = extractAbsoluteTargets(`cat /tmp/ok${op}/home/evil`).targets
      expect(t).toContain('/home/evil')
    }
  })

  it('a QUOTED `>` is not a redirect; a quoted arrow is not extracted (subsumes arrow-exclusion)', () => {
    expect(extractAbsoluteTargets(`grep ">" /tmp/f`).targets).toEqual(['/tmp/f'])
    expect(extractAbsoluteTargets(`python3 -c "print('-> /x/y')"`).targets).toEqual([])
    expect(extractAbsoluteTargets(`python3 -c "print('-> /x/y')"`).uncertain).toBe(false)
  })

  it('skips /dev/* device sinks', () => {
    expect(extractAbsoluteTargets('cat a>/dev/null').targets).toEqual([])
    expect(extractAbsoluteTargets('echo x>/dev/shm/f').targets).toEqual(['/dev/shm/f'])
  })

  it('does not extract relative or $VAR targets (documented residual, NOT uncertain)', () => {
    const r = extractAbsoluteTargets('echo x > out.txt')
    expect(r.targets).toEqual([])
    expect(r.uncertain).toBe(false)
    const v = extractAbsoluteTargets('echo x >$HOME/out')
    expect(v.uncertain).toBe(false)
  })

  it('is UNCERTAIN on unbalanced quotes or a dangling write redirect (fail-closed)', () => {
    expect(extractAbsoluteTargets('echo x >/a/"evil').uncertain).toBe(true) // unbalanced quote
    expect(extractAbsoluteTargets('echo x >').uncertain).toBe(true)         // no target
    expect(extractAbsoluteTargets('echo x > > y').uncertain).toBe(true)     // redirect->redirect
  })

  it('is NOT uncertain on ordinary reads/writes', () => {
    expect(extractAbsoluteTargets('cat /tmp/a').uncertain).toBe(false)
    expect(extractAbsoluteTargets('echo x > /tmp/f').uncertain).toBe(false)
  })

  it('handles empty / nullish input', () => {
    expect(extractAbsoluteTargets('').targets).toEqual([])
    // @ts-expect-error runtime nullish guard
    expect(extractAbsoluteTargets(undefined).targets).toEqual([])
  })

  // quote-CONCATENATION bypass (c54aa473 follow-up, EliteAI adversarial pass):
  // bash fuses adjacent quoted+unquoted spans into one word -- a masking approach
  // lost the quoted prefix; the word-reconstruction tokenizer collapses them.
  // T6 (architecture pivot c54aa473): opt-in fail-closed on uncertainty.
  it('LAYER 1: writeIntent opt-in + real write redirect + no absolute target -> uncertain', () => {
    expect(extractAbsoluteTargets('echo x > out.txt', { writeIntent: true }).uncertain).toBe(true)
    expect(extractAbsoluteTargets('echo x >$HOME/out', { writeIntent: true }).uncertain).toBe(true)
  })
  it('LAYER 1 does NOT fire without the opt-in (skill-write path keeps relative writes)', () => {
    expect(extractAbsoluteTargets('echo x > out.txt').uncertain).toBe(false)
  })
  it('LAYER 1 is quote-aware: a quoted `>` in a read is NOT a write redirect', () => {
    expect(extractAbsoluteTargets('grep ">" somefile', { writeIntent: true }).uncertain).toBe(false)
  })
  it('LAYER 1 ignores a device-only write (cat a>/dev/null stays allowed)', () => {
    const r = extractAbsoluteTargets('cat a>/dev/null', { writeIntent: true })
    expect(r.targets).toEqual([])
    expect(r.uncertain).toBe(false)
  })
  it('LAYER 1 still allows a resolvable absolute write (no false uncertain)', () => {
    const r = extractAbsoluteTargets('echo x > /tmp/ok', { writeIntent: true })
    expect(r.targets).toEqual(['/tmp/ok'])
    expect(r.uncertain).toBe(false)
  })

  it('reconstructs a path split across quoted+unquoted concatenation', () => {
    const P = '/home/x/evil.ts'
    expect(extractAbsoluteTargets('cat a>"/home/x/"evil.ts').targets).toEqual([P])   // quoted prefix
    expect(extractAbsoluteTargets('cat a>/home/x/"evil.ts"').targets).toEqual([P])   // quoted suffix
    expect(extractAbsoluteTargets('cat a>"/home/x/evil.ts"').targets).toEqual([P])   // fully quoted
    expect(extractAbsoluteTargets("cat a>'/home/x/'evil.ts").targets).toEqual([P])   // single-quote prefix
    expect(extractAbsoluteTargets('cat a>/home/"x"/evil.ts').targets).toEqual([P])   // quoted middle
    expect(extractAbsoluteTargets('cat a>""/home/x/evil.ts').targets).toEqual([P])   // empty-quote prefix
    expect(extractAbsoluteTargets('cat a>"/"home/x/evil.ts').targets).toEqual([P])   // only slash quoted
    expect(extractAbsoluteTargets('cat a>\\/home/x/evil.ts').targets).toEqual([P])   // backslash-escaped slash
  })
})
