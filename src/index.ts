#!/usr/bin/env node
import { Command } from 'commander'
import { ApiError } from './api.js'
import { die } from './util.js'
import * as auth from './commands/auth.js'
import * as org from './commands/org.js'
import * as project from './commands/project.js'
import * as branch from './commands/branch.js'
import * as secretsCmd from './commands/secrets.js'
import { deploy } from './commands/deploy.js'
import { manifest } from './commands/manifest.js'
import * as govern from './commands/govern.js'
import * as observe from './commands/observe.js'
import * as obs from './commands/metrics.js'

function onError(e: unknown): never {
  if (e instanceof ApiError) die(`${e.message} (HTTP ${e.status})`)
  die(e instanceof Error ? e.message : String(e))
}

// Wrap an async action so rejections surface as clean CLI errors.
const guard = (fn: (...a: any[]) => Promise<unknown>) => (...a: any[]): Promise<void> =>
  fn(...a).then(() => undefined).catch(onError)

const program = new Command()
program.name('insta').description('InstaCloud CLI — manage projects, branches, secrets, deploys').version('0.0.0')

// ---- auth ----
program.command('login').description('Log in with email + password')
  .option('--email <email>', 'account email')
  .option('--password <password>', 'account password (else $INSTA_PASSWORD or prompt)')
  .option('--api-url <url>', 'control-plane API base URL')
  .action(guard((o) => auth.login(o)))
program.command('logout').description('Log out and clear local tokens').action(guard(() => auth.logout()))
program.command('status').description('Show login + linked project').option('--json').action(guard((o) => auth.status(o)))

// ---- org ----
const orgCmd = program.command('org').description('Manage organizations')
orgCmd.command('list').option('--json').action(guard((o) => org.orgList(o)))
orgCmd.command('create <name>').action(guard((name) => org.orgCreate(name)))

// ---- project ----
const pj = program.command('project').description('Manage projects')
pj.command('create <name>').option('--org <id>', 'org to create under (default: personal)').action(guard((name, o) => project.projectCreate(name, o)))
pj.command('list').option('--org <id>').option('--json').action(guard((o) => project.projectList(o)))
pj.command('link <id>').description('Link a project to this directory').action(guard((id) => project.projectLink(id)))
pj.command('delete').option('--project <id>').action(guard((o) => project.projectDelete(o)))

// ---- branch ----
const br = program.command('branch').description('Manage branch environments')
br.command('create <name>').option('--from <branch>', 'parent branch (default: current)').action(guard((name, o) => branch.branchCreate(name, o)))
br.command('list').option('--json').action(guard((o) => branch.branchList(o)))
br.command('switch <name>').action(guard((name) => branch.branchSwitch(name)))
br.command('delete <name>').action(guard((name) => branch.branchDelete(name)))

// ---- secrets (seam) ----
const sec = program.command('secrets').description('Fetch the credential bundle (secret seam) into .env')
  .option('--branch <branch>').option('-o, --output <file>', 'output file (default .env)').option('--print', 'print instead of writing').option('--json')
  .action(guard((o) => secretsCmd.secrets(o)))
sec.command('list').description('List secret names only').option('--branch <branch>').action(guard((o) => secretsCmd.secretsList(o)))

// ---- deploy ----
program.command('deploy').description('Deploy a container image to a branch compute group')
  .option('--image <url>', 'container image to deploy').option('--branch <b>').option('--group <g>').option('--port <p>')
  .action(guard((o) => deploy(o)))

// ---- manifest ----
program.command('manifest').description('Print an agent-legible view of the project environments').option('--json').action(guard((o) => manifest(o)))

// ---- observability ----
program.command('metrics <component> [group]').description('Resource metrics (component: db|compute)')
  .option('--branch <b>').option('--from <unix>').option('--to <unix>').option('--step <s>').option('--json')
  .action(guard((component, group, o) => obs.metrics(component, group, o)))
program.command('logs <component> [group]').description('Runtime logs (component: db|compute)')
  .option('--branch <b>').option('--limit <n>').option('--region <r>').option('--instance <i>').option('--json')
  .action(guard((component, group, o) => obs.logs(component, group, o)))

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
pol.command('set <action> <decision>').description('action: secrets.read|deploy|project.delete|branch.delete; decision: allow|deny|approve').action(guard((a, d) => govern.policySet(a, d)))

program.parseAsync(process.argv)
