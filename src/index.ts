#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { ApiError } from './api.js'
import { die } from './util.js'
import * as auth from './commands/auth.js'
import * as setup from './commands/setup.js'
import * as mcp from './commands/mcp.js'
import * as runCmd from './commands/run.js'
import * as org from './commands/org.js'
import * as project from './commands/project.js'
import * as branch from './commands/branch.js'
import * as services from './commands/services.js'
import * as regions from './commands/regions.js'
import * as secretsCmd from './commands/secrets.js'
import { deploy } from './commands/deploy.js'
import * as computeCmd from './commands/compute.js'
import { manifest } from './commands/manifest.js'
import * as govern from './commands/govern.js'
import * as observe from './commands/observe.js'
import * as obs from './commands/metrics.js'
import { billing, billingUpgrade, billingPortal } from './commands/billing.js'
import * as selfUpdate from './commands/upgrade.js'

function onError(e: unknown): never {
  if (e instanceof ApiError) die(`${e.message} (HTTP ${e.status})`)
  die(e instanceof Error ? e.message : String(e))
}

// Wrap an async action so rejections surface as clean CLI errors.
const guard = (fn: (...a: any[]) => Promise<unknown>) => (...a: any[]): Promise<void> =>
  fn(...a).then(() => undefined).catch(onError)

const program = new Command()
// Positional options: some command groups (e.g. `secrets`, `billing`) declare a flag (like
// --branch or --org) both on the group itself (for its own default action) and on a subcommand
// of that group. Without this, commander lets the group's own option greedily match the flag
// no matter where it appears, so e.g. `secrets set NAME val --branch b` silently drops --branch
// into the (unused) group-level options instead of the subcommand's. Positional parsing makes a
// group's own options only match before the subcommand name, so occurrences after it are matched
// against the subcommand's own (identically-named) option instead.
program.enablePositionalOptions()
// Version resolution: INSTA_CLI_VERSION (baked into the standalone binary via bun build --define) →
// the installed package.json (npm/node — ../package.json sits beside dist/) → 0.0.0.
function resolveVersion(): string {
  if (process.env.INSTA_CLI_VERSION) return process.env.INSTA_CLI_VERSION
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
  } catch { return '0.0.0' }
}
program.name('insta').description('InstaCloud CLI — manage projects, branches, secrets, deploys').version(resolveVersion())

// ---- auth ----
program.command('login').description('Log in with email + password, or --oauth <github|google> (browser)')
  .option('--email <email>', 'account email')
  .option('--password <password>', 'account password (else $INSTA_PASSWORD or prompt)')
  .option('--oauth <provider>', 'browser OAuth login: github | google')
  .option('--api-url <url>', 'control-plane API base URL')
  .action(guard((o) => auth.login(o)))
program.command('logout').description('Log out and clear local tokens').action(guard(() => auth.logout()))
program.command('status').description('Show login + linked project').option('--json').action(guard((o) => auth.status(o)))

// ---- run (per-request secret injection — nothing written to disk) ----
program.command('run <cmd> [args...]').description('Run a command with the branch credential bundle injected into its environment (no .env written)')
  .option('--branch <b>', 'branch bundle to inject (default: linked branch)')
  .passThroughOptions().allowUnknownOption()
  .action(guard((cmd, args, o) => runCmd.run([cmd, ...(args ?? [])], o)))

// ---- agent setup (the `curl … | sh --agents` target) ----
const setupCmd = program.command('setup').description('Set up this machine for InstaCloud agent workflows')
setupCmd.command('agent').description('Install the insta skill user-globally for all coding agents')
  .option('-y, --yes', 'non-interactive')
  .option('--mcp-token', 'register the MCP server with a minted insta_ API token instead of OAuth (headless machines / CI)')
  .action(guard((o) => setup.setupAgent(o)))

// ---- MCP server integration ----
const mcpCmd = program.command('mcp').description('insta-cloud remote MCP server integration')
mcpCmd.command('install').description('Register the remote MCP server with coding agents (default: Claude Code + all detected)')
  .option('--agent <slug>', 'one agent: claude-code, cursor, codex, opencode, copilot, factory-droid')
  .option('--mcp-token', 'claude-code only: minted insta_ API token instead of OAuth (headless machines / CI)')
  .action(guard((o) => mcp.mcpInstall(o)))

// ---- org ----
const orgCmd = program.command('org').description('Manage organizations')
orgCmd.command('list').option('--json').action(guard((o) => org.orgList(o)))
orgCmd.command('create <name>').action(guard((name) => org.orgCreate(name)))

// ---- project ----
const pj = program.command('project').description('Manage projects')
pj.command('create [name]').option('--org <id>', 'org to create under (default: personal)').action(guard((name, o) => project.projectCreate(name, o)))
pj.command('list').option('--org <id>').option('--json').action(guard((o) => project.projectList(o)))
pj.command('link <id>').description('Link a project to this directory').action(guard((id) => project.projectLink(id)))
pj.command('delete').option('--project <id>').action(guard((o) => project.projectDelete(o)))

