#!/bin/sh
# Docker entrypoint: fix SSH socket permissions, then drop to non-root user.
# Container starts as root so we can chmod the socket, then exec as archie.
#
# bwrap works because Docker grants SYS_ADMIN + unconfined seccomp/apparmor/systempaths
# at the container level. bwrap creates user namespaces (unprivileged) and gets
# capabilities inside those namespaces — the calling process doesn't need caps itself.

# Fix SSH agent socket permissions (macOS Docker Desktop mounts it as root:root 0755)
if [ -S "${SSH_AUTH_SOCK:-}" ]; then
  chmod 0666 "$SSH_AUTH_SOCK"
fi

# Drop to non-root user and run the CMD
exec gosu archie "$@"
