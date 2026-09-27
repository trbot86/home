FROM tailscale/tailscale@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065
RUN mkdir -p /var/lib/tailscale /run/tailscale && chown 1000:1000 /var/lib/tailscale /run/tailscale && chmod 700 /var/lib/tailscale /run/tailscale
ENV HOME=/var/lib/tailscale
USER 1000:1000
# Direct daemon startup leaves login, tags and Funnel configuration explicit.
# No outbound proxy or TCP control/debug listener is enabled.
ENTRYPOINT ["tailscaled", "--tun=userspace-networking", "--statedir=/var/lib/tailscale", "--socket=/run/tailscale/tailscaled.sock", "--port=41641", "--no-logs-no-support"]
