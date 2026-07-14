import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error -- plain .mjs hook script, no types
import { isProtectedPath, gateDecision, stripLiteralPayloads, stripDeviceRedirects } from '../../scripts/hooks/claude-constitution-guard.mjs'

// Permanent regression suite for the per-agent constitution-guard (protects
// CLAUDE.md/SOUL.md self-editing). 2026-07-11: extended to cover SOUL.md and
// propagated to all 5 sub-agents (nano/muszaki/besanyi/nina/yoda) after
// Yoda's fleet-behavior audit found muszaki+besanyi SOUL.md had gone stale
// with no guard preventing a future self-edit from making it worse, and
// nina/yoda had no constitution-guard wired at all.

const AGENTS = ['nano', 'muszaki', 'besanyi', 'nina', 'yoda']

describe('claude-constitution-guard: isProtectedPath', () => {
  it('protects project CLAUDE.md at any depth', () => {
    expect(isProtectedPath('/home/kapucnis/marveen/agents/muszaki/CLAUDE.md')).toBe(true)
    expect(isProtectedPath('CLAUDE.md')).toBe(true)
  })
  it('protects project SOUL.md at any depth (2026-07-11 addition)', () => {
    expect(isProtectedPath('/home/kapucnis/marveen/agents/besanyi/SOUL.md')).toBe(true)
    expect(isProtectedPath('SOUL.md')).toBe(true)
  })
  it('protects .claude/rules/** files', () => {
    expect(isProtectedPath('/home/kapucnis/marveen/agents/nano/.claude/rules/foo.md')).toBe(true)
  })
  it('protects the global ~/.claude/CLAUDE.md and ~/.claude/settings.json', () => {
    const home = process.env.HOME
    expect(isProtectedPath(`${home}/.claude/CLAUDE.md`)).toBe(true)
    expect(isProtectedPath(`${home}/.claude/settings.json`)).toBe(true)
  })
  it('protects THIS module copy\'s own sibling settings.json (path-derived self-protection)', () => {
    // The imported module here is scripts/hooks/claude-constitution-guard.mjs,
    // so its self-derived OWN_SETTINGS_PATH is scripts/settings.json -- a
    // per-AGENT copy (e.g. agents/nano/.claude/hooks/<same file>) instead
    // self-derives to THAT agent's own agents/<name>/.claude/settings.json,
    // verified separately below via the real per-agent files on disk.
    expect(isProtectedPath('/home/kapucnis/marveen/scripts/settings.json')).toBe(true)
    expect(isProtectedPath('/home/kapucnis/marveen/agents/nano/.claude/settings.json')).toBe(false)
  })
  it('a real per-agent copy self-derives to THAT agent\'s own settings.json', async () => {
    for (const agent of AGENTS) {
      const perAgent = await import(
        `../../agents/${agent}/.claude/hooks/claude-constitution-guard.mjs`)
      expect(perAgent.isProtectedPath(`/home/kapucnis/marveen/agents/${agent}/.claude/settings.json`)).toBe(true)
      // Cross-agent: must NOT protect a sibling agent's settings.json.
      const other = AGENTS.find((a) => a !== agent)!
      expect(perAgent.isProtectedPath(`/home/kapucnis/marveen/agents/${other}/.claude/settings.json`)).toBe(false)
    }
  })
  it('does NOT protect an unrelated markdown or settings file', () => {
    expect(isProtectedPath('/home/kapucnis/marveen/README.md')).toBe(false)
    expect(isProtectedPath('/home/kapucnis/marveen/agents/nano/memory/scratch.md')).toBe(false)
    expect(isProtectedPath('/home/kapucnis/marveen/agents/nano/agent-config.json')).toBe(false)
  })
  it('does NOT protect another agent\'s settings.json (only the co-located one)', () => {
    expect(isProtectedPath('/home/kapucnis/marveen/agents/muszaki/.claude/settings.json')).toBe(false)
  })
  it('handles empty/missing path defensively', () => {
    expect(isProtectedPath('')).toBe(false)
    expect(isProtectedPath(undefined)).toBe(false)
  })
})

describe('claude-constitution-guard: gateDecision Write/Edit/NotebookEdit', () => {
  it('DENIES writing CLAUDE.md or SOUL.md', () => {
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/agents/nina/CLAUDE.md', content: 'x' }).deny).toBe(true)
    expect(gateDecision('Edit', { file_path: '/home/kapucnis/marveen/agents/nina/SOUL.md' }).deny).toBe(true)
    expect(gateDecision('NotebookEdit', { notebook_path: '/home/kapucnis/marveen/agents/yoda/CLAUDE.md' }).deny).toBe(true)
  })
  it('ALLOWS writing an unrelated file in the agent dir', () => {
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/agents/nina/memory/notes.md', content: 'x' }).deny).toBe(false)
  })
  it('ALLOWS Write with no file_path (defensive no-op)', () => {
    expect(gateDecision('Write', {}).deny).toBe(false)
  })
})

