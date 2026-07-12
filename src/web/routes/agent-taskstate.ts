import { readBody, json } from '../http-helpers.js'
import {
  readTaskState,
  writeTaskState,
  markConsumed,
  clearTaskState,
  chooseReplayInjection,
  HOT_REPLAY_WINDOW_MS,
  HOT_REPLAY_LIMIT,
} from '../agent-taskstate.js'
import { getHotMemoriesForReplay } from '../../db.js'
import type { RouteContext } from './types.js'

// Endpoints for the compact task-state re-injection feature (#4).
//  POST   /api/agent-taskstate/:agent          <- PreCompact agent-hook writes the record
//  GET    /api/agent-taskstate/:agent/replay   <- SessionStart hook: returns inject text (does NOT consume)
//  POST   /api/agent-taskstate/:agent/consume  <- SessionStart hook: mark consumed AFTER a successful inject
//  DELETE /api/agent-taskstate/:agent          <- explicit task-done clear
//
// All gated by the dashboard token in web.ts. The read->inject->consume split
// is deliberate (Marveen): if the hook reads but dies before printing, the
// record stays consumed=false so the next start still catches it.

export async function tryHandleAgentTaskState(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  const replayMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/replay$/)
  if (replayMatch && method === 'GET') {
    const agent = decodeURIComponent(replayMatch[1])
    const source = url.searchParams.get('source') || ''
    const now = Date.now()
    const record = readTaskState(agent)
    // F2 hot-memory net is a fallback only for resume|startup (never compact);
    // fetch the candidate hot memories for those sources so chooseReplayInjection
    // can use them when no valid dedicated task-state exists.
    const hot = (source === 'resume' || source === 'startup')
      ? getHotMemoriesForReplay(agent, now - HOT_REPLAY_WINDOW_MS, HOT_REPLAY_LIMIT)
      : []
    const { text } = chooseReplayInjection(record, source, now, hot)
    json(res, { additionalContext: text })
    return true
  }

  const consumeMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    markConsumed(decodeURIComponent(consumeMatch[1]))
    json(res, { ok: true })
    return true
  }

  const baseMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)$/)
  if (baseMatch && method === 'POST') {
    const agent = decodeURIComponent(baseMatch[1])
    const body = await readBody(req)
    let fields: Record<string, unknown>
    try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const record = writeTaskState(agent, {
      doneSteps: fields.doneSteps as string[] | undefined,
      alreadyDelegated: fields.alreadyDelegated as string[] | undefined,
      nextAction: fields.nextAction as string | undefined,
      pendingDecision: fields.pendingDecision as string | undefined,
      summary: fields.summary as string | undefined,
    }, Date.now())
    json(res, { ok: true, record })
    return true
  }

  if (baseMatch && method === 'GET') {
    json(res, readTaskState(decodeURIComponent(baseMatch[1])))
    return true
  }

  if (baseMatch && method === 'DELETE') {
    clearTaskState(decodeURIComponent(baseMatch[1]))
    json(res, { ok: true })
    return true
  }

  return false
}
