import { describe, expect, it } from 'vitest'
import { DROP_MSG, RecordQueue, type Batch } from './queue'
import { serializeRecord, type Level } from './record'

function log(q: RecordQueue, lv: Level, ts: number, msg = 'm'): boolean {
  if (!q.admit(lv, ts)) return false
  q.push(serializeRecord(ts, lv, msg), lv, ts)
  return true
}

function records(b: Batch): Record<string, unknown>[] {
  return b.text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function dropLines(b: Batch): Record<string, unknown>[] {
  return records(b).filter((r) => r.msg === DROP_MSG)
}

/** A valid JSON line of exactly `chars` characters, so tests can fill the cap quickly. */
function fill(q: RecordQueue, chars: number, lv: Level = 'error'): void {
  q.push(`"${'x'.repeat(chars - 2)}"`, lv, 0)
}

describe('RecordQueue', () => {
  it('returns undefined when empty', () => {
    const q = new RecordQueue()
    expect(q.hasData).toBe(false)
    expect(q.take(1)).toBeUndefined()
  })

  it('joins lines with a trailing newline and tracks size', () => {
    const q = new RecordQueue()
    log(q, 'info', 10, 'a')
    log(q, 'warn', 30, 'b')
    log(q, 'debug', 20, 'c')
    expect(q.queuedChars).toBeGreaterThan(0)
    const b = q.take(99)
    expect(b).toMatchObject({ id: 1, lines: 3, seq0: 0, minTs: 10, maxTs: 30 })
    expect(b?.text.endsWith('}\n')).toBe(true)
    expect(records(b!).map((r) => r.msg)).toEqual(['a', 'b', 'c'])
    expect(q.queuedChars).toBe(0)
    expect(q.hasData).toBe(false)
  })

  it('continues seq across batches (#061)', () => {
    const q = new RecordQueue()
    log(q, 'info', 1)
    log(q, 'info', 2)
    expect(q.take(3)?.seq0).toBe(0)
    log(q, 'info', 4)
    expect(q.take(5)).toMatchObject({ id: 2, seq0: 2 })
  })

  describe('overload (#019)', () => {
    it('rejects debug and info at 80%, warn and error until 100%', () => {
      const q = new RecordQueue(1000)
      fill(q, 800)
      expect(q.admit('debug', 1)).toBe(false)
      expect(q.admit('info', 1)).toBe(false)
      expect(q.admit('warn', 1)).toBe(true)
      expect(q.admit('error', 1)).toBe(true)
      fill(q, 200)
      expect(q.admit('warn', 1)).toBe(false)
      expect(q.admit('error', 1)).toBe(false)
    })

    it('counts in-flight data toward the cap until acked (#018)', () => {
      const q = new RecordQueue(1000)
      fill(q, 900)
      const b = q.take(1)!
      expect(q.queuedChars).toBe(0)
      expect(q.admit('info', 2)).toBe(false)
      q.ack(b.id, true)
      expect(q.admit('info', 3)).toBe(true)
    })

    it('writes one drop line with level counts and time range (#070)', () => {
      const q = new RecordQueue(1000)
      fill(q, 850)
      log(q, 'debug', 210)
      log(q, 'debug', 250)
      log(q, 'info', 390)
      const b = q.take(400)!
      const drops = dropLines(b)
      expect(drops).toEqual([
        {
          ts: 400,
          lv: 'warn',
          msg: DROP_MSG,
          ctx: { reason: 'overload', dropped: { debug: 2, info: 1 }, from: 210, to: 390 },
        },
      ])
      // drop line is the last line and takes a seq
      expect(records(b).at(-1)?.msg).toBe(DROP_MSG)
      expect(b.lines).toBe(2)
    })

    it('resets counters after the drop line is written', () => {
      const q = new RecordQueue(1000)
      fill(q, 850)
      log(q, 'debug', 1)
      const b = q.take(2)!
      q.ack(b.id, true)
      log(q, 'info', 3)
      expect(dropLines(q.take(4)!)).toEqual([])
    })

    it('writes a flush that holds only a drop line', () => {
      const q = new RecordQueue(1000)
      fill(q, 900)
      const first = q.take(1)!
      log(q, 'info', 2) // rejected: in-flight is over 80%
      expect(q.hasData).toBe(true)
      const b = q.take(3)!
      expect(b.lines).toBe(1)
      expect(b.seq0).toBe(first.lines)
      expect(dropLines(b)).toHaveLength(1)
    })
  })

  describe('failed writes (#064, #070)', () => {
    it('frees in-flight space and counts the lines by level', () => {
      const q = new RecordQueue(1000)
      log(q, 'info', 100)
      log(q, 'info', 150)
      log(q, 'error', 120)
      const b = q.take(200)!
      q.ack(b.id, false, 'quota')
      const next = q.take(300)!
      expect(dropLines(next)).toEqual([
        {
          ts: 300,
          lv: 'warn',
          msg: DROP_MSG,
          ctx: { reason: 'quota', dropped: { info: 2, error: 1 }, from: 100, to: 150 },
        },
      ])
      // in-flight is back to only the new batch
      q.ack(next.id, true)
      expect(q.admit('debug', 1)).toBe(true)
    })

    it('defaults to write-failed and merges several failed batches', () => {
      const q = new RecordQueue()
      log(q, 'info', 10)
      const a = q.take(11)!
      log(q, 'debug', 20)
      const b = q.take(21)!
      q.ack(a.id, false)
      q.ack(b.id, false, 'write-failed')
      expect(dropLines(q.take(30)!)[0]?.ctx).toEqual({
        reason: 'write-failed',
        dropped: { debug: 1, info: 1 },
        from: 10,
        to: 20,
      })
    })

    it('ignores an unknown or repeated ack', () => {
      const q = new RecordQueue(1000)
      fill(q, 500)
      const b = q.take(1)!
      q.ack(b.id, true)
      q.ack(b.id, false)
      q.ack(999, false)
      expect(q.hasData).toBe(false)
    })
  })

  it('writes retention drops with segments and bytes (#050, #070)', () => {
    const q = new RecordQueue()
    q.addRetention(2, 4_000_000, 1000, 2000)
    q.addRetention(1, 2_000_000, 500, 1500)
    expect(q.hasData).toBe(true)
    expect(dropLines(q.take(3000)!)[0]?.ctx).toEqual({
      reason: 'retention',
      segments: 3,
      bytes: 6_000_000,
      from: 500,
      to: 2000,
    })
  })

  it('writes drop lines in order overload, quota, write-failed, retention (#070)', () => {
    const q = new RecordQueue(1000)
    log(q, 'info', 1)
    const a = q.take(2)!
    log(q, 'info', 3)
    const b = q.take(4)!
    q.ack(a.id, false, 'write-failed')
    q.ack(b.id, false, 'quota')
    q.addRetention(1, 10, 0, 0)
    fill(q, 850)
    log(q, 'debug', 5)
    const reasons = dropLines(q.take(6)!).map((r) => (r.ctx as { reason: string }).reason)
    expect(reasons).toEqual(['overload', 'quota', 'write-failed', 'retention'])
  })
})
