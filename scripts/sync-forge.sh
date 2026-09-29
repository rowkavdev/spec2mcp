#!/usr/bin/env bash
# Refresh vendor/forge from cloudflare/forge at a given commit (default: main HEAD).
set -euo pipefail
ref="${1:-main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --quiet --depth 1 --revision "$ref" https://github.com/forge-placeholder "$tmp/forge" 2>/dev/null || \
git clone --quiet "https://github.com/cloudflare/forge.git" "$tmp/forge"
cd "$tmp/forge" && git checkout --quiet "$ref" && cd - >/dev/null
rsync -a --delete --exclude '*.test.ts' "$tmp/forge/packages/forge/" vendor/forge/
cp "$tmp/forge/LICENSE" vendor/forge/LICENSE
commit="$(git -C "$tmp/forge" rev-parse HEAD)"
sed -i.bak "s/^Pinned commit: .*/Pinned commit: ${commit}/" vendor/forge/PINNED.md && rm -f vendor/forge/PINNED.md.bak
echo "vendored forge at ${commit}"
