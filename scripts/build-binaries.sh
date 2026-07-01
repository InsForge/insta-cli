#!/usr/bin/env bash
# Build standalone `insta` binaries with Bun — no Node needed at runtime (like the Railway CLI).
# Cross-compiles for macOS/Linux/Windows and writes to dist/bin/ + a SHA256SUMS file.
#
#   bash scripts/build-binaries.sh [version]
#
# `version` defaults to package.json's version; it's baked into `insta --version`.
# Requires Bun (https://bun.sh). The npm package still ships the JS bin (dist/index.js) — these
# binaries are a separate download channel (GitHub releases / curl installer).
set -euo pipefail

cd "$(dirname "$0")/.."               # cli/ root
ENTRY="src/index.ts"
OUT="dist/bin"
VERSION="${1:-$(node -p "require('./package.json').version" 2>/dev/null || echo dev)}"

command -v bun >/dev/null 2>&1 || { echo "error: bun not found — install from https://bun.sh"; exit 1; }

# Bun compile target : output name suffix. Add -musl (Alpine) or -baseline (pre-AVX2 x64) variants
# here if needed, e.g. "bun-linux-x64-musl:linux-x64-musl".
targets=(
  "bun-darwin-arm64:darwin-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-linux-x64:linux-x64"
  "bun-windows-x64:windows-x64.exe"
)

rm -rf "$OUT"; mkdir -p "$OUT"
echo "building insta v$VERSION → $OUT"
for entry in "${targets[@]}"; do
  triple="${entry%%:*}"
  outfile="$OUT/insta-${entry##*:}"
  echo "  → $triple"
  bun build "$ENTRY" \
    --compile --minify \
    --target="$triple" \
    --define "process.env.INSTA_CLI_VERSION=\"$VERSION\"" \
    --outfile "$outfile"
done

# Checksums for release integrity / installer verification.
( cd "$OUT" && { command -v shasum >/dev/null 2>&1 && shasum -a 256 insta-* || sha256sum insta-*; } > SHA256SUMS )

echo "done:"
ls -lh "$OUT"
