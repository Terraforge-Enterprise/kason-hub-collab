# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci

FROM deps AS build
COPY . .
# DATABASE_URL is required by prisma.config.ts at config-load time (even for
# generate, which does not connect). Dummy value at build — real URL is
# injected at runtime via the Lightsail deployment env.
RUN DATABASE_URL="postgresql://x:x@build:5432/x" npm --workspace @kason/db run prisma:generate
RUN npm run build

FROM base AS production-deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev
# Ensure the workspace-local node_modules directory exists even if all deps
# hoisted to the root (the runtime stage's COPY would fail on a missing dir).
RUN mkdir -p /app/apps/api/node_modules

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium for puppeteer-core. The reservation sign + unsigned-pdf endpoints
# render PDFs via headless Chromium; without these packages puppeteer's
# launch() throws "No Chromium binary found" and the routes return 500.
# nss / freetype / harfbuzz / ttf-freefont are puppeteer's runtime deps on
# Alpine. puppeteer-core (vs puppeteer) does not auto-download Chromium, so
# the apk package is the source of truth.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=production-deps /app/node_modules ./node_modules
# Workspace-local deps (e.g. p-limit@6 lives here — not hoisted to root
# because root already has p-limit@3 from a transitive dep).
COPY --from=production-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# tsup bundles @kason/db and @kason/shared into the API dist — no source needed
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/db/prisma ./packages/db/prisma
COPY package.json ./package.json
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json

USER appuser
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