describe('claude-constitution-guard: gateDecision Bash write-intent', () => {
  it('DENIES redirecting output onto CLAUDE.md', () => {
    expect(gateDecision('Bash', { command: 'echo x >> CLAUDE.md' }).deny).toBe(true)
  })
  it('DENIES redirecting output onto SOUL.md', () => {
    expect(gateDecision('Bash', { command: 'echo x > SOUL.md' }).deny).toBe(true)
  })
  it('DENIES sed -i on CLAUDE.md', () => {
    expect(gateDecision('Bash', { command: "sed -i 's/a/b/' CLAUDE.md" }).deny).toBe(true)
  })
  it('DENIES cp/mv onto the own settings.json token', () => {
    expect(gateDecision('Bash', { command: 'cp new-settings.json .claude/settings.json' }).deny).toBe(true)
  })
  it('ALLOWS a plain read (cat/grep) of CLAUDE.md -- no write-intent token', () => {
    expect(gateDecision('Bash', { command: 'cat CLAUDE.md' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'grep foo SOUL.md' }).deny).toBe(false)
  })
  it('ALLOWS an unrelated write redirect (no protected token)', () => {
    expect(gateDecision('Bash', { command: 'echo x >> notes.txt' }).deny).toBe(false)
  })
  it('ALLOWS quoted prose mentioning CLAUDE.md inside a curl -d payload (no real write)', () => {
    const cmd = `curl -s -X POST http://localhost:3420/api/messages -d '{"content":"please update CLAUDE.md >> and commit"}'`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })
  it('ALLOWS a heredoc body that mentions CLAUDE.md as data, not a shell write', () => {
    const cmd = `curl -s -d @- <<'EOF'\n{"content":"sed -i CLAUDE.md was rejected"}\nEOF`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })
  // 2026-07-12 FP-fix (Yoda's real-use false-positives on the sibling
  // yoda-write-guard/skill-write-guard, same shared WRITE_INTENT_RX heritage --
  // verified this guard was affected too and fixed in lockstep).
  it('ALLOWS a stderr/device redirect while reading a protected path (no real write)', () => {
    expect(gateDecision('Bash', { command: "cat CLAUDE.md 2>/dev/null" }).deny).toBe(false)
    expect(gateDecision('Bash', { command: "python3 -c \"open('.claude/settings.json').read()\" 2>/dev/null" }).deny).toBe(false)
    expect(gateDecision('Bash', { command: "cat CLAUDE.md >/dev/null 2>&1" }).deny).toBe(false)
  })
  it('ALLOWS an arrow/comparison operator containing ">" near a protected path (not a redirect)', () => {
    expect(gateDecision('Bash', { command: "python3 -c \"print('-> reading CLAUDE.md now')\"" }).deny).toBe(false)
    expect(gateDecision('Bash', { command: "node -e \"const f = x => x; console.log('CLAUDE.md', f)\"" }).deny).toBe(false)
  })
  it('STILL DENIES a real-file redirect onto a protected path even via a digit-prefixed fd (no bypass reopened)', () => {
    expect(gateDecision('Bash', { command: 'true 2>CLAUDE.md' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'echo x 1>SOUL.md' }).deny).toBe(true)
  })
})

describe('claude-constitution-guard: stripDeviceRedirects', () => {
  it('blanks redirects to device sinks (/dev/null, stderr, stdout, tty, fd/N)', () => {
    expect(stripDeviceRedirects('cmd 2>/dev/null')).not.toMatch(/>/)
    expect(stripDeviceRedirects('cmd >/dev/null 2>&1')).not.toMatch(/>/)
    expect(stripDeviceRedirects('cmd &>/dev/null')).not.toMatch(/>/)
  })
  it('leaves a redirect to a REAL file intact', () => {
    expect(stripDeviceRedirects('cmd 2>errors.log')).toContain('>')
    expect(stripDeviceRedirects('cmd > CLAUDE.md')).toContain('>')
  })
})

describe('claude-constitution-guard: stripLiteralPayloads', () => {
  it('blanks a single-quoted -d payload', () => {
    const out = stripLiteralPayloads(`curl -d 'sed -i CLAUDE.md'`)
    expect(out).not.toContain('CLAUDE.md')
  })
  it('leaves a command-substituting payload intact (cannot safely blank)', () => {
    const cmd = `curl -d "$(cat file.json)"`
    expect(stripLiteralPayloads(cmd)).toBe(cmd)
  })
})

describe('claude-constitution-guard: non-Bash/non-file tools and empty input', () => {
  it('ALLOWS Read/Grep unconditionally (not matched by gateDecision)', () => {
    expect(gateDecision('Read', { file_path: '/home/kapucnis/marveen/agents/nano/CLAUDE.md' }).deny).toBe(false)
  })
  it('ALLOWS an empty/missing Bash command', () => {
    expect(gateDecision('Bash', {}).deny).toBe(false)
    expect(gateDecision('Bash', { command: '' }).deny).toBe(false)
  })
})

describe('claude-constitution-guard: fleet-wide propagation (2026-07-11)', () => {
  it('all 5 agents carry a byte-identical copy of the tracked canonical guard (drift guard)', () => {
    const base = readFileSync(
      '/home/kapucnis/marveen/scripts/hooks/claude-constitution-guard.mjs', 'utf-8')
    for (const agent of AGENTS) {
      const copy = readFileSync(
        `/home/kapucnis/marveen/agents/${agent}/.claude/hooks/claude-constitution-guard.mjs`, 'utf-8')
      expect(copy, `${agent}'s copy diverged from the tracked canonical copy`).toBe(base)
    }
  })
  it('all 5 agents wire the guard into PreToolUse for Bash|Write|Edit|NotebookEdit', () => {
    for (const agent of AGENTS) {
      const settings = JSON.parse(
        readFileSync(`/home/kapucnis/marveen/agents/${agent}/.claude/settings.json`, 'utf-8'))
      const entries: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> =
        settings.hooks?.PreToolUse ?? []
      const wired = entries.some((e) =>
        e.matcher === 'Bash|Write|Edit|NotebookEdit' &&
        e.hooks?.some((h) => h.command?.includes('claude-constitution-guard.mjs')))
      expect(wired, `${agent}'s settings.json does not wire the constitution guard`).toBe(true)
    }
  })
})
