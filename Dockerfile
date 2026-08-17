# syntax=docker/dockerfile:1

# Node 24 rather than the 25.x used for development: it is the line that still
# gets security updates. Nothing here depends on a 25-only API — the sources
# import only node:crypto, node:fs, node:path and node:readline, and the agent
# core declares node >= 22.19.
ARG NODE_VERSION=24
ARG PNPM_VERSION=11.22.0

# Both stages start from this. Overridable so a build on a network that cannot
# reach Docker Hub can point at a mirror, e.g.
# `--build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-bookworm-slim`.
ARG NODE_IMAGE=node:${NODE_VERSION}-bookworm-slim

# ---- build ------------------------------------------------------------------
# Pinned to the *build* platform on purpose. The output is plain JavaScript and
# no dependency ships a native binding, so none of this needs to match the
# target architecture; a linux/arm64 image therefore still runs tsc and the
# pnpm install natively instead of under QEMU emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder

ARG PNPM_VERSION

# PNPM_HOME is also where pnpm puts its content-addressable store, which is what
# the cache mounts below target.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# lefthook's postinstall installs git hooks into INIT_CWD, and there is no
# repository here. It skips itself when CI is set — see its postinstall.js;
# LEFTHOOK=0 alone would not do it, that variable is only read when CI is truthy.
ENV CI=true \
    LEFTHOOK=0

# Installed rather than activated through corepack: corepack is on its way out
# of the Node distribution, and this pins the version explicitly either way.
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app

# Manifests first, so the install layer is invalidated by a dependency change
# and not by every edit to src/.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# `tsc`, which typechecks as it emits: a type error fails the image build, so a
# broken commit never reaches the registry.
RUN pnpm run build

# Drops devDependencies in place. What survives is exactly what
# `node dist/index.js` loads at runtime.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm prune --prod

# ---- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini, because this container runs a shell on the model's behalf: the agent's
# bash tool spawns process trees, and PID 1 has to be a real init or every
# finished command is left behind as a zombie. It also forwards SIGTERM, which
# src/index.ts installs a handler for.
#
# bash itself comes with the base image and is what the agent tool looks for
# first; without it the tool silently falls back to plain sh.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# HOST: src/config.ts defaults to loopback so that a dev server is not exposed on
# the local network. Inside a container that makes the server unreachable from
# outside it, so the image says otherwise.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# Absolute, so the paths are the same whatever working directory a platform
# starts the process in, and so they line up with the volumes declared below.
ENV DATA_DIR=/app/data \
    WORKSPACE_DIR=/app/workspace \
    SESSION_DIR=/app/sessions \
    MEMORY_DIR=/app/memory

# On the shell allowlist in src/config.ts. Docker does not derive it from
# /etc/passwd, so without this the agent's bash tool would run with no HOME.
ENV HOME=/home/node

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Created here, before the volumes exist, so that a fresh named volume inherits
# node's ownership from the image. The process is unprivileged and could not
# create these itself under a root-owned /app.
RUN mkdir -p /app/data /app/workspace /app/sessions /app/memory \
 && chown node:node /app/data /app/workspace /app/sessions /app/memory

# Unprivileged, and the agent's shell inherits it: whatever the model decides to
# run is confined to what this user can reach.
USER node

EXPOSE 3000

# /health rather than a TCP probe, so a process that is listening but has failed
# to build a report still counts as unhealthy. Node's global fetch avoids
# installing curl for the sake of one request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node directly rather than `pnpm start`: one less process between the init and
# the server, and signals reach the handler without being forwarded.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

# Set again by the CI metadata step for published images; kept here so a
# locally built image still points back at the repository.
LABEL org.opencontainers.image.source="https://github.com/bestony/DeepTag" \
      org.opencontainers.image.title="DeepTag" \
      org.opencontainers.image.description="Deepseek implement of Claude Tag"
