import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, saveAgentMemory, getHotMemoriesForReplay } from '../db.js'

// F2 db query for the hot-memory replay net. Isolated in-memory DB so nothing
// touches the real store/claudeclaw.db.
const DAY = 24 * 60 * 60 * 1000

beforeAll(() => { initDatabase(':memory:') })

describe('getHotMemoriesForReplay (F2 db query)', () => {
  it('returns only the agent\'s HOT-tier memories, ts in epoch MS', () => {
    saveAgentMemory('agentH', 'hot one', 'hot')
    saveAgentMemory('agentH', 'warm one', 'warm')
    saveAgentMemory('agentH', 'hot two', 'hot')
    const rows = getHotMemoriesForReplay('agentH', Date.now() - DAY, 5)
    const contents = rows.map((r) => r.content)
    expect(contents).toContain('hot one')
    expect(contents).toContain('hot two')
    expect(contents).not.toContain('warm one') // tier filter
    // created_at (seconds) surfaced as MS, within the last minute
    expect(rows[0].ts).toBeGreaterThan(Date.now() - 60_000)
    expect(rows[0].ts).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('excludes memories outside the freshness window (T-TS5 db boundary)', () => {
    saveAgentMemory('agentW', 'fresh hot', 'hot')
    // window start in the FUTURE -> the just-created row is "too old" -> empty
    expect(getHotMemoriesForReplay('agentW', Date.now() + 3_600_000, 5)).toEqual([])
  })

  it('honors the limit', () => {
    for (let i = 0; i < 6; i++) saveAgentMemory('agentL', `hot-${i}`, 'hot')
    expect(getHotMemoriesForReplay('agentL', Date.now() - DAY, 3)).toHaveLength(3)
  })

  it('scopes to the requesting agent (no cross-agent leak)', () => {
    saveAgentMemory('agentX', 'x hot', 'hot')
    saveAgentMemory('agentY', 'y hot', 'hot')
    const rows = getHotMemoriesForReplay('agentX', Date.now() - DAY, 5).map((r) => r.content)
    expect(rows).toContain('x hot')
    expect(rows).not.toContain('y hot')
  })
})
