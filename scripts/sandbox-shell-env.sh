# Sourced by every non-interactive bash the agent runs, via BASH_ENV.
#
# Purpose: bridge the sandbox's proxy to tools that ignore the standard *_PROXY
# variables. All agent egress is forced through a local authenticated proxy whose
# URL carries a per-session token, so it is only knowable at runtime inside the
# sandbox — it cannot be baked into the spawn environment.
#
# Yarn Berry (yarn 2+) is the case that forced this: it reads only its own config
# keys (`httpProxy`/`httpsProxy`, env-mapped as YARN_HTTP_PROXY/YARN_HTTPS_PROXY)
# and ignores HTTPS_PROXY entirely, so `yarn install` fails DNS resolution inside
# the sandbox even with the registry allowlisted and the proxy exported.
#
# Keep this cheap and idempotent — it runs on EVERY bash invocation, including
# nested ones. Never fail: a non-zero exit here would break every agent command.

if [ -n "${HTTPS_PROXY:-}${ALL_PROXY:-}" ]; then
  _archie_proxy="${HTTPS_PROXY:-${ALL_PROXY}}"
  # Respect an explicit override; otherwise inherit the sandbox's proxy.
  export YARN_HTTPS_PROXY="${YARN_HTTPS_PROXY:-$_archie_proxy}"
  export YARN_HTTP_PROXY="${YARN_HTTP_PROXY:-${HTTP_PROXY:-$_archie_proxy}}"
  unset _archie_proxy
fi

: # always succeed
