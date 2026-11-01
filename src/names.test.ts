import { describe, expect, it } from 'vitest'
import { activeName, closedName, isValidNamespace, lockNames, newTabId, parseSegmentName } from './names'

describe('newTabId (#072)', () => {
  it('returns 8 characters from [0-9a-z]', () => {
    for (let i = 0; i < 200; i++) expect(newTabId()).toMatch(/^[0-9a-z]{8}$/)
  })

  it('returns different IDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, newTabId))
    expect(ids.size).toBe(1000)
  })
})

describe('isValidNamespace (#073)', () => {
  it.each(['default', 'app1', 'my-app', 'my_app', 'a', 'x'.repeat(64)])('accepts %s', (ns) => {
    expect(isValidNamespace(ns)).toBe(true)
  })

  it.each(['', 'App', 'my app', 'a:b', 'a/b', '..', 'a.b', 'x'.repeat(65), 'ñ'])('rejects %j', (ns) => {
    expect(isValidNamespace(ns)).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isValidNamespace(undefined)).toBe(false)
    expect(isValidNamespace(42)).toBe(false)
  })
})

describe('lockNames (#034)', () => {
  it('prefixes every lock with the namespace', () => {
    const l = lockNames('app1')
    expect(l.upload).toBe('opfslogd:app1:upload')
    expect(l.retention).toBe('opfslogd:app1:retention')
    expect(l.tab('k3f9x2ab')).toBe('opfslogd:app1:tab:k3f9x2ab')
  })
})

describe('segment file names (#012, #067)', () => {
  it('pads times to 13 digits', () => {
    expect(activeName(1793251200123, 'k3f9x2ab')).toBe('1793251200123_k3f9x2ab.seg')
    expect(closedName(5, 1793251260456, 'k3f9x2ab')).toBe('0000000000005_1793251260456_k3f9x2ab.seg')
  })

  it('sorts by time as strings', () => {
    const names = [closedName(1000, 2000, 'b'), closedName(999, 3000, 'a'), closedName(10_000, 10_001, 'c')]
    expect([...names].sort()).toEqual([names[1], names[0], names[2]])
  })

  it('parses both name forms', () => {
    expect(parseSegmentName('1793251200123_k3f9x2ab.seg')).toEqual({ startTs: 1793251200123, tabId: 'k3f9x2ab' })
    expect(parseSegmentName('1793251200123_1793251260456_k3f9x2ab.seg')).toEqual({
      startTs: 1793251200123,
      endTs: 1793251260456,
      tabId: 'k3f9x2ab',
    })
  })

  it.each(['notes.txt', '1793251200123_k3f9.tmp', '123_k3f9.seg', '1793251200123_K3F9.seg', '1793251200123_.seg'])(
    'ignores %s',
    (name) => {
      expect(parseSegmentName(name)).toBeUndefined()
    },
  )
})
