# --------------------- deps stage ---------------------
FROM node:20-alpine AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Install only dependency manifests first for better layer caching.
COPY package.json package-lock.json* npm-shrinkwrap.json* ./

RUN npm install --no-audit --no-fund

# --------------------- builder stage ---------------------
FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build \
  && rm -rf .next/cache

# --------------------- runner stage ---------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOST=0.0.0.0

RUN adduser -D -u 1001 -h /home/nextjs nextjs

# Runtime needs the full Next build output plus the Fastify/Next TypeScript sources,
# because the app now boots through `src/server/index.ts` instead of `server.js`.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/mail-templates ./mail-templates

RUN mkdir -p /app/data && chown -R nextjs:nextjs /app

VOLUME ["/app/data"]
EXPOSE 3000
USER nextjs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/health/live || exit 1

CMD ["npm", "start"]
