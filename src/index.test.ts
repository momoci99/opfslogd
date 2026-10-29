import { describe, expect, it } from 'vitest'
import { formatLog } from './index'

describe('formatLog', () => {
  it('prefixes message with level', () => {
    expect(formatLog('info', 'hello')).toBe('[INFO] hello')
  })
})
