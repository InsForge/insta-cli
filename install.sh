#!/usr/bin/env sh
# InstaCloud CLI installer. Downloads the prebuilt native binary for your platform from GitHub
# releases, verifies it against SHA256SUMS, and installs it. macOS / Linux / WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
#
# Options (env):
#   INSTA_VERSION      release tag to install (e.g. v0.1.0); default: latest
#   INSTA_INSTALL_DIR  install directory; default: $HOME/.insta/bin
set -eu

REPO="InsForge/insta-cli"
BIN="insta"
INSTALL_DIR="${INSTA_INSTALL_DIR:-$HOME/.insta/bin}"

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }

# ---- detect platform ----
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "error: unsupported OS '$os' (Windows: download insta-windows-x64.exe from the releases page)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "error: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
asset="insta-${os}-${arch}"

# ---- resolve release URL ----
version="${INSTA_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$version"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Installing $BIN ($asset, $version)…"
curl -fsSL "$base/$asset" -o "$tmp/$BIN" || { echo "error: download failed ($base/$asset)" >&2; exit 1; }
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo "error: could not fetch SHA256SUMS" >&2; exit 1; }

# ---- verify checksum ----
expected="$(grep " ${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || { echo "error: no checksum for $asset in SHA256SUMS" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$BIN" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$BIN" | awk '{print $1}')"
fi
if [ "$expected" != "$actual" ]; then
  echo "error: checksum mismatch for $asset" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

# ---- install ----
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$BIN"
mv "$tmp/$BIN" "$INSTALL_DIR/$BIN"
echo "✓ installed to $INSTALL_DIR/$BIN"
"$INSTALL_DIR/$BIN" --version 2>/dev/null || true

# ---- PATH hint ----
case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "Add $BIN to your PATH by adding this to your shell profile (~/.zshrc, ~/.bashrc):"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
