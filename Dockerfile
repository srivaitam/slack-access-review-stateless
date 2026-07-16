# syntax=docker/dockerfile:1.6
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PORT=10000
WORKDIR /app

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Audit logs are written to disk by default; mount a volume in prod.
RUN mkdir -p /app/audit-logs /app/exports && chown -R app:app /app
USER app

EXPOSE 10000

# Render / most PaaS inject $PORT. We respect it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "index.js"]
