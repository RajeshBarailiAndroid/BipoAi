#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE=""
for candidate in \
  "$(command -v node 2>/dev/null || true)" \
  "${CURSOR_NODE:-}" \
  "/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node" \
  "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE="$candidate"
    break
  fi
done

if [ -z "$NODE" ]; then
  echo "Node.js not found."
  echo "Install from https://nodejs.org or run: brew install node"
  exit 1
fi

if [ ! -d node_modules ]; then
  NPM="$(command -v npm 2>/dev/null || true)"
  if [ -n "$NPM" ]; then
    echo "Installing dependencies..."
    "$NPM" install
  else
    echo "Missing node_modules. Install Node/npm and run: npm install"
    exit 1
  fi
fi

echo "Using Node $("$NODE" -v) — http://localhost:${PORT:-3001}"
exec "$NODE" server.js
