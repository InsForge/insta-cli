#!/usr/bin/env sh
#
# InstaCloud agent setup installer — the one-liner for coding agents:
#
#     curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/agents.sh | sh
#
# Thin shim (the Railway agents.sh pattern): exactly equivalent to
#
#     curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents -y
#
# Installs the insta CLI (checksum-verified native binary) and the insta agent skill
# user-globally for every coding agent on the machine. Extra args are forwarded.
set -eu

curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents -y "$@"
