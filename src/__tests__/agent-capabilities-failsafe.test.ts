import { describe, expect, it } from 'vitest'
import { readAgentCapabilities } from '../web/agent-config.js'
import { tryHandleFleetQ } from '../web/routes/fleet-q.js'
import type { RouteContext } from '../web/routes/types.js'

// R3 (EliteAI hard requirement for block 4 / #570): block 4 removes the dead
// seed-config/agent-capabilities.json fallback, so readAgentCapabilities becomes
// the SOLE capability source and the fleet-q manifest endpoint calls it at
// web-startup. It must be FAIL-SAFE -- a missing agent-config.json, a missing
// personas/ directory, a missing persona file, or absent/malformed frontmatter
// must all resolve to [] and NEVER throw, so the dashboard can never fail to
// start on our fork (where personas/ may not exist for every agent).
describe('R3: readAgentCapabilities is fail-safe against missing config / persona / frontmatter', () => {
  it('returns [] (does not throw) for an agent with no config and no persona file', () => {
    // A name that has neither agents/<name>/agent-config.json nor
    // personas/<name>.md on disk -- both lookups miss.
    let result: string[] | undefined
    expect(() => { result = readAgentCapabilities('__r3_definitely_absent_agent__') }).not.toThrow()
    expect(result).toEqual([])
  })

  it('returns an array for a known agent name (never throws, shape stable)', () => {
    // Whatever the on-disk state, the return is always a string[] -- the fleetq
    // manifest builder can map over it unconditionally.
    let result: unknown
    expect(() => { result = readAgentCapabilities('eliteai') }).not.toThrow()
    expect(Array.isArray(result)).toBe(true)
  })
})

// Minimal fake ServerResponse capturing what json() writes.
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

// R3 refined (Yoda, msg 826): our fork has NO personas/*.md with frontmatter, so
// EVERY agent's capabilities resolve to [] -- the empty-manifest path is the LIVE
// path. The /.well-known/fleetq route must therefore return a VALID manifest with
// HTTP 200 (never a 500) even when no capabilities can be derived.
describe('R3 refined: /.well-known/fleetq returns a valid manifest (never 500) with empty capabilities', () => {
  it('responds 200 with an object mapping each agent to a (possibly empty) capability array', async () => {
    const { ctx, out } = fakeCtx('/.well-known/fleetq')
    const handled = await tryHandleFleetQ(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)          // valid manifest, NOT a 500
    expect(out.body).not.toBeNull()
    expect(typeof out.body).toBe('object')
    // Every value is a string[] -- empty in our fork (no persona frontmatter),
    // but always a well-formed array the consumer can map over.
    for (const caps of Object.values(out.body as Record<string, unknown>)) {
      expect(Array.isArray(caps)).toBe(true)
    }
  })
})
