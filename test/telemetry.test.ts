// Usage analytics: routing by environment, the opt-out switches, and — above all — that nothing
// sensitive (secret values, credentials, emails, free text) leaves the machine in an event.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/api.js'
import type { GlobalConfig } from '../src/config.js'
import {
  anonymousId, buildCommandEvent, commandPath, detectAgent, redactArgs, redactOptions,
  sendBatch, telemetryDisabled, telemetryKey, trackCommand, POSTHOG_HOST,
} from '../src/telemetry.js'
import { die } from '../src/util.js'

const PROD = 'https://api.instacloud.com'
const STAGING = 'https://api.staging.instacloud.com'
const CUSTOM = 'http://localhost:4800'

const loggedIn: GlobalConfig = { apiUrl: PROD, accessToken: 'insta_' + 'k'.repeat(30), user: { id: 'user_1', email: 'a@b.c', name: 'A' } }
const anon: GlobalConfig = { apiUrl: PROD }

function fakeFetch(status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response('{"status":1}', { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function tree(): { program: Command; leaf: Command } {
  const program = new Command('insta')
  const secrets = program.command('secrets')
  const leaf = secrets.command('set <name> [value]').option('--branch <b>').action(() => {})
  return { program, leaf }
}

const ctx = (config: GlobalConfig, extra: Partial<Parameters<typeof buildCommandEvent>[4]> = {}) => ({
  cliVersion: '1.2.3', channel: 'npm', config, project: null, anonymousId: 'anon-1', env: {}, tty: false, ...extra,
})

describe('opt-out and routing', () => {
  it('reads either standard switch', () => {
    expect(telemetryDisabled({})).toBe(false)
    expect(telemetryDisabled({ DO_NOT_TRACK: '1' })).toBe(true)
    expect(telemetryDisabled({ INSTA_NO_TELEMETRY: '1' })).toBe(true)
  })

  it('routes prod and staging to different projects and custom hosts to nothing', () => {
    expect(telemetryKey(PROD)).toMatch(/^phc_/)
    expect(telemetryKey(STAGING)).toMatch(/^phc_/)
    expect(telemetryKey(PROD)).not.toBe(telemetryKey(STAGING))
    expect(telemetryKey(CUSTOM)).toBeUndefined()
  })

  it('names the subcommand chain without the program', () => {
    const { program, leaf } = tree()
    expect(commandPath(leaf)).toBe('secrets set')
    expect(commandPath(program)).toBe('')
  })

  it('recognises the agent hosting the shell', () => {
    expect(detectAgent({ CLAUDECODE: '1' })).toBe('claude-code')
    expect(detectAgent({ CURSOR_TRACE_ID: 'x' })).toBe('cursor')
    expect(detectAgent({})).toBeNull()
  })
})

describe('redaction', () => {
  it('drops credential, identity and free-text options wholesale', () => {
    const out = redactOptions({ password: 'hunter2', apiKey: 'insta_abc', email: 'a@b.c', detail: 'my db is down', command: 'insta secrets set K v', area: 'x', branch: 'main', json: true })
    expect(out).toEqual({ password: '[REDACTED]', apiKey: '[REDACTED]', email: '[REDACTED]', detail: '[REDACTED]', command: '[REDACTED]', area: '[REDACTED]', branch: 'main', json: true })
  })

  it('keeps --set variable names but not their values', () => {
    expect(redactOptions({ set: ['DB_URL=postgres://u:p@h/db', 'MODE=prod'] })).toEqual({ set: ['DB_URL=[REDACTED]', 'MODE=[REDACTED]'] })
  })

  it('pattern-scrubs and truncates everything else', () => {
    const out = redactOptions({ output: '/Users/jane/app/.env', image: 'ghcr.io/x/y:1', note: 'mail jane@example.com', long: 'x'.repeat(500) })
    expect(out.output).toBe('~/app/.env')
    expect(out.image).toBe('ghcr.io/x/y:1')
    expect(out.note).toBe('mail [REDACTED_EMAIL]')
    expect((out.long as string).length).toBeLessThan(260)
    expect(out.long).toContain('chars truncated')
  })

  it('treats payload positionals as opaque: secret values, run/query argv', () => {
    expect(redactArgs('secrets set', ['DB_PASSWORD', 's3cret'])).toEqual(['DB_PASSWORD', '[REDACTED]'])
    expect(redactArgs('run', ['npm', 'run', 'dev'])).toEqual(['npm', '[REDACTED]', '[REDACTED]'])
    expect(redactArgs('db query', ['shop', 'select * from users'])).toEqual(['shop', '[REDACTED]'])
    expect(redactArgs('storage get', ['uploads/jane/1.pdf'])).toEqual(['[REDACTED]'])
    expect(redactArgs('storage delete', ['uploads/jane/1.pdf'])).toEqual(['[REDACTED]'])
    expect(redactArgs('services add', ['postgres', 'main'])).toEqual(['postgres', 'main'])
    expect(redactArgs('org create', ['jane@example.com inc'])).toEqual(['[REDACTED_EMAIL] inc'])
  })
})

describe('buildCommandEvent', () => {
  it('identifies by user id when signed in, else by the anonymous id; never carries the email', () => {
    const a = buildCommandEvent('org list', [], {}, { durationMs: 5, exitCode: 0 }, ctx(loggedIn))
    const b = buildCommandEvent('org list', [], {}, { durationMs: 5, exitCode: 0 }, ctx(anon))
    expect(a.distinct_id).toBe('user_1')
    expect(b.distinct_id).toBe('anon-1')
    expect(JSON.stringify(a)).not.toContain('a@b.c')
    expect(JSON.stringify(a)).not.toContain(loggedIn.accessToken)
  })

  it('records outcome, auth kind, environment and linked project', () => {
    const e = buildCommandEvent('deploy', ['.'], { json: true }, { durationMs: 900, exitCode: 2 },
      ctx(loggedIn, { project: { projectId: 'p1', orgId: 'o1', branch: 'feat' }, env: { CI: 'true', CLAUDECODE: '1' } }))
    expect(e.event).toBe('cli_command')
    expect(e.properties).toMatchObject({
      command: 'deploy', args: ['.'], options: { json: true }, success: false, exit_code: 2,
      duration_ms: 900, env: 'prod', api_host: 'api.instacloud.com', logged_in: true, auth_kind: 'api_key',
      project_id: 'p1', org_id: 'o1', branch: 'feat', ci: true, agent: 'claude-code', cli_version: '1.2.3', channel: 'npm',
    })
    const s = buildCommandEvent('status', [], {}, { durationMs: 1, exitCode: 0 }, ctx({ apiUrl: CUSTOM, accessToken: 'eyJsession' }))
    expect(s.properties).toMatchObject({ env: 'custom', api_host: 'localhost:4800', auth_kind: 'session', success: true })
    expect(buildCommandEvent('status', [], {}, { durationMs: 1, exitCode: 0 }, ctx(anon)).properties.auth_kind).toBeNull()
  })

  it('classifies failures: API status, CLI die() text, unexpected exceptions', () => {
    const silent = buildCommandEvent('build', ['.'], {}, { durationMs: 1, exitCode: 1 }, ctx(anon))
    expect(silent.properties).toMatchObject({ success: false, exit_code: 1 })
    expect(silent.properties).not.toHaveProperty('error_type')

    const api = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: new ApiError(403, 'forbidden for jane@example.com') }, ctx(loggedIn))
    expect(api.properties).toMatchObject({ error_type: 'api', http_status: 403, error_message: 'forbidden for [REDACTED_EMAIL]' })

    const stderr = process.stderr.write
    process.stderr.write = (() => true) as any
    let exit: unknown
    try { die('not logged in for jane@example.com') } catch (e) { exit = e } finally { process.stderr.write = stderr; process.exitCode = 0 }
    const cli = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: exit }, ctx(anon))
    expect(cli.properties).toMatchObject({ error_type: 'cli', error_message: 'not logged in for [REDACTED_EMAIL]' })

    const boom = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: new TypeError('x is not a function') }, ctx(anon))
    expect(boom.properties).toMatchObject({ error_type: 'TypeError', error_message: 'x is not a function' })
    expect(boom.properties).not.toHaveProperty('error_code')

    const net = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const offline = buildCommandEvent('org list', [], {}, { durationMs: 1, exitCode: 1, error: net }, ctx(anon))
    expect(offline.properties).toMatchObject({ error_type: 'TypeError', error_code: 'ECONNREFUSED' })
  })
})

