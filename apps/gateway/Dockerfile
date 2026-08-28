FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --omit=dev --workspace @lexprompt/gateway --include-workspace-root
COPY packages/core packages/core
COPY apps/gateway apps/gateway
USER node
EXPOSE 8081
CMD ["node", "--experimental-strip-types", "apps/gateway/src/main.ts"]
