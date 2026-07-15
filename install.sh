#!/usr/bin/env sh
# InstaCloud CLI installer. Downloads the prebuilt native binary for your platform from GitHub
# releases, verifies it against SHA256SUMS, and installs it. macOS / Linux / WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
#
# Agent one-liner (installs the CLI AND sets up coding-agent skills, non-interactive):
#   curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/agents.sh | sh
#   (equivalent to piping this script with:  sh -s -- --agents -y)
#
# Flags:
#   --agents   after installing, run `insta setup agent` (skills for Claude Code/Codex/Cursor/…)
#   -y         non-interactive
#
# Options (env):
#   INSTA_VERSION      release tag to install (e.g. v0.1.0); default: latest
#   INSTA_INSTALL_DIR  install directory; default: $HOME/.insta/bin
set -eu

AGENTS=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --agents) AGENTS=1 ;;
    -y|--yes) YES=1 ;;
  esac
done

REPO="InsForge/insta-cli"
BIN="insta"
INSTALL_DIR="${INSTA_INSTALL_DIR:-$HOME/.insta/bin}"

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }

# ---- already current? (skip the download; Railway-style existing-install awareness) ----
resolve_latest() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\(v[^"]*\)".*/\1/p' | head -1
}
if [ -x "$INSTALL_DIR/$BIN" ] && [ -z "${INSTA_VERSION:-}" ]; then
  current="v$("$INSTALL_DIR/$BIN" --version 2>/dev/null | tail -1)"
  latest="$(resolve_latest || true)"
  if [ -n "$latest" ] && [ "$current" = "$latest" ]; then
    echo "✓ insta $latest already installed at $INSTALL_DIR/$BIN — up to date"
    SKIP_DOWNLOAD=1
  fi
fi
# other insta on PATH shadowing ours? (shells use the first hit)
first_hit="$(command -v insta 2>/dev/null || true)"
if [ -n "$first_hit" ] && [ "$first_hit" != "$INSTALL_DIR/$BIN" ]; then
  echo "! another insta is first on your PATH: $first_hit"
  case "$first_hit" in
    */node_modules/*|*npm*|*/.nvm/*) echo "!   (npm-installed — update it with: npm update -g insta, or remove it to use the binary)" ;;
  esac
fi

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

if [ "${SKIP_DOWNLOAD:-0}" = "1" ]; then
  :
else
# ---- resolve release URL ----
version="${INSTA_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$version"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Installing $BIN ($asset, $version) — downloading ~60MB…"
# --progress-bar (not -s): the binary is ~60MB, so a silent download looks frozen. Show progress
# to a TTY; stay quiet when piped without one. Keep the tiny SHA256SUMS fetch silent.
if [ -t 2 ]; then dl="curl -fL --progress-bar"; else dl="curl -fsSL"; fi
$dl "$base/$asset" -o "$tmp/$BIN" || { echo "error: download failed ($base/$asset)" >&2; exit 1; }
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
fi

# ---- agent setup (--agents) ----
if [ "$AGENTS" = "1" ]; then
  echo
  echo "setting up coding-agent skills …"
  if [ "$YES" = "1" ]; then
    "$INSTALL_DIR/$BIN" setup agent -y || echo "warn: agent setup failed — run: insta setup agent"
  else
    "$INSTALL_DIR/$BIN" setup agent || echo "warn: agent setup failed — run: insta setup agent"
  fi
fi

# ---- PATH hint ----
case ":${PATH}:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "Add $BIN to your PATH by adding this to your shell profile (~/.zshrc, ~/.bashrc):"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac


# ---- next steps (the 3-command wow: real infra, then a full isolated clone of it) ----
echo
echo "Get started:"
echo "  insta login --oauth github        # cloud — or run insta-oss locally and skip this"
echo "  insta project create demo && insta deploy . --port 3000"
echo "  insta branch create preview       # clones db + storage + app into an isolated env"
