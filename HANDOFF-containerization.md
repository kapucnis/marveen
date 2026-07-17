# Handoff: Marveen konténerizálás (S2 / platform-réteg) átadása

Generated: 2026-07-17 ~20:20 CEST
From: nano
To: next owner (TBD -- EliteAI jelöli ki), review: Yoda
Kanban: a2e8459e ("Marveen konténerizálás -- Docker + docker-compose"), status in_progress
Branch: `nano/containerize` (worktree: `/home/kapucnis/marveen-nano-worktree`)

## Goal

A platform-réteget (dashboard, memória, kanban, API, router, guard -- minden
hosszan futó szolgáltatás) `docker compose up`-pal indíthatóvá tenni, `.env`-ből
konfigurálva, named volume-okkal. Az agens-sessionök (tmux + Claude Code CLI) a
gazdagépen (WSL) maradnak és hálózaton érik el a konténerizált szolgáltatásokat.
Ez az **S2 (backend-only) 1. fázis**; az S1 (teljes CLI a konténerben) későbbi,
külön kör. Laci jóváhagyta a scope-ot, GPT-ideation megtörtént, Yoda végleges
specje kiadva.

FORRÁS-SPEC (a mérvadó): inter-agent üzenetek **msg 853-859** (agent_messages
tábla, store/claudeclaw.db). A teljes C1-C12 + T1-T9 a **msg 859**-ben; az
érvelési lánc (scope-döntés, GPT-pontok, Laci Q1/Q2 válasza) 853-858.

## Current Progress

### KÉSZ és commitolva (`nano/containerize`)
| Blokk | Mi | Commit | Validáció |
|---|---|---|---|
| C1 | Multi-stage Dockerfile + `docker/entrypoint.sh` (store-writable check) + `.dockerignore` | 44a0237 | tsc; konténer-build MÉG NEM (nincs docker a hoston) |
| C6 | `GET /healthz` (token nélkül, `{ok, db}` SELECT 1) | 44a0237 (`src/web.ts:117`) | endpoint kód kész; `curl -f` smoke a CI-re vár |
| C2 | AGENT_RUNTIME=none backend: tmux-endpointok explicit 503 + service-gating + degradált status | 099b915 + 45cff49 (teszt 5/5) | `npm test` zöld |
| C2b | AGENT_RUNTIME=none frontend: sticky banner + agent-control gombok disabled + kliens-guard | f291753 + fbc136c (CSS-fix) | **böngésző-verifikált** (izolált Playwright harness, 11/11 assert + screenshot) |

C2b-hez tartozó verifikációs harness (NEM commitolt, worktree-lokál):
`_c2btest/harness.mjs` + screenshotok `_c2btest/out/`. Ez a minta bármely
worktree-beli UI-verifikációhoz újrahasznosítható (lásd nano memória id 605).

