# Handoff: Marveen containerization (S2 / platform layer) -- external builder edition

Self-contained brief for an external engineer taking over the containerization
work. Everything needed to continue is INLINE here; it does not depend on any
internal message log, memory store, or chat history. Written in English so it is
portable.

> NOTE (anonymization): this edition deliberately omits internal agent names,
> chat/message IDs, company-specific details, and secrets. Access scope, repo
> delivery, and sandboxing are being finalized separately by the maintainer.

## 1. Goal & scope

Make the **platform layer** -- the long-running services: web dashboard, memory
store, kanban, HTTP API, inter-service message router, and guard hooks -- start
with a single `docker compose up` on any machine, configured from `.env`, with
persistent data on named volumes.

This is **phase S2 (backend-only)**. The interactive agent sessions (tmux +
Claude Code CLI) stay on the host and reach the containerized services over the
network (host ports). Full-CLI-in-container (phase S1) is an explicit later phase,
out of scope here.

Approved constraints:
- Config + secrets come from `.env` (repo root has `.env` + `.env.example`).
- Data (logs, memory, vector data, SQLite DB) on NAMED VOLUMES, never baked into
  the image.
- Validation is CI-only: the development host has NO docker/docker-compose (only
  bwrap). Design/writing needs no docker; build/smoke validation does -> CI.

## 2. Tech facts that shape the Dockerfile

- Node `>=20 <24` (`.nvmrc` = 22). Build: `npm run build` (tsc -> `dist/`). Start:
  `node dist/index.js` (`npm start`). HTTP port **3420** (`startWebServer(port=3420)`).
- Native dependency **better-sqlite3** -> needs a build toolchain in the image OR a
  prebuilt binary for the target node/arch.
- Data dir `store/` holds the SQLite DB (+ `-wal`/`-shm`), memory, logs, tokens ->
  this is the single mandatory named volume in S2.
- `WEB_HOST` defaults to `127.0.0.1` -- inside a container that is UNREACHABLE via
  port mapping; compose must set `WEB_HOST=0.0.0.0` + a dashboard token.
- `TZ=Europe/Budapest` is mandatory env, else every cron schedule shifts (cron is
  interpreted in node-local TZ).

## 3. Full specification (C1-C12) -- authoritative, inline

**C1 -- Dockerfile (multi-stage).** Builder: `node:22-bookworm-slim` + python3/make/g++
-> `npm ci` -> `tsc`. Runtime: `node:22-bookworm-slim` + curl, non-root (uid 1000),
`WORKDIR /app`; copy `dist/` + `web/` + `templates/` + `seed-config/` + required
`scripts/` + `npm ci --omit=dev`. Entrypoint wrapper: first verify `/app/store` is
WRITABLE (if not: clear error + exit), then `node dist/index.js`. `EXPOSE 3420`.
(Note: the builder runs `npm ci --omit=dev` AFTER tsc so better-sqlite3's native
binding compiles as a production install while the toolchain is still present; the
runtime stage copies that production-only `node_modules`. This ABI-safe pattern is
intended -- do not "fix" it to a runtime-stage `npm ci`.)

**C2 -- AGENT_RUNTIME=none behaviour (backend).** tmux-touching API endpoints return
an explicit `503 {error:"Agent runtime not available in this deployment"}` -- NOT a
silent no-op; the dashboard shows a global banner and disables the affected UI. The
message API still returns 200 and QUEUES the message in the DB; delivery state
signals the missing runtime. FIRST STEP for the builder: inventory every
tmux-callsite (`grep src/ tmux`) + an endpoint map -- each callsite must either
503 or UI-disable; none may stay unhandled.

**C3 -- SQLite / persistence.** Volume covers the WHOLE `store/`
(`marveen-store:/app/store`). On startup: `PRAGMA quick_check` + `wal_checkpoint(TRUNCATE)`.
If quick_check reports an error: LOUD log + timestamped copy of the corrupt file +
FAIL-LOUD shutdown with a clear message -- NO silent auto-repair (a bad repair is
worse than stopping). Graceful shutdown: on SIGTERM, checkpoint + close (compose
`init: true` + `stop_grace_period: 30s`).

