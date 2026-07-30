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
# Identical to agents.sh except that everything it installs points at staging:
#
#   CLI      the newest PRERELEASE build (v*-rc.N), falling back to the latest stable if none
#            exists yet. INSTA_VERSION pins an exact tag and overrides this.
#   API      api.staging.instacloud.com   (us-west-1, a separate deployment from prod)
#   MCP      mcp.staging.instacloud.com, registered as `insta-cloud-staging` so it can coexist
#            with a production registration on the same machine
#   skills   the staging ref of InsForge/insta-skills, so the agent reads skill text that
#            describes the staging control plane
#
# One command, and every piece is staging. This script itself ships from `main` (same as
# agents.sh) — it is the installer, not the thing being staged.
#
# --staging is passed to install.sh (rather than exporting INSTA_ENV around it) so the choice is
# PERSISTED into ~/.insta/config.json. A piped `curl … | sh` cannot export into the parent shell,
# so an env var would evaporate before the `insta project create` the user runs next.
set -eu

curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh -s -- --agents --staging -y "$@"
