import { test, expect } from 'vitest'
import { dockerfileExposedPort } from '../src/commands/deploy.js'

test('reads EXPOSE from a Dockerfile (last one wins, case-insensitive, ignores comments)', () => {
  expect(dockerfileExposedPort('FROM node:20\nEXPOSE 3000\nCMD ["npm","start"]')).toBe(3000)
  expect(dockerfileExposedPort('FROM x\nexpose 5000')).toBe(5000)
  expect(dockerfileExposedPort('FROM a AS b\nEXPOSE 8080\nFROM c\nEXPOSE 3000')).toBe(3000)
  expect(dockerfileExposedPort('# EXPOSE 9999\nFROM x')).toBeUndefined()
  expect(dockerfileExposedPort('FROM x\nCMD ["run"]')).toBeUndefined()
})
