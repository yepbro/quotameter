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
# git for tooling that clones repositories, and dumb-init for correct signal
# handling (PID 1 reaping, SIGTERM propagation).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git dumb-init procps \
        libglib2.0-0 libnss3 libnspr4 libasound2 \
        libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
        libpango-1.0-0 libcairo2 libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Prepare writable directories for the non-root `node` user:
# - /app/node_modules is the mount point for the persisted dependency volume;
# - /home/node/.cache holds the npm/Playwright caches between builds;
# - /var/lib/quotameter holds isolated development config/data volumes and
#   must be owned by `node` so named volumes inherit the right ownership.
RUN mkdir -p /app/node_modules /home/node/.cache /var/lib/quotameter/config /var/lib/quotameter/data \
    && chown -R node:node /app /home/node /var/lib/quotameter

USER node

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

ENTRYPOINT ["dumb-init", "--"]
CMD ["bash"]
