#!/usr/bin/env bash
#
# Publish this package to npm using the token in .env (NPM-JS-TOKEN=...),
# without ever writing the real token into a tracked file or ~/.npmrc.
#
# Usage: tools/publish.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "✗ no .env file at $ROOT/.env — nothing to read the token from"
  exit 1
fi

TOKEN="$(grep '^NPM-JS-TOKEN=' .env | cut -d= -f2-)"
if [ -z "$TOKEN" ]; then
  echo "✗ .env has no NPM-JS-TOKEN= value"
  exit 1
fi

NPMRC_TMP="$(mktemp)"
trap 'rm -f "$NPMRC_TMP"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$NPMRC_TMP"
unset TOKEN

echo "── build ──"
npm run build

echo "── publish ──"
if NPM_CONFIG_USERCONFIG="$NPMRC_TMP" npm publish; then
  PUBLISHED=1
else
  PUBLISHED=0
fi

echo "── verify ──"
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
LIVE_VERSION="$(NPM_CONFIG_USERCONFIG="$NPMRC_TMP" npm view "$NAME" version 2>/dev/null || true)"

if [ "$PUBLISHED" = "1" ] && [ "$LIVE_VERSION" = "$VERSION" ]; then
  echo "✓ PUBLISH SUCCEEDED — $NAME@$VERSION is live at https://www.npmjs.com/package/$NAME"
  exit 0
else
  echo "✗ PUBLISH FAILED — expected $NAME@$VERSION on the registry, found: '${LIVE_VERSION:-nothing}'"
  exit 1
fi
