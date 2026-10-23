# Override to use a registry mirror, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-bookworm-slim
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build: server (tsc) + web (vite) ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

# ---- runtime: one container serving API, MCP, SSE and the compiled web app ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8080 \
    LANESIGNAL_DATA_DIR=/data \
    LANESIGNAL_CONFIG=/config/lanesignal.json \
    LANESIGNAL_WEB_DIR=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data", "/config"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