**C4 -- Ollama (embedding backend).** On startup, healthcheck `OLLAMA_URL`; if
unreachable: dashboard warning + embedding features degrade LOUDLY (log + UI signal,
search falls back to keyword mode via the existing `withEmbedding=0` path).
`host.docker.internal` + `host-gateway` is the Linux answer; README section for
Mac/Windows. Optional `ollama` compose profile for hosts without a host Ollama.

**C5 -- docker-compose.** `marveen` service: `env_file: .env`; environment
`WEB_HOST=0.0.0.0`, `TZ=Europe/Budapest`, `OLLAMA_URL`, `AUTO_UPDATE_ENABLED=0`,
`AGENT_RUNTIME=none`; `ports: 127.0.0.1:3420:3420` (see C12); `volumes:
marveen-store:/app/store`; `extra_hosts` host-gateway; `user: "1000:1000"`;
`init: true`; `restart: unless-stopped`; `stop_grace_period: 30s`; healthcheck (C6).
Plus optional `ollama` profile service.

**C6 -- healthcheck.** Dedicated light endpoint `GET /healthz`, reachable WITHOUT a
token, returning only status `{ok, db:"ok"}` (the db field is a `SELECT 1` result)
-- no sensitive data. `curl -f` targets this. (Already implemented, auth-gate-preceding.)

**C7 -- .env security.** `.env` in `.dockerignore`; a CI step that PROVES via
`docker history` + image-fs grep that no `.env`/secret is in the image; README:
`.env` change -> compose restart required.

**C8 -- migration.** `scripts/migrate-store-to-volume.sh` -- with the host service
stopped, copy the current `store/` into the named volume (via `docker run --rm -v ...`
cp pattern), with an integrity check (file count + DB quick_check after copy). Empty
volume + first start -> dashboard "new install" info. The script only COPIES, never
deletes the source.

**C9 -- CI (MANDATORY -- the dev host has no docker).** GitHub Actions workflow:
x86_64 AND arm64 (buildx matrix) image build + compose-smoke (T1-T9 where runnable
in a container) + the C7 secret check. This is the required validation path.

**C10 -- documentation.** README section: `docker compose up` quickstart, env table,
volume explanation, migration, Mac/Win Ollama note, S1 outlook.

**C11 -- MARVEEN_API_URL.** Resolution order: process env -> repo-root `.env` ->
default `http://localhost:3420`. ALL code newly written in this round (migration
script, CI smoke calls, recommended URLs in degradation messages, README examples)
uses THIS; hardcoding is forbidden. Add to `.env.example` with a comment: "the
host-side agents reach the service layer here; when it moves to a server VM only
this changes." (The in-container healthcheck localhost stays -- it is its own
network namespace.) NOTE: there are ~37 existing hardcoded `localhost:3420` sites;
those are NOT part of this round (a separate later refactor in 3 mechanisms:
TS config-registry key / a shared Python helper lib / docs text). Do not touch them now.

**C12 -- secure port default.** Compose publishes `127.0.0.1:3420:3420` by default
(host-only, no automatic LAN exposure). LAN / server-VM publishing is a deliberate,
documented change (README example).

## 4. Test plan (T1-T9) -- run in CI

- **T1** clean image build (no cache; both arches in CI).
- **T2** `compose up` -> `/healthz` green (`db:ok`).
- **T3** persistence: write a memory -> `down`/`up` -> data present + quick_check ok.
- **T4** `.env` change -> restart -> takes effect.
- **T5** AGENT_RUNTIME=none: tmux endpoints 503, message 200 + DB row, banner visible,
  ZERO tmux calls in the log.
