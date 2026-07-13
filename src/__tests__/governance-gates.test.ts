import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as selfPaceDecision, stripDataPayloads } from '../../scripts/self-pace-gate.mjs'
import {
  agentGetsGovernanceGates,
  injectSelfPaceGate,
  agentGetsDestructiveOpGate,
  injectDestructiveOpGate,
  agentGetsConstitutionGuard,
  injectConstitutionGuard,
  agentGetsSkillWriteGuard,
  injectSkillWriteGuard,
  agentGetsYodaWriteGuard,
  injectYodaWriteGuard,
  agentGetsTaskstateStartupReplay,
  injectTaskstateStartupReplay,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// --- self-pace-gate: blocks the agent from scheduling its own future turns ---
describe('self-pace-gate gateDecision', () => {
  it('denies the ScheduleWakeup runtime tool', () => {
    expect(selfPaceDecision('ScheduleWakeup', { prompt: 'x' }).deny).toBe(true)
  })
  it('denies CronCreate / CronDelete / CronList / RemoteTrigger', () => {
    for (const t of ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']) {
      expect(selfPaceDecision(t, {}).deny).toBe(true)
    }
  })
  it('denies tmux pane injection: send-keys / paste-buffer / run-shell / set-buffer', () => {
    for (const sub of ['send-keys -t agent-dev2 Enter', 'paste-buffer -t agent-dev2', 'run-shell "claude -p hi"', 'set-buffer "x"']) {
      expect(selfPaceDecision('Bash', { command: `tmux ${sub}` }).deny).toBe(true)
    }
  })
  it('denies tmux injection split across a newline (no [^newline] escape hatch)', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux \\\n  send-keys -t agent-dev2 Enter' }).deny).toBe(true)
  })
  it('denies OS-level schedulers: crontab / at / launchctl', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo "*/5 * * * * claude -p poll") | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node respawn.mjs' }).deny).toBe(true)
  })
  it('denies nohup/setsid self-respawn of claude', () => {
    expect(selfPaceDecision('Bash', { command: 'nohup claude -p "keep going" &' }).deny).toBe(true)
  })
  it('does NOT misfire "at" on a substring (netstat / cat)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat file.txt && netstat -an' }).deny).toBe(false)
  })
  it('denies a WRITE to the self-schedule store (redirect)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "{}" > ~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('ALLOWS a read-only inspection of the self-schedule store (F4)', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll ~/.claude/scheduled_tasks.json' }).deny).toBe(false)
  })
  it('denies a WRITE method to the dashboard schedule API', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/schedules -d @x.json' }).deny).toBe(true)
  })
  it('ALLOWS a GET read of the schedule API (F2 -- diagnostics, not self-pace)', () => {
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules/pending' }).deny).toBe(false)
  })
  it('denies writing the schedule store via the native Write/Edit tool (F5)', () => {
    expect(selfPaceDecision('Write', { file_path: '/home/agent/.claude/scheduled_tasks.json', content: '{}' }).deny).toBe(true)
    expect(selfPaceDecision('Edit', { file_path: '~/.claude/scheduled_tasks.json' }).deny).toBe(true)
  })
  it('denies a shell-driven /loop', () => {
    expect(selfPaceDecision('Bash', { command: 'claude /loop "keep polling"' }).deny).toBe(true)
  })
  it('ALLOWS a normal Bash command', () => {
    expect(selfPaceDecision('Bash', { command: 'git status && ls -la' }).deny).toBe(false)
  })
  it('ALLOWS a legitimate inter-agent message (not self-schedule)', () => {
    expect(selfPaceDecision('Bash', { command: 'curl -X POST http://localhost:3420/api/messages -d \'{"to":"dev4"}\'' }).deny).toBe(false)
  })
  it('ALLOWS read-only tools', () => {
    expect(selfPaceDecision('Read', {}).deny).toBe(false)
    expect(selfPaceDecision('Grep', {}).deny).toBe(false)
  })
})

