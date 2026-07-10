// The deploy request body maps CLI options to the platform API. --websocket is only sent when set, so
// a plain deploy is byte-for-byte unchanged.
import { describe, it, expect } from 'vitest'
import { deployRequestBody } from '../src/commands/deploy.js'

describe('deployRequestBody', () => {
  it('omits websocket for a normal deploy', () => {
    const b = deployRequestBody('img', 'main', { port: '3000' })
    expect(b.websocket).toBeUndefined()
    expect(b).toMatchObject({ image: 'img', branch: 'main', port: 3000 })
  })
  it('sends websocket:true when --websocket is set', () => {
    expect(deployRequestBody('img', 'main', { websocket: true }).websocket).toBe(true)
  })
  it('leaves port undefined when not provided', () => {
    expect(deployRequestBody('img', 'main', {}).port).toBeUndefined()
  })
})
