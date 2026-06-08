# Backend image — built from the monorepo ROOT context (see compose `build.context: ../..`)
# so the shared workspace packages (@chat-app/crypto, …) are available.
#
#   build stage   — npm ci (all workspaces) + build shared packages + compile backend
#   runtime stage — carries node_modules + compiled dist + source so that both
#                   `node dist/main.js` and the TypeORM `migration:run` (ts-node) work.
#
# `--ignore-scripts` keeps unrelated workspaces' native postinstalls (e.g. the mobile
# app) from running during install; the backend's deps need no install scripts.

# ---- build ------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Manifests first for a cacheable install layer.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --ignore-scripts
RUN npm run build:packages
RUN npm run build --workspace=@chat-app/backend

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Installed deps (incl. dev deps like ts-node/typeorm CLI, needed for migrations)
# and the built workspace packages + backend (dist + src).
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/backend ./apps/backend

WORKDIR /repo/apps/backend
EXPOSE 3000 3001
# REST :3000 + WebSocket :3001. Migrations are applied by the deploy via
# `docker compose exec backend npm run migration:run`.
CMD ["node", "dist/main.js"]
