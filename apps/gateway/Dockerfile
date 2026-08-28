FROM node:22-alpine
WORKDIR /app
# curl is required for the compose healthcheck (docker-compose.yml,
# ruling H1): mTLS mode requires a client certificate at the TLS handshake
# itself, before Fastify routes anything, so the healthcheck has to be a
# real TLS client (`curl --cacert --cert --key`) — a bare `http://` probe
# would report this container permanently unhealthy while it is fine. Not
# present in the base node:22-alpine image.
RUN apk add --no-cache curl
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --omit=dev --workspace @lexprompt/gateway --include-workspace-root
COPY packages/core packages/core
COPY apps/gateway apps/gateway
USER node
EXPOSE 8081
CMD ["node", "--experimental-strip-types", "apps/gateway/src/main.ts"]
