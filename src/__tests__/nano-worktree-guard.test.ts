import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isAllowedPath, splitSegments, stripDeviceRedirects, NANO_PROTECTED_RAW_RX } from '../../scripts/hooks/nano-worktree-guard.mjs'
import { extractAbsoluteTargets } from '../../scripts/hooks/lib/write-targets.mjs'

// Permanent regression suite for nano's platform-code sandbox guard
// (2026-07-10, Flotta-szabaly-4 finomitas -- Yoda's fleet-ops review + GPT
// crosscheck). Nano may prepare platform changes ONLY inside its own git
// worktree (/home/kapucnis/marveen-nano-worktree) or its own agent dir; the
// live marveen tree, systemd, and shared git branches stay eliteai-only.

const WT = '/home/kapucnis/marveen-nano-worktree'
const AGENT_DIR = '/home/kapucnis/marveen/agents/nano'
const MAIN_SRC = '/home/kapucnis/marveen/src'

describe('nano-worktree-guard: Write/Edit/NotebookEdit path boundary', () => {
  it('ALLOWS writes inside the worktree', () => {
    expect(gateDecision('Write', { file_path: `${WT}/src/token-usage.ts`, content: 'x' }).deny).toBe(false)
    expect(gateDecision('Edit', { file_path: `${WT}/README.md` }).deny).toBe(false)
  })
  it('ALLOWS writes inside nano\'s own agent dir', () => {
    expect(gateDecision('Write', { file_path: `${AGENT_DIR}/memory/scratch.md`, content: 'x' }).deny).toBe(false)
  })
  it('ALLOWS writes under /tmp', () => {
    expect(gateDecision('Write', { file_path: '/tmp/nano-scratch/x.txt', content: 'x' }).deny).toBe(false)
  })
  it('ALLOWS writes to the pre-existing fleet-dev coordination directory (2026-07-11 regression fix)', () => {
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/store/fleet-dev/DEV-PLAN.md', content: 'x' }).deny).toBe(false)
    expect(gateDecision('Edit', { file_path: '/home/kapucnis/marveen/store/fleet-dev/archive/inputs-2026-07-11.md' }).deny).toBe(false)
  })
  it('DENIES writes to sibling store/ subdirs that are NOT fleet-dev (no blanket store/ allow)', () => {
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/store/claudeclaw.db', content: 'x' }).deny).toBe(true)
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/store/fleet-development-evil/x.md', content: 'x' }).deny).toBe(true)
  })
  it('DENIES writes to the live marveen src/ tree (outside the sandbox)', () => {
    expect(gateDecision('Write', { file_path: `${MAIN_SRC}/token-usage.ts`, content: 'x' }).deny).toBe(true)
  })
  it('DENIES writes to the live dist/', () => {
    expect(gateDecision('Edit', { file_path: '/home/kapucnis/marveen/dist/web/agent-scaffold.js' }).deny).toBe(true)
  })
  it('DENIES writes to another agent\'s directory', () => {
    expect(gateDecision('Write', { file_path: '/home/kapucnis/marveen/agents/muszaki/CLAUDE.md', content: 'x' }).deny).toBe(true)
  })
  it('ALLOWS a call with no file_path (defensive no-op)', () => {
    expect(gateDecision('Write', {}).deny).toBe(false)
  })
})

