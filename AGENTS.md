# insta-cli — agent notes

The `insta` CLI — a **thin client** of the [platform](../platform) control-plane API for
project / branch / secrets / deploy / governance, built for developers and agents. Node 20 + TS
(ESM) + commander; every command wraps a platform API call. A submodule of the **insta-cloud**
superproject.

## Non-negotiables

1. `main` is branch-protected — **PR only** (squash), needs 1 approving review you can't self-cast.
   Develop on a `feat/*` or `fix/*` branch off `main`.
2. When working inside the insta-cloud superproject: commit + push **here first**, then bump the
   `cli` pointer in the superrepo — never the reverse. (Git mechanics: superproject
   `developing-on-insta-cloud` skill.)
3. Pre-commit gate: `npm run typecheck && npm test`.
4. Command/flag changes must be mirrored in `skills/insta/cli-reference.md` (superproject `skills/`
   submodule) — that's the agent-facing surface doc.

## Developing here

The full dev guide — dev loop, `src/` architecture, the PR-merge/approval flow, the release
process (binaries + npm OIDC), and gotchas — is in `.claude/skills/developing-insta-cli/SKILL.md`.
Claude Code loads it as a skill on demand; other agents (Codex, etc.) can read that file directly.
