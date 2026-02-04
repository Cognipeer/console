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
# Create non-root user
RUN adduser -D -u 1001 -h /home/nextjs nextjs

COPY --from=builder /app/ ./
RUN chown -R nextjs:nextjs .
EXPOSE 3000
USER nextjs
CMD ["npm", "run", "start"]
