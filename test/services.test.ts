import { describe, it, expect } from 'vitest'
import { assertType, assertServiceName, parseCount, parseAccess, resolveServiceId, resolveComputeServiceId, SERVICE_TYPES } from '../src/commands/services.js'

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

describe('assertServiceName', () => {
  it('accepts lower-kebab service names', () => {
    expect(() => assertServiceName('primary-db')).not.toThrow()
  })
  it('rejects names outside the platform service-name rule', () => {
    expect(() => assertServiceName('Primary')).toThrow(/lower-kebab/)
    expect(() => assertServiceName('-db')).toThrow(/lower-kebab/)
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