// ---- branch ----
const br = program.command('branch').description('Manage branch environments')
br.command('create <name>').option('--from <branch>', 'parent branch (default: current)').action(guard((name, o) => branch.branchCreate(name, o)))
br.command('list').option('--json').action(guard((o) => branch.branchList(o)))
br.command('switch <name>').action(guard((name) => branch.branchSwitch(name)))
br.command('delete <name>').action(guard((name) => branch.branchDelete(name)))
br.command('merge <source>').description('Merge a branch service set into another (structural, no data)')
  .option('--into <branch>', 'target branch (default: current)').action(guard((source, o) => branch.branchMerge(source, o)))

// ---- services (opt-in postgres/storage/compute) ----
const svc = program.command('services').alias('svc').description('Manage project services (postgres|storage|compute)')
svc.command('add <type> <name>').description('Provision a service on demand (assigns a default domain for postgres/compute)')
  .option('--branch <branch>', 'target branch (default: current)')
  .option('--region <region>', 'region for postgres/compute, e.g. us-east (see `insta regions`)')
  .option('--public', 'storage only: serve the bucket with anonymous public-read (default private)')
  .option('--image <url>', 'compute only: run this container image at creation')
  .option('--port <n>', 'compute only: port the image listens on (default 8080)')
  .action(guard((type, name, o) => services.servicesAdd(type, name, o)))
svc.command('list').option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((o) => services.servicesList(o)))
svc.command('remove <type> <name>').description('Remove a service and destroy its resources')
  .option('--branch <branch>', 'branch (default: current)')
  .action(guard((type, name, o) => services.servicesRemove(type, name, o)))
svc.command('rename <type> <name> <new-name>').description('Rename a service and re-key its managed secret names')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((type, name, newName, o) => services.servicesRename(type, name, newName, o)))
svc.command('set-access <type> <name> <access>').description('Set a storage service bucket access mode (access: public|private)')
  .option('--json').action(guard((type, name, access, o) => services.servicesSetAccess(type, name, access, o)))
svc.command('scale <type> <name> <number> [region]').description('Set a compute service machine count (paid plans only)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((type, name, number, region, o) => services.servicesScale(type, name, number, region, o)))
svc.command('upgrade <type> <name> <spec>').description('Change a compute/postgres service spec (paid plans only)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((type, name, spec, o) => services.servicesUpgrade(type, name, spec, o)))
svc.command('secrets <type> <name>').description("List a service's secret names")
  .option('--branch <b>').option('--json').action(guard((type, name, o) => services.servicesSecrets(type, name, o)))

// ---- secrets (seam) ----
const sec = program.command('secrets').description('Fetch the credential bundle (secret seam) into .env')
  .option('--branch <branch>').option('-o, --output <file>', 'output file (default .env)').option('--print', 'print instead of writing').option('--json')
  .action(guard((o) => secretsCmd.secrets(o)))
sec.command('list').description('List secret names, grouped by service').option('--branch <branch>').option('--json').action(guard((o) => secretsCmd.secretsList(o)))
sec.command('set <name> [value]').description('Set a user secret (project-wide; value from stdin if omitted)')
  .option('--branch <branch>', 'scope to one branch').option('--service <type/name>', 'bind to a branch service (implies current branch)')
  .action(guard((n, v, o) => secretsCmd.secretsSet(n, v, o)))
sec.command('unset <name>').description('Remove a user secret')
  .option('--branch <branch>', 'scope to one branch').action(guard((n, o) => secretsCmd.secretsUnset(n, o)))
sec.command('tree').description('Show secrets as project → branch → service → secrets').option('--json')
  .action(guard((o) => secretsCmd.secretsTree(o)))

// ---- deploy ----
program.command('deploy [dir]').description('Deploy a source directory (built remotely on Fly) or a prebuilt --image to a branch compute group')
  .option('--image <url>', 'prebuilt container image to deploy (instead of a source dir)').option('--branch <b>').option('--group <g>').option('--port <p>')
  .option('--websocket', 'run a WebSocket app (larger guest + connection-based concurrency)')
  .action(guard((dir, o) => deploy(dir, o)))

// ---- compute (lifecycle control + custom domains) ----
const compute = program.command('compute').description('Control compute lifecycle (start/stop/suspend/status) + custom domains')
compute.command('set-domain <host>').description('Attach a custom domain to a branch compute service (gated: deploy)')
  .option('--branch <b>').option('--group <g>').option('--json').action(guard((host, o) => computeCmd.setDomain(host, o)))
compute.command('check-domain <host>').description("Show a custom domain's cert status + required DNS records")
  .option('--branch <b>').option('--group <g>').option('--json').action(guard((host, o) => computeCmd.checkDomain(host, o)))
compute.command('remove-domain <host>').description('Detach a custom domain (gated: deploy)')
  .option('--branch <b>').option('--group <g>').action(guard((host, o) => computeCmd.removeDomain(host, o)))
compute.command('start [service]').description('Bring a compute service online (persistent — re-enables auto-wake)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStart(service, o)))
compute.command('stop [service]').description('Take a compute service offline; traffic will NOT wake it until `start`')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStop(service, o)))
compute.command('suspend [service]').description('Suspend a compute service (RAM snapshot); stays down until `start`')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeSuspend(service, o)))
compute.command('status [service]').description("Show a compute service's desired vs. live state")
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStatus(service, o)))

