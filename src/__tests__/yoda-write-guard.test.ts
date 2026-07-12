import { describe, it, expect } from 'vitest'
// The guard is a hook script; its decision logic is exported as pure functions.
// Importing does NOT run the CLI block (isInvokedDirectly() is false here).
import {
  splitSegments,
  stripHeredocBodies,
  stripDataPayloads,
  globToRegExp,
  parseApproval,
  parseConsumed,
  matchingGrant,
  bashWriteAttempts,
  collectWriteAttempts,
  decide,
} from '../../scripts/hooks/yoda-write-guard.mjs'

const HOUR = 3600_000
const NOW = 1_000_000_000_000
const YODA_SKILL = '/home/kapucnis/marveen/agents/yoda/.claude/skills/mine/SKILL.md'

// --- pure sanitizers / helpers ----------------------------------------------
describe('splitSegments', () => {
  it('splits on ; && || | & and newlines, trims', () => {
    expect(splitSegments('a && b || c ; d | e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('joins backslash line-continuations', () => {
    expect(splitSegments('echo x \\\n> f')).toEqual(['echo x  > f'])
  })
})

describe('globToRegExp', () => {
  it('** crosses slashes, * does not', () => {
    expect(globToRegExp('**/src/**').test('/r/src/a/b.ts')).toBe(true)
    expect(globToRegExp('/r/src/*.ts').test('/r/src/ok.ts')).toBe(true)
    expect(globToRegExp('/r/src/*.ts').test('/r/src/a/b.ts')).toBe(false)
  })
  it('escapes regex metacharacters literally', () => {
    expect(globToRegExp('/r/a.b/x').test('/r/a.b/x')).toBe(true)
    expect(globToRegExp('/r/a.b/x').test('/r/aXb/x')).toBe(false)
  })
})

describe('parseApproval', () => {
  it('parses an array of grants', () => {
    expect(parseApproval('[{"nonce":"a"},{"nonce":"b"}]')).toHaveLength(2)
  })
  it('keeps a grant WITHOUT pathGlob (blanket grant is valid here)', () => {
    const g = parseApproval('[{"nonce":"a","expiresAt":123}]')
    expect(g).toHaveLength(1)
    expect(g[0].pathGlob).toBeUndefined()
  })
  it('unwraps a { grants: [...] } envelope', () => {
    expect(parseApproval('{"grants":[{"nonce":"a"}]}')).toHaveLength(1)
  })
  it('wraps a single grant object', () => {
    expect(parseApproval('{"nonce":"a"}')).toHaveLength(1)
  })
  it('returns [] on invalid JSON or empty', () => {
    expect(parseApproval('not json')).toEqual([])
    expect(parseApproval('')).toEqual([])
  })
})

describe('parseConsumed', () => {
  it('reads a newline-delimited ledger into a Set, trimming blanks', () => {
    const s = parseConsumed('a\n b \n\nc\n')
    expect([...s].sort()).toEqual(['a', 'b', 'c'])
  })
})

// --- matchingGrant (one-time nonce + optional glob) -------------------------
describe('matchingGrant', () => {
  const blanket = { nonce: 'n1', expiresAt: NOW + HOUR }            // no pathGlob
  const scoped = { nonce: 's1', expiresAt: NOW + HOUR, pathGlob: '**/src/ok.ts' }

  it('blanket grant matches any resolved path', () => {
    expect(matchingGrant([blanket], '/r/src/anything.ts', NOW, [])?.nonce).toBe('n1')
  })
  it('blanket grant matches an UNRESOLVED (null) target too', () => {
    expect(matchingGrant([blanket], null, NOW, [])?.nonce).toBe('n1')
  })
  it('scoped grant matches only the covered path', () => {
    expect(matchingGrant([scoped], '/r/src/ok.ts', NOW, [])?.nonce).toBe('s1')
    expect(matchingGrant([scoped], '/r/src/other.ts', NOW, [])).toBeNull()
  })
  it('scoped grant can NEVER cover an unresolved (null) target', () => {
    expect(matchingGrant([scoped], null, NOW, [])).toBeNull()
  })
  it('rejects an already-consumed nonce', () => {
    expect(matchingGrant([blanket], '/r/x', NOW, new Set(['n1']))).toBeNull()
  })
  it('rejects an expired grant', () => {
    expect(matchingGrant([{ nonce: 'e', expiresAt: NOW - 1 }], '/r/x', NOW, [])).toBeNull()
  })
  it('rejects a grant with no nonce (not one-time-enforceable)', () => {
    expect(matchingGrant([{ expiresAt: NOW + HOUR }], '/r/x', NOW, [])).toBeNull()
  })
  it('accepts ISO-string expiry', () => {
    const iso = new Date(NOW + HOUR).toISOString()
    expect(matchingGrant([{ nonce: 'i', expiresAt: iso }], '/r/x', NOW, [])?.nonce).toBe('i')
  })
})

// --- decide (pure per-attempt policy) ---------------------------------------
describe('decide', () => {
  const wide = [{ nonce: 'w', expiresAt: NOW + HOUR, pathGlob: '**' }]

  it('blocks a guard-own attempt UNCONDITIONALLY, even with a ** token', () => {
    const d = decide({ attempt: { tool: 'Write', real: '/r/store/.yoda-write-approval', pathOrCmd: 'x', guardOwn: true }, grants: wide, consumed: [], now: NOW })
    expect(d.deny).toBe(true)
  })
  it('allows Yoda-own-skill WITHOUT a token, marked agent-own-skill (audited)', () => {
    const d = decide({ attempt: { tool: 'Write', real: YODA_SKILL, pathOrCmd: YODA_SKILL, guardOwn: false }, grants: [], consumed: [], now: NOW })
    expect(d.deny).toBe(false)
    expect(d.reason).toBe('agent-own-skill')
    expect(d.consumeNonce).toBeUndefined()
  })
  it('does NOT treat another agent\'s skills as the exception', () => {
    const other = '/home/kapucnis/marveen/agents/nano/.claude/skills/x/SKILL.md'
    expect(decide({ attempt: { tool: 'Write', real: other, pathOrCmd: other, guardOwn: false }, grants: [], consumed: [], now: NOW }).deny).toBe(true)
  })
  it('DEFAULT-DENY: an ordinary write with no grant is blocked', () => {
    expect(decide({ attempt: { tool: 'Write', real: '/r/src/x.ts', pathOrCmd: '/r/src/x.ts', guardOwn: false }, grants: [], consumed: [], now: NOW }).deny).toBe(true)
  })
  it('allows an ordinary write covered by a valid grant, reporting the nonce', () => {
    const d = decide({ attempt: { tool: 'Write', real: '/r/src/x.ts', pathOrCmd: '/r/src/x.ts', guardOwn: false }, grants: wide, consumed: [], now: NOW })
    expect(d.deny).toBe(false)
    expect(d.consumeNonce).toBe('w')
  })
  it('denies when the covering grant is expired', () => {
    const exp = [{ nonce: 'e', expiresAt: NOW - 1, pathGlob: '**' }]
    expect(decide({ attempt: { tool: 'Write', real: '/r/src/x.ts', pathOrCmd: '/r/src/x.ts', guardOwn: false }, grants: exp, consumed: [], now: NOW }).deny).toBe(true)
  })
  it('blanket grant authorizes an unresolved (null) Bash target; scoped does not', () => {
    const blanket = [{ nonce: 'b', expiresAt: NOW + HOUR }]
    const scoped = [{ nonce: 's', expiresAt: NOW + HOUR, pathGlob: '**/src/**' }]
    expect(decide({ attempt: { tool: 'Bash', real: null, pathOrCmd: 'echo x > rel', guardOwn: false }, grants: blanket, consumed: [], now: NOW }).deny).toBe(false)
    expect(decide({ attempt: { tool: 'Bash', real: null, pathOrCmd: 'echo x > rel', guardOwn: false }, grants: scoped, consumed: [], now: NOW }).deny).toBe(true)
  })
})

// --- bashWriteAttempts (write-intent detection) -----------------------------
describe('bashWriteAttempts', () => {
  it('detects a redirect write and resolves the absolute target', () => {
    const a = bashWriteAttempts('echo x > /tmp/foo/bar.txt')
    expect(a).toHaveLength(1)
    expect(a[0].real).toContain('bar.txt')
    expect(a[0].guardOwn).toBe(false)
  })
  it('detects tee/cp/mv/sed-i/touch/rm/mkdir/ln as write-intent', () => {
    for (const cmd of [
      'echo x | tee /tmp/a', 'cp s /tmp/a', 'mv s /tmp/a', 'sed -i s/a/b/ /tmp/a',
      'touch /tmp/a', 'rm /tmp/a', 'mkdir /tmp/a', 'ln -s s /tmp/a',
    ]) {
      expect(bashWriteAttempts(cmd).length).toBeGreaterThanOrEqual(1)
    }
  })
  it('returns a single unresolved (null) attempt for a relative-path write', () => {
    const a = bashWriteAttempts('echo x > relative.txt')
    expect(a).toHaveLength(1)
    expect(a[0].real).toBeNull()
  })
  it('flags a guard-own file by BASENAME even via a relative reference (R1 mitigation)', () => {
    const a = bashWriteAttempts('echo x >> ../store/.yoda-write-approval')
    expect(a.every((x) => x.guardOwn)).toBe(true)
  })
  it('does NOT match a pure read (no write-intent)', () => {
    expect(bashWriteAttempts('cat /tmp/x')).toHaveLength(0)
    expect(bashWriteAttempts('grep -r foo src/ | head')).toHaveLength(0)
  })
  it('does NOT match a curl POST (network call, -d payload stripped even if it contains > mv tee)', () => {
    const cmd = `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"mv > tee cp rm mkdir"}'`
    expect(bashWriteAttempts(cmd)).toHaveLength(0)
  })
  it('does NOT match a target mentioned only inside a heredoc body (prose)', () => {
    const cmd = "cat <<'EOF' > /tmp/report.txt\nI wrote to /etc/passwd via > redirect\nEOF"
    // the only real write target is /tmp/report.txt
    const a = bashWriteAttempts(cmd)
    expect(a.some((x) => x.real && x.real.includes('report.txt'))).toBe(true)
    expect(a.some((x) => x.real && x.real.includes('passwd'))).toBe(false)
  })
})

// --- collectWriteAttempts (tool dispatch) -----------------------------------
describe('collectWriteAttempts', () => {
  it('returns one attempt for a native Write', () => {
    const a = collectWriteAttempts({ tool_name: 'Write', tool_input: { file_path: '/tmp/foo/x.ts', content: 'c' } })
    expect(a).toHaveLength(1)
    expect(a[0].tool).toBe('Write')
    expect(a[0].guardOwn).toBe(false)
  })
  it('returns one attempt for a native Edit', () => {
    expect(collectWriteAttempts({ tool_name: 'Edit', tool_input: { file_path: '/tmp/foo/x.ts', old_string: 'a', new_string: 'b' } })).toHaveLength(1)
  })
  it('returns [] for a non-write tool (Read/Grep/Glob)', () => {
    expect(collectWriteAttempts({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })).toEqual([])
    expect(collectWriteAttempts({ tool_name: 'Grep', tool_input: { pattern: 'x' } })).toEqual([])
  })
  it('returns [] for a curl-POST Bash (not a file write)', () => {
    expect(collectWriteAttempts({ tool_name: 'Bash', tool_input: { command: 'curl -s -X POST http://localhost:3420/api/memories -d \'{"content":"x"}\'' } })).toEqual([])
  })
  it('returns an attempt for a Bash write-intent command', () => {
    expect(collectWriteAttempts({ tool_name: 'Bash', tool_input: { command: 'echo x > /tmp/foo/y' } })).toHaveLength(1)
  })
  it('returns [] for a native write with no path (malformed -> fail open upstream)', () => {
    expect(collectWriteAttempts({ tool_name: 'Write', tool_input: { content: 'c' } })).toEqual([])
  })
})

// --- payload sanitizers ------------------------------------------------------
describe('payload sanitizers', () => {
  it('stripHeredocBodies blanks the body but keeps the introducer', () => {
    const out = stripHeredocBodies("cat <<'EOF' > x\nrm -rf /\nEOF")
    expect(out).not.toContain('rm -rf')
    expect(out).toContain('<<')
  })
  it('stripDataPayloads blanks a single-quoted -d body', () => {
    const out = stripDataPayloads(`curl -d '{"x":"rm -rf /"}' http://y`)
    expect(out).not.toContain('rm -rf')
  })
})
