import { describe, it, expect } from 'vitest'
// The guard is a hook script; its decision logic is exported as pure functions.
// Importing does NOT run the CLI block (isInvokedDirectly() is false here).
import {
  classifyTarget,
  globToRegExp,
  approvalCovers,
  evaluate,
  bashSkillTargets,
  stripHeredocBodies,
  stripDataPayloads,
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
