import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, getDb, getAgentMemories, getMemoriesForChat, getMemoryStats } from '../db.js'
import { ALLOWED_CHAT_ID } from '../config.js'

// BUG2 -- the SHARED counter (getMemoryStats, GROUP BY, no limit) disagreed with
// the Shared list because the list readers LIMITed by accessed_at FIRST and only
// then filtered by category. A single shared row with the oldest accessed_at was
// crowded out of the top-N window. Fix: the category filter is now in the SQL
// WHERE, before the LIMIT. These tests reproduce Laci's exact scenario.

function seed(agentId: string, category: string, accessedAt: number, content = 'x'): void {
  getDb().prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords)' +
    " VALUES (?, ?, ?, 'semantic', 1.0, ?, ?, ?, ?, 0, ?)"
  ).run(ALLOWED_CHAT_ID, null, content, accessedAt, accessedAt, agentId, category, null)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  // 55 fresh warm rows for testagent (accessed_at 2000..2054)
  for (let i = 0; i < 55; i++) seed('testagent', 'warm', 2000 + i)
  // the ONLY shared row -- oldest accessed_at, owned by a DIFFERENT agent
  // (visible to all via category='shared')
  seed('otheragent', 'shared', 1000, 'the shared one')
  // hot rows: 2 for testagent (fresh), 1 for another agent
  seed('testagent', 'hot', 3000)
  seed('testagent', 'hot', 3001)
  seed('otheragent', 'hot', 3002)
})

describe('BUG2: tier filter is applied before LIMIT (no crowd-out)', () => {
  it('T1 (Laci-repro): the single oldest-accessed shared row is returned for tier=shared', () => {
    const shared = getAgentMemories('testagent', 50, 'shared')
    expect(shared.length).toBe(1)
    expect(shared[0].category).toBe('shared')
    expect(shared[0].content).toBe('the shared one')
    // chat-wide reader (no agent) must also surface it
    const chatShared = getMemoriesForChat(ALLOWED_CHAT_ID, 50, 'shared')
    expect(chatShared.length).toBe(1)
    expect(chatShared[0].category).toBe('shared')
  })

  it('T1b (the bug premise): without the tier filter the shared row IS crowded out of top-50', () => {
    const top = getAgentMemories('testagent', 50)   // default path, unchanged
    expect(top.length).toBe(50)
    expect(top.find(m => m.category === 'shared')).toBeUndefined()
  })

  it('T2: stats.byTier.shared equals the tier=shared list length', () => {
    const stats = getMemoryStats()
    const listed = getAgentMemories('testagent', 200, 'shared')
    expect(stats.byTier.shared).toBe(listed.length)
    expect(stats.byTier.shared).toBe(1)
  })

  it('T3: agent + tier combination returns only that agent\'s rows in that tier', () => {
    const hot = getAgentMemories('testagent', 50, 'hot')
    expect(hot.length).toBe(2)                       // testagent's 2 hot, not otheragent's
    expect(hot.every(m => m.category === 'hot')).toBe(true)
    expect(hot.every(m => m.agent_id === 'testagent')).toBe(true)
    // agent + tier=shared collapses to "all shared rows the agent can see"
    const sharedCombo = getAgentMemories('testagent', 50, 'shared')
    expect(sharedCombo.every(m => m.category === 'shared')).toBe(true)
  })

  it('T4: tier-less behavior is unchanged (top-N by accessed_at desc)', () => {
    const top = getAgentMemories('testagent', 5)
    expect(top.length).toBe(5)
    // freshest first: the 2 hot (3001, 3000) then the newest warm
    expect(top[0].accessed_at).toBe(3001)
    expect(top[1].accessed_at).toBe(3000)
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1].accessed_at).toBeGreaterThanOrEqual(top[i].accessed_at)
    }
  })
})
