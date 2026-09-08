// Per-service env means several compute services can each define the SAME name
// (hermes / claude-code / codex each holding their own ADMIN_PASSWORD). The flat
// `{ secrets }` bundle cannot hold three values for one name, so the old read let the
// newest row win silently — a hand-set hermes password read back as codex's.
//
// The platform now WITHHOLDS a colliding name and reports it in `collisions`. These tests pin
// the client half: ask for withholding, report every collision on stderr only, and — the one
// that matters — REFUSE to spawn, because `env: { ...process.env, ...bundle }` means a withheld
// name falls through to whatever the developer once exported.
import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
import {
  assertServiceRef, bundleQuery, collisionLines, fetchSecretBundle, secrets, secretsUnset, type Collision,
} from '../src/commands/secrets.js'
import { bundleFetcher, childEnv, refusalLines, runWithSecrets } from '../src/commands/run.js'
import { CliExit } from '../src/util.js'

const COLLISION: Collision[] = [
  { name: 'ADMIN_PASSWORD', services: ['compute/hermes', 'compute/claude-code', 'compute/codex'] },
]

/** Records every request the command makes, and answers with one canned body. */
function stubApi(body: unknown, status = 200) {
  const calls: string[] = []
  return {
    calls,
    rawRequest: async (m: string, p: string) => { calls.push(`${m} ${p}`); return { status, body } },
  }
}

/** Run `fn` with both streams captured — so "stderr, never stdout" is directly assertable. */
async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = process.stdout.write.bind(process.stdout)
  const se = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((s: string) => { out.push(String(s)); return true }) as typeof so
  process.stderr.write = ((s: string) => { err.push(String(s)); return true }) as typeof se
  try { await fn() } finally { process.stdout.write = so; process.stderr.write = se }
  return { out: out.join(''), err: err.join('') }
}

describe('bundleQuery', () => {
  it('asks the platform to withhold collisions on every general read', () => {
    expect(bundleQuery({ branch: 'dev' })).toBe('?branch=dev&on_collision=withhold')
  })

  it('scopes to one service instead — that env is unambiguous, so nothing is withheld', () => {
    expect(bundleQuery({ branch: 'dev', service: 'compute/hermes' }))
      .toBe('?branch=dev&service=compute%2Fhermes')
  })

  it('still withholds when no branch is known', () => {
    expect(bundleQuery({})).toBe('?on_collision=withhold')
  })
})

describe('assertServiceRef', () => {
  // The platform 400s an empty service; falling back to the branch-wide read would quietly answer
  // a different question (`--service "$SVC"` with SVC unset is the way this happens for real).
  it('rejects an empty or blank --service instead of reading the whole branch', async () => {
    try {
      const { err } = await capture(async () => {
        for (const raw of ['', '   ']) expect(() => assertServiceRef(raw), JSON.stringify(raw)).toThrow(CliExit)
      })
      expect(err).toContain('--service requires <type>/<name>')
    } finally { process.exitCode = 0 }
  })

  it('accepts a service ref, and no flag at all', () => {
    expect(() => assertServiceRef('compute/hermes')).not.toThrow()
    expect(() => assertServiceRef(undefined)).not.toThrow()
  })
})

describe('collisionLines', () => {
  it('names the secret, every service that defines it, and the command that reads one', () => {
    expect(collisionLines(COLLISION)).toEqual([
      'ADMIN_PASSWORD omitted — 3 services define it:',
      '  compute/hermes, compute/claude-code, compute/codex',
      '  read one with: insta secrets --service compute/hermes',
    ])
  })

  it('renders every entry, and nothing at all when there are none', () => {
    const two = [...COLLISION, { name: 'ADMIN_USERNAME', services: ['compute/hermes', 'compute/codex'] }]
    expect(collisionLines(two)).toHaveLength(6)
    expect(collisionLines(two)[3]).toBe('ADMIN_USERNAME omitted — 2 services define it:')
    expect(collisionLines([])).toEqual([])
  })
})

