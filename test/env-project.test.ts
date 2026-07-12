// Railway-parity linkless targeting: INSTA_PROJECT_ID (+ INSTA_BRANCH / INSTA_ORG_ID) resolve the
// project with no .insta/project.json anywhere — for CI, one-off commands, and agents. Env wins
// over a link file (an explicit parameter beats ambient state).
import { test, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProject, writeProject } from '../src/config.js'

afterEach(() => { delete process.env.INSTA_PROJECT_ID; delete process.env.INSTA_BRANCH; delete process.env.INSTA_ORG_ID })

test('INSTA_PROJECT_ID targets a project from an unlinked directory', async () => {
  process.env.INSTA_PROJECT_ID = 'p-env'
  const lone = mkdtempSync(join(tmpdir(), 'insta-nolink-'))
  expect(await readProject(lone)).toMatchObject({ projectId: 'p-env', branch: 'main' })
})

test('INSTA_BRANCH overrides the default branch; env beats a link file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-linked-'))
  await writeProject({ projectId: 'p-file', orgId: 'o', branch: 'main' }, dir)
  process.env.INSTA_PROJECT_ID = 'p-env'
  process.env.INSTA_BRANCH = 'feat'
  expect(await readProject(dir)).toMatchObject({ projectId: 'p-env', branch: 'feat' })
})

test('without the env var, the link file still rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-linked-'))
  await writeProject({ projectId: 'p-file', orgId: 'o', branch: 'main' }, dir)
  expect(await readProject(dir)).toMatchObject({ projectId: 'p-file' })
})