describe('nano-worktree-guard: systemctl / launchctl', () => {
  it('DENIES any systemctl invocation', () => {
    for (const cmd of ['systemctl --user restart eliteai-dashboard.service', 'sudo systemctl status foo', 'systemctl stop x']) {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('DENIES launchctl', () => {
    expect(gateDecision('Bash', { command: 'launchctl kickstart -k gui/1000/com.x' }).deny).toBe(true)
  })
  it('ALLOWS journalctl (read-only, explicitly not blocked)', () => {
    expect(gateDecision('Bash', { command: 'journalctl --user -u eliteai-dashboard.service -n 20' }).deny).toBe(false)
  })
})

describe('nano-worktree-guard: symlink protection', () => {
  it('DENIES ln -s', () => {
    expect(gateDecision('Bash', { command: `ln -s ${MAIN_SRC} ${WT}/src-link` }).deny).toBe(true)
  })
  it('DENIES ln -fs', () => {
    expect(gateDecision('Bash', { command: 'ln -fs /etc/passwd /tmp/x' }).deny).toBe(true)
  })
  it('ALLOWS a plain ln (hard link, no -s)', () => {
    expect(gateDecision('Bash', { command: `ln ${WT}/a ${WT}/b` }).deny).toBe(false)
  })
})

describe('nano-worktree-guard: git boundaries', () => {
  it('DENIES git push', () => {
    expect(gateDecision('Bash', { command: 'git push origin nano/sandbox' }).deny).toBe(true)
  })
  it('DENIES git merge / rebase / cherry-pick', () => {
    for (const cmd of ['git merge develop', 'git rebase main', 'git cherry-pick abc123']) {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('DENIES git reset --hard', () => {
    expect(gateDecision('Bash', { command: 'git reset --hard origin/main' }).deny).toBe(true)
  })
  it('DENIES git update-ref / symbolic-ref / worktree management', () => {
    for (const cmd of ['git update-ref refs/heads/main abc123', 'git symbolic-ref HEAD refs/heads/main', 'git worktree add /tmp/x develop', 'git worktree remove /tmp/x']) {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('DENIES deleting main/develop branches', () => {
    expect(gateDecision('Bash', { command: 'git branch -D develop' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'git branch -D main' }).deny).toBe(true)
  })
  it('DENIES git remote add/set-url/remove', () => {
    for (const cmd of ['git remote add evil https://x', 'git remote set-url origin https://x', 'git remote remove origin']) {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    }
  })
  it('DENIES checkout/switch to a non-nano/* branch', () => {
    expect(gateDecision('Bash', { command: 'git checkout develop' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'git checkout main' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'git switch develop' }).deny).toBe(true)
  })
  it('ALLOWS checkout/switch to a nano/*-prefixed branch (including -b new branch)', () => {
    expect(gateDecision('Bash', { command: 'git checkout nano/sandbox' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'git checkout -b nano/token-usage-fix' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'git switch -c nano/x' }).deny).toBe(false)
  })
  it('ALLOWS checkout of a path (restoring a file, not switching branches)', () => {
    expect(gateDecision('Bash', { command: 'git checkout -- src/token-usage.ts' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'git checkout .' }).deny).toBe(false)
  })
  it('DENIES creating a new branch that is NOT nano/*-prefixed', () => {
    expect(gateDecision('Bash', { command: 'git checkout -b sneaky-branch' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'git switch -c develop-clone' }).deny).toBe(true)
  })
  it('ALLOWS the core allowed workflow: status, diff, add, commit, log, branch (list), stash', () => {
    for (const cmd of ['git status', 'git diff', 'git add -A', 'git commit -m "x"', 'git log --oneline', 'git branch', 'git stash']) {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
    }
  })
})

describe('nano-worktree-guard: Bash write-intent outside the sandbox', () => {
  it('DENIES redirecting output onto a live-tree file (absolute path)', () => {
    expect(gateDecision('Bash', { command: `echo x > ${MAIN_SRC}/token-usage.ts` }).deny).toBe(true)
  })
  it('DENIES cp onto a live-tree destination (absolute path)', () => {
    expect(gateDecision('Bash', { command: `cp ${WT}/src/x.ts ${MAIN_SRC}/x.ts` }).deny).toBe(true)
  })
  it('ALLOWS redirecting output inside the worktree', () => {
    expect(gateDecision('Bash', { command: `echo x > ${WT}/src/x.ts` }).deny).toBe(false)
  })
  it('2026-07-12 architecture pivot: a bare relative-path write now DENIES (Layer 1 fail-closed-on-uncertainty opt-in, kanban c54aa473) -- an accepted T3 over-block, not a bug', () => {
    expect(gateDecision('Bash', { command: 'echo x > notes.txt' }).deny).toBe(true)
  })
  it('mkdir/touch (not in WRITE_INTENT_RX) remain unaffected by the pivot', () => {
    expect(gateDecision('Bash', { command: 'mkdir -p build' }).deny).toBe(false)
  })
  it('does NOT deny an unrelated absolute-path READ (cat/grep, no write-intent token)', () => {
    expect(gateDecision('Bash', { command: `cat ${MAIN_SRC}/token-usage.ts` }).deny).toBe(false)
    expect(gateDecision('Bash', { command: `grep foo ${MAIN_SRC}/token-usage.ts` }).deny).toBe(false)
  })
})

// 2026-07-12 no-space redirect gap CLOSED (kanban 48957aec): the old
// (?:^|\s)(\/...) token extractor only saw an absolute path preceded by
// start/whitespace, so `echo x>/abs/path` (no space around `>`) was a
// sandbox-escape route -- write-intent matched but the target was invisible.
// Shared extractAbsoluteTargets() (scripts/hooks/lib/write-targets.mjs)
// closes this for both skill-write-guard and nano-worktree-guard.
describe('nano-worktree-guard: no-space redirect gap CLOSED', () => {
  it('DENIES a NO-SPACE redirect into the main tree (was a sandbox-escape route)', () => {
    expect(gateDecision('Bash', { command: `echo x>${MAIN_SRC}/q.ts` }).deny).toBe(true)
  })
  it('DENIES a NO-SPACE append (>>) into the main tree', () => {
    expect(gateDecision('Bash', { command: `echo x>>${MAIN_SRC}/q.ts` }).deny).toBe(true)
  })
  it('DENIES a glued fd-redirect (2>) into a REAL main-tree file', () => {
    expect(gateDecision('Bash', { command: `python3 -c pass 2>${MAIN_SRC}/err.log` }).deny).toBe(true)
  })
  it('2026-07-12 architecture pivot: a read of a MAIN-TREE file with ANY redirect (even device-discard) now DENIES via Layer 2 raw-substring, re-narrowing the 2026-07-12-morning bug-1 fix for reads specifically INSIDE a protected root -- accepted T3 item-4 over-block (Layer 2 runs on the truly raw string by design, cannot distinguish device-discard from a real write without re-introducing parser-dependency)', () => {
    expect(gateDecision('Bash', { command: `cat ${MAIN_SRC}/x.ts>/dev/null` }).deny).toBe(true)
  })
  it('a plain read with NO redirect at all (no write-intent) is unaffected', () => {
    expect(gateDecision('Bash', { command: `cat ${MAIN_SRC}/x.ts` }).deny).toBe(false)
  })
  it('no-space/glued redirects extracted, operators/relative/device paths are not (opts.writeIntent default off)', () => {
    expect(extractAbsoluteTargets(`echo x>${MAIN_SRC}/q.ts`).targets).toEqual([`${MAIN_SRC}/q.ts`])
    expect(extractAbsoluteTargets("python3 -c 'x->/y'").targets).toEqual([])
    expect(extractAbsoluteTargets('echo x>rel.txt').targets).toEqual([])
    expect(extractAbsoluteTargets('cat a>/dev/null').targets).toEqual([])
  })
})

// 2026-07-12 ARCHITECTURE PIVOT (kanban c54aa473, Yoda decision): a THIRD
// bypass (quote-concatenation, `cat x>"/main/src/"evil.ts` -- bash fuses
// adjacent quoted+unquoted spans into one word) was found by EliteAI's own
// adversarial pass against the c54aa473 structural-tokenizer fix, and the
// GPT-crosscheck itself had predicted "no bypass expected" for that exact
// construction and was wrong. Root cause: the security decision depended on
// PRECISE target extraction, and bash argument assembly is always richer
// than a tokenizer. Two INDEPENDENT layers now, verified live+independently
// by EliteAI with a 162-case generative fuzz (0 leaks) plus 11 extra
// hand-crafted adversarial cases beyond that matrix (nested empty quotes,
// single-slash quoting, alternating quote types, char-by-char quote spam) --
// all correctly denied.
describe('nano-worktree-guard: architecture pivot -- Layer 1 (fail-closed) + Layer 2 (raw-substring)', () => {
  const EVIL = `${MAIN_SRC}/evil.ts`
  it('LAYER 1: relative/$VAR write-intent now uncertain -> DENY (opt-in fail-closed)', () => {
    expect(extractAbsoluteTargets('echo x > out.txt', { writeIntent: true }).uncertain).toBe(true)
    expect(extractAbsoluteTargets('echo x >$HOME/out', { writeIntent: true }).uncertain).toBe(true)
  })
  it('LAYER 1 is quote-aware (a quoted `>` in a read is not a write) and device-aware (no FP)', () => {
    expect(extractAbsoluteTargets('grep ">" somefile', { writeIntent: true }).uncertain).toBe(false)
    const r = extractAbsoluteTargets('cat a>/dev/null', { writeIntent: true })
    expect(r.targets).toEqual([]); expect(r.uncertain).toBe(false)
  })
  it('THE THIRD BYPASS (quote-concatenation) now DENIES -- word-reconstruction, not masking', () => {
    expect(gateDecision('Bash', { command: `cat x>"${MAIN_SRC}/"evil.ts` }).deny).toBe(true)
    expect(extractAbsoluteTargets(`cat x>"${MAIN_SRC}/"evil.ts`).targets).toEqual([EVIL])
  })
  it('all THREE historical exploits DENY in one pass (regression lock)', () => {
    expect(gateDecision('Bash', { command: `echo x>${EVIL}` }).deny).toBe(true) // #1 bare no-space
    expect(gateDecision('Bash', { command: `cat /tmp/x>${EVIL}` }).deny).toBe(true) // #2 glued real-path
    expect(gateDecision('Bash', { command: `cat x>"${MAIN_SRC}/"evil.ts` }).deny).toBe(true) // #3 quote-concat
  })
  it('LAYER 2 (raw-substring) fires on chained/decoy redirects independent of tokenization', () => {
    expect(gateDecision('Bash', { command: `cat a>b>${EVIL}` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `cat ${EVIL}>/tmp/decoy` }).deny).toBe(true)
  })
  it('LAYER 2 protected-root regex is path-boundary-safe (no partial-dirname FP)', () => {
    expect(NANO_PROTECTED_RAW_RX.test(`${MAIN_SRC}data/evil.ts`)).toBe(false)
    expect(NANO_PROTECTED_RAW_RX.test(EVIL)).toBe(true)
  })
  it('EliteAI extra adversarial round: quote-split WITHIN the protected substring itself', () => {
    expect(gateDecision('Bash', { command: `cat x>${MAIN_SRC.slice(0, -3)}"s"rc/evil.ts` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `cat x>'/'h'o'm'e'/'k'a'p'u'c'n'i's'/'m'a'r'v'e'e'n'/'s'r'c'/e'v'i'l'.'t's` }).deny).toBe(true)
  })
  it('legitimate absolute sandbox writes and no-redirect reads remain unaffected; a main-tree read WITH a redirect now denies (see the dedicated over-block test above)', () => {
    expect(gateDecision('Bash', { command: `echo x > ${WT}/ok.ts` }).deny).toBe(false)
    expect(gateDecision('Bash', { command: `cat ${MAIN_SRC}/README.md` }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'journalctl -u eliteai-dashboard.service -n 5' }).deny).toBe(false)
  })
})

describe('nano-worktree-guard: non-Bash/non-file tools and empty input', () => {
  it('ALLOWS Read/Grep unconditionally', () => {
    expect(gateDecision('Read', { file_path: MAIN_SRC }).deny).toBe(false)
    expect(gateDecision('Grep', {}).deny).toBe(false)
  })
  it('ALLOWS an empty/missing Bash command', () => {
    expect(gateDecision('Bash', {}).deny).toBe(false)
    expect(gateDecision('Bash', { command: '' }).deny).toBe(false)
  })
  it('ALLOWS an ordinary Bash command with no matched pattern', () => {
    expect(gateDecision('Bash', { command: 'npm test' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: 'node --version' }).deny).toBe(false)
  })
})

// 2026-07-12 FP-fix (same WRITE_INTENT_RX heritage as yoda-write-guard/
// skill-write-guard/claude-constitution-guard, msg 501/512/514 -- Nano
// self-reported hitting this while reading the main tree during review work).
describe('nano-worktree-guard FP-fix: device/operator write-intent', () => {
  const MT2 = MAIN_SRC.replace(/\/src$/, '')

  it('allows reading the main tree with stderr suppressed (2>/dev/null)', () => {
    expect(gateDecision('Bash', { command: `cat ${MT2}/README.md 2>/dev/null` }).deny).toBe(false)
    expect(gateDecision('Bash', { command: `grep -r foo ${MAIN_SRC} 2>/dev/null` }).deny).toBe(false)
  })
  it('allows the >/dev/null 2>&1 idiom and 2>&1 merge over a main-tree read', () => {
    expect(gateDecision('Bash', { command: 'some-check >/dev/null 2>&1' }).deny).toBe(false)
    expect(gateDecision('Bash', { command: `cat ${MT2}/package.json 2>&1 | head` }).deny).toBe(false)
  })
  it('allows an arrow token in a read-only one-liner', () => {
    expect(gateDecision('Bash', { command: `python3 -c "print('-> model:', 1)"` }).deny).toBe(false)
  })
  it('STILL blocks real redirect/cp/mv/tee/sed-i/install writes into the main tree', () => {
    expect(gateDecision('Bash', { command: `echo x > ${MAIN_SRC}/foo.ts` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `echo x >> ${MT2}/CLAUDE.md` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `cp a ${MT2}/dist/y.js` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `mv a ${MT2}/store/z` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `echo x | tee ${MT2}/store/x` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `sed -i s/a/b/ ${MAIN_SRC}/z.ts` }).deny).toBe(true)
    expect(gateDecision('Bash', { command: `install a ${MT2}/bin/x` }).deny).toBe(true)
  })
  it('STILL blocks an fd-redirect capturing into a REAL main-tree file (no bypass)', () => {
    expect(gateDecision('Bash', { command: `python3 -c pass 2> ${MAIN_SRC}/err.log` }).deny).toBe(true)
  })
  it('STILL blocks systemctl/git/symlink even with a device redirect appended (scope-lock)', () => {
    expect(gateDecision('Bash', { command: 'systemctl restart x 2>/dev/null' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'git push 2>&1' }).deny).toBe(true)
  })
  it('stripDeviceRedirects blanks device sinks + fd-dups, keeps real-file redirects', () => {
    expect(stripDeviceRedirects('cat x 2>/dev/null')).not.toMatch(/>/)
    expect(stripDeviceRedirects('chk >/dev/null 2>&1')).not.toMatch(/>/)
    expect(stripDeviceRedirects(`echo x > ${MAIN_SRC}/real`)).toContain(`> ${MAIN_SRC}/real`)
  })
})

describe('nano-worktree-guard: helper functions', () => {
  it('isAllowedPath accepts the worktree, agent dir, and /tmp; rejects everything else', () => {
    expect(isAllowedPath(WT)).toBe(true)
    expect(isAllowedPath(`${WT}/x`)).toBe(true)
    expect(isAllowedPath(AGENT_DIR)).toBe(true)
    expect(isAllowedPath('/tmp/x')).toBe(true)
    expect(isAllowedPath(MAIN_SRC)).toBe(false)
    expect(isAllowedPath('/home/kapucnis/marveen')).toBe(false)
    // A prefix collision must not false-allow (e.g. a sibling dir sharing the
    // worktree name as a substring).
    expect(isAllowedPath('/home/kapucnis/marveen-nano-worktree-evil')).toBe(false)
  })
  it('splitSegments splits on &&, ||, ;, |, newlines (same contract as destructive-op-guard)', () => {
    expect(splitSegments('a && b; c')).toEqual(['a', 'b', 'c'])
  })
})
