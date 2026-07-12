import { describe, it, expect } from 'vitest'
// The guard is a hook script; its decision logic is exported as pure functions.
// Importing does NOT run the CLI block (isInvokedDirectly() is false here).
import {
  classifyTarget,
  globToRegExp,
  approvalCovers,
  matchingGrant,
  parseConsumed,
  evaluate,
  bashSkillTargets,
  stripHeredocBodies,
  stripDataPayloads,
  stripDeviceRedirects,
} from '../../scripts/hooks/skill-write-guard.mjs'

const ROOTS = { home: '/h', root: '/r' }
const HOUR = 3600_000
const NOW = 1_000_000_000_000

describe('classifyTarget', () => {
  it('classifies global skills', () => {
    expect(classifyTarget('/h/.claude/skills/foo/SKILL.md', ROOTS)).toBe('global-skill')
    expect(classifyTarget('/h/.claude/skills', ROOTS)).toBe('global-skill')
  })
  it('classifies scheduled tasks', () => {
    expect(classifyTarget('/h/.claude/scheduled-tasks/bar/task-config.json', ROOTS)).toBe('scheduled-task')
  })
  it('classifies agent-own (local) skills', () => {
    expect(classifyTarget('/r/agents/nano/.claude/skills/x/SKILL.md', ROOTS)).toBe('local-skill')
    expect(classifyTarget('/anywhere/agents/besanyi/.claude/skills/y', ROOTS)).toBe('local-skill')
  })
  it('classifies the guard-own token and log', () => {
    expect(classifyTarget('/r/store/.skill-write-approval', ROOTS)).toBe('guard-token')
    expect(classifyTarget('/r/store/skill-audit.log', ROOTS)).toBe('guard-log')
  })
  it('returns null for non-skill paths (incl. near-miss prefixes)', () => {
    expect(classifyTarget('/r/src/web.ts', ROOTS)).toBeNull()
    expect(classifyTarget('/h/.claude/skillsEVIL/x', ROOTS)).toBeNull() // no path separator
    expect(classifyTarget('', ROOTS)).toBeNull()
  })
})

describe('globToRegExp', () => {
  it('** crosses slashes, * does not', () => {
    expect(globToRegExp('**/skills/evil/**').test('/h/.claude/skills/evil/SKILL.md')).toBe(true)
    expect(globToRegExp('/h/.claude/skills/*/SKILL.md').test('/h/.claude/skills/ok/SKILL.md')).toBe(true)
    expect(globToRegExp('/h/.claude/skills/*/SKILL.md').test('/h/.claude/skills/a/b/SKILL.md')).toBe(false)
  })
  it('escapes regex metacharacters literally', () => {
    expect(globToRegExp('/h/a.b/x').test('/h/a.b/x')).toBe(true)
    expect(globToRegExp('/h/a.b/x').test('/h/aXb/x')).toBe(false)
  })
})

describe('approvalCovers', () => {
  const grant = (over: object = {}) => ({ nonce: 'n1', expiresAt: NOW + HOUR, pathGlob: '**/skills/ok/**', ...over })
  it('covers an unexpired, matching grant', () => {
    expect(approvalCovers([grant()], '/h/.claude/skills/ok/SKILL.md', NOW)).toBe(true)
  })
  it('rejects an expired grant', () => {
    expect(approvalCovers([grant({ expiresAt: NOW - 1 })], '/h/.claude/skills/ok/SKILL.md', NOW)).toBe(false)
  })
  it('rejects a non-matching glob', () => {
    expect(approvalCovers([grant()], '/h/.claude/skills/evil/SKILL.md', NOW)).toBe(false)
  })
  it('rejects an empty grant list', () => {
    expect(approvalCovers([], '/h/.claude/skills/ok/SKILL.md', NOW)).toBe(false)
  })
  it('accepts ISO-string expiry', () => {
    const iso = new Date(NOW + HOUR).toISOString()
    expect(approvalCovers([grant({ expiresAt: iso })], '/h/.claude/skills/ok/SKILL.md', NOW)).toBe(true)
  })
})

