FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/alexa ./packages/alexa
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @our-place/alexa build && pnpm --filter @our-place/alexa test
RUN pnpm --filter @our-place/alexa deploy --prod --legacy /runtime

FROM node:24.14.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production ALEXA_HOST=0.0.0.0 ALEXA_PORT=3000
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
