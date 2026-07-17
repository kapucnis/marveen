import { describe, it, expect, vi } from 'vitest'

// C2c: force AGENT_RUNTIME=none by overriding the single config helper, exactly
// as the C2 contract test does. The onboarding route reads agentRuntimeAvailable()
// for both the status short-circuit and the POST guards.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, agentRuntimeAvailable: () => false }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
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

describe('C2c: AGENT_RUNTIME=none -- onboarding never blocks the dashboard, mutations 503', () => {
  it('GET /api/onboarding/status -> 200 needsOnboarding:false + reason, WITHOUT running host probes', async () => {
    const { ctx, out } = fakeCtx('/api/onboarding/status', 'GET')
    expect(await tryHandleOnboarding(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.needsOnboarding).toBe(false)
    expect(out.body.reason).toBe('agent-runtime-none')
  })

  it('POST /api/onboarding/claude-auth -> 503 with the shared runtime-unavailable body', async () => {
    const { ctx, out } = fakeCtx('/api/onboarding/claude-auth', 'POST')
    expect(await tryHandleOnboarding(ctx)).toBe(true)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ error: AGENT_RUNTIME_UNAVAILABLE_ERROR })
  })

  it('POST /api/onboarding/launch -> 503 with the shared runtime-unavailable body', async () => {
    const { ctx, out } = fakeCtx('/api/onboarding/launch', 'POST')
    expect(await tryHandleOnboarding(ctx)).toBe(true)
    expect(out.status).toBe(503)
    expect(out.body).toEqual({ error: AGENT_RUNTIME_UNAVAILABLE_ERROR })
  })
})
