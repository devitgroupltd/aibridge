#!/usr/bin/env bash
# §9's type gate ("tsc --noEmit ... meant to run in CI per package") had no runnable command behind
# it - a human had to remember to loop the five package tsconfigs by hand. This is that loop, kept at
# the repo root (like dev-bridge.sh/setup-windows.ps1) rather than under any one package, since it
# checks all of them.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="$ROOT_DIR/node_modules/.bin/tsc"

status=0
for tsconfig in "$ROOT_DIR"/packages/*/tsconfig.json; do
  pkg_dir="$(dirname "$tsconfig")"
  pkg_name="$(basename "$pkg_dir")"
  echo "== typecheck: $pkg_name =="
  if ! "$TSC" --noEmit -p "$tsconfig"; then
    status=1
  fi
done

exit $status
