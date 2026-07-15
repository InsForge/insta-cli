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
  # Not a conflict if the first hit is just the symlink WE created into an on-PATH dir
  # (see the linking step below) — it resolves straight back to our binary. Warn only for a
  # genuinely different insta (e.g. an npm-installed one) that would actually shadow ours.
  if [ -L "$first_hit" ] && [ "$(readlink "$first_hit" 2>/dev/null)" = "$INSTALL_DIR/$BIN" ]; then
    : # our own symlink → the binary; nothing to warn about
  else
    echo "! another insta is first on your PATH: $first_hit"
    case "$first_hit" in
      */node_modules/*|*npm*|*/.nvm/*) echo "!   (npm-installed — update it with: npm update -g insta, or remove it to use the binary)" ;;
    esac
  fi
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

# --progress-bar (not -s): a silent download looks frozen. Show progress to a TTY; stay quiet
# when piped without one. Keep the tiny SHA256SUMS fetch silent.
if [ -t 2 ]; then dl="curl -fL --progress-bar"; else dl="curl -fsSL"; fi
# Prefer the gzipped asset (~3× smaller); fall back to the raw binary for older releases.
if curl -fsSL -I "$base/$asset.gz" >/dev/null 2>&1; then
  echo "Installing $BIN ($asset, $version) — downloading ~20MB…"
  $dl "$base/$asset.gz" -o "$tmp/$BIN.gz" || { echo "error: download failed ($base/$asset.gz)" >&2; exit 1; }
  gunzip "$tmp/$BIN.gz" || { echo "error: could not decompress $asset.gz" >&2; exit 1; }
else
  echo "Installing $BIN ($asset, $version) — downloading ~60MB…"
  $dl "$base/$asset" -o "$tmp/$BIN" || { echo "error: download failed ($base/$asset)" >&2; exit 1; }
fi
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

# ---- make `insta` immediately runnable in THIS shell ----
# The recommended one-liner is `curl … | sh && insta …`, so the binary must be callable in the
# current shell right away — a piped script can't edit the parent's PATH. If a directory that's
# already on PATH is writable (macOS /usr/local/bin, or ~/.local/bin), symlink there so `insta`
# just works with no profile reload. (This is why installing only to ~/.insta/bin fails.)
if [ "${SKIP_DOWNLOAD:-0}" != "1" ] || [ ! -e "$INSTALL_DIR/$BIN" ]; then :; fi
ON_PATH=0
case ":${PATH}:" in *":$INSTALL_DIR:"*) ON_PATH=1 ;; esac
LINKED=""
if [ "$ON_PATH" != "1" ]; then
  for d in /usr/local/bin "$HOME/.local/bin"; do
    case ":${PATH}:" in *":$d:"*) ;; *) continue ;; esac   # must already be on PATH
    [ -d "$d" ] && [ -w "$d" ] || continue                  # …and writable (no sudo)
    ln -sf "$INSTALL_DIR/$BIN" "$d/$BIN" && LINKED="$d/$BIN" && break
  done
fi

# ---- agent setup (--agents) ----
if [ "$AGENTS" = "1" ]; then
  echo
  # `insta setup agent` prints its own "setting up coding-agent skills …" line + clean summary.
  if [ "$YES" = "1" ]; then
    "$INSTALL_DIR/$BIN" setup agent -y || echo "warn: agent setup failed — run: insta setup agent"
  else
    "$INSTALL_DIR/$BIN" setup agent || echo "warn: agent setup failed — run: insta setup agent"
  fi
fi

# ---- PATH: confirm reachable, or tell the user exactly how (incl. THIS shell) ----
if [ "$ON_PATH" = "1" ]; then
  : # already on PATH
elif [ -n "$LINKED" ]; then
  echo "✓ linked → $LINKED (on your PATH)"
  command -v hash >/dev/null 2>&1 && hash -r 2>/dev/null || true  # drop any cached 'not found'
else
  # No writable PATH dir — persist for new shells, and make THIS shell work now.
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -e "$rc" ] || continue
    grep -q "$INSTALL_DIR" "$rc" 2>/dev/null || printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$rc"
  done
  echo
  echo "Added $BIN to your PATH for new shells. For THIS shell, run:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo "(the recommended \`… | sh && insta …\` one-liner needs \`insta\` on PATH — the line above enables it here)"
fi


# ---- next steps (the 3-command wow: real infra, then a full isolated clone of it) ----
echo
echo "Next steps:"
echo "  insta login --oauth github     # connect to the cloud (or run insta-oss locally to skip)"
echo "  insta project create demo      # postgres + storage + compute, provisioned in one shot"
echo "  insta deploy . --port 3000     # ship your app and get a live URL"
echo "  insta branch create preview    # clone db + storage + app into an isolated env"
echo
echo "Your coding agents now know InstaCloud — you can just ask them to do the above."