// --- stripDataPayloads: a curl -d/--data body is DATA sent over the wire, never
// a shell invocation, so a trigger token INSIDE the payload must not false-deny a
// legit dispatch. Only provably-literal payloads are blanked; a payload that can
// command-substitute ($(...)/backtick) is kept so a real substitution still trips. ---
describe('self-pace-gate stripDataPayloads (data-payload false-positive guard)', () => {
  it('blanks a single-quoted -d payload but keeps the flag', () => {
    expect(stripDataPayloads(`curl -d '{"x":"/api/schedules"}' u`)).toBe(`curl -d '' u`)
  })
  it('blanks a double-quoted -d payload without substitution', () => {
    expect(stripDataPayloads(`curl -d "{tmux send-keys}" u`)).toBe(`curl -d "" u`)
  })
  it("blanks an ANSI-C $'...' payload", () => {
    expect(stripDataPayloads(`curl -d $'{"a":"/loop"}' u`)).toBe(`curl -d '' u`)
  })
  it('KEEPS a payload that can command-substitute ($(...))', () => {
    const cmd = `curl -d "$(crontab -r)" u`
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('KEEPS a payload with a backtick substitution', () => {
    const cmd = 'curl -d "`crontab -r`" u'
    expect(stripDataPayloads(cmd)).toBe(cmd)
  })
  it('handles --data / --data-raw / --data-binary / --data-urlencode long forms', () => {
    for (const flag of ['--data', '--data-raw', '--data-binary', '--data-urlencode']) {
      expect(stripDataPayloads(`curl ${flag} '/api/schedules' u`)).toBe(`curl ${flag} '' u`)
    }
  })
  it('supports the --data=VALUE equals form', () => {
    expect(stripDataPayloads(`curl --data='{"/loop":1}' u`)).toBe(`curl --data='' u`)
  })
  it('leaves URL/method args outside the payload untouched', () => {
    expect(stripDataPayloads(`curl -X POST /api/schedules -d '{}'`)).toBe(`curl -X POST /api/schedules -d ''`)
  })
  it('is a no-op when there is no -d/--data flag', () => {
    expect(stripDataPayloads('git status && ls -la')).toBe('git status && ls -la')
  })
  it('matches bash single-quote parsing: backslash is literal, first quote closes', () => {
    // bash: the -d value is `x\`; a C-style escape regex would scan PAST the real
    // closing quote and blank the out-of-band `; crontab -r`.
    expect(stripDataPayloads(`curl -d 'x\\' ; crontab -r`)).toBe(`curl -d '' ; crontab -r`)
  })
})

// --- integration: the payload-blanking must NOT weaken real WRITE/substitution
// detection; only the false-deny on a legit dispatch body is removed ---
describe('self-pace-gate: data-payload guard does not weaken real detection', () => {
  it('ALLOWS a dispatch whose JSON body merely MENTIONS /api/schedules', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev4","content":"please read the /api/schedules docs"}'` }).deny).toBe(false)
  })
  it('ALLOWS a dispatch body mentioning tmux send-keys / scheduled_tasks.json / /loop as text', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/messages -d '{"to":"dev3","content":"the tmux send-keys path writes scheduled_tasks.json on /loop"}'` }).deny).toBe(false)
  })
  it('STILL denies a real WRITE to /api/schedules (URL/method live outside the payload)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -X POST http://localhost:3420/api/schedules -d '{"schedule":"*/5 * * * *"}'` }).deny).toBe(true)
  })
  it('STILL denies a command-substitution payload ($(...) is kept, not blanked)', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d "$(crontab -r)" http://x` }).deny).toBe(true)
  })
  it('STILL denies a blocked binary outside the payload after a separator', () => {
    expect(selfPaceDecision('Bash', { command: `curl -d '{}' http://x ; crontab -r` }).deny).toBe(true)
  })
  it('STILL denies a self-pace after a bash single-quote close (backslash-literal parity)', () => {
    // regression for the C-vs-bash single-quote desync: the -d value is `x\`, then
    // the real `; <blocked>` executes -- must still deny for every self-pace route.
    for (const tail of ['crontab -r', "tmux send-keys -t s 'go' Enter", 'curl -X POST http://h/api/schedules', 'claude /loop 5m foo']) {
      expect(selfPaceDecision('Bash', { command: `curl -d 'x\\' ; ${tail} ; echo 'z'` }).deny).toBe(true)
    }
  })
})

