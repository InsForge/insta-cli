// `insta run -- <cmd>` — the Railway model for credentials: fetch the branch's secret bundle
// per invocation and inject it into the CHILD PROCESS ENVIRONMENT only. Nothing is written to
// disk, so there is no .env to leak, stale-out, or commit. The bundle exists exactly as long
// as the process does.
import { spawn } from 'node:child_process'
import { ApiClient, requireProject } from '../api.js'
import { die, info } from '../util.js'

export type RunDeps = {
  fetchBundle: () => Promise<Record<string, string>>
  cwd?: string
  spawnImpl?: typeof spawn
}

/** Core, dependency-injected for tests: spawn cmd with the bundle in env, return its exit code. */
export async function runWithSecrets(cmd: string, args: string[], deps: RunDeps): Promise<number> {
  const bundle = await deps.fetchBundle()
  return await new Promise<number>((resolve, reject) => {
    const child = (deps.spawnImpl ?? spawn)(cmd, args, {
      stdio: 'inherit',
      cwd: deps.cwd,
      env: { ...process.env, ...bundle },
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function run(cmdAndArgs: string[], opts: { branch?: string }): Promise<void> {
  const [cmd, ...rest] = cmdAndArgs
  if (!cmd) die('usage: insta run [--branch <b>] -- <command> [args…]')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const code = await runWithSecrets(cmd!, rest, {
    fetchBundle: async () => {
      const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets?branch=${encodeURIComponent(branch)}`)
      if (res.status === 202) {
        die(`secrets.read requires approval — run: insta approvals approve ${res.body.approvalId}, then re-run`)
      }
      info(`running with ${Object.keys(res.body.secrets).length} injected secrets (branch ${branch}) — nothing written to disk`)
      return res.body.secrets as Record<string, string>
    },
  })
  process.exit(code)
}
