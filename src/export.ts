// Worker side of exportLogs(): time-ordered merge of segments into one JSONL Blob (#054 - #056).

import { parseSegmentName } from './names'
import type { Dirs } from './opfs'
import { exportLineMaker, scanSegment } from './segment'

export interface ExportResult {
  file: Blob
  skipped: { activeOtherTabs: number; unreadable: number }
}

/** This tab's active segment, read through its own handle (#054). */
export interface ActiveSnapshot {
  name: string
  bytes: Uint8Array
}

interface Source {
  startTs: number
  endTs: number
  read: () => Promise<Uint8Array | undefined>
}

interface Cursor {
  lines: string[]
  next: number
  make: (line: string, index: number) => string
}

const MIME = 'application/x-ndjson'
/** Output is folded into the Blob in pieces of about this many characters. */
const CHUNK_CHARS = 1 << 20

export async function exportLogs(
  dirs: Dirs,
  own: ActiveSnapshot | undefined,
  from: number | undefined,
  to: number | undefined,
): Promise<ExportResult> {
  const lo = from ?? -Infinity
  const hi = to ?? Infinity
  const skipped = { activeOtherTabs: 0, unreadable: 0 }
  const sources: Source[] = []

  for (const dir of [dirs.pending, dirs.done]) {
    for await (const [name, handle] of dir.entries()) {
      const parsed = parseSegmentName(name)
      if (!parsed || parsed.endTs === undefined || handle.kind !== 'file') continue
      if (parsed.endTs < lo || parsed.startTs > hi) continue // picked by name (#055)
      sources.push({
        startTs: parsed.startTs,
        endTs: parsed.endTs,
        read: async () => {
          try {
            return new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer())
          } catch {
            return undefined // deleted by retention meanwhile
          }
        },
      })
    }
  }
  for await (const [name, handle] of dirs.active.entries()) {
    if (handle.kind === 'file' && parseSegmentName(name) && name !== own?.name) skipped.activeOtherTabs++
  }
  if (own) {
    const scan = scanSegment(own.bytes)
    if (scan.kind === 'ok' && scan.minTs !== undefined && scan.maxTs !== undefined && scan.maxTs >= lo && scan.minTs <= hi) {
      const bytes = own.bytes
      sources.push({ startTs: scan.minTs, endTs: scan.maxTs, read: () => Promise.resolve(bytes) })
    }
  }
  sources.sort((a, b) => a.startTs - b.startTs)

  // k-way merge (#056): open a file once the output reaches its start time, so only files
  // whose ranges overlap are open together. Each file's lines keep their order (#011).
  const fromKey = Number.isFinite(lo) ? pad13(lo) : undefined
  const toKey = Number.isFinite(hi) ? pad13(hi) : undefined
  const open: Cursor[] = []
  let nextSource = 0
  let blob = new Blob([], { type: MIME })
  let parts: string[] = []
  let partChars = 0

  const openNext = async (): Promise<void> => {
    const src = sources[nextSource++]
    if (!src) return
    const cursor = await load(src, skipped)
    if (cursor) open.push(cursor)
  }

  for (;;) {
    // pick the open cursor whose next line has the smallest ts
    let best: Cursor | undefined
    let bestKey = ''
    for (const c of open) {
      const key = tsKey(c.lines[c.next])
      if (best === undefined || key < bestKey) {
        best = c
        bestKey = key
      }
    }
    const pending = sources[nextSource]
    if (pending && (best === undefined || pad13(pending.startTs) <= bestKey)) {
      await openNext()
      continue
    }
    if (!best) break

    const line = best.lines[best.next] ?? ''
    const index = best.next++
    if (best.next >= best.lines.length) open.splice(open.indexOf(best), 1)
    if ((fromKey && bestKey < fromKey) || (toKey && bestKey > toKey)) continue // by leading ts (#016)
    const out = best.make(line, index)
    parts.push(out, '\n')
    partChars += out.length + 1
    if (partChars >= CHUNK_CHARS) {
      blob = new Blob([blob, ...parts], { type: MIME })
      parts = []
      partChars = 0
    }
  }
  if (parts.length > 0) blob = new Blob([blob, ...parts], { type: MIME })
  return { file: blob, skipped }
}

async function load(src: Source, skipped: ExportResult['skipped']): Promise<Cursor | undefined> {
  const bytes = await src.read()
  if (!bytes) return undefined
  const scan = scanSegment(bytes)
  if (scan.kind === 'unreadable') {
    skipped.unreadable++
    return undefined
  }
  if (scan.kind === 'broken' || scan.lines === 0) return undefined
  const headerEnd = bytes.indexOf(0x0a) + 1
  const lines = new TextDecoder().decode(bytes.subarray(headerEnd, scan.validEnd)).split('\n')
  lines.pop()
  return { lines, next: 0, make: exportLineMaker(scan.header) }
}

/** The 13 ts digits at the start of a record line (#016); compares as a string. */
function tsKey(line: string | undefined): string {
  return line ? line.slice(6, 19) : '9999999999999'
}

function pad13(ts: number): string {
  return String(Math.max(0, Math.trunc(ts))).padStart(13, '0')
}
