# PassVault web dashboard: static build served by Caddy (TLS + /api proxy).
# Build from the REPOSITORY ROOT:
#   podman build -f deploy/web.Containerfile --build-arg VITE_API_URL=https://vault.example.com -t passvault-web .
ARG NODE_IMAGE=docker.io/library/node:24-alpine
ARG CADDY_IMAGE=docker.io/library/caddy:2.10-alpine

FROM ${NODE_IMAGE} AS build
ARG VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build arg is required" && exit 1)
RUN npm install -g pnpm@10.12.1 && npm cache clean --force
ENV CI=true
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter "@passvault/web..."
RUN cd apps/web && VITE_API_URL="$VITE_API_URL" pnpm exec vite build

FROM ${CADDY_IMAGE} AS runtime
COPY --from=build /repo/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
