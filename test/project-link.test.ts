// "Link once and it works" requires git-style ancestor lookup: commands run from any
// subdirectory of a linked project must resolve the SAME link, and updates (branch switch)
// must rewrite the link at the project root — never mint a nested .insta in the subdir.
import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProject, writeProject } from '../src/config.js'

const proj = { projectId: 'p-1', orgId: 'o-1', branch: 'main' }

function linkedProjectWithSubdir(): { root: string; sub: string } {
  const root = mkdtempSync(join(tmpdir(), 'insta-link-'))
  const sub = join(root, 'src', 'deep')
  mkdirSync(sub, { recursive: true })
  return { root, sub }
}

test('readProject finds the link from a nested subdirectory', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  expect(await readProject(sub)).toMatchObject({ projectId: 'p-1' })
})

test('writeProject from a subdirectory updates the root link, not a nested copy', async () => {
  const { root, sub } = linkedProjectWithSubdir()
  await writeProject(proj, root)
  await writeProject({ ...proj, branch: 'feat' }, sub) // e.g. `insta branch switch feat` run in src/deep
  expect((await readProject(root))?.branch).toBe('feat')
  expect(existsSync(join(sub, '.insta'))).toBe(false) // no second link minted
})

test('unlinked directories still resolve to null (walk stops at fs root)', async () => {
  const lone = mkdtempSync(join(tmpdir(), 'insta-unlinked-'))
  expect(await readProject(lone)).toBeNull()
})
