// projectCreate with --json and no resolvable name must HARD-ERROR (exit 1, message on stderr,
// nothing on stdout) — a scripted caller can't act on guidance prose, and the non-json path's
// friendly exit-0 guidance would be read as success. The generic-cwd path runs before any network
// or config access, so this is testable with process mocks alone.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { projectCreate } from '../src/commands/project.js'

describe('projectCreate --json with no resolvable name', () => {
  afterEach(() => vi.restoreAllMocks())

  it('dies (exit 1, stderr) instead of printing exit-0 guidance', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp') // 'tmp' is a GENERIC_DIR → name resolves to null
    vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)

    await expect(projectCreate(undefined, { json: true })).rejects.toThrow('exit 1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr.join('')).toMatch(/no project name — pass one: insta project create <name>/)
    expect(stdout.join('')).toBe('')
  })

  it('non-json path keeps the friendly guidance on stdout (exit 0)', async () => {
    const stdout: string[] = []
    vi.spyOn(process, 'cwd').mockReturnValue('/tmp')
    vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })

    await projectCreate(undefined, {})
    expect(stdout.join('')).toMatch(/name your project:\s+insta project create <name>/)
  })
})
