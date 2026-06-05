# --------------------- deps stage ---------------------
FROM node:22 AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* npm-shrinkwrap.json* ./
RUN npm install --no-audit --no-fund

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

RUN npx playwright install-deps chromium

RUN mkdir -p /home/node/.cache/ms-playwright && \
    mkdir -p /app/data && \
    chown -R node:node /home/node && \
    chown -R node:node /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/mail-templates ./mail-templates

USER node

RUN npx playwright install chromium

EXPOSE 3000
CMD ["npm", "start"]