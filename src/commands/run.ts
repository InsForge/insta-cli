// `insta run -- <cmd>` — the Railway model for credentials: fetch the branch's secret bundle
// per invocation and inject it into the CHILD PROCESS ENVIRONMENT only. Nothing is written to
// disk, so there is no .env to leak, stale-out, or commit. The bundle exists exactly as long
// as the process does.
import { spawn } from 'node:child_process'
import { ApiClient, requireProject } from '../api.js'
import { CliExit, die, refuse, relayExitCode } from '../util.js'
import { collisionLines, fetchSecretBundle, type Collision, type SecretBundle, type SecretsApi } from './secrets.js'

export type RunDeps = {
  fetchBundle: () => Promise<SecretBundle>
  cwd?: string
  spawnImpl?: typeof spawn
  // Proceed despite a collision — the colliding names are then stripped from the child env.
  ignoreCollisions?: boolean
  // Printed only once we're actually going to spawn, so the "running with N secrets" line can
  // never precede a refusal.
  announce?: (bundle: SecretBundle) => void
}

/** The bundle read, as run does it: the same GET as `insta secrets`, general or --service. */
export function bundleFetcher(
  api: SecretsApi,
  projectId: string,
  opts: { branch?: string; service?: string },
): () => Promise<SecretBundle> {
  return async () => {
    const b = await fetchSecretBundle(api, projectId, opts)
    if (!b) throw new CliExit() // gated (202): handleApproval already said how to unblock it
    return b
  }
}

/** The child's environment: the parent's, plus the bundle, MINUS every colliding name.
 *  Deleting is not belt-and-braces. A withheld name is simply ABSENT from the bundle, so the
 *  spread would let the parent's own export stand in for it — the developer who once exported
 *  codex's password would run hermes' command against it, with no sign anything was withheld. */
export function childEnv(
  parent: NodeJS.ProcessEnv,
  bundle: Record<string, string>,
  collisions: Collision[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, ...bundle }
  for (const c of collisions) delete env[c.name]
  return env
}

/** Pure: why run stopped, and the two ways forward. */
export function refusalLines(collisions: Collision[]): string[] {
  const n = collisions.length
  return [
    `refusing to run: ${n} secret name${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} defined by more than one service, so the bundle cannot say which value the command should get:`,
    ...collisionLines(collisions),
    `pick one service's env:   insta run --service ${collisions[0]?.services[0] ?? '<type>/<name>'} -- <cmd>`,
    'or run without the name:  insta run --ignore-collisions -- <cmd>',
  ]
}

/** Core, dependency-injected for tests: spawn cmd with the bundle in env, return its exit code. */
export async function runWithSecrets(cmd: string, args: string[], deps: RunDeps): Promise<number> {
  const bundle = await deps.fetchBundle()
  const collisions = bundle.collisions ?? []
  if (collisions.length) {
    // Refuse rather than warn: with the name missing from the bundle the child would silently
    // inherit the parent's value, and even clearing it isn't enough — the child may hold a
    // compiled-in default or load its own .env, so a missing credential need not be observable.
    if (!deps.ignoreCollisions) refuse(refusalLines(collisions))
    process.stderr.write(
      `warning: --ignore-collisions — ${collisions.map((c) => c.name).join(', ')} removed from the child environment (${collisions.length} name${collisions.length === 1 ? '' : 's'} defined by more than one service)\n`,
    )
  }
  const env = childEnv(process.env, bundle.secrets, collisions)
  deps.announce?.(bundle)
  return await new Promise<number>((resolve, reject) => {
    const child = (deps.spawnImpl ?? spawn)(cmd, args, { stdio: 'inherit', cwd: deps.cwd, env })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function run(
  cmdAndArgs: string[],
  opts: { branch?: string; service?: string; ignoreCollisions?: boolean },
): Promise<void> {
  const [cmd, ...rest] = cmdAndArgs
  if (!cmd) die('usage: insta run [--branch <b>] [--service <type/name>] -- <command> [args…]')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const code = await runWithSecrets(cmd!, rest, {
    fetchBundle: bundleFetcher(api, p.projectId, { branch, service: opts.service }),
    ignoreCollisions: opts.ignoreCollisions,
    // stderr, not stdout: `insta run`'s stdout belongs entirely to the child command (that's why
    // run has no --json — wrapping would break the child's own output contract).
    announce: (b) =>
      process.stderr.write(
        `running with ${Object.keys(b.secrets).length} injected secrets (${opts.service ? `${opts.service}, ` : ''}branch ${branch}) — nothing written to disk\n`,
      ),
  })
  relayExitCode(code)
}