describe('anonymousId', () => {
  it('mints once and reuses', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'insta-telemetry-')), 'nested', 'telemetry.json')
    const first = await anonymousId(file)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await anonymousId(file)).toBe(first)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ anonymousId: first })
  })
})

describe('sendBatch', () => {
  it('posts a PostHog batch and swallows transport failures', async () => {
    const { fetchImpl, calls } = fakeFetch()
    expect(await sendBatch('phc_k', [{ event: 'e' }], fetchImpl)).toBe(true)
    expect(calls[0]!.url).toBe(`${POSTHOG_HOST}/batch/`)
    expect(calls[0]!.body).toEqual({ api_key: 'phc_k', batch: [{ event: 'e' }] })
    expect(await sendBatch('phc_k', [], fakeFetch(500).fetchImpl)).toBe(false)
    const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await sendBatch('phc_k', [], boom)).toBe(false)
  })
})

describe('trackCommand', () => {
  const deps = async (config: GlobalConfig) => ({
    ...fakeFetch(),
    env: {} as NodeJS.ProcessEnv,
    loadConfig: async () => config,
    loadProject: async () => null,
    idFile: join(await mkdtemp(join(tmpdir(), 'insta-telemetry-')), 'telemetry.json'),
    channel: 'source',
    tty: false,
  })

  it('sends one cli_command event for a finished command', async () => {
    const d = await deps(loggedIn)
    const { leaf } = tree()
    await trackCommand(leaf, ['DB_PASSWORD', 's3cret'], { durationMs: 10, exitCode: 0 }, '1.0.0', d)
    expect(d.calls).toHaveLength(1)
    const [ev] = d.calls[0]!.body.batch
    expect(ev.event).toBe('cli_command')
    expect(ev.distinct_id).toBe('user_1')
    expect(ev.properties.command).toBe('secrets set')
    expect(ev.properties.args).toEqual(['DB_PASSWORD', '[REDACTED]'])
    expect(JSON.stringify(d.calls[0]!.body)).not.toContain('s3cret')
  })

  it('stays silent when opted out, on custom hosts, and for internal commands', async () => {
    const { leaf } = tree()
    const off = { ...(await deps(loggedIn)), env: { DO_NOT_TRACK: '1' } }
    await trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', off)
    expect(off.calls).toHaveLength(0)

    const custom = await deps({ apiUrl: CUSTOM })
    await trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', custom)
    expect(custom.calls).toHaveLength(0)

    const hidden = await deps(loggedIn)
    await trackCommand(new Command('insta').command('__update-check'), [], { durationMs: 1, exitCode: 0 }, '1.0.0', hidden)
    expect(hidden.calls).toHaveLength(0)
  })

  it('never throws, even when the config cannot be read', async () => {
    const d = { ...(await deps(loggedIn)), loadConfig: async () => { throw new Error('unknown INSTA_ENV') } }
    const { leaf } = tree()
    await expect(trackCommand(leaf, [], { durationMs: 1, exitCode: 0 }, '1.0.0', d)).resolves.toBeUndefined()
    expect(d.calls).toHaveLength(0)
  })
})
