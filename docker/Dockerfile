# syntax=docker/dockerfile:1
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f docker/Dockerfile -t ivanti-mcp .
#   docker compose -f docker/compose.yaml up
#
# `.dockerignore` stays at the root because that is where the context is and where
# the classic builder looks for it; BuildKit would also accept
# `docker/Dockerfile.dockerignore`, but a second copy is a second thing to drift.
#
# BASE IMAGES ARE PINNED BY DIGEST, with the tag kept beside it for the reader. A
# tag is a pointer the publisher moves; a digest is the bytes this was tested on.
# Dependabot (.github/dependabot.yml) proposes the next digest as a pull request,
# so a base-image change arrives reviewed and CI-built rather than silently on the
# next rebuild. Both are multi-arch indexes (amd64 and arm64 among them).
#
# pnpm is pinned rather than taken from corepack, which has been moved and
# deprecated across Node releases. It must equal package.json's `packageManager`,
# and `pnpm check:docker` fails when the two disagree.
ARG PNPM_VERSION=10.20.0

# ──────────────────────────────────────────────────────────────────────────────
# Build: the toolchain never reaches the final image.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
ARG PNPM_VERSION
RUN npm install --global "pnpm@${PNPM_VERSION}"

# Dependencies first, so a source-only change does not re-resolve the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ──────────────────────────────────────────────────────────────────────────────
# Production dependencies, laid out flat.
#
# pnpm's default store is a tree of symlinks into a content-addressed store,
# which does not survive a COPY into another image: the links point at paths
# that are not there. `--node-linker=hoisted` writes real directories instead.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN npm install --global "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --node-linker=hoisted --ignore-scripts

# Nothing here is read by a running process: type declarations are a compile-time
# artefact, source maps need --enable-source-maps (which this image does not pass),
# and READMEs are documentation. ~10 MB of a 28 MB tree. LICENCE files stay — MIT
# and friends require the notice to travel with the distribution.
# `-not -iname 'licen[cs]e*'` is load-bearing: four production packages (jose, ms, qs,
# json-schema-typed) ship their licence ONLY as a .md file, and `-name '*.md'` deleted it —
# leaving the MIT permission notice and the BSD conditions in neither the image nor
# THIRD-PARTY-NOTICES.md. The comment below was true for 94 of 99 packages and false for
# exactly the ones that needed it.
RUN find node_modules \( -name '*.d.ts' -o -name '*.md' -o -name '*.map' \) \
      -not -iname 'licen[cs]e*' -not -iname 'copying*' -type f -delete

# ──────────────────────────────────────────────────────────────────────────────
# Runtime: distroless. No shell, no package manager, no npm — nothing to exec
# into and nothing to install from, which is the point. Runs as `nonroot`.
#
# Debian 13, not 12: the debian12 image stopped being rebuilt, so its newest
# digest still carried the OpenSSL and glibc that Debian had long since fixed
# (docs/notes.md). The digest is the multi-arch index.
# ──────────────────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Standard OCI metadata, so `docker inspect` answers what this is and on what
# terms without anyone opening the repository.
LABEL org.opencontainers.image.title="SYNERGY Ivanti MCP" \
      org.opencontainers.image.vendor="SYNERGY" \
      org.opencontainers.image.url="https://www.synergy.eu" \
      org.opencontainers.image.source="https://github.com/syn-con/ivanti-mcp" \
      org.opencontainers.image.licenses="LicenseRef-SYNERGY-Commercial"

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `src/version.ts` reads ../package.json at startup and the server refuses to
# start without it: an unidentifiable deployment is worse than one that fails.
COPY package.json ./
# Permissive licences require their notices to travel with the distribution, so
# they travel inside the image rather than only in the repository.
COPY LICENSE THIRD-PARTY-NOTICES.md ./
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs

# No EXPOSE: the ports are MCP_PORT and METRICS_PORT, which have no built-in value, and an
# EXPOSE would name one the server is not listening on. EXPOSE publishes nothing anyway.

# There is no shell, so this is the exec form against the image's own node.
# The script exits 0 when the HTTP transport is off — a stdio deployment has
# nothing to poll, and a container that reports itself unhealthy for running as
# designed is worse than no check at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "docker/healthcheck.mjs"]

# The distroless entrypoint is already `node`.
CMD ["dist/index.js"]
