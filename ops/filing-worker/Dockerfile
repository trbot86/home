FROM node:24.14.0-bookworm-slim
RUN npm install --global @openai/codex@0.126.0-alpha.8 && npm cache clean --force \
    && mkdir /auth /work && chown node:node /auth /work
COPY worker.mjs /opt/filing/worker.mjs
USER node
WORKDIR /work
ENV HOME=/auth CODEX_HOME=/auth FILING_CODEX_HOME=/auth \
    FILING_CODEX_EXECUTABLE=/usr/local/bin/codex FILING_WORKER_TEMP=/tmp
CMD ["node", "/opt/filing/worker.mjs"]
