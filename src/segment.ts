// Segment file contents: header line, crash-recovery scan, exported lines (#013, #016, #033, #067, #071).

/** Format this library writes (#013). */
export const FORMAT_VERSION = 1
/** Oldest reader that can read what this library writes (#013). */
export const MIN_READER = 1

export interface SegmentHeader {
  format: number
  minReader: number
  tab: string
  seq0: number
  context: Record<string, unknown>
}

/**
 * The first line of a segment, without the trailing newline (#071).
 * `contextJson` is the global context, already serialized (#031).
 */
export function headerLine(tab: string, seq0: number, contextJson: string): string {
  return `{"format":${FORMAT_VERSION},"minReader":${MIN_READER},"tab":${JSON.stringify(tab)},"seq0":${seq0},"context":${contextJson}}`
}

/** Parses a header line; returns undefined if it is not a valid header. */
export function parseHeader(line: string): SegmentHeader | undefined {
  let h: unknown
  try {
    h = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(h)) return undefined
  const { format, minReader, tab, seq0, context } = h
  if (
    typeof format !== 'number' ||
    typeof minReader !== 'number' ||
    typeof tab !== 'string' ||
    typeof seq0 !== 'number' ||
    !Number.isSafeInteger(seq0) ||
    seq0 < 0 ||
    !isObject(context)
  ) {
    return undefined
  }
  return { format, minReader, tab, seq0, context }
}

/** True when this library can read a file with this header (#013). */
export function canRead(header: SegmentHeader): boolean {
  return header.minReader <= FORMAT_VERSION
}

export type ScanResult =
  /** Header line missing or broken: no usable records, delete the file (#016). */
  | { kind: 'broken' }
  /** Written by a newer format; crash recovery leaves it alone (#013). */
  | { kind: 'unreadable'; header: SegmentHeader }
  | {
      kind: 'ok'
      header: SegmentHeader
      /** Byte offset after the last good line; truncate the file here. */
      validEnd: number
      /** Number of good record lines. */
      lines: number
      /** Smallest and largest record ts; absent when there are no records (#067). */
      minTs?: number
      maxTs?: number
    }

const NL = 0x0a

/**
 * Finds the first record line that is incomplete, holds a NUL byte, is not valid
 * UTF-8, or does not parse as a record. Everything from there on is cut (#016).
 */
export function scanSegment(bytes: Uint8Array): ScanResult {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const headerEnd = bytes.indexOf(NL)
  if (headerEnd < 0) return { kind: 'broken' }
  const header = decodeLine(decoder, bytes.subarray(0, headerEnd), parseHeader)
  if (!header) return { kind: 'broken' }
  if (!canRead(header)) return { kind: 'unreadable', header }

  let start = headerEnd + 1
  let lines = 0
  let minTs = Infinity
  let maxTs = -Infinity
  while (start < bytes.length) {
    const end = bytes.indexOf(NL, start)
    if (end < 0) break
    const ts = decodeLine(decoder, bytes.subarray(start, end), recordTs)
    if (ts === undefined) break
    if (ts < minTs) minTs = ts
    if (ts > maxTs) maxTs = ts
    lines++
    start = end + 1
  }
  return lines > 0
    ? { kind: 'ok', header, validEnd: start, lines, minTs, maxTs }
    : { kind: 'ok', header, validEnd: start, lines }
}

function decodeLine<T>(decoder: TextDecoder, line: Uint8Array, parse: (s: string) => T | undefined): T | undefined {
  if (line.includes(0)) return undefined
  let text: string
  try {
    text = decoder.decode(line)
  } catch {
    return undefined
  }
  return parse(text)
}

function recordTs(line: string): number | undefined {
  let r: unknown
  try {
    r = JSON.parse(line)
  } catch {
    return undefined
  }
  return isObject(r) && typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : undefined
}

/**
 * Returns a function that turns a stored record line into an exported line by
 * adding `tab`, `seq`, and `context` (#033). No parsing: the line is cut at its
 * closing brace. An empty context is left out (#071).
 */
export function exportLineMaker(header: SegmentHeader): (line: string, index: number) => string {
  const contextJson = JSON.stringify(header.context)
  const tail = contextJson === '{}' ? '}' : `,"context":${contextJson}}`
  const tabPart = `,"tab":${JSON.stringify(header.tab)},"seq":`
  const seq0 = header.seq0
  return (line, index) => {
    const close = line.lastIndexOf('}')
    return line.slice(0, close) + tabPart + (seq0 + index) + tail
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