// --- compound-command false-positives: a token in one segment must NOT trip a
// check anchored in another (per-segment matching -- round-2 hardening) ---
describe('self-pace-gate compound-command false-positives', () => {
  it('ALLOWS a store read followed by an unrelated cp/mv in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'cat ~/.claude/scheduled_tasks.json && cp other.txt backup.txt' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'grep poll scheduled_tasks.json; mv a.log b.log' }).deny).toBe(false)
  })
  it('ALLOWS a schedule-API GET with an unrelated -d flag in another segment', () => {
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules && date -d yesterday' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'curl http://localhost:3420/api/schedules | grep -d' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'ls -d */ && curl http://localhost:3420/api/schedules' }).deny).toBe(false)
  })
  it('ALLOWS "batch"/"crontab" as a word in a script name or commit message', () => {
    expect(selfPaceDecision('Bash', { command: 'npm run batch:migrate' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'git commit -m "add batch endpoint + crontab docs"' }).deny).toBe(false)
  })
  it('ALLOWS a legit tmux read with the injected word merely mentioned elsewhere', () => {
    expect(selfPaceDecision('Bash', { command: 'tmux list-sessions && echo "send-keys docs"' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'tmux ls && grep send-keys notes.md' }).deny).toBe(false)
  })
  it('STILL denies the real binary when it IS the command in a segment', () => {
    expect(selfPaceDecision('Bash', { command: 'echo "claude -p go" | at now + 5 minutes' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'ls; tmux send-keys -t agent-dev2 Enter' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'echo cmd | batch' }).deny).toBe(true)
  })
  it('ALLOWS at/batch as a shell variable assignment, not the binary', () => {
    expect(selfPaceDecision('Bash', { command: 'at=$(git rev-parse HEAD); echo $at' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'start=1; batch=2; end=3' }).deny).toBe(false)
  })
  it('ALLOWS read-listing of schedulers (crontab -l / launchctl list / atq)', () => {
    expect(selfPaceDecision('Bash', { command: 'crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'crontab -l | grep claude' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'launchctl list | grep agent' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'atq' }).deny).toBe(false)
  })
  it('STILL denies scheduler WRITE forms (crontab - / crontab -r / launchctl submit)', () => {
    expect(selfPaceDecision('Bash', { command: '(crontab -l; echo job) | crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'launchctl submit -l self -- node x.mjs' }).deny).toBe(true)
  })
  it('denies scheduler WRITE behind a sudo/env/PATH/absolute-path wrapper', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -r' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: '/usr/bin/at now + 1 minute' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'PATH=/usr/bin crontab cronfile' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'env crontab -' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'sudo launchctl bootstrap gui/501 x.plist' }).deny).toBe(true)
  })
  it('ALLOWS a wrapped scheduler READ, and a crontab-prefixed script name', () => {
    expect(selfPaceDecision('Bash', { command: 'sudo crontab -l' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: './scripts/crontab-helper.sh status' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'at=$(date +%s); echo $at' }).deny).toBe(false)
  })
})

// --- scaffold wiring: main-exempt + idempotent ---
describe('governance gate scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent', () => {
    expect(agentGetsGovernanceGates('dev2')).toBe(true)
    expect(agentGetsGovernanceGates('dev3')).toBe(true)
    expect(agentGetsGovernanceGates(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectSelfPaceGate is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs')).length).toBe(1)
  })
  it('the hook MATCHER fires on native file tools too (not just Bash)', () => {
    // Regression guard: gateDecision blocks a Write/Edit to the schedule store,
    // but that branch only runs in production if the hook MATCHER covers those
    // tool names. A Bash-only matcher would leave the native-file route open
    // while the unit test (which calls gateDecision directly) still passes.
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))
    const re = new RegExp(`^(?:${entry!.matcher})$`)
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'ScheduleWakeup', 'CronCreate']) {
      expect(re.test(t)).toBe(true)
    }
    expect(re.test('Read')).toBe(false)
  })
  it('self-pace gate survives a respawn re-run, and NO operator-gate is wired', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectSelfPaceGate(s) // respawn re-run
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    // operator-confirmation-gate is intentionally NOT wired: merge/deploy is
    // operator-authorized autonomously; the self-decide vector is covered above.
    expect(pre.some((e) => JSON.stringify(e).includes('operator-confirmation-gate.mjs'))).toBe(false)
  })
})

