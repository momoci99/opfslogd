// Worker-side segment writer: open, append, roll back, rotate (#012, #016, #021, #064, #066, #067, #068).

import { activeName } from './names'
import { freeName, type Dirs, type SyncAccessHandle, type WorkerFileHandle } from './opfs'
import type { WriteFailReason } from './queue'
import { headerLine } from './segment'

export interface WriterOptions {
  tabId: string
  context: string
  rotateMaxAgeMs: number
  rotateMaxBytes: number
  upload: boolean
  /** Runs a task in the worker's message order; used by the age timer. */
  schedule: (task: () => Promise<void>) => void
}

interface ActiveSegment {
  file: WorkerFileHandle
  handle: SyncAccessHandle
  name: string
  /** Bytes in the file; the next write goes here. */
  size: number
  /** Record lines written; 0 means header only. */
  records: number
  minTs: number
  maxTs: number
  ageTimer: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()

export class SegmentWriter {
  private readonly dirs: Dirs
  private readonly opts: WriterOptions
  private context: string
  private seg: ActiveSegment | undefined
  /** Lines received from the main thread, written or not; sets the next seq0 (#064). */
  private received = 0

  constructor(dirs: Dirs, opts: WriterOptions) {
    this.dirs = dirs
    this.opts = opts
    this.context = opts.context
  }

  /**
   * Appends one batch. Opens a segment first if none is active (#064).
   * On failure, the file is cut back to where it was and the segment is rotated.
   */
  async write(bytes: Uint8Array, lines: number, minTs: number, maxTs: number): Promise<true | WriteFailReason> {
    const seq0 = this.received
    this.received += lines

    if (!this.seg) {
      try {
        this.seg = await this.open(minTs, seq0)
      } catch (e) {
        return failReason(e)
      }
    }
    const seg = this.seg
    const at = seg.size
    try {
      const n = seg.handle.write(bytes, { at })
      if (n !== bytes.length) throw shortWrite(n, bytes.length)
    } catch (e) {
      try {
        seg.handle.truncate(at)
      } catch {
        // crash recovery cuts a partial line later (#016)
      }
      await this.rotate()
      return failReason(e)
    }
    seg.size = at + bytes.length
    seg.records += lines
    if (minTs < seg.minTs) seg.minTs = minTs
    if (maxTs > seg.maxTs) seg.maxTs = maxTs
    if (seg.size >= this.opts.rotateMaxBytes) await this.rotate()
    return true
  }

  /** The next segment gets the new context; the current one is closed (#031). */
  async setContext(context: string): Promise<void> {
    this.context = context
    await this.rotate()
  }

  /** Moves the active segment out of `active/` (#030). */
  async close(): Promise<void> {
    await this.rotate()
  }

  private async open(startTs: number, seq0: number): Promise<ActiveSegment> {
    const name = activeName(startTs, this.opts.tabId)
    const file = (await this.dirs.active.getFileHandle(name, { create: true })) as WorkerFileHandle
    const handle = await file.createSyncAccessHandle()
    const header = encoder.encode(headerLine(this.opts.tabId, seq0, this.context) + '\n')
    try {
      handle.truncate(0)
      const n = handle.write(header, { at: 0 })
      if (n !== header.length) throw shortWrite(n, header.length)
    } catch (e) {
      handle.close()
      await this.dirs.active.removeEntry(name).catch(() => {})
      throw e
    }
    const ageTimer = setTimeout(() => {
      this.opts.schedule(async () => {
        if (this.seg?.name === name) await this.rotate()
      })
    }, this.opts.rotateMaxAgeMs)
    return { file, handle, name, size: header.length, records: 0, minTs: Infinity, maxTs: -Infinity, ageTimer }
  }

  /**
   * Closes the active segment and moves it to `pending/` or `done/` (#068) under its
   * closed name (#067). A segment with no records is deleted. The next write opens a new one.
   */
  private async rotate(): Promise<void> {
    const seg = this.seg
    if (!seg) return
    this.seg = undefined
    clearTimeout(seg.ageTimer)
    try {
      seg.handle.flush()
    } catch {
      // the move below still keeps what reached the file
    }
    seg.handle.close()
    if (seg.records === 0) {
      await this.dirs.active.removeEntry(seg.name).catch(() => {})
      return
    }
    const dest = this.opts.upload ? this.dirs.pending : this.dirs.done
    try {
      await seg.file.move(dest, await freeName(dest, seg.minTs, seg.maxTs, this.opts.tabId))
    } catch {
      // Left in active/: orphan recovery moves it once this tab's lock is gone (#012).
    }
  }
}

/**
 * Browsers do not throw QuotaExceededError from a sync handle write when storage is full.
 * Measured (docs/design/benchmark.html): Chromium writes part of the data and returns a bogus
 * count; Firefox writes nothing and returns 0. A short write is therefore treated as quota.
 */
function shortWrite(written: number, expected: number): DOMException {
  return new DOMException(`short write: ${written} of ${expected} bytes`, 'QuotaExceededError')
}

function failReason(e: unknown): WriteFailReason {
  return e instanceof DOMException && e.name === 'QuotaExceededError' ? 'quota' : 'write-failed'
}
