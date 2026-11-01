import { describe, expect, it } from 'vitest'
import { mergeContext, serializeContext } from './context'

describe('mergeContext (#032)', () => {
  it('merges top-level keys and leaves the input unchanged', () => {
    const cur = { version: '2.3.1', env: 'prod' }
    expect(mergeContext(cur, { userId: 'u42' })).toEqual({ version: '2.3.1', env: 'prod', userId: 'u42' })
    expect(cur).toEqual({ version: '2.3.1', env: 'prod' })
  })

  it('removes keys set to undefined', () => {
    expect(mergeContext({ a: 1, userId: 'u42' }, { userId: undefined })).toEqual({ a: 1 })
  })

  it('replaces nested objects instead of merging them', () => {
    expect(mergeContext({ user: { id: 1, plan: 'pro' } }, { user: { id: 2 } })).toEqual({ user: { id: 2 } })
  })

  it('ignores a non-object partial', () => {
    expect(mergeContext({ a: 1 }, null)).toEqual({ a: 1 })
    expect(mergeContext({ a: 1 }, 'x')).toEqual({ a: 1 })
  })
})

describe('serializeContext', () => {
  it('serializes to JSON', () => {
    expect(serializeContext({ a: 1 })).toBe('{"a":1}')
  })

  it('replaces an unserializable context instead of throwing (#011)', () => {
    const c: Record<string, unknown> = {}
    c.self = c
    expect(JSON.parse(serializeContext(c))).toEqual({ _unserializable: expect.stringContaining('TypeError') })
  })
})
