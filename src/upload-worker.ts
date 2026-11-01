// Worker side of upload: list pending segments, convert one to exported JSONL, mark it done
// (#007, #016, #033, #048, #067).

import { parseSegmentName } from './names'
import type { Dirs } from './opfs'
import { exportLineMaker, scanSegment } from './segment'

/** `meta` of send(), without the signal the main thread adds (#048). */
export interface UploadMeta {
  segmentId: string
  sha256: string
  size: number
  from: number
  to: number
}

export type Prepared =
  | { kind: 'file'; file: Blob; meta: UploadMeta }
  /** Written by a newer format; left in pending/ for a newer tab (#013). */
  | { kind: 'unreadable' }
  /** Gone, or holds no usable records. */
  | { kind: 'skip' }

/** Closed segments in pending/, oldest first (#047). */
export async function listPending(dirs: Dirs): Promise<string[]> {
  const names: string[] = []
  for await (const [name, handle] of dirs.pending.entries()) {
    if (handle.kind === 'file' && parseSegmentName(name)?.endTs !== undefined) names.push(name)
  }
  return names.sort()
}

/** The segment as the backend receives it: header line dropped, tab, seq, context added (#033). */
export async function prepare(dirs: Dirs, name: string): Promise<Prepared> {
  let bytes: Uint8Array
  try {
    const file = await (await dirs.pending.getFileHandle(name)).getFile()
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { kind: 'skip' }
  }
  const scan = scanSegment(bytes)
  if (scan.kind === 'unreadable') return { kind: 'unreadable' }
  if (scan.kind === 'broken' || scan.lines === 0) return { kind: 'skip' }

  const headerEnd = bytes.indexOf(0x0a) + 1
  const lines = new TextDecoder().decode(bytes.subarray(headerEnd, scan.validEnd)).split('\n')
  lines.pop() // text ends with a newline
  const make = exportLineMaker(scan.header)
  const text = lines.map((line, i) => make(line, i)).join('\n') + '\n'
  const encoded = new TextEncoder().encode(text)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))
  const parsed = parseSegmentName(name)
  return {
    kind: 'file',
    file: new Blob([encoded], { type: 'application/x-ndjson' }),
    meta: {
      segmentId: name.replace(/\.seg$/, ''),
      sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''),
      size: encoded.length,
      from: scan.minTs ?? parsed?.startTs ?? 0,
      to: scan.maxTs ?? parsed?.endTs ?? 0,
    },
  }
}

/** Moves an uploaded segment from pending/ to done/, keeping its name (#007). */
export async function markDone(dirs: Dirs, name: string): Promise<boolean> {
  try {
    const file = (await dirs.pending.getFileHandle(name)) as FileSystemFileHandle & {
      move(dest: FileSystemDirectoryHandle, name: string): Promise<void>
    }
    await file.move(dirs.done, name)
    return true
  } catch {
    return false // deleted by retention meanwhile; nothing to do
  }
}
