// Railway-lesson: the install moment must read all-green. The skills tool prints a red
// "Failed to install N" for agents that don't support global installs (Eve, PromptScript) —
// expected noise, not failure. Filter classifies each line: keep real output, drop the
// expected-noise lines, and summarize what was skipped.
import { test, expect } from 'vitest'
import { classifyInstallLine } from '../src/commands/setup.js'

test('drops expected no-global-support failures and the red banner', () => {
  expect(classifyInstallLine('✗ insta → Eve: Eve does not support global skill installation')).toBe('skip')
  expect(classifyInstallLine('✗ insta → PromptScript: PromptScript does not support global skill installation')).toBe('skip')
  expect(classifyInstallLine('■  Failed to install 2')).toBe('skip')
})

test('keeps real progress and REAL failures', () => {
  expect(classifyInstallLine('→ ~/.claude/skills/insta')).toBe('keep')
  expect(classifyInstallLine('✓ Repository cloned')).toBe('keep')
  expect(classifyInstallLine('✗ insta → Claude Code: EACCES permission denied')).toBe('keep')
})