describe('fetchSecretBundle', () => {
  it('requests the service-scoped URL for --service', async () => {
    const api = stubApi({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const b = await fetchSecretBundle(api, 'p1', { branch: 'dev', service: 'compute/hermes' })
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(b).toEqual({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
  })

  it('requests withholding for a general read and surfaces the collisions', async () => {
    const api = stubApi({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION })
    const b = await fetchSecretBundle(api, 'p1', { branch: 'dev' })
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&on_collision=withhold'])
    expect(b?.collisions).toEqual(COLLISION)
  })

  // An older platform answers without the field; absent means "none reported", not a crash.
  it('treats a missing collisions field as none', async () => {
    const api = stubApi({ secrets: { A: '1' } })
    expect((await fetchSecretBundle(api, 'p1', { branch: 'dev' }))?.collisions).toEqual([])
  })

  it('parks on a 202 approval instead of returning a bundle', async () => {
    const api = stubApi({ status: 'approval_required', action: 'secrets.read', approvalId: 'ap1' }, 202)
    try {
      const { err } = await capture(async () => {
        expect(await fetchSecretBundle(api, 'p1', { branch: 'dev' })).toBeNull()
      })
      expect(err).toContain('approval required')
      expect(process.exitCode).toBe(2)
    } finally { process.exitCode = 0 }
  })
})

describe('secrets', () => {
  const deps = (body: unknown) => ({ api: stubApi(body), projectId: 'p1', linkedBranch: 'dev' })
  const BODY = { secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }

  it('--print puts the env on stdout and the collision on stderr, never the other way round', async () => {
    const d = deps(BODY)
    const { out, err } = await capture(() => secrets({ print: true }, d))
    expect(out).toBe('DATABASE_URL="pg://x"\n')
    expect(out).not.toContain('ADMIN_PASSWORD')
    expect(out).not.toContain('omitted')
    expect(err).toContain('ADMIN_PASSWORD omitted — 3 services define it:')
    expect(err).toContain('read one with: insta secrets --service compute/hermes')
  })

  it('carries collisions in --json alongside the secrets', async () => {
    const d = deps(BODY)
    const { out } = await capture(() => secrets({ json: true }, d))
    expect(JSON.parse(out)).toEqual({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION })
  })

  it('--service scopes the read to that one service', async () => {
    const d = deps({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const { out } = await capture(() => secrets({ print: true, service: 'compute/hermes' }, d))
    expect(d.api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(out).toBe('ADMIN_PASSWORD="hermes-pw"\n')
  })
})

describe('secrets unset --service', () => {
  it('sends the service query param, so only that service’s copy is deleted', async () => {
    const api = stubApi({ ok: true })
    await capture(() => secretsUnset('ADMIN_PASSWORD', { branch: 'dev', service: 'compute/hermes' }, { api, projectId: 'p1' }))
    expect(api.calls).toEqual(['DELETE /projects/p1/secrets/ADMIN_PASSWORD?branch=dev&service=compute%2Fhermes'])
  })

  it('still deletes project-wide with no flags', async () => {
    const api = stubApi({ ok: true })
    await capture(() => secretsUnset('X', {}, { api, projectId: 'p1' }))
    expect(api.calls).toEqual(['DELETE /projects/p1/secrets/X'])
  })
})

class FakeChild extends EventEmitter {}

/** A spawn that records its calls and exits 0 — so "was it called at all" is assertable. */
function recordingSpawn(): { calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }>; impl: any } {
  const calls: Array<{ cmd: string; env: NodeJS.ProcessEnv }> = []
  const impl = (cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, env: opts.env })
    const child = new FakeChild()
    queueMicrotask(() => child.emit('close', 0))
    return child
  }
  return { calls, impl }
}

describe('childEnv', () => {
  it('drops every colliding name so the parent’s stale export cannot stand in for it', () => {
    const env = childEnv({ ADMIN_PASSWORD: 'stale-codex-value', PATH: '/bin' }, { DATABASE_URL: 'pg://x' }, COLLISION)
    expect(env.ADMIN_PASSWORD).toBeUndefined()
    expect(env.DATABASE_URL).toBe('pg://x')
    expect(env.PATH).toBe('/bin')
  })
})

describe('run with a collision', () => {
  it('refuses: nothing is spawned, and the exit code is the gate code 2', async () => {
    const { calls, impl } = recordingSpawn()
    try {
      const { out, err } = await capture(async () => {
        await expect(runWithSecrets('echo', ['hi'], {
          fetchBundle: async () => ({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }),
          spawnImpl: impl,
        })).rejects.toBeInstanceOf(CliExit)
      })
      expect(calls).toEqual([]) // the whole point: no child ran
      expect(process.exitCode).toBe(2)
      expect(err).toContain('ADMIN_PASSWORD omitted — 3 services define it:')
      expect(err).toContain('--ignore-collisions')
      expect(out).toBe('') // run's stdout belongs to the child; there is no child
    } finally { process.exitCode = 0 }
  })

  it('refusalLines say how to proceed both ways', () => {
    const lines = refusalLines(COLLISION).join('\n')
    expect(lines).toContain('insta run --service compute/hermes')
    expect(lines).toContain('insta run --ignore-collisions')
  })

  // The regression that motivated the refusal: a withheld name is simply MISSING from the
  // bundle, and `{ ...process.env, ...bundle }` then hands the child whatever the developer
  // once exported — hermes' command running against codex's password.
  it('--ignore-collisions runs but strips the name, even when process.env holds a value for it', async () => {
    process.env.ADMIN_PASSWORD = 'stale-codex-value'
    try {
      const { err } = await capture(async () => {
        const code = await runWithSecrets(
          process.execPath,
          ['-e', 'process.exit(process.env.ADMIN_PASSWORD === undefined && process.env.DATABASE_URL === "pg://x" ? 7 : 1)'],
          {
            fetchBundle: async () => ({ secrets: { DATABASE_URL: 'pg://x' }, collisions: COLLISION }),
            ignoreCollisions: true,
          },
        )
        expect(code).toBe(7) // 7 only if ADMIN_PASSWORD reached the child as absent
      })
      expect(err).toContain('ADMIN_PASSWORD')
    } finally { delete process.env.ADMIN_PASSWORD }
  })
})

describe('run --service', () => {
  it('fetches that service’s own env and spawns normally', async () => {
    const api = stubApi({ secrets: { ADMIN_PASSWORD: 'hermes-pw' }, collisions: [] })
    const { calls, impl } = recordingSpawn()
    const code = await runWithSecrets('hermes-cmd', [], {
      fetchBundle: bundleFetcher(api, 'p1', { branch: 'dev', service: 'compute/hermes' }),
      spawnImpl: impl,
    })
    expect(code).toBe(0)
    expect(api.calls).toEqual(['GET /projects/p1/secrets?branch=dev&service=compute%2Fhermes'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.env.ADMIN_PASSWORD).toBe('hermes-pw')
  })
})