- **T6** Ollama: when reachable embedding works; when unreachable loud degradation +
  keyword search still works.
- **T7** security: non-root (`id`=1000), `.env` NOT in the image, AND a grep gate:
  ZERO hardcoded `localhost:3420` in the new code (C11).
- **T8** graceful stop: `compose stop` -> checkpoint log + clean exit + no WAL complaint
  on restart.
- **T9** migration script: copy integrity + source untouched.

Evidence expectation: CI run links/logs + T1-T9 outputs (all validation via CI,
since docker is not available locally). Reviewer inspects the same CI artifacts.

## 5. Status: what is DONE vs REMAINING

DONE and committed on the containerization branch (`nano/containerize`):
- **C1 + C6** (commit `44a0237`): Dockerfile + `docker/entrypoint.sh` (store-writable
  check) + `.dockerignore` + `/healthz`. Reviewed & approved. Final-review still owes
  a CI evidence item: prove the runtime image has NO dev deps (no typescript/vitest/tsx
  in node_modules) + report final image size for BOTH arches.
- **C2** (commit `099b915` backend + `45cff49` tests, 5/5 green): 503 gating + service
  gating + degraded status (`runtimeReason`, `runState:"unknown"`, `running:null`).
  Reviewed & approved.
- **C2b** (commits `f291753` + `fbc136c` + `e214b58` + `70cc857`): AGENT_RUNTIME=none
  frontend -- sticky banner + agent-control buttons disabled + client guard. The banner
  renders on the initial Overview landing too. Reviewed GO-with-conditions; the blocking
  finding (banner text was accent-less/truncated) is fixed in `70cc857`, and the
  agents-page disabled-button screenshot + a restart-button toast check were added.
  Browser-verified (11/11 + natural-render + an 8-assert review re-run). Re-review in flight.
- **C2c** (commits `a79687c` + `a5bccd1`): a decided, approved 3-part block that closes
  the C2 contract. (1) `/api/onboarding/status` short-circuits to
  `{needsOnboarding:false, reason:'agent-runtime-none'}`; (2) the two onboarding POST
  endpoints return the shared 503; (3) the Team-panel run-state is runtime-gated --
  `/api/overview` (agents count + team members) and `/api/team/graph` (main + subs) now
  report `running: null` instead of a hardcoded `true` / raw tmux probe that would lie in
  a container, and the UI renders null as no status rather than a false "running/stopped".
  Contract tests 10/10; browser-verified. Re-review in flight.

REMAINING (none started): **C3, C4, C5, C7 (CI secret check), C8, C9 (CI -- do this
early, it is the only validation path), C10, C11, C12.** No container-level test
(T1-T9) has run yet -- only unit contract tests (C2: 5/5, C2c: 3/3, C2c/F-3: 2/2) and
browser harnesses. A reusable browser harness is committed at
`scripts/container-verify/verify-agent-runtime-none.mjs` (run after `npm run build`).

NOTE: a full `npm test` shows 2 failures in `claude-constitution-guard.test.ts` -- these
are ENVIRONMENTAL (it dynamically imports per-agent hook files absent from a fresh
worktree), NOT a regression, and have their own backlog card. Do not chase them.

POST-DEPLOY CHECK (required): after merge/build, verify on a runtime-AVAILABLE (normal
host) deployment that the banner does NOT appear and the agent-control buttons are NOT
disabled -- i.e. the gating only triggers under AGENT_RUNTIME=none.

Suggested order (from the reviewer): C2b (done), C3, C4, C5+C12+C7, C8+C11, C9+C10.
Final-package reminders: C11 grep gate; dev-dependency-free runtime image proof +
image size for both arches; T1-T9 from CI; C3 FAIL-LOUD (no silent auto-repair).

## 6. CRITICAL footgun -- do not repeat this

Local UI/service testing of the worktree build has a sharp edge that already caused
a several-minute outage of the live dashboard. Understand this before running anything:

