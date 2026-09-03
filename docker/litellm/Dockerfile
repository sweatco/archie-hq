# Self-contained model gateway: the config and the streaming hook are baked in,
# so production runs this with no bind mounts (the repo checkout does not exist
# on the VM).
#
# Pin to a digest before relying on this in production. `main-stable` moves, and
# archie_visible_close.py depends on /v1/messages reaching
# async_post_call_streaming_iterator_hook as raw SSE — re-run a live task after
# any base bump.
FROM ghcr.io/berriai/litellm:main-stable

COPY config.yaml /app/config.yaml
COPY archie_visible_close.py /app/archie_visible_close.py

# LiteLLM honours PORT, which would collide with archie's when both read the
# same env file, so the port is fixed here.
CMD ["--config", "/app/config.yaml", "--port", "4000"]
