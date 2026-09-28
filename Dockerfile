FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY scripts/build-server.mjs ./scripts/build-server.mjs
RUN pnpm install --frozen-lockfile && pnpm build && pnpm test
RUN pnpm --filter @our-place/server deploy --prod --legacy /runtime

FROM node:24.14.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_ROOT=/data BACKUP_ROOT=/backups HOST=0.0.0.0 PORT=3000 TZ=America/Toronto
RUN mkdir /data /backups && chown node:node /data /backups
COPY --from=build --chown=node:node /runtime ./apps/server
RUN chmod 0555 /app/apps/server/filing-client.mjs
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
