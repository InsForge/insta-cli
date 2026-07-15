import { test, expect } from 'vitest'
import { slugifyName, resolveProjectName } from '../src/commands/project.js'

test('slugify makes a valid project name', () => {
  expect(slugifyName('My Cool App!')).toBe('my-cool-app')
  expect(slugifyName('linkbox')).toBe('linkbox')
})

test('explicit arg wins (slugified)', () => {
  expect(resolveProjectName('LinkBox', '/x/whatever')).toBe('linkbox')
})

test('no arg, real project dir → the dir basename (intuitive, no prompt)', () => {
  expect(resolveProjectName(undefined, '/Users/me/my-project')).toBe('my-project')
})

test('no arg, GENERIC dir → null (caller guides; no junk-named project)', () => {
  // ~/projects, /tmp, etc. must NOT become a project named "projects"/"tmp", and must NOT
  // auto-invent one either — return null so the command guides the user to name it.
  expect(resolveProjectName(undefined, '/Users/gary/projects')).toBeNull()
  expect(resolveProjectName(undefined, '/tmp')).toBeNull()
  expect(resolveProjectName(undefined, '/Users/me/src')).toBeNull()
})

test('no arg, the HOME dir itself → null (not the username)', () => {
  const home = process.env.HOME || '/Users/me'
  expect(resolveProjectName(undefined, home)).toBeNull()
})

test('resolution NEVER blocks on a prompt (pure, no stdin/TTY dependency)', () => {
  // Regression: `curl|sh && insta project create` and bare create in ~/projects must never hang.
  expect(resolveProjectName(undefined, '/Users/gary/projects')).toBeNull()
  expect(resolveProjectName('demo', '/Users/gary/projects')).toBe('demo')
})
