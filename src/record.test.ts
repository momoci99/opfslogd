import { describe, expect, it } from 'vitest'
import { serializeRecord } from './record'

const TS = 1793251200123

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('serializeRecord', () => {
  it('writes ts, lv, msg, ctx in that order (#016)', () => {
    const line = serializeRecord(TS, 'info', 'upload done', { fileId: 'a1', ms: 320 })
    expect(line).toBe('{"ts":1793251200123,"lv":"info","msg":"upload done","ctx":{"fileId":"a1","ms":320}}')
  })

  it('leaves out ctx when not given', () => {
    expect(serializeRecord(TS, 'warn', 'slow')).toBe('{"ts":1793251200123,"lv":"warn","msg":"slow"}')
  })

  it('records ctx as it was at call time (#014)', () => {
    const obj = { a: 1 }
    const line = serializeRecord(TS, 'info', 'x', obj)
    obj.a = 2
    expect(parse(line).ctx).toEqual({ a: 1 })
  })

  it('turns a non-string msg into a string', () => {
    expect(parse(serializeRecord(TS, 'info', 42)).msg).toBe('42')
  })

  describe('unserializable ctx (#011)', () => {
    it('replaces a circular ctx', () => {
      const ctx: Record<string, unknown> = {}
      ctx.self = ctx
      const r = parse(serializeRecord(TS, 'info', 'x', ctx))
      expect(r.msg).toBe('x')
      expect(r.ctx).toEqual({ _unserializable: expect.stringContaining('TypeError') })
    })

    it('replaces a ctx holding a BigInt', () => {
      const r = parse(serializeRecord(TS, 'info', 'x', { n: 1n }))
      expect(r.ctx).toEqual({ _unserializable: expect.any(String) })
    })

    it('does not throw when a getter throws', () => {
      const ctx = {
        get bad(): never {
          throw new Error('boom')
        },
      }
      const r = parse(serializeRecord(TS, 'info', 'x', ctx))
      expect(r.ctx).toEqual({ _unserializable: 'Error: boom' })
    })

    it('does not throw when a toJSON throws', () => {
      const ctx = {
        toJSON(): never {
          throw new Error('nope')
        },
      }
      expect(parse(serializeRecord(TS, 'info', 'x', ctx)).ctx).toEqual({ _unserializable: 'Error: nope' })
    })
  })

  describe('errors (#025)', () => {
    it('moves ctx.err into err and keeps the rest of ctx', () => {
      const e = new TypeError('bad')
      const ctx = { err: e, fileId: 'a1' }
      const r = parse(serializeRecord(TS, 'error', 'upload failed', ctx))
      expect(r.ctx).toEqual({ fileId: 'a1' })
      expect(r.err).toEqual({ name: 'TypeError', message: 'bad', stack: e.stack })
      expect(ctx.err).toBe(e) // caller's object unchanged
    })

    it('leaves out ctx when err was its only key', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', { err: new Error('a') }))
      expect('ctx' in r).toBe(false)
      expect(r.err).toMatchObject({ message: 'a' })
    })

    it('accepts an Error as ctx itself', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', new Error('a')))
      expect('ctx' in r).toBe(false)
      expect(r.err).toMatchObject({ name: 'Error', message: 'a' })
    })

    it('keeps a non-Error ctx.err in ctx', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', { err: 'text' }))
      expect(r.ctx).toEqual({ err: 'text' })
      expect('err' in r).toBe(false)
    })

    it('works on every level', () => {
      expect(parse(serializeRecord(TS, 'debug', 'x', new Error('a'))).err).toMatchObject({ message: 'a' })
    })

    it('puts err after ctx', () => {
      const line = serializeRecord(TS, 'error', 'x', { err: new Error('a'), k: 1 })
      expect(line.indexOf('"ctx"')).toBeLessThan(line.indexOf('"err"'))
    })

    it('does not convert an Error deeper in ctx', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', { last: { error: new Error('a') } }))
      expect(r.ctx).toEqual({ last: { error: {} } })
    })
  })

  describe('cause chain (#026)', () => {
    it('stores the cause in the same shape', () => {
      const inner = new TypeError('Failed to fetch')
      const r = parse(serializeRecord(TS, 'error', 'x', new Error('upload failed', { cause: inner })))
      expect(r.err).toMatchObject({ message: 'upload failed', cause: { name: 'TypeError', message: 'Failed to fetch' } })
    })

    it('stores at most 5 levels of cause', () => {
      let e = new Error('e0')
      for (let i = 1; i <= 7; i++) e = new Error(`e${i}`, { cause: e })
      let err = parse(serializeRecord(TS, 'error', 'x', e)).err as Record<string, unknown> | undefined
      const messages: unknown[] = []
      while (err) {
        messages.push(err.message)
        err = err.cause as Record<string, unknown> | undefined
      }
      expect(messages).toEqual(['e7', 'e6', 'e5', 'e4', 'e3', 'e2'])
    })

    it('ends the chain at a cycle', () => {
      const a = new Error('a')
      const b = new Error('b', { cause: a })
      ;(a as { cause?: unknown }).cause = b
      const r = parse(serializeRecord(TS, 'error', 'x', a))
      expect(r.err).toMatchObject({ message: 'a', cause: { message: 'b' } })
      expect((r.err as { cause: Record<string, unknown> }).cause).not.toHaveProperty('cause')
    })

    it('stores a non-Error cause as a plain value', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', new Error('a', { cause: { status: 503 } })))
      expect(r.err).toMatchObject({ cause: { status: 503 } })
    })

    it('replaces an unserializable cause', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', new Error('a', { cause: 1n })))
      expect(r.err).toMatchObject({ cause: { _unserializable: expect.any(String) } })
    })
  })

  describe('own properties (#027)', () => {
    class HttpError extends Error {
      override name = 'HttpError'
      status = 503
      code = 'UPSTREAM_DOWN'
    }

    it('copies enumerable properties', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', new HttpError('bad')))
      expect(r.err).toMatchObject({ name: 'HttpError', message: 'bad', status: 503, code: 'UPSTREAM_DOWN' })
    })

    it('lets fixed fields win over properties with the same name', () => {
      const e = new Error('real')
      Object.defineProperty(e, 'message', { value: 'real', enumerable: true })
      ;(e as unknown as Record<string, unknown>).stack = 'own stack'
      const r = parse(serializeRecord(TS, 'error', 'x', e))
      expect(r.err).toMatchObject({ message: 'real', stack: 'own stack' })
    })

    it('replaces an unserializable property and keeps the others', () => {
      const e = Object.assign(new Error('a'), { big: 1n, ok: true })
      const r = parse(serializeRecord(TS, 'error', 'x', e))
      expect(r.err).toMatchObject({ big: { _unserializable: expect.any(String) }, ok: true })
    })

    it('copies properties at each level of cause', () => {
      const r = parse(serializeRecord(TS, 'error', 'x', new Error('a', { cause: new HttpError('b') })))
      expect(r.err).toMatchObject({ cause: { status: 503 } })
    })
  })
})
