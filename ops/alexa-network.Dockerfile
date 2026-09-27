FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
RUN apt-get update && apt-get install -y --no-install-recommends iptables iproute2 util-linux && rm -rf /var/lib/apt/lists/*
COPY ops/alexa-network /guard
HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=3 CMD ["node", "/guard/health.mjs"]
ENTRYPOINT ["/bin/sh", "/guard/start.sh"]