// ---- manifest ----
program.command('manifest').description('Print an agent-legible view of the project environments').option('--json').action(guard((o) => manifest(o)))

// ---- regions ----
program.command('regions').description('List regions available for postgres/compute services').option('--json').action(guard((o) => regions.regionsList(o)))

// ---- observability ----
program.command('metrics <target> [group]').description('Service metrics (target: db|compute)')
  .option('--branch <b>').option('--from <unix>').option('--to <unix>').option('--step <s>').option('--json')
  .action(guard((target, group, o) => obs.metrics(target, group, o)))
program.command('logs <target> [group]').description('Service runtime logs (target: db|compute)')
  .option('--branch <b>').option('--limit <n>').option('--region <r>').option('--instance <i>').option('--json')
  .action(guard((target, group, o) => obs.logs(target, group, o)))
program.command('usage').description('Usage for the current billing cycle by billing dimension (org by default; --proj for one project)')
  .option('--from <unix>').option('--to <unix>').option('--proj [id]', 'show one project (the linked one, or a given id) instead of the whole org').option('--json')
  .action(guard((o) => obs.usage(o)))
const bill = program.command('billing').description('Current billing cycle overview (tier / used / included / overage / credits / forecast + per-dimension & per-project breakdown)')
  .option('--org <id>', 'target org (default: linked project\'s org)').option('--json')
  .action(guard((o) => billing(o)))
bill.command('upgrade <tier>').description('Subscribe the org to a paid tier (pro|enterprise) via Stripe Checkout')
  .option('--org <id>').option('--no-open', 'print the URL instead of opening a browser').option('--json')
  .action(guard((tier, o) => billingUpgrade(tier, o)))
bill.command('portal').description('Open the Stripe Customer Portal (change plan / card / cancel)')
  .option('--org <id>').option('--no-open', 'print the URL instead of opening a browser').option('--json')
  .action(guard((o) => billingPortal(o)))

// ---- events (audit timeline) ----
program.command('events').description('Show the audit + agent-event timeline').option('--branch <b>').option('--limit <n>').option('--json').action(guard((o) => govern.events(o)))

// ---- approvals ----
const ap = program.command('approvals').description('Governance approvals (HITL)')
ap.command('list').option('--status <s>', 'pending|granted|denied|consumed').option('--json').action(guard((o) => govern.approvalsList(o)))
ap.command('approve <id>').option('--always', 'also set the policy to allow').action(guard((id, o) => govern.approvalsApprove(id, o)))
ap.command('deny <id>').action(guard((id) => govern.approvalsDeny(id)))

// ---- observe (local credential audit) ----
const ob = program.command('observe').description('Local credential-audit hook')
ob.command('install').description('Install the PostToolUse hook into this project').action(guard(() => observe.observeInstall()))
ob.command('uninstall').action(guard(() => observe.observeUninstall()))
ob.command('report').description('Render the local credential audit').option('--json').action(guard((o) => observe.observeReport(o)))
ob.command('sync').description('Upload findings into the project timeline').action(guard(() => observe.observeSync()))

// ---- policy ----
const pol = program.command('policy').description('Governance policy')
pol.command('get').option('--json').action(guard((o) => govern.policyGet(o)))
pol.command('set <action> <decision>').description('action: secrets.read|secrets.write|deploy|project.delete|branch.delete|service.add|service.remove|service.scale|service.upgrade|service.setAccess; decision: allow|deny|approve').action(guard((a, d) => govern.policySet(a, d)))

// ---- self-update ----
program.command('upgrade').description('Update the insta CLI to the latest release (binary or npm install)')
  .action(guard(() => selfUpdate.upgrade()))
program.command('autoupdate [mode]').description('Show or set auto-update: on | off (default: on while pre-1.0)')
  .action(guard((mode) => selfUpdate.autoupdate(mode)))
program.command('__update-check', { hidden: true }).action(guard(() => selfUpdate.backgroundCheck()))

selfUpdate.maybeUpdate(resolveVersion(), process.argv)
program.parseAsync(process.argv)
