import { readFileSync } from 'node:fs'

// bun build --define bakes INSTA_CLI_VERSION into the standalone binary, which has no package.json to read.
export function cliVersion(): string {
  if (process.env.INSTA_CLI_VERSION) return process.env.INSTA_CLI_VERSION
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
  } catch {
    return '0.0.0'
  }
}

export const USER_AGENT = `insta-cli/${cliVersion()}`
