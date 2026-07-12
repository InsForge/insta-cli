// "One command, just works": an unlinked directory must not die with a link lecture.
// Resolution: exactly one project → auto-select silently and SAVE the link (next run is
// instant); several + TTY → picker, then save; several + no TTY → actionable error listing
// ids; zero → point at project create.
import { test, expect } from 'vitest'
import { autoResolveProject, type ResolveDeps } from '../src/resolve-project.js'

const deps = (over: Partial<ResolveDeps>): ResolveDeps => ({
  listProjects: async () => [{ id: 'p-1', name: 'solo' }],
  promptChoice: async () => { throw new Error('prompt must not be called') },
  save: async () => {},
  tty: true,
  ...over,
})

test('exactly one project: auto-selects and saves the link, no prompt', async () => {
  const saved: unknown[] = []
  const r = await autoResolveProject('org-1', deps({ save: async (c) => { saved.push(c) } }))
  expect(r).toMatchObject({ projectId: 'p-1', branch: 'main' })
  expect(saved).toHaveLength(1)
})

test('several projects + TTY: picker chooses, choice is saved', async () => {
  const saved: unknown[] = []
  const r = await autoResolveProject('org-1', deps({
    listProjects: async () => [{ id: 'p-1', name: 'a' }, { id: 'p-2', name: 'b' }],
    promptChoice: async (items) => items[1]!,
    save: async (c) => { saved.push(c) },
  }))
  expect(r.projectId).toBe('p-2')
  expect(saved).toHaveLength(1)
})

test('several projects + no TTY: dies actionably (lists ids, suggests env/link)', async () => {
  await expect(autoResolveProject('org-1', deps({
    listProjects: async () => [{ id: 'p-1', name: 'a' }, { id: 'p-2', name: 'b' }],
    tty: false,
  }))).rejects.toThrow(/INSTA_PROJECT_ID|project link/)
})

test('zero projects: dies pointing at project create', async () => {
  await expect(autoResolveProject('org-1', deps({ listProjects: async () => [] })))
    .rejects.toThrow(/project create/)
})
