// `insta env` — show or switch the deployment environment (prod | staging).
//
// This exists because the canonical install is a pipe: `curl -fsSL agents.staging.instacloud.com | sh`.
// A piped script cannot export anything into the parent shell, so the staging one-liner has no way
// to make `INSTA_ENV=staging` stick for the `insta project create` the user runs next. Persisting
// the choice into ~/.insta/config.json is the only mechanism that survives the pipe — and it is the
// same file `login --api-url` already writes, so this adds a surface, not a concept.
import { ApiClient } from '../api.js'
import { resolveEnv } from '../config.js'
import { DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, isEnvName, mcpServerName, type EnvName } from '../env.js'
import { die, info, printJson } from '../util.js'

export async function envShow(opts: { json?: boolean }): Promise<void> {
  const { apiUrl, env, mcpUrl, skills } = await resolveEnv()
  const mcpServer = mcpServerName(env ?? DEFAULT_ENV)
  if (opts.json) return printJson({ env, apiUrl, mcpUrl, mcpServer, skills })
  info(`env:     ${env ?? '(custom)'}`)
  info(`api:     ${apiUrl}`)
  info(`mcp:     ${mcpUrl} (${mcpServer})`)
  info(`skills:  ${skills}`)
  if (!env) info('  (custom apiUrl — `insta env use <name>` to switch to a named environment)')
}

export async function envUse(name: string): Promise<void> {
  const want = name.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown environment "${name}" — expected one of: ${ENV_NAMES.join(', ')}`)
  const target: EnvName = want

  const api = await ApiClient.load()
  const from = envForApiUrl(api.apiUrl)
  const nextApi = ENVS[target].api
  if (api.apiUrl === nextApi) {
    info(`already on ${target} (${nextApi})`)
    return
  }

  // Drop the stored session along with the host. prod and staging are separate deployments, so the
  // old token cannot authenticate here — and keeping it is actively unsafe, because api.ts's 401
  // path POSTs the refresh token to whatever apiUrl now resolves to, handing one deployment's
  // credential to another. Same reasoning as the retired-host path in config.ts.
  const hadSession = !!api.config.accessToken
  api.setApiUrl(nextApi)
  if (hadSession) api.clearSession()
  await api.persist()

  info(`switched ${from ?? '(custom)'} → ${target}`)
  info(`  api: ${nextApi}`)
  info(`  mcp: ${ENVS[target].mcp} (registers as \`${mcpServerName(target)}\`)`)
  if (hadSession) info('  previous session dropped (separate deployment) — run `insta login --oauth github`')
  // Switching the CLI does NOT re-point already-installed agents: their MCP registration and skill
  // files were written for the previous environment and are keyed by a different server name, so
  // they keep talking to it until setup is re-run. (The installer path is fine — install.sh runs
  // `env use` before `setup agent`.)
  info('  re-point this machine\'s agents at it with: insta setup agent')
}
