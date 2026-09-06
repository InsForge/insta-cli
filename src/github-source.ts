// Fetch a template manifest out of a GitHub repository, on this machine, with the user's own git
// credentials. Parsing, ref resolution and the shallow clone live here; the deploy path stays in
// commands/template.ts. See docs/superpowers/specs/2026-09-04-template-deploy-github-url-design.md.
import { MANIFEST_FILE } from './template-manifest.js'

export type GitHubTarget = { owner: string; repo: string; refAndPath: string }

const GITHUB_HOST = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i
// Checked FIRST: `./x` and `../x` would otherwise read as a dotted host followed by a slash.
const LOCAL_PREFIX = /^[.~/\\]/
// A scheme, an scp-style address, or a dotted first segment: all of these are addresses, not paths.
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\/|^[^/\\]+@[^/\\]+:|^[^/\\]*\.[^/\\]*\//i
const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function unsupportedSourceMessage(target: string): string {
  return `unsupported template source: ${target}. Use a registry code, a local directory, or https://github.com/<owner>/<repo>[/tree/<ref>[/<dir>]]`
}

// Percent-decode first, so %2e%2e and %2f cannot smuggle a traversal past the segment check.
function decodedSegments(parts: string[], target: string): string[] {
  return parts.map((raw) => {
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { throw new Error(unsupportedSourceMessage(target)) }
    if (!seg || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) throw new Error(unsupportedSourceMessage(target))
    return seg
  })
}

/** Parse a github.com URL into owner, repo and the still-unsplit ref+path tail.
 *  null = not URL-shaped, so the caller's local-directory and registry modes still get a look.
 *  A URL-shaped target that is not a github.com repository URL throws (spec 4.1). */
export function parseGitHubTemplateUrl(target: string): GitHubTarget | null {
  if (!GITHUB_HOST.test(target)) {
    // A path is never an address, whatever dots it carries: `./x` must reach local mode, not throw.
    if (!LOCAL_PREFIX.test(target) && URL_SHAPED.test(target)) throw new Error(unsupportedSourceMessage(target))
    return null
  }
  const rest = target.replace(GITHUB_HOST, '').replace(/\/+$/, '')
  const parts = rest.split('/')
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/i, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new Error(unsupportedSourceMessage(target))

  const kind = parts[2]
  if (kind === undefined) return { owner, repo, refAndPath: '' }
  if (kind !== 'tree' && kind !== 'blob') throw new Error(unsupportedSourceMessage(target))

  let tail = decodedSegments(parts.slice(3), target)
  if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  if (kind === 'blob') {
    // A file link is read as its directory, and only for the manifest itself.
    if (tail[tail.length - 1] !== MANIFEST_FILE) throw new Error(unsupportedSourceMessage(target))
    tail = tail.slice(0, -1)
    if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  }
  return { owner, repo, refAndPath: tail.join('/') }
}
