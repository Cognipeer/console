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

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/mail-templates ./mail-templates

RUN npx playwright install-deps chromium

RUN mkdir -p /home/node/.cache/ms-playwright && \
    mkdir -p /app/data && \
    chown -R node:node /home/node && \
    chown -R node:node /app

USER node

RUN npx playwright install chromium

EXPOSE 3000
CMD ["npm", "start"]