// --- destructive-op-guard scaffold wiring (2026-07-10 guard-unification):
// same main-exempt + idempotent contract as the other gates. The gateDecision
// LOGIC itself is covered exhaustively in destructive-op-guard.test.ts -- this
// only proves the scaffold wires it correctly into a sub-agent's settings.json. ---
describe('destructive-op-guard scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent (main gets it via its own root settings.json -> eliteai-guard.mjs wrapper)', () => {
    expect(agentGetsDestructiveOpGate('nano')).toBe(true)
    expect(agentGetsDestructiveOpGate('muszaki')).toBe(true)
    expect(agentGetsDestructiveOpGate('yoda')).toBe(true)
    expect(agentGetsDestructiveOpGate(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectDestructiveOpGate is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectDestructiveOpGate(s)
    injectDestructiveOpGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('destructive-op-guard.mjs')).length).toBe(1)
  })
  it('the hook matcher is Bash-only (the threat model requires execution, not a file write)', () => {
    const s: Record<string, unknown> = {}
    injectDestructiveOpGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('destructive-op-guard.mjs'))
    expect(entry!.matcher).toBe('Bash')
  })
  it('coexists with the other PreToolUse hooks (self-pace, email-send) without clobbering them', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectDestructiveOpGate(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('destructive-op-guard.mjs'))).toBe(true)
    expect(pre.length).toBe(2)
  })
})

// 2026-07-11: added after Yoda's fleet-behavior audit (nina/yoda had no
// constitution-guard at all; muszaki/besanyi had a manually-copied one that
// had already drifted, since nothing re-synced it on respawn).
describe('constitution-guard scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent', () => {
    expect(agentGetsConstitutionGuard('nano')).toBe(true)
    expect(agentGetsConstitutionGuard('nina')).toBe(true)
    expect(agentGetsConstitutionGuard('yoda')).toBe(true)
    expect(agentGetsConstitutionGuard(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectConstitutionGuard is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectConstitutionGuard('nina', s)
    injectConstitutionGuard('nina', s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('claude-constitution-guard.mjs')).length).toBe(1)
  })
  it('the hook matcher covers Bash|Write|Edit|NotebookEdit (the threat model includes a direct file write)', () => {
    const s: Record<string, unknown> = {}
    injectConstitutionGuard('nina', s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('claude-constitution-guard.mjs'))
    expect(entry!.matcher).toBe('Bash|Write|Edit|NotebookEdit')
  })
  it('re-propagates the canonical guard file into the target agent\'s own hooks dir (self-healing against drift)', () => {
    const s: Record<string, unknown> = {}
    injectConstitutionGuard('nina', s)
    const canonical = readFileSync(
      join(PROJECT_ROOT, 'scripts', 'hooks', 'claude-constitution-guard.mjs'), 'utf-8')
    const copied = readFileSync(
      join(PROJECT_ROOT, 'agents', 'nina', '.claude', 'hooks', 'claude-constitution-guard.mjs'), 'utf-8')
    expect(copied).toBe(canonical)
  })
  it('coexists with the other PreToolUse hooks without clobbering them', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectDestructiveOpGate(s)
    injectConstitutionGuard('nina', s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('destructive-op-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('claude-constitution-guard.mjs'))).toBe(true)
    expect(pre.length).toBe(3)
  })
})