- **Never run the worktree build via `node dist/index.js`.** Reasons: (1) config reads
  `WEB_PORT` from the repo `.env`, NOT from the shell env -> it always binds 3420;
  (2) the boot path calls `acquirePortLock(WEB_PORT)` (`src/index.ts:306`) which
  **kills whatever holds 3420** -- i.e. the live dashboard -- and takes the port.
- To exercise the dashboard/UI locally, use an **isolated harness** that imports
  `startWebServer` DIRECTLY from the build, with FOUR mandatory conditions:
  1. **Explicit non-3420 port + `if (port === 3420) throw` before listen.** Reason:
     `startWebServer` has its own EADDRINUSE-reclaim (`src/web.ts:211-244`) that
     SIGTERMs same-uid node processes on the port -> a default port would re-kill the
     live instance.
  2. **`WEB_ONLY=true` in the harness process env.** This existing staging mode
     (`src/web.ts:310` area) disables the message router, schedule runner, channel
     monitors, reauth healer, hook registration, and scheduled-task seeding -- without
     it the test instance would write into live sessions/settings. Independent second
     line of defense beyond port isolation.
  3. **Never boot via `dist/index.js`.** Import `startWebServer` directly so
     `PROJECT_ROOT` = worktree and `store/` + token stay worktree-local. Practical
     addition: call `initDatabase()` (from the build's `db.js`) BEFORE `startWebServer`,
     else `getDb()` is undefined and DB-backed routes 500.
  4. **Teardown: `server.close()` in a finally block + the harness process exits.** No
     orphan test process.
- Risk with an empty worktree store: the harness serves REAL static files + routes but
  an EMPTY store -- if the scenario assumes live data (memory/kanban/agents), SEED it,
  else you verify a false-negative UI state. (Concrete case: an empty store makes the
  app render the first-run ONBOARDING wizard instead of the dashboard -- see below.)
- A working reference harness exists at `_c2btest/harness.mjs` in the branch.

Other environment facts: the dev host has NO docker and NO `sqlite3` CLI (query the
DB via a language sqlite binding). A browser check catches bug classes a
typecheck/parity gate cannot -- e.g. C2b's banner rendered as a tall left column
instead of a full-width top bar because `<body>` is a CSS grid; the fix was
`.agent-runtime-banner { grid-column: 1 / -1 }`.

## 7. Onboarding gap under AGENT_RUNTIME=none -- RESOLVED (C2c)

Originally: under `AGENT_RUNTIME=none` the onboarding-status check reported
`needsOnboarding=true` because `agentsRunning()` is false (no host tmux session in a
container), so the first-run onboarding wizard would have BLOCKED the dashboard (you
would not even see the C2b banner). This is closed by **C2c** (commit `a79687c`):
`/api/onboarding/status` short-circuits to `{needsOnboarding:false,
reason:'agent-runtime-none'}` when the runtime is unavailable, and the onboarding
mutation POSTs return the shared 503. A natural-render browser check confirmed the
overlay no longer blocks the dashboard. (Review is pending, but the fix is in place;
no further action needed here before wiring C5/compose.)

## 8. First steps for whoever takes over

1. Read this whole brief; the spec in section 3 is authoritative and self-contained.
2. Locate the done code on the `nano/containerize` branch (commits `44a0237`,
   `099b915`, `45cff49`, `f291753`, `fbc136c`).
3. Resolve the section-7 onboarding item with the reviewer.
4. Pull **C9 (CI) forward** -- it is the ONLY validation path (no local docker).
5. Then C5 + C12 (compose builds on the existing C1 Dockerfile/entrypoint), then
   C3/C4, then C8/C11/C10/C7.
6. Working mode: work in a dedicated branch; NEVER `node dist/index.js` full boot;
   every step is reviewed; the maintainer merges/builds/deploys -- the builder never
   merges/deploys alone. All container validation via CI; evidence = CI run links +
   T1-T9 outputs.
