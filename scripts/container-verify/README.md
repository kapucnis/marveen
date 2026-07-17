# container-verify

Isolated browser verification for the **AGENT_RUNTIME=none** (containerized S2)
deployment mode. Proves the dashboard behaves correctly when the host agent
runtime is unavailable: C2b (runtime banner + disabled agent-control), C2c
(onboarding does not block; overview + team run-state gated), and the review
findings F-1/F-2/F-3.

## Run

```bash
npm run build                                  # dist/ must be current
node scripts/container-verify/verify-agent-runtime-none.mjs
```

Headless Chromium via `@playwright/test` (already a devDependency). Screenshots
land in `scripts/container-verify/out/` (gitignored). Override the port with
`VERIFY_PORT=<n>` (must not be 3420).

## Why not just `node dist/index.js`?

`config.ts` reads `WEB_PORT` from the repo `.env` (NOT the shell env), so a build
started that way always binds **3420** and its boot path calls
`acquirePortLock(3420)`, which **kills the live dashboard**. This harness imports
`startWebServer` directly and never boots `index.js`. Four mandatory safety
conditions are enforced:

1. explicit non-3420 port + a hard `if (port === 3420) throw` before listen
   (`startWebServer`'s EADDRINUSE-reclaim would otherwise SIGTERM the live
   instance on the default port);
2. `WEB_ONLY=true` (disables router / scheduler / monitors / hook registration /
   task seeding — an independent second line of defense beyond port isolation);
3. never boot `dist/index.js` — importing `startWebServer` keeps `PROJECT_ROOT`
   and `store/` repo-local, so the live store is never touched;
4. teardown: `server.close()` in a `finally`, the process exits, no orphan.

It creates a temporary repo-root `.env` with `AGENT_RUNTIME=none` and removes it
on teardown; it refuses to run if a `.env` already exists (never clobbers a real
one). A fresh checkout has an empty `store/`, so the app would otherwise render
the first-run onboarding wizard — C2c is what lets the dashboard render naturally.
