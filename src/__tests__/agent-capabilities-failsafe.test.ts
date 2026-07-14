import { describe, expect, it } from 'vitest'
import { readAgentCapabilities } from '../web/agent-config.js'

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
