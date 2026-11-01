import { describe, expect, it } from 'vitest'
import { serializeRecord } from './record'
import { exportLineMaker, headerLine, parseHeader, scanSegment, type SegmentHeader } from './segment'

const enc = new TextEncoder()

function file(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const HEADER = headerLine('k3f9x2ab', 40, '{"version":"2.3.1"}') + '\n'
const R1 = serializeRecord(300, 'info', 'a') + '\n'
const R2 = serializeRecord(100, 'error', 'b', { k: 1 }) + '\n'
const R3 = serializeRecord(200, 'warn', 'c') + '\n'

describe('header line (#071)', () => {
  it('uses the final key names in order', () => {
    expect(headerLine('k3f9x2ab', 0, '{}')).toBe('{"format":1,"minReader":1,"tab":"k3f9x2ab","seq0":0,"context":{}}')
  })

  it('round-trips', () => {
    expect(parseHeader(HEADER.trimEnd())).toEqual({
      format: 1,
      minReader: 1,
      tab: 'k3f9x2ab',
      seq0: 40,
      context: { version: '2.3.1' },
    })
  })

  it.each([
    'not json',
    '[]',
    R1.trimEnd(),
    '{"format":1,"minReader":1,"tab":"t","seq0":-1,"context":{}}',
    '{"format":1,"minReader":1,"tab":"t","seq0":0,"context":null}',
    '{"format":1,"minReader":1,"tab":"t","seq0":0.5,"context":{}}',
  ])('rejects %s', (line) => {
    expect(parseHeader(line)).toBeUndefined()
  })

  it('ignores unknown keys (#013)', () => {
    expect(parseHeader('{"format":2,"minReader":1,"tab":"t","seq0":0,"context":{},"extra":true}')).toMatchObject({
      format: 2,
    })
  })
})

describe('scanSegment (#016)', () => {
  it('reads a clean file and finds the ts range (#067)', () => {
    const bytes = file(HEADER, R1, R2, R3)
    expect(scanSegment(bytes)).toMatchObject({ kind: 'ok', lines: 3, validEnd: bytes.length, minTs: 100, maxTs: 300 })
  })

  it('accepts a header-only file', () => {
    const r = scanSegment(file(HEADER))
    expect(r).toMatchObject({ kind: 'ok', lines: 0, validEnd: enc.encode(HEADER).length })
    expect(r).not.toHaveProperty('minTs')
  })

  it('cuts an incomplete last line', () => {
    const r = scanSegment(file(HEADER, R1, R2.slice(0, 10)))
    expect(r).toMatchObject({ kind: 'ok', lines: 1, validEnd: enc.encode(HEADER + R1).length, minTs: 300, maxTs: 300 })
  })

  it('cuts at a zero-filled tail', () => {
    const r = scanSegment(file(HEADER, R1, new Uint8Array(64)))
    expect(r).toMatchObject({ lines: 1, validEnd: enc.encode(HEADER + R1).length })
  })

  it('cuts at a NUL byte inside a line that ends in a newline', () => {
    const bad = enc.encode(R2)
    bad[5] = 0
    expect(scanSegment(file(HEADER, R1, bad, R3))).toMatchObject({ lines: 1 })
  })

  it('cuts at invalid UTF-8', () => {
    expect(scanSegment(file(HEADER, R1, new Uint8Array([0xff, 0xfe, 0x0a]), R3))).toMatchObject({ lines: 1 })
  })

  it('cuts at a line that parses but is not a record, and keeps nothing after it', () => {
    expect(scanSegment(file(HEADER, R1, '[1,2]\n', R3))).toMatchObject({ lines: 1 })
  })

  it('reports a missing or broken header', () => {
    expect(scanSegment(new Uint8Array(0))).toEqual({ kind: 'broken' })
    expect(scanSegment(file('{"format":1,"minR'))).toEqual({ kind: 'broken' })
    expect(scanSegment(file('garbage\n', R1))).toEqual({ kind: 'broken' })
  })

  it('leaves a newer format alone (#013)', () => {
    const r = scanSegment(file('{"format":3,"minReader":2,"tab":"t","seq0":0,"context":{}}\n', '\0\0\0'))
    expect(r).toMatchObject({ kind: 'unreadable', header: { minReader: 2 } })
  })

  it('handles multi-byte characters', () => {
    const line = serializeRecord(1, 'info', '결제 실패 😀') + '\n'
    expect(scanSegment(file(HEADER, line))).toMatchObject({ lines: 1 })
  })
})

describe('exportLineMaker (#033, #071)', () => {
  const header: SegmentHeader = { format: 1, minReader: 1, tab: 'k3f9x2ab', seq0: 40, context: { userId: 'u42' } }

  it('adds tab, seq, and context to each line', () => {
    const make = exportLineMaker(header)
    const line = serializeRecord(1793251200123, 'info', 'clicked', { id: 7 })
    expect(make(line, 2)).toBe(
      '{"ts":1793251200123,"lv":"info","msg":"clicked","ctx":{"id":7},"tab":"k3f9x2ab","seq":42,"context":{"userId":"u42"}}',
    )
    expect(JSON.parse(make(line, 0))).toMatchObject({ seq: 40 })
  })

  it('leaves out an empty context', () => {
    const make = exportLineMaker({ ...header, context: {} })
    expect(make(serializeRecord(1, 'warn', 'x'), 0)).toBe('{"ts":1,"lv":"warn","msg":"x","tab":"k3f9x2ab","seq":40}')
  })
})
