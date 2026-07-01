#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/tabpane.zip"
VERSION="$(node -e 'const fs=require("fs"); const path=require("path"); const root=process.argv[1]; const m=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8")); if(!/^[0-9]+(\.[0-9]+){1,3}$/.test(m.version)){throw new Error("Invalid manifest version: "+m.version)} process.stdout.write(m.version)' "$ROOT")"
STORE_FILE="$OUT_DIR/tabpane-chrome-store-v$VERSION.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE" "$OUT_DIR"/tabpane-chrome-store-v*.zip

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

cp "$OUT_FILE" "$STORE_FILE"
echo "$OUT_FILE"
echo "$STORE_FILE"
