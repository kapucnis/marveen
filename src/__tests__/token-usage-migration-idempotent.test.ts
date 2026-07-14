import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// R4 (EliteAI hard requirement for block 5 / #573): #573 adds the token_usage
// columns `thinking_tokens` and `model` via ALTER TABLE migrations. Those run on
// every startup, so they MUST be idempotent on an already-live store/claudeclaw.db
// -- re-running the migration path (a restart) must not throw a duplicate-column
// error and must preserve existing rows. This exercises the migration on a real
// FILE DB (persisted across two initDatabase calls), not :memory:.
describe('R4: token_usage thinking_tokens/model migration is idempotent on a live-shaped file DB', () => {
  it('re-running initDatabase on the same file DB does not throw and preserves the row + new columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r4-mig-'))
    const dbPath = join(dir, 'live.db')

    // First init: full schema incl. task_title (ours) + thinking_tokens + model (#573).
    initDatabase(dbPath)
    getDb().prepare(
      `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, thinking_tokens, model, content_preview, tool_name, task_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('r4mig', 's1', '2026-07-14T00:00:00Z', 10, 20, 0, 0, 5, 'claude-opus-4-8', 'x', 'tool', 'A task')

    // Second init on the SAME persisted file = a restart on a live DB. The
    // CREATE TABLE IF NOT EXISTS + the ALTER-in-try/catch migrations must be a
    // no-op here, not a duplicate-column throw.
    expect(() => initDatabase(dbPath)).not.toThrow()

    const row = getDb()
      .prepare("SELECT thinking_tokens, model, task_title FROM token_usage WHERE agent = 'r4mig'")
      .get() as { thinking_tokens: number; model: string; task_title: string }
    expect(row.thinking_tokens).toBe(5)
    expect(row.model).toBe('claude-opus-4-8')
    expect(row.task_title).toBe('A task')
  })
})
