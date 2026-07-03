// CLI config: global (~/.insta/config.json: api url + tokens) and per-project (./.insta/project.json).
import { homedir } from 'node:os'
import { join } from 'node:path'
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
}

export type ProjectConfig = { projectId: string; orgId: string; branch: string }

const DEFAULT_API = process.env.INSTA_API_URL ?? 'https://beta-api.insta.insforge.dev'

export async function readGlobal(): Promise<GlobalConfig> {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_FILE, 'utf8')) as GlobalConfig
    return { ...parsed, apiUrl: parsed.apiUrl ?? DEFAULT_API }
  } catch {
    return { apiUrl: DEFAULT_API }
  }
}

export async function writeGlobal(c: GlobalConfig): Promise<void> {
  await mkdir(GLOBAL_DIR, { recursive: true })
  await writeFile(GLOBAL_FILE, JSON.stringify(c, null, 2))
}

export async function readProject(cwd = process.cwd()): Promise<ProjectConfig | null> {
  try {
    return JSON.parse(await readFile(join(cwd, PROJECT_DIR, PROJECT_FILE), 'utf8')) as ProjectConfig
  } catch {
    return null
  }
}

export async function writeProject(c: ProjectConfig, cwd = process.cwd()): Promise<void> {
  await mkdir(join(cwd, PROJECT_DIR), { recursive: true })
  await writeFile(join(cwd, PROJECT_DIR, PROJECT_FILE), JSON.stringify(c, null, 2))
}
