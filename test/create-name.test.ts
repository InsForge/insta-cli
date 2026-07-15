import { test, expect } from 'vitest'
import { slugifyName, resolveProjectName, generateProjectName } from '../src/commands/project.js'

test('slugify makes a valid project name', () => {
  expect(slugifyName('My Cool App!')).toBe('my-cool-app')
  expect(slugifyName('linkbox')).toBe('linkbox')
})

test('explicit arg wins (slugified)', async () => {
  expect(await resolveProjectName('LinkBox', '/x/whatever')).toBe('linkbox')
})

test('no arg, real project dir → the dir basename (intuitive, no prompt)', async () => {
  expect(await resolveProjectName(undefined, '/Users/me/my-project', () => 'gen-name-1')).toBe('my-project')
})

test('no arg, GENERIC dir → auto-generated name, never the useless basename', async () => {
  // ~/projects, /tmp, etc. must NOT become a project literally named "projects"/"tmp".
  expect(await resolveProjectName(undefined, '/Users/gary/projects', () => 'swift-otter-482')).toBe('swift-otter-482')
  expect(await resolveProjectName(undefined, '/tmp', () => 'swift-otter-482')).toBe('swift-otter-482')
})

test('no arg NEVER blocks on a prompt (no stdin/TTY dependency)', async () => {
  // Regression: create must resolve a name with zero interaction so `curl|sh && insta project create`
  // and `insta project create` in ~/projects never hang waiting for input.
  const name = await resolveProjectName(undefined, '/Users/gary/projects', () => 'auto-name-1')
  expect(name).toBe('auto-name-1')
})

test('generated names are valid slugs shaped adjective-noun-NNN', () => {
  // deterministic rand → first adjective, first noun, floor(0*900)=0 → "swift-otter-100"
  const n = generateProjectName(() => 0)
  expect(n).toBe('swift-otter-100')
  expect(slugifyName(n)).toBe(n) // already a valid project name
  expect(n).toMatch(/^[a-z]+-[a-z]+-\d{3}$/)
})
