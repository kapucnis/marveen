#!/usr/bin/env bash
# C8: one-time migration of an existing HOST install's store/ (SQLite DB +
# WAL/SHM, memory, logs, tokens) into the named Docker volume the compose
# service (C5) mounts at /app/store. Uses `docker run --rm -v ... cp` to
# bridge a host bind-mount and a named volume (a named volume has no direct
# host filesystem path to `cp` into).
#
# SAFETY CONTRACT (do not weaken these without updating C9's T9 smoke test):
#   - COPY ONLY. This script never deletes, moves, or truncates the source
#     store/ directory, under any flag or code path. A failed/aborted
#     migration must leave the host install exactly as it was.
#   - Refuses to run against a volume that already has files, unless --force
#     is passed -- prevents silently clobbering an already-migrated or
#     already-live volume.
#   - Verifies integrity AFTER copying: file count parity (source vs volume)
#     + `PRAGMA quick_check` on the copied DB (via the same better-sqlite3
#     build the marveen image ships, run read-only). Any mismatch is a loud
#     failure, not a warning -- a migration you can't trust is worse than no
#     migration.
#
# Usage:
#   ./scripts/migrate-store-to-volume.sh [--force] [--dry-run]
#     [--source DIR] [--volume NAME] [--image NAME]
#
# An EMPTY volume needs no migration at all -- starting the marveen service
# against a fresh, empty named volume is a normal "new install" (the
# dashboard's own first-run / onboarding flow handles it); only run this
# script if you are moving data from an EXISTING host install.
set -euo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/store"
VOLUME="marveen-store"
IMAGE="marveen:latest"
FORCE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --source) SOURCE="$2"; shift 2 ;;
    --volume) VOLUME="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "FATAL: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: docker not found on PATH. This script bridges a host directory" >&2
  echo "       and a named Docker volume via a throwaway container -- it needs docker." >&2
  exit 1
fi

if [ ! -d "$SOURCE" ]; then
  echo "FATAL: source store directory not found: $SOURCE" >&2
  exit 1
fi
if [ ! -f "$SOURCE/claudeclaw.db" ]; then
  echo "FATAL: $SOURCE does not contain claudeclaw.db -- refusing to migrate what" >&2
  echo "       does not look like a real marveen store/ directory." >&2
  exit 1
fi

echo "== C8 store migration =="
echo "  source store: $SOURCE"
echo "  target volume: $VOLUME"
echo "  image (for the integrity check): $IMAGE"
echo

echo "!! Make sure the HOST marveen service is STOPPED before continuing --"
echo "   the SQLite DB must not be written to mid-copy (a live WAL means a" \
     "torn snapshot). Stop it however your install manages it (systemctl" \
     "stop / launchctl unload / kill the process), THEN re-run this script."
echo

SOURCE_FILE_COUNT="$(find "$SOURCE" -type f | wc -l | tr -d ' ')"
echo "Source file count: $SOURCE_FILE_COUNT"

# Does the volume already exist and already have data? A pre-existing,
# non-empty volume means either a prior migration already ran, or the
# service already booted fresh against it -- either way, blindly overwriting
# it is exactly the footgun --force exists to gate.
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  EXISTING_COUNT="$(docker run --rm -v "${VOLUME}:/to:ro" alpine:latest \
    sh -c 'find /to -mindepth 1 -type f 2>/dev/null | wc -l' | tr -d ' ')"
  if [ "$EXISTING_COUNT" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
    echo "FATAL: volume '$VOLUME' already exists and already contains" \
         "$EXISTING_COUNT file(s)." >&2
    echo "       Re-run with --force if you really mean to copy on top of it" \
         "(existing files with the same name are overwritten; nothing on" \
         "the source side is ever touched either way)." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would: docker run --rm -v \"$SOURCE:/from:ro\" -v \"$VOLUME:/to\" alpine:latest cp -a /from/. /to/"
  echo "[dry-run] would then verify: file count parity + quick_check on the copy."
  echo "[dry-run] no changes made."
  exit 0
fi

echo "Copying (source is never modified)..."
docker run --rm \
  -v "${SOURCE}:/from:ro" \
  -v "${VOLUME}:/to" \
  alpine:latest \
  sh -c 'mkdir -p /to && cp -a /from/. /to/'

echo "Copy finished. Verifying integrity..."

COPIED_FILE_COUNT="$(docker run --rm -v "${VOLUME}:/to:ro" alpine:latest \
  sh -c 'find /to -type f 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$COPIED_FILE_COUNT" != "$SOURCE_FILE_COUNT" ]; then
  echo "FATAL: file count mismatch after copy -- source had $SOURCE_FILE_COUNT," \
       "volume has $COPIED_FILE_COUNT. The source is untouched; the volume" \
       "copy should not be trusted. Inspect and re-run." >&2
  exit 1
fi
echo "  file count OK: $COPIED_FILE_COUNT files"

# Read-only quick_check on the COPY, using the same better-sqlite3 build the
# marveen image ships (ABI-matched to the image's node/arch -- a host-side
# sqlite3 CLI is not assumed to exist, and per C3 this is the same check the
# service itself runs on every boot). Overrides the image's entrypoint (which
# would otherwise `exec node dist/index.js`).
QUICK_CHECK_JS='const Database = require("better-sqlite3"); const db = new Database("/data/claudeclaw.db", { readonly: true }); const r = db.pragma("quick_check", { simple: true }); if (r !== "ok") { console.error("quick_check FAILED: " + r); process.exit(1); } console.log("quick_check: ok");'
if ! docker run --rm --entrypoint node \
  -v "${VOLUME}:/data:ro" \
  "$IMAGE" \
  -e "$QUICK_CHECK_JS"
then
  echo "FATAL: quick_check failed on the migrated database copy. The source" \
       "store/ is untouched. Do not point the compose service at this volume" \
       "until this is resolved (see C3's startup check for the same failure" \
       "mode -- the service itself would also refuse to boot against this copy)." >&2
  exit 1
fi

echo
echo "Migration OK: $COPIED_FILE_COUNT files copied, quick_check passed."
echo "The source directory ($SOURCE) was NOT modified or deleted."
echo "You can now: docker compose up -d"
