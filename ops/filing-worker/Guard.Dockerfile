FROM node:24.14.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY network-guard.mjs /opt/filing/network-guard.mjs
CMD ["node", "/opt/filing/network-guard.mjs"]
