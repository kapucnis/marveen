// BUG1(b) live-evidence harness (Yoda-mandated). Drives the REAL worktree
// checkout, whose branch (nano/bug1b-...) is NOT on origin -- exactly the
// divergent-fork state. Proves:
//   (a) POST /api/updates/apply returns a clean 409 with reason
//       'branch-not-on-origin' (short-circuits BEFORE update.sh is ever spawned
//       -- preflight fails, so nothing is pulled/built), and
//   (b) the dashboard shows the honest, fork-aware error toast (screenshot).
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
// Run from the worktree root AFTER `npm run build`:  node scripts/ui-evidence-bug1b.mjs
process.env.WEB_ONLY = 'true'            // <-- disables schedulers/monitors/tmux (Yoda F-2)
process.env.DASHBOARD_TOKEN = 'ui-evidence-bug1b-token'
process.env.NODE_ENV = 'test'

const { initDatabase } = await import('../dist/db.js')
const { startWebServer } = await import('../dist/web.js')
const { PROJECT_ROOT } = await import('../dist/config.js')
const { chromium } = await import('@playwright/test')
const { mkdirSync } = await import('node:fs')
const { join } = await import('node:path')

// Durable screenshot location (Yoda F-2): /tmp gets reaped, leaving the evidence
// unviewable. store/self-audit persists in the worktree the reviewer flips to.
const OUT = process.env.SHOT_DIR || join(PROJECT_ROOT, 'store', 'self-audit')
mkdirSync(OUT, { recursive: true })
const PORT = 3522
const TOKEN = process.env.DASHBOARD_TOKEN

initDatabase(':memory:')
const server = startWebServer(PORT)
await new Promise((r) => setTimeout(r, 600))

const browser = await chromium.launch()
const page = await browser.newPage()
let failed = false
try {
  await page.goto(`http://localhost:${PORT}/?token=${TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  await page.evaluate(() => document.getElementById('onboardingOverlay')?.remove())

  // (a) raw endpoint proof -- same request the "Frissítés most" button makes.
  const apiResult = await page.evaluate(async (token) => {
    const r = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ autoStash: false }),
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }, TOKEN)
  console.log('endpoint:', JSON.stringify(apiResult))
  if (apiResult.status !== 409) { console.error(`FAIL: expected 409, got ${apiResult.status}`); failed = true }
  if (apiResult.body.reason !== 'branch-not-on-origin') { console.error(`FAIL: reason=${apiResult.body.reason}`); failed = true }
  if (!/divergent fork/i.test(apiResult.body.error || '')) { console.error('FAIL: message not fork-aware'); failed = true }
  if (!/fleet-update-watch/i.test(apiResult.body.error || '')) { console.error('FAIL: message missing fleet-update-watch path'); failed = true }

  // (b) dashboard screenshot of the honest toast. Drive the SAME code path the
  // "Frissítés most" button runs -- fetch /api/updates/apply and render its 409
  // through the app's own showToast + localized string -- so the screenshot is
  // exactly what Laci sees. (A long duration keeps the toast on screen for the
  // capture; the real button uses the default 3s.)
  await page.click('a.sb-link[data-page="updates"]')
  await page.waitForSelector('#updatesPage:not([hidden])', { timeout: 8000 })
  await page.evaluate(async (token) => {
    const r = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ autoStash: false }),
    })
    const data = await r.json().catch(() => ({}))
    const msg = (typeof t === 'function') ? t('updates.toast.not_started', { msg: data.error }) : data.error
    if (typeof showToast === 'function') showToast(msg, 60000)
  }, TOKEN)
  await page.waitForSelector('#toast.visible', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/bug1b-preflight-409.png`, fullPage: true })

  if (!failed) console.log('PASS: 409 branch-not-on-origin (no update.sh spawned), fork-aware toast; screenshot saved')
} catch (e) {
  console.error('ERROR', e)
  failed = true
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
