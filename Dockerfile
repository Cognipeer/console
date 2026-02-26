# --------------------- deps stage ---------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Install only what's needed to resolve deps cache-friendly
COPY package.json package-lock.json* npm-shrinkwrap.json* ./
RUN npm ci

# --------------------- builder stage ---------------------
FROM node:20-alpine AS builder
WORKDIR /app
# Copy deps and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

# --------------------- runner stage ---------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV NODE_ENV=production
# Create non-root user
RUN adduser -D -u 1001 -h /home/nextjs nextjs

# Copy standalone output (includes server.js + minimal node_modules)
COPY --from=builder /app/.next/standalone ./
# Copy static assets
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Copy mail templates (needed at runtime)
COPY --from=builder /app/mail-templates ./mail-templates

RUN mkdir -p /app/data && chown -R nextjs:nextjs .
VOLUME ["/app/data"]
EXPOSE 3000
USER nextjs

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/health/live || exit 1

CMD ["node", "server.js"]
