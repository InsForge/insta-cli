import { describe, it, expect } from 'vitest'
import {
  assertType, parseCount, parseAccess, resolveServiceId, resolveComputeServiceId, SERVICE_TYPES,
  servicesAddRequestBody, servicesAdd, serviceListLine,
} from '../src/commands/services.js'

describe('assertType', () => {
  it('accepts valid service types', () => {
    for (const t of SERVICE_TYPES) expect(() => assertType(t)).not.toThrow()
  })
  it('rejects unknown types', () => {
    expect(() => assertType('lambda')).toThrow(/postgres\|storage\|compute/)
  })
  it('honors a restricted allowed set (scale = compute only)', () => {
    expect(() => assertType('compute', ['compute'])).not.toThrow()
    expect(() => assertType('postgres', ['compute'])).toThrow(/must be compute/)
    expect(() => assertType('storage', ['compute', 'postgres'])).toThrow(/compute\|postgres/)
  })
})

describe('parseCount', () => {
  it('parses positive integers', () => {
    expect(parseCount('1')).toBe(1)
    expect(parseCount('5')).toBe(5)
  })
  it('rejects zero, negatives, and non-integers', () => {
    expect(() => parseCount('0')).toThrow(/positive integer/)
    expect(() => parseCount('-2')).toThrow(/positive integer/)
    expect(() => parseCount('2.5')).toThrow(/positive integer/)
    expect(() => parseCount('abc')).toThrow(/positive integer/)
  })
})

describe('parseAccess', () => {
  it('maps public/private to a boolean', () => {
    expect(parseAccess('public')).toBe(true)
    expect(parseAccess('private')).toBe(false)
  })
  it('rejects anything else', () => {
    expect(() => parseAccess('open')).toThrow(/public\|private/)
    expect(() => parseAccess('')).toThrow(/public\|private/)
    expect(() => parseAccess('Public')).toThrow(/public\|private/)
  })
})

describe('resolveServiceId', () => {
  const services = [
    { id: 'a', type: 'postgres', name: 'db' },
    { id: 'b', type: 'compute', name: 'api' },
    { id: 'c', type: 'compute', name: 'worker' },
  ]
  it('resolves by (type, name)', () => {
    expect(resolveServiceId(services, 'compute', 'worker')).toBe('c')
    expect(resolveServiceId(services, 'postgres', 'db')).toBe('a')
  })
  it('throws when not found', () => {
    expect(() => resolveServiceId(services, 'compute', 'nope')).toThrow(/service not found/)
    expect(() => resolveServiceId(services, 'storage', 'db')).toThrow(/service not found/)
  })
})

describe('resolveComputeServiceId', () => {
  const one = [{ id: 'a', type: 'postgres', name: 'db' }, { id: 'b', type: 'compute', name: 'api' }]
  const two = [...one, { id: 'c', type: 'compute', name: 'worker' }]
  it('returns the sole compute service when name is omitted', () => {
    expect(resolveComputeServiceId(one)).toBe('b')
  })
  it('resolves by name', () => {
    expect(resolveComputeServiceId(two, 'worker')).toBe('c')
  })
  it('errors when the named compute service is missing', () => {
    expect(() => resolveComputeServiceId(two, 'nope')).toThrow(/compute service not found/)
  })
  it('errors on ambiguity when name omitted', () => {
    expect(() => resolveComputeServiceId(two)).toThrow(/multiple compute services/)
  })
  it('errors when there is no compute service', () => {
    expect(() => resolveComputeServiceId([{ id: 'a', type: 'postgres', name: 'db' }])).toThrow(/no compute service/)
  })
})

describe('servicesAddRequestBody', () => {
  it('omits image/port when not passed', () => {
    const b = servicesAddRequestBody('compute', 'api', 'main', {})
    expect(b).toEqual({ type: 'compute', name: 'api', branch: 'main', public: false })
  })
  it('sends image and port (as a number) when passed', () => {
    const b = servicesAddRequestBody('compute', 'api', 'main', { image: 'ghcr.io/acme/api:latest', port: '3000' })
    expect(b).toMatchObject({ image: 'ghcr.io/acme/api:latest', port: 3000 })
    expect(b.port).toBe(3000) // Number, not the raw string
  })
  it('omits branch when undefined', () => {
    expect(servicesAddRequestBody('postgres', 'db', undefined, {})).toEqual({ type: 'postgres', name: 'db', public: false })
  })
  it('carries --public through unchanged', () => {
    expect(servicesAddRequestBody('storage', 'bkt', 'main', { public: true })).toMatchObject({ public: true })
  })
})

describe('servicesAdd validation (throws before any network/config access)', () => {
  it('rejects --image for a non-compute type', async () => {
    await expect(servicesAdd('storage', 'bkt', { image: 'ghcr.io/acme/api:latest' })).rejects.toThrow(/--image is only valid for compute services/)
  })
  it('rejects --port for a non-compute type', async () => {
    await expect(servicesAdd('postgres', 'db', { port: '3000' })).rejects.toThrow(/--port is only valid for compute services/)
  })
  it('rejects --public for a non-storage type', async () => {
    await expect(servicesAdd('compute', 'api', { public: true })).rejects.toThrow(/--public is only valid for storage services/)
  })
  it('rejects an unknown service type before any option checks', async () => {
    await expect(servicesAdd('lambda', 'x', {})).rejects.toThrow(/postgres\|storage\|compute/)
  })
})

describe('serviceListLine', () => {
  it('renders a compute row with the running image when present', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, image: 'ghcr.io/acme/api:latest', port: 8080 })
    expect(line).toBe('compute/api  [active]  x1  running ghcr.io/acme/api:latest:8080  svc_1')
  })
  it('renders a compute row without a port suffix when port is absent', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, image: 'ghcr.io/acme/api:latest' })
    expect(line).toBe('compute/api  [active]  x1  running ghcr.io/acme/api:latest  svc_1')
  })
  it('renders a compute row unchanged when no image is reported', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 2 })
    expect(line).toBe('compute/api  [active]  x2  svc_1')
  })
  it('renders a storage row with access, unaffected by the image change', () => {
    const line = serviceListLine({ type: 'storage', name: 'bkt', status: 'active', id: 'svc_2', public: true })
    expect(line).toBe('storage/bkt  [active]  public  svc_2')
  })
  it('renders a postgres row with domain', () => {
    const line = serviceListLine({ type: 'postgres', name: 'db', status: 'active', id: 'svc_3', domain: 'db.example.com' })
    expect(line).toBe('postgres/db  [active]  db.example.com  svc_3')
  })
})
