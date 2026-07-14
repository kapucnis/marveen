import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
//
// dist_backup/** (2026-07-10): the marveen-deploy skill's rollback safety net
// (`cp -r dist dist_backup` before a build) is untracked and not `dist/`, so
// vitest's default excludes don't catch it -- a stale compiled test snapshot
// left over from a deploy gets collected as a SEPARATE, often-broken test file
// and fails the run for reasons that have nothing to do with the actual change
// under test. configDefaults.exclude already covers dist/.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/smoke/**', 'dist_backup/**'],
  },
})