### HÁTRA (egyik sincs elkezdve)
| Blokk | Mi | Megjegyzés |
|---|---|---|
| C3 | SQLite perzisztencia: induláskor `PRAGMA quick_check` + `wal_checkpoint(TRUNCATE)`; quick_check hibánál HANGOS log + időbélyeges másolat + **FAIL-LOUD** leállás (SEMMI csendes auto-repair); SIGTERM-re checkpoint+close | `src/`-ben MOST nincs wal_checkpoint/quick_check |
| C4 | Ollama: induláskori healthcheck az OLLAMA_URL-re + dashboard-warning + hangos degradáció (kulcsszavas fallback) | container-specifikus rész hiányzik |
| C5 | `docker-compose.yml` (marveen service + opcionális ollama profil) | fájl HIÁNYZIK |
| C7 | CI-lépés ami `docker history`+fs-grep-pel BIZONYÍTJA hogy nincs `.env`/titok az image-ben | `.dockerignore` már tartalmazza `.env`-et; a CI-check hiányzik |
| C8 | `scripts/migrate-store-to-volume.sh` (csak másol, sosem töröl, integritás-check) | fájl HIÁNYZIK |
| C9 | **GitHub Actions CI (KÖTELEZŐ validációs út)**: x86_64+arm64 buildx build + compose-smoke (T1-T9) + C7 titok-check | `.github/workflows` HIÁNYZIK -- ez a legfontosabb hátralévő, mert helyben nincs docker |
| C10 | README-szakasz (quickstart, env-tábla, volume, migráció, Mac/Win Ollama, S1-kitekintés) | hiányzik |
| C11 | `MARVEEN_API_URL` env (process env -> repo .env -> default http://localhost:3420); MINDEN új konténer-kód ezt használja, hardcode tilos | nincs bevezetve |
| C12 | Compose port default `127.0.0.1:3420:3420` (gazdagép-only, nem LAN) | a C5 része, hiányzik |

Durva arány: a 4 "app-kódba építhető" blokk kész (C1, C6, C2, C2b); a 8 infra-
blokk (C3-C5, C7-C12) hátra. **Konténer-szintű validáció (T1-T9) NULLA** -- csak
unit (C2: 5/5) és böngésző-harness (C2b) futott.

## What Worked

- **Fázisolt S2->S1 scope** (Yoda javaslata, Laci jóváhagyta): az S2 önmagában
  értékes hordozható dashboard+adat, az S1 külön kör.
- **C2 backend 503-gating** unit-tesztekkel: `npm test` zöld a hoston, nem kell docker.
- **C2b böngésző-verifikáció izolált harness-szel** (Yoda A-opció): közvetlenül
  importált `startWebServer(<nem-3420 port>)`, `initDatabase()` előtte,
  `WEB_ONLY=true`, teardown finally-ben. A live 3420-at nem érinti. Ez fogott egy
  layout-bugot amit a tsc/parity gate nem (banner bal oszlopként renderelt -> fix
  `grid-column:1/-1`). Minta: nano memória id 605.

## What Didn't Work (buktatók -- FONTOS a következő tulajdonosnak)

- **PORT-LOCK INCIDENS (2026-07-17 ~19:37-19:41, én okoztam):** a worktree buildet
  `node dist/index.js`-szel futtatni TILOS. Ok: (1) a `config.ts` a `WEB_PORT`-ot
  `readEnvFile()`-ból (worktree/.env) veszi, a shell env-et IGNORÁLJA -> mindig
  3420-ra indul; (2) az `index.ts` boot-eleji `acquirePortLock(WEB_PORT)` KILÖVI a
  3420-at tartó live systemd dashboardot és átveszi a portot (WEB_ONLY alatt
  router+scheduler ki -> a flotta pár percig degradált). Helyreállás: a live systemd
  `Restart=on-failure` visszahozta. Tanulság memóriában: id 602. -> Konténer-UI/
  szolgáltatás lokál-teszthez SOHA a full boot; izolált harness (fent) vagy CI.
- **Nincs docker/docker-compose a fejlesztő-hoston** (audit-memória id 134 óta,
  csak bwrap van). Ezért a T1-T9 és minden image/compose validáció KIZÁRÓLAG CI-n
  (C9) mehet. A tervezés/írás nem igényel dockert, a build/smoke igen.
- **`sqlite3` CLI SINCS telepítve** a hoston -- a DB-t python3 `sqlite3` modullal
  kell lekérdezni (a `messages` tábla neve `agent_messages`).
- **Onboarding-finding (AGENT_RUNTIME=none alatt):** a `/api/onboarding/status`
  `needsOnboarding=true`-t ad, mert `agentsRunning()=false` (nincs konténeres tmux
  session). Vagyis egy VALÓDI konténerben a first-run onboarding wizard
  valószínűleg BLOKKOLNÁ a dashboardot (a C2b bannert se látnád). Ezt Yodának
  jeleztem (msg 1089) mint lehetséges C-blokk-igény (onboarding-skip a konténeres
  flow-hoz) -- NEM C2b-blokkoló, de a következő tulajdonosnak tisztázni kell.
- **`git commit -m "$(cat <<EOF...)"` heredoc** a nano-worktree-guard-ot triggeli
  ("redirect-határ nem parse-olható"). Commit-üzenetet fájlba írj és `git commit -F`.

## Next Steps (konkrét, végrehajtható)

1. **Olvasd el a teljes specet:** `agent_messages` msg 853-859 (store/claudeclaw.db,
   python3 sqlite3). A msg 859 a mérvadó C1-C12 + T1-T9. Erősítsd meg a status-
   térképet a `nano/containerize` git logból (`git log --oneline`, a docker-commitok:
   44a0237, 099b915, 45cff49, f291753, fbc136c).
2. **Tisztázd Yodával az onboarding-findinget** (msg 1089): kell-e egy új blokk/
   alpont az AGENT_RUNTIME=none melletti onboarding-skiphez, mielőtt a C5 compose
   élesíthető. Ez befolyásolja hogy a C2b banner egyáltalán látszik-e a konténerben.
3. **C9 (CI) -- ezt húzd előre**, mert ez az EGYETLEN validációs út (nincs helyi
   docker). GitHub Actions: x86_64+arm64 buildx build + compose-smoke (T1-T9 amennyi
   konténerben futtatható) + C7 titok-check. Yoda a CI-artefaktumokat reviewzza.
4. **C5 (docker-compose.yml) + C12** (port 127.0.0.1:3420:3420): a C1 Dockerfile és
   entrypoint már megvan, erre épül. WEB_HOST=0.0.0.0, TZ=Europe/Budapest,
   AUTO_UPDATE_ENABLED=0, AGENT_RUNTIME=none, user "1000:1000", init:true,
   stop_grace_period:30s, healthcheck a /healthz-re, volume marveen-store:/app/store,
   extra_hosts host-gateway.
5. **C3** (SQLite quick_check + wal_checkpoint startup + fail-loud + SIGTERM
   checkpoint) és **C4** (Ollama startup-healthcheck + degradáció) -- app-kód, a
   hoston is tesztelhető unit/integ szinten.
6. **C8** migrate-store-to-volume.sh, **C11** MARVEEN_API_URL (új kód env-alapú,
   default localhost:3420, hardcode tilos -- Yoda C11-grep-kaput fog nézni),
   **C10** README, **C7** CI titok-check.
7. **Munkamód (kötelező):** külön worktree-ben (`nano/`-branch), NE
   `node dist/index.js` full boot; minden lépést Yoda reviewz; EliteAI merge-el/
   buildel/deploy-ol -- a következő tulajdonos SOSE merge-el/deploy-ol önállóan.
   Minden konténer-validáció CI-n; a bizonyíték CI-run linkek + T1-T9 kimenetek.

BACKLOG (NEM ez a kör): a meglévő 37 hardcode-olt `localhost:3420` hely retrofitja
3 mechanizmusban (TS config-registry / Python fleet-helper közös lib / doksik-
CLAUDE.md szöveg) -- külön, későbbi kör (Yoda döntése, msg 858). NE nyúlj hozzá most.
