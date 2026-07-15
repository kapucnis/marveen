# syntax=docker/dockerfile:1
#
# Marveen platform-layer container (C1). Multi-stage: the builder compiles
# TypeScript AND the better-sqlite3 native binding (needs a C++ toolchain); the
# runtime is a slim image that carries ONLY the compiled production artifacts, so
# no build tools ship in the final image.
#
# The agent sessions (tmux + Claude Code CLI) are NOT in this image -- they run on
# the host (see AGENT_RUNTIME=none, C2). This image is the long-running service
# layer only: dashboard, memory, kanban, API, router, guards.

# ---- Builder ---------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# better-sqlite3 compiles a native binding on install; python3/make/g++ are the
# node-gyp toolchain. Present ONLY in the builder.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install with the full lockfile first (better cache: deps change less than src).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript -> dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Re-resolve to production-only deps IN THE BUILDER, where the toolchain exists,
# so better-sqlite3's native binding is compiled deterministically. The runtime
# stage copies this node_modules verbatim -- it never runs `npm ci` itself, so
# the slim runtime needs no compiler. Builder and runtime share the same base
# image + arch (buildx builds each arch separately), so the binding is ABI-safe.
RUN npm ci --omit=dev

# ---- Runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# curl is used by the compose healthcheck against /healthz (C6). Nothing else.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm config delete prefix 2>/dev/null || true

WORKDIR /app

# Production artifacts from the builder (node_modules carries the compiled
# better-sqlite3 binding; no toolchain needed here).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY web ./web
COPY templates ./templates
COPY seed-config ./seed-config
COPY scripts ./scripts

# Entrypoint wrapper: verifies /app/store is writable BEFORE booting (a mis-mounted
# or read-only volume otherwise fails deep inside DB init with a cryptic error).
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R 1000:1000 /app

# Non-root. The node:22 image already ships a 'node' account at uid/gid 1000.
USER 1000:1000

# store/ is a mounted named volume in production (see docker-compose); declaring
# it documents the writable data location and keeps an accidental run without a
# mount from writing into the image layer.
VOLUME ["/app/store"]

EXPOSE 3420

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
