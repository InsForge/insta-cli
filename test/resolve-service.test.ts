// `insta services add` used to answer a missing type with commander's "missing required argument",
// which never says what the types are. Resolution: both args given → untouched (no prompt anywhere
// near the fast path); TTY → ask what, then what to call it; no TTY → the kind list as an error,
// because nothing was created; a bad type → straight through, so assertType keeps owning that
// wording.
import { test, expect } from 'vitest'
import {
  SERVICE_KINDS,
  missingArgsMessage,
  resolveServiceArgs,
  serviceKindLines,
  type ServiceArgsDeps,
} from '../src/resolve-service.js'
import { SERVICE_TYPES } from '../src/commands/services.js'

const deps = (over: Partial<ServiceArgsDeps> = {}): ServiceArgsDeps => ({
  selectType: async () => { throw new Error('selectType must not be called') },
  askName: async () => { throw new Error('askName must not be called') },
  tty: true,
  ...over,
})

test('every service type has a kind entry to offer', () => {
  expect(SERVICE_KINDS.map((k) => k.type)).toEqual([...SERVICE_TYPES])
})

test('both arguments given: returned as-is, nothing is asked', async () => {
  const r = await resolveServiceArgs('postgres', 'main-db', deps())
  expect(r).toEqual({ type: 'postgres', name: 'main-db' })
})

test('no arguments + TTY: asks what, then the name for that kind', async () => {
  const asked: string[] = []
  const r = await resolveServiceArgs(undefined, undefined, deps({
    selectType: async (kinds) => { asked.push('type'); return kinds[1]!.type },
    askName: async (kind) => { asked.push(`name:${kind.type}`); return kind.defaultName },
  }))
  expect(r).toEqual({ type: 'storage', name: 'assets' })
  expect(asked).toEqual(['type', 'name:storage'])
})

test('type given, name missing + TTY: only the name is asked', async () => {
  const r = await resolveServiceArgs('compute', undefined, deps({ askName: async (k) => k.defaultName }))
  expect(r).toEqual({ type: 'compute', name: 'app' })
})

test('no TTY: throws, and the message lists every kind with an example', async () => {
  await expect(resolveServiceArgs(undefined, undefined, deps({ tty: false }))).rejects.toThrow(/what to add/)
  const msg = missingArgsMessage()
  for (const t of SERVICE_TYPES) expect(msg).toContain(t)
  expect(msg).toContain('insta services add postgres main-db')
})

test('no TTY with a type: asks for the missing half, not the whole list', () => {
  expect(missingArgsMessage('storage')).toBe('name the service:  insta services add storage assets')
})

test('unknown type: passed through for assertType to report, prompts untouched', async () => {
  const r = await resolveServiceArgs('mysql', undefined, deps({ tty: false }))
  expect(r).toEqual({ type: 'mysql', name: '' })
})

test('kind lines stay one per type and mention what each is', () => {
  const lines = serviceKindLines()
  expect(lines).toHaveLength(SERVICE_TYPES.length)
  expect(lines.join('\n')).toContain('empty until `insta deploy`')
})
