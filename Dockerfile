# --- build stage: install workspace deps and build both packages ---
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY server server
COPY web web
RUN pnpm -r build

# --- prod deps stage: server runtime dependencies only ---
FROM node:22-alpine AS proddeps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --prod --filter @twiliochat/server

# --- runtime ---
FROM node:22-alpine
ENV NODE_ENV=production PUBLIC_DIR=/app/public
WORKDIR /app/server
COPY --from=proddeps /app/node_modules /app/node_modules
COPY --from=proddeps /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist dist
COPY --from=build /app/server/drizzle drizzle
COPY --from=build /app/server/package.json .
COPY --from=build /app/web/dist /app/public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
