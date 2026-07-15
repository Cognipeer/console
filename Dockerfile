# --------------------- deps stage ---------------------
FROM node:22 AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* npm-shrinkwrap.json* ./
RUN npm ci --no-audit --no-fund

# --------------------- builder stage ---------------------
FROM node:22 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# When set to 1 (e.g. by docker-compose.e2e.yml) the build skips the strict
# type/lint gate. Defaults to empty → normal strict production build.
ARG E2E_BUILD=
ENV E2E_BUILD=${E2E_BUILD}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  && rm -rf .next/cache

# --------------------- runner stage ---------------------
FROM node:22 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce-cli \
       docker-buildx-plugin \
       docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*


RUN curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" \
    && chmod +x /usr/local/bin/kubectl

RUN npx playwright install-deps chromium

RUN mkdir -p /home/node/.cache/ms-playwright && \
    mkdir -p /app/data && \
    chown -R node:node /home/node

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/docker ./docker
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/mail-templates ./mail-templates


RUN mkdir -p /app/.next/cache/images && \
    chown -R node:node /app

USER node

RUN npx playwright install chromium

EXPOSE 3000
# Invoke node directly instead of `npm start`. `npm` as PID 1 does not
# reliably forward SIGTERM to the child node process, so on every restart/
# redeploy the orchestrator's SIGTERM was effectively swallowed and the
# container sat until the hard-kill grace period expired — `initLifecycle()`'s
# graceful shutdown handlers (queue drain, cache/db disconnect, etc., see
# src/lib/core/lifecycle.ts) never ran. Any crawl job `running` at that
# moment was hard-killed mid-crawl instead of shutting down cleanly, which is
# consistent with production crawls stopping partway through instead of
# completing all pages. Running node as PID 1 lets SIGTERM reach it directly.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
