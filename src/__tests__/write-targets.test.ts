import { describe, it, expect } from 'vitest'
import { extractAbsoluteTargets } from '../../scripts/hooks/lib/write-targets.mjs'

// Shared write-target extractor used by skill-write-guard + nano-worktree-guard.
// Closes the "no-space redirect" gap (kanban 48957aec) without re-opening the
// operator/device false-positives the earlier FP-fix closed.
describe('extractAbsoluteTargets', () => {
  it('extracts whitespace/start-preceded absolute paths (old behavior preserved)', () => {
    expect(extractAbsoluteTargets('cp /s/a /d/b')).toEqual(['/s/a', '/d/b'])
    expect(extractAbsoluteTargets('echo x > /a/b')).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('tee /a/b')).toEqual(['/a/b'])
  })

  it('NOW extracts NO-SPACE redirect targets (the gap): x>/p, x>>/p, 2>/p', () => {
    expect(extractAbsoluteTargets('echo x>/a/b')).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('echo x>>/a/b')).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('cmd 2>/a/b')).toEqual(['/a/b'])
    expect(extractAbsoluteTargets('echo x >/a/b')).toEqual(['/a/b']) // space before >, none after
  })

  it('does NOT treat operator/arrow `>` as a redirect (no new FP)', () => {
    expect(extractAbsoluteTargets("python3 -c 'a->/b'")).toEqual([])
    expect(extractAbsoluteTargets('node -e "()=>/z/"')).toEqual([])
  })

  it('skips device-sink paths even when glued to a redirect (belt for the FP trap)', () => {
    expect(extractAbsoluteTargets('cat a>/dev/null')).toEqual([])
    expect(extractAbsoluteTargets('cmd >/dev/stderr')).toEqual([])
    // a real path UNDER /dev that is not a std sink is still a target
    expect(extractAbsoluteTargets('echo x>/dev/shm/f')).toEqual(['/dev/shm/f'])
  })

  it('does not extract quoted or relative targets (documented limitation)', () => {
    expect(extractAbsoluteTargets(`open('/q/r')`)).toEqual([])
    expect(extractAbsoluteTargets('echo x>rel.txt')).toEqual([])
  })

  it('handles empty / nullish input', () => {
    expect(extractAbsoluteTargets('')).toEqual([])
    // @ts-expect-error runtime nullish guard
    expect(extractAbsoluteTargets(undefined)).toEqual([])
  })
})
