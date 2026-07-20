import { test, expect } from 'vitest'
import { buildAddServiceBody } from '../src/commands/services.js'

test('includes region for postgres/compute', () => {
  expect(buildAddServiceBody('postgres', 'db', { region: 'us-east' })).toEqual({ type: 'postgres', name: 'db', region: 'us-east', public: false })
  expect(buildAddServiceBody('compute', 'api', { region: 'eu-central', branch: 'feat' })).toEqual({ type: 'compute', name: 'api', branch: 'feat', region: 'eu-central', public: false })
})

test('omits region when not provided', () => {
  expect(buildAddServiceBody('postgres', 'db', {})).toEqual({ type: 'postgres', name: 'db', public: false })
})

test('rejects region on storage, and --public on non-storage', () => {
  expect(() => buildAddServiceBody('storage', 'files', { region: 'us-east' })).toThrow(/--region is not valid for storage/)
  expect(() => buildAddServiceBody('postgres', 'db', { public: true })).toThrow(/--public is only valid for storage/)
})
