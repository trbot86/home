# Synthetic fixtures and test trust roots exist only in this rehearsal image.
FROM node:24.14.0-bookworm-slim AS rehearsal
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile
COPY scripts/alexa-rehearsal-service.ts ./scripts/alexa-rehearsal-service.ts
RUN mkdir /sockets /fixture /requests /test-data && chown node:node /sockets /fixture /requests /test-data
USER node
ENTRYPOINT ["node", "--import", "tsx", "scripts/alexa-rehearsal-service.ts"]
