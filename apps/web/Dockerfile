# Web image — built from the monorepo ROOT context (compose `build.context: ../..`).
#
# Next.js inlines NEXT_PUBLIC_* into the client bundle AT BUILD TIME, so the public
# Firebase config is passed as build args (compose `build.args`, sourced from the
# compose .env file the deploy renders). These are public client values, not secrets.
#
# No `output: 'standalone'` is configured, so the runtime stage carries node_modules
# + .next + source and serves with `next start` on container port 3000 (Caddy targets web:3000).

# ---- build ------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /repo

ARG NEXT_PUBLIC_FIREBASE_API_KEY
ARG NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
ARG NEXT_PUBLIC_FIREBASE_PROJECT_ID
ARG NEXT_PUBLIC_FIREBASE_APP_ID
ARG NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
ARG NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
ENV NEXT_PUBLIC_FIREBASE_API_KEY=$NEXT_PUBLIC_FIREBASE_API_KEY \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID=$NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    NEXT_PUBLIC_FIREBASE_APP_ID=$NEXT_PUBLIC_FIREBASE_APP_ID \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=$NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --ignore-scripts
RUN npm run build:packages
RUN npm run build --workspace=@chat-app/web

# ---- runtime ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/web ./apps/web

WORKDIR /repo/apps/web
EXPOSE 3000
# Serve on 3000 (Caddy proxies web:3000); overrides the package script's dev port.
CMD ["npx", "next", "start", "-p", "3000"]
