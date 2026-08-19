#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 ORCHARD_SOURCE OUTPUT_BINARY" >&2
  exit 2
fi

source_dir=$1
output_binary=$2
expected_commit=1c241832f5710f68d395c91c414ca55afcb0468a
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch_file=$script_dir/orchard-0.56.1-external-netcat.patch

actual_commit=$(git -C "$source_dir" rev-parse HEAD)
if [ "$actual_commit" != "$expected_commit" ]; then
  echo "expected Orchard 0.56.1 commit $expected_commit, found $actual_commit" >&2
  exit 1
fi
if [ -n "$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "Orchard source checkout must be clean" >&2
  exit 1
fi

git -C "$source_dir" apply --check "$patch_file"
git -C "$source_dir" apply "$patch_file"
GOTOOLCHAIN=auto go -C "$source_dir" test ./internal/dialer ./internal/command/dev
GOTOOLCHAIN=auto go -C "$source_dir" build -o "$output_binary" ./cmd/orchard
codesign --force --sign - "$output_binary"
shasum -a 256 "$output_binary"
