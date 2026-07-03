# insta-cli

InstaCloud CLI (`insta`) — a thin client of the [platform](../platform) control-plane API.
Manages project / branch / secrets / deploy / governance — built for developers and agents.

Tech stack: Node 20 + TypeScript (ESM) + commander. Every command is a wrapper around the platform API.

## Installation

**One-line install (native binary, no node required)** — macOS / Linux / WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh | sh
#   Installs to ~/.insta/bin/insta (override with INSTA_INSTALL_DIR); verifies SHA256SUMS.
#   Pin a version: curl -fsSL .../install.sh | INSTA_VERSION=v0.1.0 sh
# Windows: download insta-windows-x64.exe from the releases page.
```

**Build from source (requires node):**

```bash
npm install
npm run build         # -> dist/index.js (bin: insta; pure JS, requires node to run)
node dist/index.js --help
```

### Build your own binaries (Bun cross-compilation)

The binaries that `install.sh` installs are cross-compiled with Bun by CI (tag `v*` → `.github/workflows/release.yml`)
and published to GitHub releases. You can also build them locally: requires [Bun](https://bun.sh). The npm package still
ships JS (`dist/index.js`) — binaries are a separate distribution channel.

```bash
npm run compile            # compile for the current platform only -> dist/bin/insta
npm run build:binaries     # cross-compile all platforms -> dist/bin/insta-<os>-<arch>(.exe) + SHA256SUMS
#   The version (baked into `insta --version`) defaults to package.json, or pass it: bash scripts/build-binaries.sh 1.2.3
```

Artifacts look like `insta-darwin-arm64` / `insta-linux-x64` / `insta-windows-x64.exe` (`file` reports native Mach-O/ELF/PE executables).
`dist/` is gitignored; binaries are not committed — CI publishes them to releases.

## Quickstart

```bash
# Point at the control plane (defaults to http://localhost:8080; override with $INSTA_API_URL or --api-url)
insta login --email you@example.com --password ****** --api-url http://localhost:8080
insta project create my-app          # create an empty project and link the current directory (no services by default)
insta services add postgres db       # add services on demand (postgres/storage/compute)
insta services add compute api       # compute is used to deploy images
insta secrets                        # write the current branch's credentials to ./.env (secret seam)
insta deploy --image <registry/img>  # deploy a container image to the current branch's compute service
insta status                         # login state + linked project/branch
```

## Commands

| Command | Description |
|------|------|
| `insta login [--email --password --api-url]` | Log in (email/password; tokens auto-refresh) |
| `insta login --oauth <github\|google>` | Browser OAuth login (starts a local loopback port; the token is carried back automatically after browser authorization) |
| `insta logout` / `insta status [--json]` | Log out / show status |
| `insta org list [--json]` / `org create <name>` | Organizations (each user may own only one free org) |
| `insta project create <name> [--org]` | Create an empty project and link it (no services by default) |
| `insta project list [--org] [--json]` / `link <id>` / `delete` | Project management |
| `insta services add <postgres\|storage\|compute> <name>` | Provision a service on demand (postgres/compute get a default access domain) |
| `insta services list [--json]` / `services remove <type> <name>` | List / remove services |
| `insta services scale compute <name> <number> [region]` | Set the compute machine count (paid tiers; rejected on free) |
| `insta services upgrade <compute\|postgres> <name> <spec>` | Upgrade the spec (paid tiers; upgrade only, no downgrade) |
| `insta branch create <name> [--from]` | Create a branch environment (materializes the project's current services; up to 10 branches per project) |
| `insta branch list [--json]` / `switch <name>` / `delete <name>` | Branch management |
| `insta secrets [--branch -o --print --json]` | Secret seam: write credentials to `.env` |
| `insta secrets list [--branch]` | List secret names only |
| `insta deploy --image <url> [--branch --group --port]` | Deploy an image |
| `insta manifest [--json]` | Agent-readable environment manifest |
| `insta metrics <db\|compute> [group] [--branch --from --to --step --json]` | Resource metrics (compute=Fly; db limited) |
| `insta logs <db\|compute> [group] [--branch --limit --region --instance --json]` | Runtime logs (compute=Fly; db limited) |
| `insta events [--branch --limit --json]` | Audit + agent event timeline |
| `insta usage [--from --to --json]` | Resource usage aggregated by meter (includes costUsd) |
| `insta billing [--org --json]` | Current billing-cycle summary (tier / quota / used / overage / status) |
| `insta billing upgrade <pro\|enterprise> [--org --no-open --json]` | Subscribe to a paid tier via Stripe Checkout; returns and opens the payment link |
| `insta billing portal [--org --no-open --json]` | Open the Stripe Customer Portal (change plan / card / cancel) |
| `insta approvals list [--status] [--json]` | Governance approval list |
| `insta approvals approve <id> [--always]` / `deny <id>` | Approve / deny (admin) |
| `insta policy get [--json]` / `policy set <action> <decision>` | Governance policy (actions include `service.add/remove/scale/upgrade`) |

When a governance-gated operation (`secrets.read`/`deploy`/`project.delete`/`branch.delete`/`service.add`/`service.remove`/`service.scale`/`service.upgrade`) hits an approval,
the CLI prompts `approval required — run: insta approvals approve <id>`.

## Configuration locations

- Global: `~/.insta/config.json` (apiUrl + access/refresh token + user)
- Project: `./.insta/project.json` (projectId / orgId / current branch)

## Local end-to-end run

The platform provides a `dev:fake` mode (fake provider adapters, no Neon/Fly/Tigris credentials required):

```bash
# 1) Start Postgres + the platform dev server (see ../platform)
docker run -d --name pg -e POSTGRES_PASSWORD=insta -e POSTGRES_DB=insta_dev -p 55432:5432 postgres:16-alpine
cd ../platform && DATABASE_URL='postgres://postgres:insta@localhost:55432/insta_dev' PORT=8899 npm run dev:fake

# 2) Run the full flow with the CLI (signup goes through /auth/signup + /auth/verify-email; in dev mode the verification code is printed in the server logs)
INSTA_API_URL=http://localhost:8899 insta login --email you@x.com --password ...
```

## OAuth browser login

```bash
insta login --oauth github          # or google
# CLI starts a local loopback port → opens the browser to /auth/cli/authorize → Better Auth runs provider authorization →
# the platform reads the session cookie to exchange for a bearer token → carries it back to the loopback port → CLI stores it as login state
```

> The platform must have an OAuth app configured for that provider (`GITHUB_OAUTH_CLIENT_ID/SECRET` or `GOOGLE_*`),
> and the app's callback URL must be **`{INSTA_API_BASE_URL}/api/auth/callback/<provider>`** (not the loopback address).

> `metrics` / `logs` / `usage` are supported (usage is aggregated at the collection layer). Multiple compute services (`services add compute`) and `services scale/upgrade` are implemented; image building will come later. Multiple postgres/storage services (>1 per project) are currently constrained by the credential seam and remain future work.