// 2026-07-11: K1 of the injection-defense package (Yoda spec msg_id:364,
// built by Nano, adversarially re-verified by Yoda + GPT-crosscheck GO-with-
// conditions). The gateDecision LOGIC itself is covered exhaustively in
// skill-write-guard.test.ts -- this only proves the scaffold wires it
// correctly into a sub-agent's settings.json.
describe('skill-write-guard scaffold wiring', () => {
  it('applies to sub-agents, exempts the main agent (main issues approval tokens out-of-band, so gating it would block the mechanism itself)', () => {
    expect(agentGetsSkillWriteGuard('nano')).toBe(true)
    expect(agentGetsSkillWriteGuard('nina')).toBe(true)
    expect(agentGetsSkillWriteGuard('yoda')).toBe(true)
    expect(agentGetsSkillWriteGuard(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectSkillWriteGuard is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectSkillWriteGuard(s)
    injectSkillWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('skill-write-guard.mjs')).length).toBe(1)
  })
  it('the hook matcher covers Bash|Edit|Write|NotebookEdit (a Bash-only matcher would let a native Write call sail past unseen)', () => {
    const s: Record<string, unknown> = {}
    injectSkillWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('skill-write-guard.mjs'))
    expect(entry!.matcher).toBe('Bash|Edit|Write|NotebookEdit')
  })
  it('coexists with the other PreToolUse hooks without clobbering them', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectDestructiveOpGate(s)
    injectConstitutionGuard('nina', s)
    injectSkillWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('destructive-op-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('claude-constitution-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('skill-write-guard.mjs'))).toBe(true)
    expect(pre.length).toBe(4)
  })
})

// 2026-07-12: technical enforcement of Yoda's write restriction (previously
// prose-only in his CLAUDE.md). Scoped to the literal agent name 'yoda', not
// a fleet-wide rule -- see agentGetsYodaWriteGuard's own comment for why.
// Exceptional routing (Laci + independent GPT agreement): Yoda was excluded
// from designing/reviewing his own restriction, so this wiring-test suite
// (like the guard itself) went through EliteAI+GPT only.
describe('yoda-write-guard scaffold wiring', () => {
  it('applies ONLY to yoda, not other sub-agents or the main agent', () => {
    expect(agentGetsYodaWriteGuard('yoda')).toBe(true)
    expect(agentGetsYodaWriteGuard('nano')).toBe(false)
    expect(agentGetsYodaWriteGuard('nina')).toBe(false)
    expect(agentGetsYodaWriteGuard(MAIN_AGENT_ID)).toBe(false)
  })
  it('injectYodaWriteGuard is idempotent (no duplicate on respawn)', () => {
    const s: Record<string, unknown> = {}
    injectYodaWriteGuard(s)
    injectYodaWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.filter((e) => JSON.stringify(e).includes('yoda-write-guard.mjs')).length).toBe(1)
  })
  it('the hook matcher covers Bash|Edit|Write|NotebookEdit', () => {
    const s: Record<string, unknown> = {}
    injectYodaWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>)
    const entry = pre.find((e) => JSON.stringify(e).includes('yoda-write-guard.mjs'))
    expect(entry!.matcher).toBe('Bash|Edit|Write|NotebookEdit')
  })
  it('coexists with the other PreToolUse hooks without clobbering them', () => {
    const s: Record<string, unknown> = {}
    injectSelfPaceGate(s)
    injectDestructiveOpGate(s)
    injectConstitutionGuard('yoda', s)
    injectSkillWriteGuard(s)
    injectYodaWriteGuard(s)
    const pre = ((s.hooks as Record<string, unknown>).PreToolUse as unknown[])
    expect(pre.some((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('destructive-op-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('claude-constitution-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('skill-write-guard.mjs'))).toBe(true)
    expect(pre.some((e) => JSON.stringify(e).includes('yoda-write-guard.mjs'))).toBe(true)
    expect(pre.length).toBe(5)
  })
})

