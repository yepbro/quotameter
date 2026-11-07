# Development image for Quotameter.
#
# Reproducible toolchain for building, testing, and running the service without
# host-installed Node.js. The public distribution channel is the npm package;
# this image is not used for production packaging.
#
# Node.js 22.13.0 is the minimum supported runtime (built-in node:sqlite
# without the --experimental-sqlite flag); keeping the development image at the
# minimum version catches accidental use of newer APIs early.
FROM node:22.13.0-bookworm-slim

# Tools needed inside the container: TLS roots, HTTP client for diagnostics,
# git for tooling that clones repositories, dumb-init for correct signal
# handling (PID 1 reaping, SIGTERM propagation), and the passwd tools —
# usermod/groupmod, explicitly declared for the uid remap below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git dumb-init procps passwd \
        libglib2.0-0 libnss3 libnspr4 libasound2 \
        libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
        libpango-1.0-0 libcairo2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# npm 11: the registry retired the quick-audit endpoint on 2026-10-30 and
# the npm bundled with Node 22.13 (10.9.x) can no longer run `npm audit`;
# npm 11 uses the bulk advisory endpoint. Node stays at the 22.13.0 minimum.
RUN npm install -g npm@11.9.0

WORKDIR /app

# Match the container user to the host user (decision D-181): compose passes
# DEV_UID/DEV_GID as build args — the Makefile exports the host uid/gid — so
# container-side tools (prettier --write, eslint --fix, codegen) can rewrite
# tracked files created host-side without EACCES. The 1000:1000 defaults keep
# the image's own `node` user and the whole step a no-op. Remapping the
# existing user (rather than a numeric `USER`) keeps a passwd entry, so
# HOME=/home/node and every name-based path resolution keep working.
ARG DEV_UID=1000
ARG DEV_GID=1000

# Prepare writable directories for the non-root `node` user:
# - /app/node_modules is the mount point for the persisted dependency volume;
# - /home/node/.cache holds the npm/Playwright caches between builds;
# - /var/lib/quotameter holds isolated development config/data volumes and
#   must be owned by `node` so named volumes inherit the right ownership
#   (a fresh named volume seeds its root ownership from these directories).
# The remap refuses an id another image account/group already holds (root,
# nobody, the `users` group, …) with a named error instead of a raw
# usermod/groupmod failure, and never remaps onto uid/gid 0.
RUN mkdir -p /app/node_modules /home/node/.cache /var/lib/quotameter/config /var/lib/quotameter/data \
    && if [ "$DEV_UID" != "1000" ]; then \
        if getent passwd "$DEV_UID" >/dev/null; then \
          echo "DEV_UID=$DEV_UID is already taken by another account in the image; cannot remap 'node' onto it" >&2; \
          exit 1; \
        fi; \
        usermod -u "$DEV_UID" node; \
    fi \
    && if [ "$DEV_GID" != "1000" ]; then \
        if getent group "$DEV_GID" >/dev/null; then \
          echo "DEV_GID=$DEV_GID is already taken by another group in the image; cannot remap 'node' onto it" >&2; \
          exit 1; \
        fi; \
        groupmod -g "$DEV_GID" node; \
    fi \
    && chown -R node:node /app /home/node /var/lib/quotameter

USER node

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

ENTRYPOINT ["dumb-init", "--"]
CMD ["bash"]
