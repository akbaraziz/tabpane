#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/tabpane.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

(
  cd "$ROOT"
  zip -X -q -r "$OUT_FILE" \
    manifest.json \
    background.js \
    manager.html \
    manager.css \
    manager.js \
    README.md \
    PRIVACY.md \
    LICENSE \
    icons/icon16.png \
    icons/icon32.png \
    icons/icon48.png \
    icons/icon128.png
)

echo "$OUT_FILE"
