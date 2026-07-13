// BUG2 UI-evidence harness (Yoda-mandated). Drives the real dashboard UI with
// Playwright against an in-memory DB seeded with Laci's exact crowd-out scenario:
// 55 fresh warm rows + a SINGLE shared row with the oldest accessed_at. Opens the
// Memory panel, clicks the Shared tab, verifies the shared entry is visible and
// the counter matches the list.
//
// SAFETY (Yoda F-2): WEB_ONLY=true is MANDATORY. startWebServer otherwise boots
// the full background constellation -- schedule runner, message router, channel
// monitors, auto-restart runner -- and TWO tmux paths: the worker pre-start
// (tmux new-session detached `claude --dangerously-skip-permissions`) and the
// schedule runner, whose first tick reads task definitions from the REAL
// ~/.claude/scheduled-tasks (file-based, not this in-memory DB) with a 30-minute
// catch-up window and would inject tasks into LIVE tmux sessions. Earlier runs
// only escaped because the script exited before the 60s first tick; that is luck,
// not safety. WEB_ONLY disables all of it (web.ts honours it for exactly this
// "staging preview must not conflict with the live fleet" case).
//
// Run from the worktree root AFTER `npm run build`:
//   node scripts/ui-evidence-bug2.mjs
process.env.WEB_ONLY = 'true'            // <-- disables schedulers/monitors/tmux (Yoda F-2)
process.env.DASHBOARD_TOKEN = 'ui-evidence-bug2-token'
process.env.NODE_ENV = 'test'

const { initDatabase, getDb } = await import('../dist/db.js')
const { ALLOWED_CHAT_ID, PROJECT_ROOT } = await import('../dist/config.js')
const { startWebServer } = await import('../dist/web.js')
const { chromium } = await import('@playwright/test')
const { mkdirSync } = await import('node:fs')
const { join } = await import('node:path')

// Durable screenshot location (Yoda F-2): /tmp gets reaped, leaving the evidence
// unviewable. store/self-audit persists in the worktree the reviewer flips to.
const OUT = process.env.SHOT_DIR || join(PROJECT_ROOT, 'store', 'self-audit')
mkdirSync(OUT, { recursive: true })
const PORT = 3521

initDatabase(':memory:')
const db = getDb()
const ins = db.prepare(
  "INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords)" +
  " VALUES (?, ?, ?, 'semantic', 1.0, ?, ?, ?, ?, 0, ?)"
)
for (let i = 0; i < 55; i++) ins.run(ALLOWED_CHAT_ID, null, `warm memory ${i}`, 2000 + i, 2000 + i, 'testagent', 'warm', null)
// the single shared row -- OLDEST accessed_at (would be crowded out of top-50)
ins.run(ALLOWED_CHAT_ID, null, 'SHARED-MEMORY-EVIDENCE-282 (oldest accessed_at)', 1000, 1000, 'eliteai', 'shared', null)

const server = startWebServer(PORT)
await new Promise((r) => setTimeout(r, 600))

const browser = await chromium.launch()
const page = await browser.newPage()
let failed = false
try {
  await page.goto(`http://localhost:${PORT}/?token=${process.env.DASHBOARD_TOKEN}`, { waitUntil: 'domcontentloaded' })
  // Fresh DB pops the onboarding wizard overlay -- dismiss it so it can't
  // intercept clicks (not under test here).
  await page.waitForTimeout(400)
  await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())
  await page.click('a.sb-link[data-page="memories"]')
  await page.waitForSelector('#memoriesPage:not([hidden])', { timeout: 8000 })
  // click the Shared tab and let the list load
  await page.click('.mem-tab[data-tier="shared"]')
  await page.waitForTimeout(1200)

  const listCount = await page.locator('#memList .mem-item').count()
  const sharedVisible = await page.locator('#memList .mem-item', { hasText: 'SHARED-MEMORY-EVIDENCE-282' }).count()
  // read the shared stat counter from the stats cards
  const sharedStat = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.stat-card')]
    const card = cards.find((c) => /Shared/i.test(c.textContent || ''))
    const v = card?.querySelector('.stat-value')?.textContent?.trim()
    return v || null
  })

  await page.screenshot({ path: `${OUT}/bug2-shared-tab.png`, fullPage: true })

  console.log(JSON.stringify({ listCount, sharedVisible, sharedStat }))
  if (listCount !== 1) { console.error(`FAIL: expected 1 list item, got ${listCount}`); failed = true }
  if (sharedVisible !== 1) { console.error('FAIL: shared entry not visible in list'); failed = true }
  if (sharedStat !== String(listCount)) { console.error(`FAIL: counter(${sharedStat}) != list length(${listCount})`); failed = true }
  if (!failed) console.log('PASS: shared counter == list length == 1, shared entry visible; screenshot saved')
} catch (e) {
  console.error('ERROR', e)
  failed = true
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
