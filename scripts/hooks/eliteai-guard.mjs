#!/usr/bin/env node
// PreToolUse hard-gate for the MAIN agent (EliteAI).
//
// THIN WRAPPER (2026-07-10 guard-unification) over scripts/hooks/destructive-op-guard.mjs,
// the shared, agent-agnostic core now used by every agent in the fleet. This
// file's own name/path stays exactly as before so root .claude/settings.json's
// hook reference never needs to change -- zero risk of self-locking out the
// main agent's own active session with a settings.json edit.
//
// FAIL-CLOSED WRAPPER CONTRACT: if the shared module cannot be imported/run,
// this wrapper denies the Bash call rather than silently letting it through
// (per GPT-crosscheck 2026-07-10). A broken guard should be loud, not silent.
//
// Original history/context (2026-07-10 self-audit, now superseded by the
// shared module's own header comment): the root .claude/settings.json ran in
// a permissive profile with NO PreToolUse hook, so nothing gated EliteAI's
// tool calls, while sub-agents already carried some governance hooks. This
// file closed that gap for EliteAI specifically; the shared module now closes
// it for every agent uniformly. See destructive-op-guard.mjs for the full
// scope/limitations documentation (rm -rf, force-push, destructive SQL, DB
// overwrite, filesystem-destroying ops, obfuscated exec).

import { readFileSync, appendFileSync } from 'node:fs'

const LOG_PATH = '/home/kapucnis/marveen/store/self-audit/guard.log'

function logLine(kind, detail) {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()}\teliteai\t${kind}\t${(detail || '').slice(0, 300)}\n`) } catch { /* ignore */ }
}

function denyJson(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

let payload
try {
  payload = JSON.parse(readFileSync(0, 'utf-8'))
} catch {
  logLine('FAILOPEN', 'malformed/empty payload -> allow')
  process.exit(0) // never break the agent on a payload parse error
}

if (payload?.tool_name !== 'Bash') process.exit(0)

try {
  const core = await import('./destructive-op-guard.mjs')
  const d = core.gateDecision(payload.tool_name, payload.tool_input)
  if (d.deny) {
    const cmd = String(payload?.tool_input?.command ?? '')
    logLine('DENY', `${d.why} :: ${cmd}`)
    denyJson(
      'ELiteAI biztonsagi guardrail (PreToolUse hard-gate): VISSZAFORDITHATATLAN-DESTRUKTIV ' +
      `muvelet blokkolva. Ok: ${d.why}. Ha ez TENYLEG szandekos es jogos, NE ezen a hook-utvonalon ` +
      'kerdd ki magad: szolj Lacinak Telegramon, ird le pontosan mit es miert, es az O explicit ' +
      'jovahagyasaval hajtsd vegre kezzel (vagy o vegzi). A destruktiv adatmuveletet amugy is a ' +
      'dashboard API-n (kanban/memoria/messages) vegezd, ne nyers SQL-lel/rm-mel. ' +
      '(Guardrail: scripts/hooks/destructive-op-guard.mjs, wrapper: eliteai-guard.mjs)',
    )
  }
  process.exit(0)
} catch (err) {
  // FAIL CLOSED: the shared guard module itself failed to load/run -- do not
  // silently let a destructive Bash command through. Block until fixed.
  logLine('GUARD-MODULE-ERROR', String(err))
  denyJson(
    'Biztonsagi guardrail HIBA: a destructive-op-guard.mjs modul nem toltheto be vagy hibara ' +
    'futott, ezert MINDEN Bash-parancs blokkolva van amig ez nincs javitva. Reszletek: ' +
    'store/self-audit/guard.log. Szolj Lacinak Telegramon.',
  )
}
