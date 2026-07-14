#!/usr/bin/env sh
#
# InstaCloud agent setup installer — the one-liner for coding agents:
#
#     curl -fsSL agents.instacloud.com | sh
#
# (agents.instacloud.com is a CloudFront edge cache of this file — same bytes, rate-limit-proof.
#  The raw fallback also works: curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/agents.sh | sh)
#
# Thin shim (the Railway agents.sh pattern): exactly equivalent to
#
#     curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents -y
#
# Installs the insta CLI (checksum-verified native binary) and the insta agent skill
# user-globally for every coding agent on the machine. Extra args are forwarded.
set -eu

curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents -y "$@"
