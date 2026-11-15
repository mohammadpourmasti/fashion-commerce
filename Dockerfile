# syntax=docker/dockerfile:1

# Production image for the Next.js app (output: "standalone").
#
#   docker build -t fashion-commerce .
#   docker run --rm -p 3000:3000 fashion-commerce
#
# Build args (NEXT_PUBLIC_* are inlined into the browser bundle at build time):
#   NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_DEFAULT_CURRENCY
# Server secrets (DATABASE_URL, AUTH_SECRET, ...) are never baked in: pass them
# at runtime with `docker run -e` / `--env-file` or your orchestrator.
#
# The build downloads Google Fonts through next/font (ADR-005), so it needs
# outbound network access.

ARG NODE_VERSION=22

# ---- base: shared Node runtime ----
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- deps: install from the lockfile only (cached until it changes) ----
FROM base AS deps
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- builder: compile the app ----
FROM base AS builder
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG NEXT_PUBLIC_DEFAULT_CURRENCY=IRR
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_DEFAULT_CURRENCY=${NEXT_PUBLIC_DEFAULT_CURRENCY} \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `public/` may be absent from a fresh clone (git does not track empty dirs).
RUN mkdir -p public && npm run build

# ---- runner: only what is needed to serve ----
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Numeric IDs (1001:1001) so orchestrators can verify the image is non-root
# (e.g. Kubernetes runAsNonRoot). The base image already uses 1000 for `node`.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=1001:1001 /app/public ./public
COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static

USER 1001:1001
EXPOSE 3000

# busybox wget ships in the Alpine base layer (CONFIG_WGET=y); it exits non-zero
# on connection errors and HTTP error statuses.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/fa || exit 1

CMD ["node", "server.js"]
