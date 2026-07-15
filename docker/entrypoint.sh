#!/bin/sh
# Marveen container entrypoint (C1). Fail LOUD and early if the store volume is
# not writable -- the DB, WAL, dashboard token, and every persisted artifact live
# under /app/store, so a read-only or wrong-owner mount must stop the boot with a
# clear message rather than crash cryptically inside DB init.
set -e

STORE_DIR="/app/store"

# The image declares uid 1000; the mounted named volume must be writable by it.
if ! mkdir -p "$STORE_DIR" 2>/dev/null; then
  echo "FATAL: cannot create store directory '$STORE_DIR' (uid $(id -u))." >&2
  echo "       Mount a writable named volume at /app/store (see docker-compose.yml)." >&2
  exit 1
fi

probe="$STORE_DIR/.write-probe.$$"
if ! ( : > "$probe" ) 2>/dev/null; then
  echo "FATAL: store directory '$STORE_DIR' is not writable by uid $(id -u)." >&2
  echo "       The named volume 'marveen-store' must be owned by / writable for uid 1000." >&2
  echo "       See the docker compose quickstart in README (volume permissions)." >&2
  exit 1
fi
rm -f "$probe"

exec node dist/index.js