// 2026-07-12: taskstate-persistence fix (kanban 95cf1ffb). The SessionStart
// matcher was compact|resume only, from the one-time template seed -- never
// re-applied on respawn (unlike the PreToolUse gates), so an existing agent's
// matcher stayed stale forever. This is the re-applied-on-every-spawn fix.
describe('taskstate-replay SessionStart matcher widening', () => {
  it('applies to sub-agents, exempts the main agent', () => {
    expect(agentGetsTaskstateStartupReplay('nano')).toBe(true)
    expect(agentGetsTaskstateStartupReplay('yoda')).toBe(true)
    expect(agentGetsTaskstateStartupReplay('nina')).toBe(true)
    expect(agentGetsTaskstateStartupReplay(MAIN_AGENT_ID)).toBe(false)
  })
  it('widens an EXISTING compact|resume matcher to include startup, without touching the command', () => {
    const s: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          {
            matcher: 'compact|resume',
            hooks: [{ type: 'command', command: 'python3 /x/scripts/hooks/taskstate-replay.py', timeout: 15 }],
          },
        ],
      },
    }
    injectTaskstateStartupReplay(s)
    const entries = ((s.hooks as Record<string, unknown>).SessionStart as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
    expect(entries.length).toBe(1)
    expect(entries[0].matcher).toBe('compact|resume|startup')
    expect(entries[0].hooks[0].command).toContain('taskstate-replay.py')
  })
  it('is idempotent (re-running on an already-widened matcher is a no-op, no duplicate entries)', () => {
    const s: Record<string, unknown> = {}
    injectTaskstateStartupReplay(s)
    injectTaskstateStartupReplay(s)
    const entries = ((s.hooks as Record<string, unknown>).SessionStart as unknown[])
    expect(entries.length).toBe(1)
  })
  it('adds a fresh entry (matching the template shape) when no taskstate-replay SessionStart hook exists yet', () => {
    const s: Record<string, unknown> = {}
    injectTaskstateStartupReplay(s)
    const entries = ((s.hooks as Record<string, unknown>).SessionStart as Array<{ matcher: string }>)
    expect(entries.length).toBe(1)
    expect(entries[0].matcher).toBe('compact|resume|startup')
  })
  it('does not clobber an unrelated SessionStart entry', () => {
    const s: Record<string, unknown> = {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 /x/some-other-hook.py' }] },
        ],
      },
    }
    injectTaskstateStartupReplay(s)
    const entries = ((s.hooks as Record<string, unknown>).SessionStart as Array<{ matcher: string; hooks: Array<{ command: string }> }>)
    expect(entries.length).toBe(2)
    expect(entries.some((e) => e.hooks[0].command.includes('some-other-hook.py'))).toBe(true)
    expect(entries.some((e) => e.matcher === 'compact|resume|startup')).toBe(true)
  })
})

// --- backtick command substitution: the boundary anchor recognises `...` the
// same as $(...), so a scheduler binary inside a legacy backtick substitution is
// caught (was a documented pre-existing denylist gap: $() denied, backtick not).
describe('self-pace-gate backtick command-substitution boundary', () => {
  it('denies a bare backtick scheduler substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('denies an assignment via backtick substitution', () => {
    expect(selfPaceDecision('Bash', { command: 'X=`crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick substitution after a commit message (message blanked, op remains)', () => {
    expect(selfPaceDecision('Bash', { command: 'git commit -m "a" `crontab -r`' }).deny).toBe(true)
  })
  it('denies a backtick launchctl load', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `launchctl load x`' }).deny).toBe(true)
  })
  it('parity with $(): both substitution forms of the same op are denied', () => {
    expect(selfPaceDecision('Bash', { command: 'git status $(crontab -r)' }).deny).toBe(true)
    expect(selfPaceDecision('Bash', { command: 'git status `crontab -r`' }).deny).toBe(true)
  })
  it('does not over-fire: a backtick substitution of a NON-scheduler binary is allowed', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `date`' }).deny).toBe(false)
    expect(selfPaceDecision('Bash', { command: 'FILES=`ls -1`' }).deny).toBe(false)
  })
  it('still allows a legit read-listing inside a substitution (crontab -l)', () => {
    expect(selfPaceDecision('Bash', { command: 'echo `crontab -l`' }).deny).toBe(false)
  })
})
