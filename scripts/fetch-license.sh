#!/usr/bin/env bash
#
# fetch-license.sh — write the canonical, verbatim GNU AGPL-3.0 text into ./LICENSE.
#
# Run this once, from a machine with network access, before publishing the
# repository. It replaces the placeholder LICENSE notice with the byte-exact
# license text from gnu.org.
#
set -euo pipefail

cd "$(dirname "$0")/.."

URL="https://www.gnu.org/licenses/agpl-3.0.txt"
echo "Fetching canonical AGPL-3.0 text from ${URL} ..."
curl -fsSL "${URL}" -o LICENSE
echo "LICENSE updated with the canonical AGPL-3.0 text ($(wc -l < LICENSE) lines)."
