#!/bin/bash
# GIT_ASKPASS helper for GitHub App authentication
#
# Git calls this script with a prompt like:
#   "Username for 'https://github.com': "
#   "Password for 'https://x-access-token@github.com': "
#
# We return:
#   - "x-access-token" for username
#   - GitHub App installation token for password

PROMPT="$1"

case "$PROMPT" in
  Username*)
    echo "x-access-token"
    ;;
  Password*)
    # Generate token using our script
    # Try compiled JS first (production), fall back to tsx (development)
    if [ -f /app/dist/scripts/github-token.js ]; then
      node /app/dist/scripts/github-token.js
    else
      npx tsx /app/scripts/github-token.ts
    fi
    ;;
esac
