#!/usr/bin/env bash
# §10.1: bundles packages/channel-server into a single dependency-free script the
# aibridge-telegram plugin ships (plugins/aibridge-telegram/server/index.js). Plugin sources are
# installed by copying files out of a marketplace checkout, not by running a build step on the
# installing machine, so the bundle has to be committed pre-built - re-run this and commit the
# result whenever packages/channel-server or packages/protocol changes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/plugins/aibridge-telegram/server"
mkdir -p "$OUT_DIR"

bun build "$ROOT_DIR/packages/channel-server/src/index.ts" \
  --outfile "$OUT_DIR/index.js" \
  --target bun

echo "built $OUT_DIR/index.js"
