#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(dirname "$SCRIPT_DIR")

cd "$REPO_DIR"
exec env \
  CRAFT_APP_NAME=Stair \
  CRAFT_APP_ICON="$REPO_DIR/apps/electron/resources/stair/icon.png" \
  CRAFT_DISABLE_AUTO_UPDATE=1 \
  bun run electron:dev "$@"
