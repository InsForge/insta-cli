// `insta db query` seams — all pure, so nothing here reaches a backend (mirrors db-stats.test.ts).
import { describe, expect, it } from 'vitest'

import {
  consoleExecPath, execBody, renderMysqlRows, renderRedisReply, renderMongoResult,
} from '../src/commands/db-query.js'

describe('consoleExecPath', () => {
  it('is the managed-DB console exec route for the service', () => {
    expect(consoleExecPath('pr_1', 'svc_9')).toBe('/projects/pr_1/database/console/svc_9/exec')
  })
})

describe('execBody', () => {
  // mysql/mongodb quote the whole statement, so the tokens rejoin into one command string.
  it('joins mysql args into a single command', () => {
    expect(execBody('mysql', ['select', '*', 'from', 'products', 'limit', '10']))
      .toEqual({ command: 'select * from products limit 10' })
  })

  // redis is pre-tokenized: each arg stays a distinct argv element, verbatim — a value that
  // contains a space (already one shell token) must not be re-split.
  it('keeps redis args as a verbatim argv, never a joined string', () => {
    expect(execBody('redis', ['GET', 'mykey'])).toEqual({ argv: ['GET', 'mykey'] })
    expect(execBody('redis', ['SET', 'greeting', 'hello world']))
      .toEqual({ argv: ['SET', 'greeting', 'hello world'] })
  })

  it('adds database for mongodb only when --database is given', () => {
    expect(execBody('mongodb', ['db.users.find().limit(10).toArray()'], 'shop'))
      .toEqual({ command: 'db.users.find().limit(10).toArray()', database: 'shop' })
    const bare = execBody('mongodb', ['db.users.find()'])
    expect(bare).toEqual({ command: 'db.users.find()' })
    expect('database' in bare).toBe(false)
  })
})

describe('renderMysqlRows', () => {
  it('renders the header and rows as an aligned table with a count footer', () => {
    const lines = renderMysqlRows({
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'price' }],
      rows: [
        ['1', 'apple', '3'],
        ['2', 'banana', null],
      ],
      rowCount: 2,
      truncated: false,
    })
    expect(lines).toEqual([
      'id  name    price',
      '1   apple   3',
      '2   banana  —',
      '(2 rows)',
    ])
  })

  // A null cell is a missing value, rendered as the repo's em-dash — never an empty string or 0.
  it('renders a null cell as an em-dash', () => {
    const lines = renderMysqlRows({ columns: [{ name: 'v' }], rows: [[null]], rowCount: 1 })
    expect(lines[1]).toBe('—')
  })

  // The footer reports the server's rowCount (not rows.length) and flags a truncated page.
  it('uses the returned rowCount and marks truncation', () => {
    const lines = renderMysqlRows({
      columns: [{ name: 'x' }],
      rows: [['a'], ['b']],
      rowCount: 100,
      truncated: true,
    })
    expect(lines).toEqual(['x', 'a', 'b', '(100 rows, truncated)'])
  })
})

describe('renderRedisReply', () => {
  it('prints a scalar reply raw', () => {
    expect(renderRedisReply('OK')).toBe('OK')
    expect(renderRedisReply(42)).toBe('42')
    expect(renderRedisReply(0)).toBe('0')
  })

  it('pretty-prints a structured reply as JSON', () => {
    expect(renderRedisReply(['a', 'b'])).toBe(JSON.stringify(['a', 'b'], null, 2))
    expect(renderRedisReply({ field: 'v' })).toBe(JSON.stringify({ field: 'v' }, null, 2))
    expect(renderRedisReply(null)).toBe('null')
  })
})

describe('renderMongoResult', () => {
  it('pretty-prints the result as JSON', () => {
    const result = [{ _id: 1, name: 'a' }]
    expect(renderMongoResult(result)).toBe(JSON.stringify(result, null, 2))
    expect(renderMongoResult({})).toBe('{}')
  })
})
