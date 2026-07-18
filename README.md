# Marveen

![Marveen Banner](banner.png)

[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5+Vector-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Anthropic-D97757?logo=anthropic&logoColor=white)](https://claude.ai/code)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed-000000?logo=ollama&logoColor=white)](https://ollama.com/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Slack](https://img.shields.io/badge/Slack-Socket_Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/)
[![GitHub stars](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)

> AI csapatod, ami fut amíg te alszol.

Marveen egy AI asszisztens keretrendszer, ami Claude Code-ra épül. Saját AI csapatot építhetsz, akik Telegramon vagy Slacken kommunikálnak veled, önállóan dolgoznak, és egymással is együttműködnek.

## Funkciók

- **AI Csapat**: Több ágens, mindegyik saját csatornával (Telegram vagy Slack), személyiséggel és memóriával
- **Mission Control**: Web dashboard (http://localhost:3420) a csapat kezeléséhez
- **Inter-agent kommunikáció**: Az ágensek delegálhatnak egymásnak feladatokat
- **Ütemezések**: Cron-alapú feladatok automatikus futtatása
- **Kanban**: Feladattábla AI auto-bontással; Jira-szerű nézetek — swimlane (csoportosítás felelős vagy prioritás szerint), oszloponkénti WIP-limit, beakadt-kártya jelzés (card-aging), alfeladat-beágyazás és kártya-szerkesztő
- **Heartbeat**: Csendes háttér-monitorozás, csak fontosnál szól (naptár, email, kanban)
- **Memória**: Hot/Warm/Cold tier rendszer, hibrid kereséssel (FTS5 + vektor) és gráf nézettel
- **MCP Connectorok**: Gmail, Calendar, Drive, Notion, Slack és más szolgáltatások
- **Skillek**: Újrahasználható képességek az ágenseknek
- **Öntanulás**: Az ágensek automatikusan tanulnak a munkájukból és skill-eket hoznak létre

## 📚 Dokumentáció

Részletes, funkciónkénti leírások a [`docs/`](docs/README.md) mappában — mindegyik lap két szemszögből: 🎯 *mit tud / miért érdekes* + 🛠 *hogyan működik*.

| Funkció | Lap |
|---------|-----|
| Heartbeat + fokozatos autonómia | [docs/heartbeat-autonomy.md](docs/heartbeat-autonomy.md) |
| Memória-rendszer (FTS5 + vektor + RRF) | [docs/memory-system.md](docs/memory-system.md) |
| Kanban (auto-breakdown, swimlane, WIP-limit, card-aging) | [docs/kanban.md](docs/kanban.md) |
| Ügynök-flotta + inter-agent | [docs/agent-fleet.md](docs/agent-fleet.md) |
| Skill-factory (öntanulás) | [docs/skill-factory.md](docs/skill-factory.md) |
| Channels (Telegram / Slack) | [docs/channels.md](docs/channels.md) |
| Printing-press CLI-k | [docs/printing-press-cli.md](docs/printing-press-cli.md) |
| Skool CLI | [docs/skool-cli.md](docs/skool-cli.md) |
| connectors.hu | [docs/connectors-hu.md](docs/connectors-hu.md) |
| Vault & titkosítás | [docs/vault.md](docs/vault.md) |
| Dream-engine | [docs/dream-engine.md](docs/dream-engine.md) |
| Háttér-feladatok | [docs/background-tasks.md](docs/background-tasks.md) |
| Ütemezett feladatok | [docs/scheduled-tasks.md](docs/scheduled-tasks.md) |
| Költöztetés (másik gépre) | [docs/MIGRATION.md](docs/MIGRATION.md) |
| Beszélgetés-folytonosság | [docs/conversation-continuity.md](docs/conversation-continuity.md) |
| Channel reply-guard | [docs/channel-reply-guard.md](docs/channel-reply-guard.md) |
| Telegram haladásjelző | [docs/telegram-progress-indicator.md](docs/telegram-progress-indicator.md) |
| Új asszisztens onboarding | [docs/onboarding-uj-asszisztens.md](docs/onboarding-uj-asszisztens.md) |

## Öntanulás & Seed-ek

Az ágensek automatikusan tanulnak a munkájukból: komplex feladat vagy hiba-recovery után újrahasznosítható skill-t (recept) írnak maguknak, a meglévőket pedig célzottan patch-elik. A skill-ek token-hatékonyan, 3 szinten töltődnek (progressive disclosure). A flotta-szintű skill-ek és ütemezett feladatok a `seed-skills/` és `seed-scheduled-tasks/` mappából terjednek minden telepítésre (idempotens: a meglévő testreszabást nem írja felül).

→ **Részletek:** [docs/skill-factory.md](docs/skill-factory.md)

## Memória rendszer

Minden ágens saját, réteges memóriával rendelkezik (hot / warm / cold / shared), SQLite-ban tárolva. A keresés hibrid: FTS5 full-text + szemantikus vektor (Ollama `nomic-embed-text`), RRF-fel fúzionálva. A memóriák salience decay-en mennek át (a régi, nem használt tételek halványulnak, de sosem törlődnek), és minden este napi napló készül. A `PreCompact` hook a kontextus-tömörítés előtt automatikusan elmenti a fontos döntéseket. A dashboardon gráf-nézet is van.

→ **Részletek:** [docs/memory-system.md](docs/memory-system.md)

## Telepítés

### macOS / Linux

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh
```

### Windows (WSL)

```powershell
irm https://raw.githubusercontent.com/Szotasz/marveen/main/install-windows.ps1 | iex
```

Vagy manuálisan:
```powershell
git clone https://github.com/Szotasz/marveen.git
cd marveen
.\install-windows.ps1
```

A Windows telepítő automatikusan beállítja a WSL-t (Windows Subsystem for Linux) és azon belül telepíti a Marveen-t.

> **Ha a PowerShell ablak bezárul / a telepítő nem jut túl a WSL+Ubuntu lépésen:** nyisd meg az Ubuntu-t (Start menü → Ubuntu), majd a WSL Ubuntu shellben futtasd közvetlenül a Linux-telepítőt (a PowerShell wrapper megkerülése):
> ```bash
> curl -fsSL https://raw.githubusercontent.com/Szotasz/marveen/main/install-linux.sh -o install.sh && bash install.sh
> ```
> Ez a megbízható út, ha a `wsl.exe`/Windows-claude környezet összeakad.

A telepítő végigvezet a beállításokon:
1. Függőségek ellenőrzése és telepítése
2. Claude Code bejelentkezés
3. Telegram bot létrehozása
4. Személyes beállítások (a bot neve és a termék/márka neve)
5. Szolgáltatások indítása

### Branding (saját márkanév)

A platform szabadon márkázható telepítéskor. Két, egymástól **független** beállítás:

| Beállítás | Mi ez | Default |
|-----------|-------|---------|
| `BOT_NAME` | A fő ágens megjelenített neve (pl. `MyAssistant`) | `Marveen` |
| `BRAND_NAME` | A termék / rendszer neve a dashboard fejlécében (böngésző-cím, oldalsáv, mobil topbar) | `BOT_NAME` |

A telepítő mindkettőt megkérdezi. Ha csak Entert nyomsz, minden marad `Marveen` (a viselkedés változatlan a meglévő telepítésekhez képest). Ha külön márkanevet adsz meg, a teljes felület és az OS szolgáltatás-azonosítók is azzal jönnek létre:

```bash
# Példa: az ágens neve "MyAssistant", a terméké "AcmeAI"
#   Mi legyen a botod neve? [Marveen]: MyAssistant
#   Mi a termék/márka neve? [MyAssistant]: AcmeAI
```

A `.env`-ben ezek a kulcsok jelennek meg (lásd `.env.example`):

```env
BOT_NAME=MyAssistant
BRAND_NAME=AcmeAI
MAIN_AGENT_ID=myassistant   # belső ágens-azonosító (a BOT_NAME ASCII slug-ja)
SERVICE_ID=acmeai           # OS szolgáltatás-azonosító (a BRAND_NAME ASCII slug-ja)
```

A `MAIN_AGENT_ID` és `SERVICE_ID` értékeket a telepítő automatikusan származtatja; ritkán kell kézzel szerkeszteni. Ha a `BRAND_NAME` megegyezik a `BOT_NAME`-mel (a default), a `SERVICE_ID` megegyezik a `MAIN_AGENT_ID`-vel, így a launchd/systemd unit-nevek byte-azonosak a márkázatlan telepítéssel: a helyben történő frissítés nem törik el.

## Használat

### Dashboard
Nyisd meg: http://localhost:3420

### Csatorna (Telegram vagy Slack)

A telepítés során választhatsz csatorna providert. Az alapértelmezett a Telegram.

#### Telegram (alapértelmezett)
Írj a botodnak Telegramon -- Marveen válaszol.

#### Slack (alternatív)

Slack használatához a telepítő automatikusan végigvezet, de manuálisan is beállíthatod:

1. Hozz létre egy Slack App-ot a [Slack API](https://api.slack.com/apps) oldalon
2. Engedélyezd a Socket Mode-ot (Settings > Socket Mode > Enable)
3. Generálj egy App-Level Token-t (`xapp-...`) a `connections:write` scope-pal
4. Add hozzá a Bot Token Scopes-okat (OAuth & Permissions): `chat:write`, `channels:read`, `files:write`, `files:read`
5. Installáld az App-ot a workspace-edbe -- megkapod a Bot User OAuth Token-t (`xoxb-...`)
6. Hívd meg a botot a kívánt csatornába (`/invite @BotNev`)
7. A `.env` fájlban állítsd be:
   ```
   CHANNEL_PROVIDER=slack
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   SLACK_CHANNEL_ID=C01234ABCDE
   ```
8. A Slack channel plugin automatikusan települ: `slack@jeremylongshore/claude-code-slack-channel`

A csatorna váltáshoz futtasd újra a `./install.sh`-t vagy szerkeszd a `.env` fájlt manuálisan.

### Ágensek
A Csapat oldalon hozz létre új ágenseket. Mindegyik:
- Saját Telegram bot
- Saját személyiség (SOUL.md)
- Saját utasítások (CLAUDE.md)
- Saját memória és skillek

### Telegram bot profilkép

A telepítő automatikusan generál egy pixel-art avatart és Telegramon elküldi neked a beállítási utasításokkal. Ha egyedi képet szeretnél:

1. Tedd a fájlt `agents/<AGENT_NEVE>/avatar.png` alá (png/jpg/jpeg/webp)
2. Indítsd újra a szolgáltatást (`./scripts/stop.sh && ./scripts/start.sh`)
3. Az install-flow újra elküldi az avatart a Telegram chatbe

**Beállítás a Telegram botodra:**
1. Nyisd meg a [@BotFather](https://t.me/BotFather) chatet
2. Küld a `/setuserpic` parancsot
3. Válaszd ki a botodat a listából
4. Küldd be a kapott képet

A dashboardon (Csapat oldal) is cserélhetsz avatart: kattints a bot kártyájára, válassz a galériából vagy tölts fel sajátot -- a rendszer automatikusan elküldi a Telegram chatbe.

### Ütemezések
Időzített feladatok és heartbeat monitorok beállítása:
- Lista, napi idővonal és heti nézet
- Feladat: mindig szól az eredménnyel
- Heartbeat: csendes ellenőrzés, csak fontosnál értesít

### Vault & Titkosítás

Az MCP szerverek API kulcsait, tokenjeit és jelszavait egy titkosított Vault kezeli (AES-256-GCM), a master key macOS-en a Keychain-ben (Linuxon fájl-alapú fallback). A `.mcp.json`-ben csak `vault:SECRET_ID` referenciák állnak — a plaintext kulcsok nem hevernek olvashatóan. A dashboard Vault-oldalán kezelheted a titkokat, a Scan & Import megtalálja a meglévő plaintext kulcsokat.

→ **Részletek:** [docs/vault.md](docs/vault.md)

### Ágens monitorozás

A `monitor_agents.sh` script összefogja az összes futó ágens tmux session-jét egyetlen `monitor` session-be, iTerm2 Control Mode-dal (`-CC`) minden ágens külön iTerm tab-ként jelenik meg.

```bash
# Lokálisan (a gépen ahol az ágensek futnak):
./scripts/monitor_agents.sh

# Távolról (laptopról SSH-n, iTerm2-vel):
ssh macmini -t "~/marveen/scripts/monitor_agents.sh"

# Ha új ágens indult és nem látod a monitorban -- kill + újraindítás:
ssh macmini "/opt/homebrew/bin/tmux kill-session -t monitor" && \
  ssh macmini -t "~/marveen/scripts/monitor_agents.sh"
```

A script automatikusan felderíti a futó `agent-*` és `marveen-channels` session-öket. A monitor session törlése nem érinti az ágens session-öket -- csak a linked-window referenciákat szünteti meg.

### Frissítés
```bash
./update.sh
```

### Leállítás / Indítás
```bash
./scripts/stop.sh
./scripts/start.sh
```

### VPS / AWS EC2 telepítés (szerver)

Linux VPS-en (Ubuntu 22+, Debian 12+) az `./install.sh` automatikusan az `install-linux.sh`-t futtatja. Headless szerveren a bejelentkezéshez OAuth token kell, mert nincs böngésző.

```bash
# 1. A SAJÁT gépeden (ahol van böngésző):
claude setup-token
# Másold ki a generált tokent (sk-ant-oat01-...)

# 2. A VPS-en:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh    # automatikusan install-linux.sh-t futtat
```

A token 1 évig érvényes. Ne állíts be `ANTHROPIC_API_KEY`-t mellé.

**Fontos VPS-specifikus tudnivalók:**
- **RAM**: legalább 2 GB ajánlott (t3.small). 1 GB-os gépen az npm build swap nélkül elbukhat -- a telepítő figyelmeztet és felajánl swap-létrehozást.
- **claude.ai MCP-k**: ha a claude.ai fiókodban sok MCP connector van engedélyezve, a headless claude session megpróbálja betölteni mindet, ami instabilitást okozhat. Telepítés előtt tiltsd le a felesleges MCP-ket a claude.ai Settings oldalán.
- **Közvetlen futtatás**: `./install-linux.sh` (Linux) vagy `./install-macos.sh` (macOS) ha az OS-detekciót ki akarod hagyni.

## Konténerizálás (Docker)

Ez az **S2 fázis** (platform-réteg, backend-only): a hosszan futó szolgáltatások
(dashboard, memória, kanban, API, üzenet-router, guard hookok) `docker compose
up`-pal indíthatók, `.env`-ből konfigurálva, named volume-on perzisztálva. Az
ágens-sessionök (tmux + Claude Code CLI) **a gazdagépen maradnak** és a
hálózaton keresztül érik el a konténerizált szolgáltatásokat -- a teljes CLI
konténerbe költöztetése (**S1**) egy későbbi, külön fázis, ebben a körben nincs
megvalósítva.

### Gyorsindítás

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
cp .env.example .env
# szerkeszd a .env-et: TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, OWNER_NAME, stb.
docker compose up -d
curl http://127.0.0.1:3420/healthz   # {"ok":true,"db":"ok"}
```

Első indításkor a `store/` üres -- ez egy normál "friss telepítés" (a dashboard
saját first-run/onboarding folyamata kezeli). Ha egy MEGLÉVŐ, host-alapú
telepítésről költözöl, a store-t előbb migráld ([lásd lent](#migráció-meglévő-host-telepítésről)),
NE üres volume-mal indulj.

### Környezeti változók

A `.env`-et ugyanúgy tölti be a konténer (`env_file:`), mint a host-telepítés --
egyetlen fájl, ugyanaz a formátum. Öt kulcs viszont **rögzített** a
`docker-compose.yml`-ben, a konténeres üzemmódhoz kötve; ezeket a `.env`-ben
megadott érték nem írja felül:

| Változó | Rögzített érték | Miért |
|---|---|---|
| `WEB_HOST` | `0.0.0.0` | a `127.0.0.1` alapérték a konténeren belül elérhetetlen lenne a port-mapping felől |
| `AGENT_RUNTIME` | `none` | jelzi, hogy a tmux/Claude Code CLI a gazdagépen fut, nem itt -- ez kapcsolja ki a tmux-érintő végpontokat/szolgáltatásokat |
| `TZ` | a `.env` `TZ` értéke, alapért. `Europe/Budapest` | minden cron-ütemezés node-lokál TZ-ben értelmeződik |
| `OLLAMA_URL` | a `.env` `OLLAMA_URL` értéke, alapért. `http://host.docker.internal:11434` | a host-alapértelmezett (`localhost:11434`) a konténeren belül nem a hostot jelentené |
| `AUTO_UPDATE_ENABLED` | `0` | a host-alapú `update.sh` (git pull + systemd restart) nem értelmezhető image-újraépítésnél; frissítéshez építsd újra az image-et |

Minden más `.env` kulcs (Telegram/Slack tokenek, `OWNER_NAME`, `KANBAN_*`
beállítások, stb.) ugyanúgy működik, mint a host-telepítésen.

`MARVEEN_API_URL` -- ha a szolgáltatás-réteg később külön szerver-VM-re
költözik, ez az EGYETLEN dolog, amit a gazdagépen futó ágenseknek/scripteknek
át kell állítani (alapérték: `http://localhost:3420`).

### Volume és perzisztencia

A teljes `store/` (SQLite adatbázis + WAL/SHM, memória, logok, tokenek) egyetlen
named volume-on (`marveen-store`) él, **sosem az image-be sütve**. Indításkor a
szolgáltatás `PRAGMA quick_check`-et fut, majd `wal_checkpoint`-ol; sérült
adatbázisnál **hangosan, auto-repair nélkül** leáll (időbélyeges másolatot
mentve a hibás fájlról vizsgálatra) -- ez szándékos: egy rossz automata
javítás rosszabb, mint egy megállt indítás. `docker compose stop`-nál a
szolgáltatás checkpointol és bezárja az adatbázist, mielőtt a konténer leáll
(`init: true` + `stop_grace_period: 30s` ad rá időt).

### Migráció meglévő host-telepítésről

Ha már fut egy host-alapú (nem konténeres) telepítésed, és át akarsz állni
konténerre:

```bash
# 1. Állítsd le a HOST szolgáltatást (systemctl stop / launchctl unload / stb.)
#    -- az adatbázisba írás közben nem szabad másolni.
# 2. Másold a store/-ot a named volume-ba:
./scripts/migrate-store-to-volume.sh
# 3. Indítsd a konténert:
docker compose up -d
```

A script **csak másol, sosem töröl** -- a host `store/` könyvtárad érintetlen
marad, bármi történjen is. Másolás után fájlszám-egyezést és
`PRAGMA quick_check`-et ellenőriz a bemásolt adatbázison; hiba esetén hangosan
leáll, a forrás mellé nem is nyúlva. `--dry-run`-nal megnézheted előre, mit
csinálna; `--help`-pel a teljes opciólista.

### Ollama (szemantikus memória-keresés) Mac/Windows alatt

Linuxon az `extra_hosts: host-gateway` (már benne van a `docker-compose.yml`
-ben) elég ahhoz, hogy a konténer elérje a host-on futó Ollamát a
`host.docker.internal` néven. **Docker Desktop (Mac/Windows) ezt natívan
biztosítja**, nincs extra teendő.

Ha a gépeden egyáltalán nincs Ollama telepítve, egy opcionális `ollama`
compose-profillal indítható konténerben is:

```bash
docker compose --profile ollama up -d
# .env: OLLAMA_URL=http://ollama:11434
```

Ha Ollama induláskor nem elérhető, a dashboard erről hangos figyelmeztetést ad
(banner + log), és a keresés automatikusan kulcsszavas módra vált -- ez nem
blokkolja az indulást, csak a szemantikus keresés minősége csökken.

### S1 kitekintés

Ez a kör (S2) szándékosan **nem** teszi konténerbe az interaktív ágens-
sessionöket (tmux + Claude Code CLI) -- azok maradnak a gazdagépen, és a
konténerizált szolgáltatás-réteget hálózaton érik el. A teljes CLI
konténerbe költöztetése (S1: minden, beleértve az ágens-sessionöket is, egy
image-ben) egy külön, későbbi kör -- nagyobb scope (pl. Claude Code CLI +
hitelesítés-kezelés konténerben, tmux-session perzisztencia), erre most nem
készült terv.

> Ez a szakasz csak a `marveen-store` volume migrálásáról szól. Ha a **teljes
> flottát** (skillek, per-agent identitás, csatorna-tokenek, stb. is) másik
> gépre költözteted, azt a [docs/MIGRATION.md](docs/MIGRATION.md) futtatási
> útmutató írja le végig -- az ottani leltár jelenleg még nem tartalmazza a
> konténeres `marveen-store` volume-ot (ez a mód még nincs élesítve), a
> `docker run --rm -v ... alpine cp` mintát viszont már ugyanúgy használja a
> `projects/loxonTSDB/` compose-stack volume-jaihoz -- ha/amikor a marveen
> konténeres módra áll, ugyanez az idióma alkalmazható rá is (lásd
> `scripts/migrate-store-to-volume.sh`).

## Követelmények

- macOS, Linux, vagy Windows 10/11 (WSL-lel)
- Node.js 20+
- Claude Code CLI (Claude Max/Pro előfizetés szükséges)
- Telegram fiók vagy Slack workspace

## Közösség és támogatás

Kérdésed van? Csatlakozz az AI a mindennapokban közösséghez:

- **Skool közösség**: [skool.com/ai-a-mindennapokban](https://skool.com/ai-a-mindennapokban) -- oktatóanyagok, kérdések, tapasztalatcsere
- **YouTube**: [AI a mindennapokban](https://www.youtube.com/@aiamindennapokban) -- videók, tutorialok
- **Weboldal**: [aiamindennapokban.hu](https://aiamindennapokban.hu)

## Támogasd a projektet

Ha hasznos számodra a Marveen, támogasd a fejlesztést:

[![Támogatás](https://img.shields.io/badge/Támogatás-Donably-orange)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## Köszönet

A Marveen több külső projektre és koncepcióra épít. A teljes felsorolás (forrás, szerző, licensz, hogyan használjuk) az [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) fájlban található. Köszönet a Perplexity AI-nek (Bumblebee), Artem Zhutovnak (handoff / retrospective / skill-management skill suite), Mike Van Hornnak (printing-press), Andrej Karpathynak (CLAUDE.md pattern), és Matt Pococknak (handoff design tippek) a munkájukért.

## Készítette

**Szota Szabolcs** -- AI konzultáns, az "AI a mindennapokban" csatorna készítője

[![GitHub](https://img.shields.io/github/stars/Szotasz/marveen?style=social)](https://github.com/Szotasz/marveen)