describe('evaluate', () => {
  const grants = [{ nonce: 'n', expiresAt: NOW + HOUR, pathGlob: '**/skills/ok/**' }]
  it('blocks guard token and log unconditionally', () => {
    expect(evaluate({ kind: 'guard-token', realPath: '/r/store/.skill-write-approval', grants, now: NOW }).deny).toBe(true)
    expect(evaluate({ kind: 'guard-log', realPath: '/r/store/skill-audit.log', grants, now: NOW }).deny).toBe(true)
  })
  it('blocks a global skill without a covering grant', () => {
    expect(evaluate({ kind: 'global-skill', realPath: '/h/.claude/skills/evil/SKILL.md', grants, now: NOW }).deny).toBe(true)
  })
  it('allows + audits a global skill covered by a valid grant', () => {
    const d = evaluate({ kind: 'global-skill', realPath: '/h/.claude/skills/ok/SKILL.md', grants, now: NOW })
    expect(d.deny).toBe(false)
    expect(d.audit).toBe(true)
  })
  it('blocks a scheduled task without a grant, allows with one', () => {
    expect(evaluate({ kind: 'scheduled-task', realPath: '/h/.claude/scheduled-tasks/x', grants, now: NOW }).deny).toBe(true)
    const ok = [{ nonce: 'n', expiresAt: NOW + HOUR, pathGlob: '**/scheduled-tasks/**' }]
    expect(evaluate({ kind: 'scheduled-task', realPath: '/h/.claude/scheduled-tasks/x', grants: ok, now: NOW }).deny).toBe(false)
  })
  it('allows + audits a local (agent-own) skill', () => {
    const d = evaluate({ kind: 'local-skill', realPath: '/r/agents/nano/.claude/skills/x/SKILL.md', grants: [], now: NOW })
    expect(d.deny).toBe(false)
    expect(d.audit).toBe(true)
  })
  it('allows a non-skill path', () => {
    expect(evaluate({ kind: null, realPath: '/r/src/x.ts', grants: [], now: NOW }).deny).toBe(false)
  })
})

describe('bashSkillTargets', () => {
  it('detects a redirect write to a global skill', () => {
    const h = bashSkillTargets('echo x > /h/.claude/skills/evil/SKILL.md', ROOTS)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ kind: 'global-skill', action: 'modify' })
  })
  it('detects cp/tee/install/mkdir into a skills path', () => {
    expect(bashSkillTargets('cp a /r/agents/nano/.claude/skills/x/SKILL.md', ROOTS)[0].kind).toBe('local-skill')
    expect(bashSkillTargets('mkdir -p /h/.claude/skills/evil', ROOTS)[0].kind).toBe('global-skill')
  })
  it('flags rm of a skill path as a delete', () => {
    const h = bashSkillTargets('rm -f /h/.claude/skills/evil/SKILL.md', ROOTS)
    expect(h[0]).toMatchObject({ kind: 'global-skill', action: 'delete' })
  })
  it('does NOT match a pure read (no write-intent)', () => {
    expect(bashSkillTargets('cat /h/.claude/skills/x/SKILL.md', ROOTS)).toHaveLength(0)
  })
  it('does NOT match a skills path mentioned inside a -d/--data payload (prose)', () => {
    const cmd = `curl -s -d '{"content":"I edited >> /h/.claude/skills/evil/SKILL.md"}' http://x`
    expect(bashSkillTargets(cmd, ROOTS)).toHaveLength(0)
  })
  it('does NOT match a skills path inside a heredoc body (prose)', () => {
    const cmd = "cat <<'EOF' > /tmp/report.txt\nI wrote to /h/.claude/skills/evil/SKILL.md\nEOF"
    // the only real write target here is /tmp/report.txt (not a skill) -> no hits
    expect(bashSkillTargets(cmd, ROOTS)).toHaveLength(0)
  })
})

describe('one-time nonce (token-replay defense)', () => {
  const grant = { nonce: 'n1', expiresAt: NOW + HOUR, pathGlob: '**/skills/**' }
  it('parseConsumed reads a newline-delimited ledger into a Set', () => {
    const s = parseConsumed('a\n b \n\nc\n')
    expect([...s].sort()).toEqual(['a', 'b', 'c'])
  })
  it('matchingGrant returns the grant when the nonce is fresh', () => {
    expect(matchingGrant([grant], '/h/.claude/skills/x/SKILL.md', NOW, [])?.nonce).toBe('n1')
  })
  it('matchingGrant rejects an already-consumed nonce', () => {
    expect(matchingGrant([grant], '/h/.claude/skills/x/SKILL.md', NOW, new Set(['n1']))).toBeNull()
  })
  it('matchingGrant rejects a grant with no nonce (not one-time-enforceable)', () => {
    const noNonce = { expiresAt: NOW + HOUR, pathGlob: '**/skills/**' } as any
    expect(matchingGrant([noNonce], '/h/.claude/skills/x/SKILL.md', NOW, [])).toBeNull()
  })
  it('approvalCovers honors the consumed set', () => {
    expect(approvalCovers([grant], '/h/.claude/skills/x/SKILL.md', NOW, [])).toBe(true)
    expect(approvalCovers([grant], '/h/.claude/skills/x/SKILL.md', NOW, ['n1'])).toBe(false)
  })
  it('evaluate reports the nonce to consume on allow, and denies once spent', () => {
    const ok = evaluate({ kind: 'global-skill', realPath: '/h/.claude/skills/x/SKILL.md', grants: [grant], consumed: [], now: NOW })
    expect(ok.deny).toBe(false)
    expect(ok.consumeNonce).toBe('n1')
    const spent = evaluate({ kind: 'global-skill', realPath: '/h/.claude/skills/y/SKILL.md', grants: [grant], consumed: ['n1'], now: NOW })
    expect(spent.deny).toBe(true)
  })
  it('blocks writes to the consumed ledger itself', () => {
    expect(classifyTarget('/r/store/.skill-write-consumed', ROOTS)).toBe('guard-consumed')
    expect(evaluate({ kind: 'guard-consumed', realPath: '/r/store/.skill-write-consumed', grants: [], consumed: [], now: NOW }).deny).toBe(true)
  })
})

