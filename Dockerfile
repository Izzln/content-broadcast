# ---- admin UI ---------------------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY server/web/package*.json ./
RUN npm ci
COPY server/web ./
# vite outDir is ../public -> /app/public
RUN npm run build

# ---- server (TypeScript -> dist) ---------------------------------------------
FROM node:22-bookworm-slim AS server-build
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -------------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=web /app/public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUBLIC_DIR=/app/public

EXPOSE 8080
VOLUME /data
CMD ["node", "dist/index.js"]
