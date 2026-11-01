// Tab IDs, namespaces, segment file names, and lock names (#012, #034, #067, #072, #073).

const TAB_ID_LENGTH = 8
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

const NAMESPACE_RE = /^[a-z0-9_-]{1,64}$/

/** 8 random characters from [0-9a-z] (#072). */
export function newTabId(): string {
  let id = ''
  const bytes = new Uint8Array(16)
  while (id.length < TAB_ID_LENGTH) {
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      // 252 = 36 * 7: skip the top values so every character is equally likely
      if (b < 252 && id.length < TAB_ID_LENGTH) id += BASE36[b % 36]
    }
  }
  return id
}

export function isValidNamespace(ns: unknown): ns is string {
  return typeof ns === 'string' && NAMESPACE_RE.test(ns)
}

export interface LockNames {
  upload: string
  retention: string
  tab: (tabId: string) => string
}

export function lockNames(ns: string): LockNames {
  const prefix = `opfslogd:${ns}:`
  return {
    upload: `${prefix}upload`,
    retention: `${prefix}retention`,
    tab: (tabId) => `${prefix}tab:${tabId}`,
  }
}

/** Zero-padded to 13 digits so lexical order is time order (#012). */
function pad13(ts: number): string {
  return String(Math.max(0, Math.trunc(ts))).padStart(13, '0')
}

/** `{startTs}_{tabId}.seg` for a segment in `active/`. */
export function activeName(startTs: number, tabId: string): string {
  return `${pad13(startTs)}_${tabId}.seg`
}

/** `{minTs}_{maxTs}_{tabId}.seg` for a segment in `pending/` or `done/` (#067). */
export function closedName(minTs: number, maxTs: number, tabId: string): string {
  return `${pad13(minTs)}_${pad13(maxTs)}_${tabId}.seg`
}

export interface SegmentName {
  startTs: number
  /** Present only for closed segments. */
  endTs?: number
  tabId: string
}

const ACTIVE_RE = /^(\d{13})_([0-9a-z]+)\.seg$/
const CLOSED_RE = /^(\d{13})_(\d{13})_([0-9a-z]+)\.seg$/

/** Parses a segment file name; returns undefined for any other file. */
export function parseSegmentName(name: string): SegmentName | undefined {
  const c = CLOSED_RE.exec(name)
  if (c) return { startTs: Number(c[1]), endTs: Number(c[2]), tabId: c[3] ?? '' }
  const a = ACTIVE_RE.exec(name)
  if (a) return { startTs: Number(a[1]), tabId: a[2] ?? '' }
  return undefined
}
