// Main-thread string queue, overload rejection, and drop lines (#015, #018, #019, #064, #070).

import { serializeRecord, type Level } from './record'

/** Cap on queued plus in-flight characters (#019, draft). */
export const CAP_CHARS = 4_000_000

/** Share of the cap at which debug and info are rejected (#019). */
const LOW_LEVEL_LIMIT = 0.8

/** Fixed, documented text of every drop line (#044). */
export const DROP_MSG = 'opfslogd: records dropped'

export type WriteFailReason = 'quota' | 'write-failed'

type LevelCounts = Record<Level, number>

/** One flush, ready to send to the worker. */
export interface Batch {
  id: number
  /** Lines joined with '\n', ending in '\n'. */
  text: string
  /** Record lines, drop lines included. */
  lines: number
  /** `seq` of the first line (#061). */
  seq0: number
  minTs: number
  maxTs: number
}

interface InFlight {
  chars: number
  counts: LevelCounts
  minTs: number
  maxTs: number
}

interface LevelDrops {
  counts: LevelCounts
  from: number
  to: number
}

interface RetentionDrops {
  segments: number
  bytes: number
  from: number
  to: number
}

export class RecordQueue {
  private readonly cap: number
  private lines: string[] = []
  private chars = 0
  private counts: LevelCounts = zeroCounts()
  private minTs = Infinity
  private maxTs = -Infinity

  private inFlightChars = 0
  private readonly inFlight = new Map<number, InFlight>()
  private nextId = 1
  private nextSeq = 0

  // Order here is the order of drop lines in a flush (#070).
  private overload: LevelDrops | undefined
  private quota: LevelDrops | undefined
  private writeFailed: LevelDrops | undefined
  private retention: RetentionDrops | undefined

  constructor(cap: number = CAP_CHARS) {
    this.cap = cap
  }

  /** Characters waiting in the queue; drives the size trigger (#017). */
  get queuedChars(): number {
    return this.chars
  }

  /** True when a flush would write at least one line. */
  get hasData(): boolean {
    return (
      this.lines.length > 0 ||
      this.overload !== undefined ||
      this.quota !== undefined ||
      this.writeFailed !== undefined ||
      this.retention !== undefined
    )
  }

  /**
   * Checks usage before the record is serialized (#019).
   * A rejected record is counted for the overload drop line.
   */
  admit(lv: Level, ts: number): boolean {
    const used = this.chars + this.inFlightChars
    const limit = lv === 'debug' || lv === 'info' ? this.cap * LOW_LEVEL_LIMIT : this.cap
    if (used < limit) return true
    this.overload = addDrop(this.overload, lv, 1, ts, ts)
    return false
  }

  push(line: string, lv: Level, ts: number): void {
    this.lines.push(line)
    this.chars += line.length
    this.counts[lv]++
    if (ts < this.minTs) this.minTs = ts
    if (ts > this.maxTs) this.maxTs = ts
  }

  /** Counts pending segments deleted by a retention run in the worker (#050, #061). */
  addRetention(segments: number, bytes: number, from: number, to: number): void {
    const r = this.retention
    this.retention = r
      ? { segments: r.segments + segments, bytes: r.bytes + bytes, from: Math.min(r.from, from), to: Math.max(r.to, to) }
      : { segments, bytes, from, to }
  }

  /**
   * Empties the queue into one batch, with drop lines appended (#070).
   * Returns undefined when there is nothing to write.
   */
  take(now: number): Batch | undefined {
    if (!this.hasData) return undefined

    this.appendLevelDrop('overload', this.overload, now)
    this.appendLevelDrop('quota', this.quota, now)
    this.appendLevelDrop('write-failed', this.writeFailed, now)
    if (this.retention) {
      const { segments, bytes, from, to } = this.retention
      this.push(serializeRecord(now, 'warn', DROP_MSG, { reason: 'retention', segments, bytes, from, to }), 'warn', now)
    }
    this.overload = this.quota = this.writeFailed = undefined
    this.retention = undefined

    const lineCount = this.lines.length
    const batch: Batch = {
      id: this.nextId++,
      text: this.lines.join('\n') + '\n',
      lines: lineCount,
      seq0: this.nextSeq,
      minTs: this.minTs,
      maxTs: this.maxTs,
    }
    this.nextSeq += lineCount
    this.inFlight.set(batch.id, { chars: this.chars, counts: this.counts, minTs: this.minTs, maxTs: this.maxTs })
    this.inFlightChars += this.chars

    this.lines = []
    this.chars = 0
    this.counts = zeroCounts()
    this.minTs = Infinity
    this.maxTs = -Infinity
    return batch
  }

  /**
   * Handles the worker's ack for a batch (#018).
   * A failed write counts the batch's lines as dropped (#064).
   */
  ack(id: number, ok: boolean, reason: WriteFailReason = 'write-failed'): void {
    const f = this.inFlight.get(id)
    if (!f) return
    this.inFlight.delete(id)
    this.inFlightChars -= f.chars
    if (ok) return
    let drops = reason === 'quota' ? this.quota : this.writeFailed
    for (const lv of LEVELS) {
      const n = f.counts[lv]
      if (n > 0) drops = addDrop(drops, lv, n, f.minTs, f.maxTs)
    }
    if (reason === 'quota') this.quota = drops
    else this.writeFailed = drops
  }

  private appendLevelDrop(reason: string, d: LevelDrops | undefined, now: number): void {
    if (!d) return
    const dropped: Partial<LevelCounts> = {}
    for (const lv of LEVELS) if (d.counts[lv] > 0) dropped[lv] = d.counts[lv]
    this.push(serializeRecord(now, 'warn', DROP_MSG, { reason, dropped, from: d.from, to: d.to }), 'warn', now)
  }
}

const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error']

function zeroCounts(): LevelCounts {
  return { debug: 0, info: 0, warn: 0, error: 0 }
}

function addDrop(d: LevelDrops | undefined, lv: Level, n: number, from: number, to: number): LevelDrops {
  if (!d) {
    const counts = zeroCounts()
    counts[lv] = n
    return { counts, from, to }
  }
  d.counts[lv] += n
  if (from < d.from) d.from = from
  if (to > d.to) d.to = to
  return d
}
