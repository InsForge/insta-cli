// Railway-lesson: the install moment must read clean. We CAPTURE the skills tool's clack UI
// (clone spinner, "Installing to all N agents", the full path box, the third-party security
// box) and print our own one-line summary instead of streaming it. These tests pin the summary
// and the error-path classifier (which still decides what to surface if the install FAILS).
import { test, expect } from 'vitest'
import { classifyInstallLine, parseInstalledAgents, summarizeInstall } from '../src/commands/setup.js'

// Representative slice of what `skills add … -a '*'` actually prints on success — including the
// box borders the tool wraps each path in (the exact format the parser must tolerate).
const SAMPLE = `
●  Installing to all 73 agents
◇  Installed 1 skill ────────────────────╮
│                                        │
│  ✓ insta (copied)                      │
│    → ~/.agents/skills/insta            │
│    → ~/.claude/skills/insta            │
│    → ~/.cursor/skills/insta            │
│    → ~/.config/goose/skills/insta      │
│    → ~/.codeium/windsurf/skills/insta  │
│    → ~/.aider-desk/skills/insta        │
│    → ~/.kilocode/skills/insta          │
├────────────────────────────────────────╯
`

test('summary names the well-known agents and rolls the rest into +N more', () => {
  const { count, names } = parseInstalledAgents(SAMPLE)
  expect(count).toBe(7)
  expect(names).toContain('Claude Code')
  expect(names).toContain('Cursor')
  expect(names).toContain('Universal (.agents)')
  const line = summarizeInstall(SAMPLE)
  expect(line.startsWith('✓ Agent skills —')).toBe(true)
  expect(line).toContain('Claude Code')
  // never dumps raw paths or the scary "73 agents" banner
  expect(line).not.toContain('skills/insta')
  expect(line).not.toContain('73 agents')
})

test('summary degrades gracefully when no paths are parseable', () => {
  expect(summarizeInstall('some unexpected output')).toBe('✓ insta skill installed for your coding agents')
})

test('error-path classifier drops expected no-global-support noise', () => {
  expect(classifyInstallLine('✗ insta → Eve: Eve does not support global skill installation')).toBe('skip')
  expect(classifyInstallLine('■  Failed to install 2')).toBe('skip')
})

test('error-path classifier keeps REAL failures', () => {
  expect(classifyInstallLine('✗ insta → Claude Code: EACCES permission denied')).toBe('keep')
})
