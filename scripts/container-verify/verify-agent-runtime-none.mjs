// Isolated browser verification for the AGENT_RUNTIME=none (containerized) mode:
// C2b (banner + disabled agent-control), C2c (onboarding does not block; overview
// + team run-state gated), plus the review findings F-1/F-2/F-3.
//
// WHY THIS EXISTS / DO NOT run the worktree build via `node dist/index.js`:
//   config reads WEB_PORT from the repo .env (NOT the shell env) so it always
//   binds 3420, and the index.ts boot calls acquirePortLock(3420) which KILLS the
//   live dashboard. This harness imports startWebServer DIRECTLY and never boots
//   index.js. Four mandatory safety conditions (from the code review):
//     1. explicit non-3420 port + hard assert before listen (EADDRINUSE-reclaim,
//        src/web.ts, would SIGTERM the live instance on the default port);
//     2. WEB_ONLY=true (disables router/scheduler/monitors/hooks/seeding);
//     3. never boot dist/index.js -> PROJECT_ROOT + store stay repo-local;
//     4. teardown: server.close() in finally, process exits (no orphan).
//
// Usage:  node scripts/container-verify/verify-agent-runtime-none.mjs
// Requires: @playwright/test + chromium (already in devDeps). Runs headless.
// It creates a temporary repo-root .env with AGENT_RUNTIME=none and removes it on
// teardown; refuses to run if a .env already exists (never clobbers a real one).
import { writeFileSync, existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
function findRepoRoot(start) {
  let d = start
  for (;;) {
    if (existsSync(join(d, 'package.json')) && existsSync(join(d, 'dist'))) return d
    const p = dirname(d)
    if (p === d) throw new Error('repo root (package.json + dist/) not found -- run `npm run build` first')
    d = p
  }
}
const ROOT = findRepoRoot(HERE)

const PORT = Number(process.env.VERIFY_PORT || 3459)
if (PORT === 3420) { console.error('FATAL: refusing to bind 3420 (live dashboard)'); process.exit(2) }
process.env.WEB_ONLY = 'true'

const ENV_PATH = join(ROOT, '.env')
const createdEnv = !existsSync(ENV_PATH)
if (createdEnv) writeFileSync(ENV_PATH, 'AGENT_RUNTIME=none\n')
else { console.error('FATAL: repo .env exists -- refusing to overwrite. Remove it or run in a clean checkout.'); process.exit(3) }

const OUT = join(HERE, 'out'); mkdirSync(OUT, { recursive: true })
const results = []
const assert = (n, c, d) => { results.push({ n, pass: !!c }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
const EXPECTED_BANNER = 'Az ágens-futtatókörnyezet ebben a telepítésben nem érhető el -- az ágens indítás/leállítás/újraindítás és az élő terminál itt le van tiltva.'

let server, browser
try {
  const { initDatabase } = await import(join(ROOT, 'dist', 'db.js'))
  initDatabase()
  const { startWebServer } = await import(join(ROOT, 'dist', 'web.js'))
  server = startWebServer(PORT)
  await new Promise((res, rej) => { if (server.listening) return res(); server.once('listening', res); server.once('error', rej) })
  const token = readFileSync(join(ROOT, 'store', '.dashboard-token'), 'utf8').trim()
  const authed = (p) => fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())

  // C2 / C2c backend contracts
  assert('C2 /api/marveen agentRuntimeAvailable === false', (await authed('/api/marveen')).agentRuntimeAvailable === false)
  const onb = await authed('/api/onboarding/status')
  assert('C2c onboarding needsOnboarding false + reason', onb.needsOnboarding === false && onb.reason === 'agent-runtime-none')
  const tg = await authed('/api/team/graph')
  assert('F-3 team/graph every node running null', tg.nodes.length > 0 && tg.nodes.every(n => n.running === null))
  const ov = await authed('/api/overview')
  assert('F-3 overview agents.running null + runtimeAvailable false', ov.agents.running === null && ov.runtimeAvailable === false)

  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const jsErrors = []
  page.on('pageerror', e => jsErrors.push(e.message))
  // Natural render: C2c means the onboarding overlay no longer blocks the dashboard.
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#agentRuntimeBanner', { state: 'visible', timeout: 15000 })

  const bannerText = (await page.textContent('#agentRuntimeBanner') || '').trim()
  assert('C2c overlay does not block (dashboard rendered)', await page.evaluate(() => { const o = document.getElementById('onboardingOverlay'); return !(o && o.classList.contains('active') && !o.hidden) }))
  assert('F-1 banner text matches corrected HU string', bannerText === EXPECTED_BANNER, JSON.stringify(bannerText.slice(0, 40)))
  await page.screenshot({ path: join(OUT, 'banner-overview.png') })

  const teamMeta = await page.evaluate(() => Array.from(document.querySelectorAll('#overviewTeamGrid .team-node-meta')).map(e => (e.textContent || '').trim()))
  assert('F-3 team cards show no false Fut/Áll', teamMeta.length > 0 && !teamMeta.includes('Fut') && !teamMeta.includes('Áll'))

  await page.click('.sb-link[data-page="agents"]')
  await page.waitForSelector('#agentsGrid .agent-card:not(.add-card)', { timeout: 10000 })
  await page.click('#agentsGrid .agent-card:not(.marveen-card):not(.add-card)')
  await page.waitForTimeout(700)
  const btn = await page.evaluate(() => { const s = document.getElementById('agentStartBtn'), p = document.getElementById('agentStopBtn'); const l = document.getElementById('processLabel'); return { sd: s && s.disabled, pd: p && p.disabled, title: s ? s.title : '', label: l ? (l.textContent || '') : null } })
  assert('F-2 agents page: start/stop disabled + title', btn.sd === true && btn.pd === true && (btn.title || '').length > 0)
  assert('F-5 status label empty (not "Leállva") under null run-state', btn.label === '', JSON.stringify(btn.label))
  await page.screenshot({ path: join(OUT, 'agents-buttons-disabled.png') })

  const toast = await page.evaluate(async () => { const b = document.getElementById('marveenRestartBtn'); if (!b) return {}; b.click(); await new Promise(r => setTimeout(r, 300)); const t = document.getElementById('toast'); return { v: t && t.classList.contains('visible'), text: t ? (t.textContent || '') : '' } })
  assert('F-2 marveenRestartBtn fires runtime-blocked toast', toast.v === true && String(toast.text).includes('érhető el'))

  assert('no JS exceptions', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '))
  const passed = results.filter(r => r.pass).length
  console.log(`\n=== ${passed}/${results.length} passed -- screenshots in ${OUT} ===`)
  process.exitCode = passed === results.length ? 0 : 1
} catch (e) {
  console.error('HARNESS ERROR:', e && e.stack || e); process.exitCode = 1
} finally {
  if (browser) { try { await browser.close() } catch {} }
  if (server) await new Promise(r => server.close(() => r()))
  if (createdEnv && existsSync(ENV_PATH)) rmSync(ENV_PATH)
  console.log('teardown complete')
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
