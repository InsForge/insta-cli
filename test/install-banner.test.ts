// The installer's "Next steps" banner is the CLI's onboarding surface — and, because the binary
// upgrade channel re-runs `curl install.sh | sh` with inherited stdio, its upgrade banner too. It
// used to recommend `insta deploy . --port 3000` unqualified, which errors for any app without a
// Dockerfile (the common "just ship my app" case): a directory deploy builds the directory's own
// Dockerfile, and the no-Dockerfile nixpacks lane is server-side, GitHub-connected repos only.
// These assertions pin the banner to what the CLI can actually do.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const installSh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const nextSteps = installSh.slice(installSh.indexOf('echo "Next steps:"'))
const deployLine = nextSteps.split('\n').find((l) => l.includes('insta deploy .'))!

describe('installer next-steps banner', () => {
  it('recommends a deploy line at all (the banner is the onboarding path)', () => {
    expect(deployLine).toBeDefined()
  })

  it('says a directory deploy needs a Dockerfile — it must not promise what deploy rejects', () => {
    expect(deployLine.toLowerCase()).toContain('dockerfile')
  })

  it('points at `insta build` first, so the user sees the plan before the deploy can dead-end', () => {
    expect(nextSteps).toContain('insta build .')
    expect(nextSteps.indexOf('insta build .')).toBeLessThan(nextSteps.indexOf('insta deploy .'))
  })
})
