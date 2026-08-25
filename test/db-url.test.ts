import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { connectWithPsql, resolveDbUrl } from '../src/commands/db.js'

function stubApi(services: Array<{ id: string; type: string; name: string }>, credentials: Record<string, string>, status = 200) {
  const paths: string[] = []
  return {
    paths,
    request: async (_m: string, p: string) => { paths.push(p); return { services } },
    rawRequest: async (_m: string, p: string) => {
      paths.push(p)
      return status === 200 ? { status, body: { credentials } } : { status, body: { status: 'approval_required', action: 'secrets.read', approvalId: 'ap1' } }
    },
  }
}

describe('resolveDbUrl', () => {
  const services = [{ id: 's1', type: 'postgres', name: 'db' }, { id: 's2', type: 'compute', name: 'api' }]

  it('resolves the sole postgres service, branch-scoped, and reads its credentials by id', async () => {
    const api = stubApi(services, { DATABASE_URL: 'pg://db' })
    const r = await resolveDbUrl(api, 'p1', 'dev', undefined)
    expect(r).toEqual({ serviceName: 'db', url: 'pg://db' })
    expect(api.paths).toEqual(['/projects/p1/services?branch=dev', '/projects/p1/services/s1/credentials'])
  })

  it('honours --group and fails on an unknown one', async () => {
    const two = [...services, { id: 's3', type: 'postgres', name: 'analytics' }]
    const api = stubApi(two, { DATABASE_URL: 'pg://an' })
    const r = await resolveDbUrl(api, 'p1', undefined, 'analytics')
    expect(r?.url).toBe('pg://an')
    expect(api.paths[1]).toBe('/projects/p1/services/s3/credentials')
    await expect(resolveDbUrl(stubApi(two, {}), 'p1', undefined, 'nope')).rejects.toThrow(/not found/)
  })

  it('demands --group when several postgres services exist', async () => {
    const two = [...services, { id: 's3', type: 'postgres', name: 'analytics' }]
    await expect(resolveDbUrl(stubApi(two, {}), 'p1', undefined, undefined)).rejects.toThrow(/multiple postgres/)
  })

  it('reports a credential-less service as provisioning, not undefined', async () => {
    await expect(resolveDbUrl(stubApi(services, {}), 'p1', undefined, undefined))
      .rejects.toThrow(/no DATABASE_URL credential yet/)
  })

  it('parks on a 202 approval: null result, exit code 2', async () => {
    expect(await resolveDbUrl(stubApi(services, {}, 202), 'p1', undefined, undefined)).toBeNull()
    expect(process.exitCode).toBe(2)
    process.exitCode = 0
  })
})

class FakeChild extends EventEmitter {}

describe('connectWithPsql', () => {
  it('passes the DSN as psql argv and returns its exit code', async () => {
    let call: { cmd: string; args: string[] } | undefined
    const child = new FakeChild()
    const code = connectWithPsql('pg://db', ((cmd: string, args: string[]) => {
      call = { cmd, args }
      queueMicrotask(() => child.emit('close', 3))
      return child
    }) as any)
    expect(await code).toBe(3)
    expect(call).toEqual({ cmd: 'psql', args: ['pg://db'] })
  })

  it('turns a missing psql binary into guidance, not a raw ENOENT', async () => {
    const child = new FakeChild()
    const code = connectWithPsql('pg://db', (() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn psql ENOENT'), { code: 'ENOENT' })))
      return child
    }) as any)
    await expect(code).rejects.toThrow(/psql not found on PATH.*insta db url/)
  })
})
