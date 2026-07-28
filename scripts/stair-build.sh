#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname "$SCRIPT_DIR")

cd "$REPO_DIR"
bun run electron:build

# BrowserWindow resolves this generated path directly on Windows and Linux.
cp apps/electron/resources/stair/icon.png apps/electron/dist/resources/icon.png

cd apps/electron
exec "$REPO_DIR/node_modules/.bin/electron-builder" \
  --config electron-builder.stair.yml \
  "$@"
