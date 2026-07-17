import { describe, it, expect, vi, beforeAll } from 'vitest'

// C2c/F-3: force AGENT_RUNTIME=none (same technique as the C2 contract test).
// Both the overview Team panel and the /api/team/graph nodes must report run-state
// as null (unknown) rather than a hardcoded true / a raw tmux probe, which lie in
// a container where the agents run on the host, not in this deployment.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, agentRuntimeAvailable: () => false }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { tryHandleOverview } = await import('../web/routes/overview.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { initDatabase } = await import('../db.js')
type RouteContext = import('../web/routes/types.js').RouteContext

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

describe('C2c/F-3: AGENT_RUNTIME=none -- overview + team graph report run-state as null (unknown)', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('GET /api/overview -> agents.running null, runtimeAvailable false, every team member running null', async () => {
    const { ctx, out } = fakeCtx('/api/overview', 'GET')
    expect(await tryHandleOverview(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.agents.running).toBeNull()
    expect(out.body.runtimeAvailable).toBe(false)
    expect(Array.isArray(out.body.team)).toBe(true)
    for (const member of out.body.team) expect(member.running).toBeNull()
  })

  it('GET /api/team/graph -> every node running null (main not hardcoded true, subs not tmux-probed)', async () => {
    const { ctx, out } = fakeCtx('/api/team/graph', 'GET')
    expect(await tryHandleAgents(ctx, '/tmp/web')).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.nodes)).toBe(true)
    expect(out.body.nodes.length).toBeGreaterThan(0)
    for (const node of out.body.nodes) expect(node.running).toBeNull()
  })
})
