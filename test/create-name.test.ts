import { test, expect, afterEach } from 'vitest'
import { slugifyName, resolveProjectName } from '../src/commands/project.js'

const realTTY = process.stdin.isTTY
afterEach(() => { Object.defineProperty(process.stdin, 'isTTY', { value: realTTY, configurable: true }) })

test('slugify makes a valid project name', () => {
  expect(slugifyName('My Cool App!')).toBe('my-cool-app')
  expect(slugifyName('linkbox')).toBe('linkbox')
})
test('explicit arg wins (slugified)', async () => {
  expect(await resolveProjectName('LinkBox', '/x/whatever')).toBe('linkbox')
})
test('no arg, non-TTY → directory basename (so the pasted one-liner runs unedited)', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  expect(await resolveProjectName(undefined, '/Users/me/my-project')).toBe('my-project')
})
test('no arg, TTY → prompt, Enter accepts the dir-name default', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  expect(await resolveProjectName(undefined, '/Users/me/cool-thing', async () => '')).toBe('cool-thing')
  expect(await resolveProjectName(undefined, '/Users/me/cool-thing', async () => 'chosen name')).toBe('chosen-name')
})
