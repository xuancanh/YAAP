# yaam-chat production image.
#
#   Build:  docker build -t yaam-chat .
#   Run:    docker run -p 8790:8790 --env-file .env yaam-chat
#
# Required runtime env (fail-fast validated at boot when NODE_ENV=production,
# see server/src/config/validation.ts):
#   DATABASE_URL            Postgres connection string
#   S3_ENDPOINT             S3-compatible endpoint (S3_REGION optional)
#   S3_BUCKET
#   S3_ACCESS_KEY_ID
#   S3_SECRET_ACCESS_KEY
#   S3_FORCE_PATH_STYLE     'true' for MinIO-style endpoints (optional)
# Recommended: YAAM_API_TOKEN (API auth), TOKEN_ENCRYPTION_KEY (tokens at
# rest), PUBLIC_BASE_URL (OAuth redirect base). See .env.example for the rest.
#
# The image ships the compiled NestJS API (server/dist) and the Vite frontend
# bundle (dist/). The API does NOT serve static files — publish dist/ via a
# static host or reverse proxy that also forwards /api to this container.
# packs/ is baked into server/src/market/*.generated.ts at build time, so it
# is not needed at runtime.

# ---- build stage: full toolchain, compiles server (tsc) + frontend (vite) ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# tsc -b typechecks tsconfig.app (src) + tsconfig.node (vite.config.ts, scripts)
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY server ./server
RUN npm run build

# ---- runtime stage: production deps + compiled output only ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
# server/package.json ("type": "commonjs") must shadow the root package.json's
# "type": "module" or node refuses to load the CommonJS output in server/dist.
COPY server/package.json ./server/package.json
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8790
CMD ["node", "server/dist/main.js"]
