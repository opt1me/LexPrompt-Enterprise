FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @lexprompt/api --include-workspace-root
COPY packages/core packages/core
COPY apps/api apps/api
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
