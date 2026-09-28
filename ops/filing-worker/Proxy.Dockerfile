FROM node:24.14.0-bookworm-slim
COPY auth-proxy.mjs /opt/filing/auth-proxy.mjs
COPY inference-gateway.mjs /opt/filing/inference-gateway.mjs
USER node
CMD ["node", "/opt/filing/auth-proxy.mjs"]