describe('payload sanitizers', () => {
  it('stripHeredocBodies blanks the body but keeps the introducer', () => {
    const out = stripHeredocBodies("cat <<'EOF' > x\nDROP TABLE t; rm -rf /\nEOF")
    expect(out).not.toContain('DROP TABLE')
    expect(out).toContain('<<')
  })
  it('stripDataPayloads blanks a single-quoted -d body', () => {
    const out = stripDataPayloads(`curl -d '{"x":"rm -rf /"}' http://y`)
    expect(out).not.toContain('rm -rf')
  })
})

// --- FP-fix #1/#2: device redirects + arrow tokens are not write-intent ------
describe('stripDeviceRedirects (FP-fix #1)', () => {
  it('blanks /dev/null redirects and fd-dups, keeps real-file redirects', () => {
    expect(stripDeviceRedirects('cat x 2>/dev/null')).not.toMatch(/>/)
    expect(stripDeviceRedirects('cmd >/dev/null 2>&1')).not.toMatch(/>/)
    expect(stripDeviceRedirects('echo x > /r/real')).toContain('> /r/real')
  })
})

describe('bashSkillTargets: FP-fix #1/#2 (read-only commands)', () => {
  it('does NOT flag a scheduled-task READ that suppresses stderr (2>/dev/null)', () => {
    // pure read of a task-config with stderr-suppression must not look like a write
    expect(bashSkillTargets('cat /h/.claude/scheduled-tasks/x/task-config.json 2>/dev/null', ROOTS)).toHaveLength(0)
  })
  it('does NOT flag a skill READ with the >/dev/null 2>&1 idiom', () => {
    expect(bashSkillTargets('grep foo /h/.claude/skills/x/SKILL.md >/dev/null 2>&1', ROOTS)).toHaveLength(0)
  })
  it('does NOT flag a `->` arrow token next to an (unquoted) skill path', () => {
    expect(bashSkillTargets("echo '-> label' /h/.claude/skills/x/SKILL.md", ROOTS)).toHaveLength(0)
  })
  it('STILL flags a REAL redirect write to a skill path (no bypass)', () => {
    expect(bashSkillTargets('echo x > /h/.claude/skills/evil/SKILL.md', ROOTS)[0].kind).toBe('global-skill')
  })
  it('STILL flags a real fd-redirect (2> file) capturing into a skill path', () => {
    // fd-redirect to a REAL skill file (not a device sink) stays caught when the
    // target is extractable (whitespace-separated). Only /dev/* sinks are exempt.
    expect(bashSkillTargets('python3 -c pass 2> /h/.claude/skills/evil/SKILL.md', ROOTS)[0].kind).toBe('global-skill')
  })
})

// --- no-space redirect gap (kanban 48957aec): the fail-open skill-write bypass -
describe('bashSkillTargets: no-space redirect gap CLOSED', () => {
  it('flags a NO-SPACE redirect into a global skill (was a fail-open BYPASS)', () => {
    const h = bashSkillTargets('echo payload>/h/.claude/skills/evil/SKILL.md', ROOTS)
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ kind: 'global-skill', action: 'modify' })
  })
  it('flags a NO-SPACE append (>>) into a scheduled-task path', () => {
    const h = bashSkillTargets('echo x>>/h/.claude/scheduled-tasks/bar/task-config.json', ROOTS)
    expect(h[0]?.kind).toBe('scheduled-task')
  })
  it('still does NOT flag a device-suppressed read glued to the redirect', () => {
    expect(bashSkillTargets('cat /h/.claude/skills/x/SKILL.md 2>/dev/null', ROOTS)).toHaveLength(0)
  })
  it('still does NOT flag an arrow token near a skill path', () => {
    expect(bashSkillTargets("echo '-> /h/.claude/skills/x/SKILL.md'", ROOTS)).toHaveLength(0)
  })
})
