// The Claude Code hooks schema executes `command` as ONE shell string ($CLAUDE_PROJECT_DIR is an
// env var the shell expands). The installer used to emit command:'node' + an args array with a
// ${CLAUDE_PROJECT_DIR} template — nothing expands it, so node threw MODULE_NOT_FOUND after EVERY
// tool call in every linked project. Found live (user report, 2026-07-12).
import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installObserve } from '../src/observe/install.js'

function fakeAssets(): string {
  const d = mkdtempSync(join(tmpdir(), 'obs-assets-'))
  writeFileSync(join(d, 'hook.js'), '// hook')
  writeFileSync(join(d, 'scanner.js'), '// scanner')
  return d
}

test('claude hook entry is a single shell-string command with $CLAUDE_PROJECT_DIR (no args array)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const hook = settings.hooks.PostToolUse.at(-1).hooks[0]
  expect(hook.args).toBeUndefined()
  expect(hook.command).toBe('node "$CLAUDE_PROJECT_DIR/.insta/observe/hook.js"')
})

test('re-install replaces a broken legacy args-array entry instead of stacking', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.insta/observe/hook.js'], _insta: 'insta-observe' }] }] },
  }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const all = settings.hooks.PostToolUse.flatMap((g: any) => g.hooks)
  expect(all).toHaveLength(1)
  expect(all[0].args).toBeUndefined()
})
