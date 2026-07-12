// CLI config: global (~/.insta/config.json: api url + tokens) and per-project (./.insta/project.json).
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const GLOBAL_DIR = join(homedir(), '.insta')
const GLOBAL_FILE = join(GLOBAL_DIR, 'config.json')
const PROJECT_DIR = '.insta'
const PROJECT_FILE = 'project.json'

export type GlobalConfig = {
  apiUrl: string
  accessToken?: string
  refreshToken?: string
  user?: { id: string; email: string | null; name: string | null }
  autoUpdate?: boolean // self-update on new releases (default true while pre-1.0)
}

export type ProjectConfig = { projectId: string; orgId: string; branch: string }

const DEFAULT_API = 'https://beta-api.insta.insforge.dev'

export async function readGlobal(): Promise<GlobalConfig> {
  // INSTA_API_URL overrides the persisted apiUrl, not just the default — otherwise the
  // env var is silently ignored as soon as any login has written a config file.
  const envApi = process.env.INSTA_API_URL
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_FILE, 'utf8')) as GlobalConfig
    return { ...parsed, apiUrl: envApi ?? parsed.apiUrl ?? DEFAULT_API }
  } catch {
    return { apiUrl: envApi ?? DEFAULT_API }
  }
}

export async function writeGlobal(c: GlobalConfig): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true })
  await writeFile(GLOBAL_FILE, JSON.stringify(c, null, 2))
}

/** Git-style ancestor lookup: the nearest directory at-or-above `cwd` containing
 *  .insta/project.json — so "link once" works from any subdirectory of the project. */
export async function findProjectRoot(cwd = process.cwd()): Promise<string | null> {
  let dir = resolve(cwd)
  for (;;) {
    try {
      await readFile(join(dir, PROJECT_DIR, PROJECT_FILE), 'utf8')
      return dir
    } catch { /* keep climbing */ }
    const parent = dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
}

export async function readProject(cwd = process.cwd()): Promise<ProjectConfig | null> {
  const root = await findProjectRoot(cwd)
  if (!root) return null
  try {
    return JSON.parse(await readFile(join(root, PROJECT_DIR, PROJECT_FILE), 'utf8')) as ProjectConfig
  } catch {
    return null
  }
}

/** Writes to the existing project root when inside a linked project (branch switches from a
 *  subdirectory must not mint a nested link); a fresh `link` in an unlinked tree writes to cwd. */
export async function writeProject(c: ProjectConfig, cwd = process.cwd()): Promise<void> {
  const target = (await findProjectRoot(cwd)) ?? cwd
  await mkdir(join(target, PROJECT_DIR), { recursive: true })
  await writeFile(join(target, PROJECT_DIR, PROJECT_FILE), JSON.stringify(c, null, 2))
}
