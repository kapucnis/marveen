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

const VW = { width: 1280, height: 720 }   // Yoda F-1 regression viewport
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: VW })
page.on('dialog', (d) => d.accept())      // auto-accept the apply confirm()
let failed = false
const fail = (m) => { console.error('FAIL: ' + m); failed = true }
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
  if (apiResult.status !== 409) fail(`expected 409, got ${apiResult.status}`)
  if (apiResult.body.reason !== 'branch-not-on-origin') fail(`reason=${apiResult.body.reason}`)
  if (apiResult.body.branch !== 'nano/bug1b-preflight-branch-check') fail(`branch field=${apiResult.body.branch}`)

  // (b) drive the REAL button path -> short localized toast + fork-notice panel.
  await page.click('a.sb-link[data-page="updates"]')
  await page.waitForSelector('#updatesPage:not([hidden])', { timeout: 8000 })
  await page.evaluate(() => { const b = document.getElementById('updatesApplyBtn'); if (b) b.hidden = false })
  await page.click('#updatesApplyBtn')
  await page.waitForSelector('#toast.visible', { timeout: 6000 })
  await page.waitForTimeout(300)

  const toastText = (await page.locator('#toast').textContent())?.trim() || ''
  const toastBox = await page.locator('#toast').boundingBox()
  const forkVisible = await page.locator('#updatesForkNotice:not([hidden])').count()
  const forkText = (await page.locator('#updatesForkNotice').textContent())?.trim() || ''

  console.log('toast:', JSON.stringify({ len: toastText.length, box: toastBox }))
  // F-1 regression: the toast is SHORT and fully inside the 1280x720 viewport.
  if (toastText.length > 130) fail(`toast too long (${toastText.length} chars) -- not the short form`)
  if (!toastBox) fail('toast has no bounding box')
  else {
    const within = toastBox.x >= 0 && toastBox.y >= 0 &&
      (toastBox.x + toastBox.width) <= VW.width && (toastBox.y + toastBox.height) <= VW.height
    if (!within) fail(`toast clips the viewport: ${JSON.stringify(toastBox)} vs ${JSON.stringify(VW)}`)
  }
  // The full explanation lives in the fork-notice panel (localized, with branch).
  if (!forkVisible) fail('fork-notice panel not visible')
  if (!/nano\/bug1b-preflight-branch-check/.test(forkText)) fail('fork-notice missing the branch name')
  if (!/fleet-update-watch/i.test(forkText)) fail('fork-notice missing the fleet-update-watch guidance')

  await page.screenshot({ path: `${OUT}/bug1b-preflight-409.png` })   // 1280x720 viewport

  if (!failed) console.log('PASS: short toast within 1280x720 + fork-notice panel (localized, with branch); 409 before any update.sh spawn; screenshot saved')
} catch (e) {
  console.error('ERROR', e)
  failed = true
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
