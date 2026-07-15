import { describe, it, expect, vi, beforeAll } from 'vitest'

// C2: force AGENT_RUNTIME=none for this file by overriding the single config
// helper. The route guards + startup gating all read agentRuntimeAvailable(),
// so this exercises the deployment where the host agent runtime is absent.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, agentRuntimeAvailable: () => false }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { tryHandleBackgroundTasks } = await import('../web/routes/background-tasks.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { initDatabase, getDb } = await import('../db.js')
const { AGENT_RUNTIME_UNAVAILABLE_ERROR } = await import('../web/http-helpers.js')
type RouteContext = import('../web/routes/types.js').RouteContext

// A fake ctx whose req yields no body (every guard fires BEFORE the body is read).
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = { headers: {}, socket: {}, method, url, on: () => req }
  const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
  return { ctx, out }
}

describe('C2: AGENT_RUNTIME=none -- tmux-touching endpoints 503, status degrades, message-API untouched', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('agent-terminal /keys POST -> 503 with the shared runtime-unavailable body', async () => {
    const { ctx, out } = fakeCtx('/api/agents/nano/keys', 'POST')
    expect(await tryHandleAgentTerminal(ctx)).toBe(true)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ error: AGENT_RUNTIME_UNAVAILABLE_ERROR })
  })

  it('agent-terminal /pane/stream GET -> 503', async () => {
    const { ctx, out } = fakeCtx('/api/agents/nano/pane/stream', 'GET')
    expect(await tryHandleAgentTerminal(ctx)).toBe(true)
    expect(out.status).toBe(503)
  })

  it('background-tasks POST -> 503 (spawn)', async () => {
    const { ctx, out } = fakeCtx('/api/background-tasks', 'POST')
    expect(await tryHandleBackgroundTasks(ctx)).toBe(true)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ error: AGENT_RUNTIME_UNAVAILABLE_ERROR })
  })

  it('background-tasks GET :id -> 200 but liveOutput:null + runtime:"unavailable" (degraded)', async () => {
    // Seed a "running" task; without the runtime the pane is NOT captured.
    const id = 'ABCD1234'
    getDb().prepare(
      "INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, 'nano', 'p', 'running', 'sess-x', 1784000000)"
    ).run(id)
    const { ctx, out } = fakeCtx(`/api/background-tasks/${id}`, 'GET')
    expect(await tryHandleBackgroundTasks(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.liveOutput).toBeNull()
    expect(out.body.runtime).toBe('unavailable')
  })

  it('agents /start POST -> 503', async () => {
    const { ctx, out } = fakeCtx('/api/agents/nano/start', 'POST')
    expect(await tryHandleAgents(ctx, '/tmp/web')).toBe(true)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ error: AGENT_RUNTIME_UNAVAILABLE_ERROR })
  })
})
