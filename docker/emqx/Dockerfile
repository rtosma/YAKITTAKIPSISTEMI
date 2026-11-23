# ==============================================================================
# EMQX — with a startup wrapper that seeds MQTT authentication from env vars.
# See entrypoint.sh for why this exists (AUTH-202 / OPS hardening: closes the
# EMQX_ALLOW_ANONYMOUS: "true" hole — anyone on the network could otherwise
# publish/subscribe fake pump or tank telemetry with no credentials at all).
# ==============================================================================
FROM emqx:5.8.0

USER root
COPY entrypoint.sh /usr/local/bin/emqx-entrypoint-wrapper.sh
RUN chmod +x /usr/local/bin/emqx-entrypoint-wrapper.sh
USER emqx

ENTRYPOINT ["/usr/local/bin/emqx-entrypoint-wrapper.sh"]
CMD ["/opt/emqx/bin/emqx", "foreground"]
