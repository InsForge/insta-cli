#!/usr/bin/env sh
#
# InstaCloud agent setup installer, STAGING — the one-liner for coding agents:
#
#     curl -fsSL agents.staging.instacloud.com | sh
#
# (agents.staging.instacloud.com is a CloudFront edge cache of this file, the staging sibling of
#  agents.instacloud.com → agents.sh. The raw fallback also works:
#  curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/agents-staging.sh | sh)
#
# Identical to agents.sh except that it targets the staging deployment
# (api/mcp.staging.instacloud.com, us-west-1) instead of production (us-east-2).
#
# Note this ships from the SAME main branch as agents.sh — the staging/prod split here is about
# which control plane the CLI talks to, NOT which build of the CLI you get. You always get the
# current released binary; use INSTA_VERSION to pin a different one.
#
# --staging is passed to install.sh (rather than exporting INSTA_ENV around it) so the choice is
# PERSISTED into ~/.insta/config.json. A piped `curl … | sh` cannot export into the parent shell,
# so an env var would evaporate before the `insta project create` the user runs next.
set -eu

curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents --staging -y "$@"
