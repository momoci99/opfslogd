// Worker-side retention run: orphan recovery, age limit, size limit (#012, #016, #050-#053, #067, #068, #075).

import { parseSegmentName, type SegmentName } from './names'
import { freeName, type Dirs, type WorkerFileHandle } from './opfs'
import { scanSegment } from './segment'

export interface RetentionOptions {
  /** Lock name of a tab, to tell live tabs from crashed or closed ones (#012). */
  tabLock: (tabId: string) => string
  maxBytes: number
  maxAgeMs: number
  /** Recovered orphans go to `pending/` when true, `done/` when false (#068). */
  upload: boolean
  now: number
}

/** Pending segments deleted by the run, for the drop line (#061, #070). */
export interface RetentionDrops {
  segments: number
  bytes: number
  from: number
  to: number
}

export interface RetentionResult {
  recovered: number
  deleted: number
  dropped: RetentionDrops | undefined
}

interface Entry {
  dir: FileSystemDirectoryHandle
  state: 'active' | 'pending' | 'done'
  name: string
  parsed: SegmentName
  size: number
}

/**
 * One retention run. The caller holds the retention lock (#022).
 * Never touches an active file whose tab lock is held, so live tabs keep writing.
 */
export async function runRetention(dirs: Dirs, opts: RetentionOptions): Promise<RetentionResult> {
  const recovered = await recoverOrphans(dirs, opts)

  const entries = [...(await list(dirs.active, 'active')), ...(await list(dirs.pending, 'pending')), ...(await list(dirs.done, 'done'))]
  let total = entries.reduce((n, e) => n + e.size, 0)
  let deleted = 0
  let dropped: RetentionDrops | undefined

  const remove = async (e: Entry): Promise<void> => {
    try {
      await e.dir.removeEntry(e.name)
    } catch {
      return // gone already, or in use; try again next run
    }
    deleted++
    total -= e.size
    if (e.state === 'pending') {
      const from = e.parsed.startTs
      const to = e.parsed.endTs ?? e.parsed.startTs
      dropped = dropped
        ? { segments: dropped.segments + 1, bytes: dropped.bytes + e.size, from: Math.min(dropped.from, from), to: Math.max(dropped.to, to) }
        : { segments: 1, bytes: e.size, from, to }
    }
  }

  // 1. Age: closed segments whose last record is older than maxAgeMs (#050).
  const closed = entries.filter((e) => e.state !== 'active')
  const cutoff = opts.now - opts.maxAgeMs
  const kept: Entry[] = []
  for (const e of closed) {
    if ((e.parsed.endTs ?? e.parsed.startTs) < cutoff) await remove(e)
    else kept.push(e)
  }

  // 2. Size: done first, then pending, oldest first; active files count but stay (#050, #052).
  if (total > opts.maxBytes) {
    const byAge = (a: Entry, b: Entry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const order = [...kept.filter((e) => e.state === 'done').sort(byAge), ...kept.filter((e) => e.state === 'pending').sort(byAge)]
    for (const e of order) {
      if (total <= opts.maxBytes) break
      await remove(e)
    }
  }
  return { recovered, deleted, dropped }
}

/**
 * Moves `active/` files whose tab lock is gone out of `active/` (#012, #020): cut at the
 * first bad line (#016), name by the record ts range (#067). A file without records is
 * deleted (#075); a file in a newer format is left alone (#013).
 */
async function recoverOrphans(dirs: Dirs, opts: RetentionOptions): Promise<number> {
  const { held = [] } = await navigator.locks.query()
  const live = new Set(held.map((l) => l.name))
  let recovered = 0
  for await (const [name, handle] of dirs.active.entries()) {
    const parsed = parseSegmentName(name)
    if (!parsed || parsed.endTs !== undefined || handle.kind !== 'file') continue
    if (live.has(opts.tabLock(parsed.tabId))) continue
    if (await recoverOne(dirs, opts, name, parsed.tabId, handle as WorkerFileHandle)) recovered++
  }
  return recovered
}

async function recoverOne(dirs: Dirs, opts: RetentionOptions, name: string, tabId: string, file: WorkerFileHandle): Promise<boolean> {
  let handle
  try {
    handle = await file.createSyncAccessHandle()
  } catch {
    return false // the old worker may still be shutting down; next run
  }
  let target: { minTs: number; maxTs: number } | undefined
  let remove = false
  try {
    const size = handle.getSize()
    const bytes = new Uint8Array(size)
    handle.read(bytes, { at: 0 })
    const scan = scanSegment(bytes)
    if (scan.kind === 'unreadable') return false
    if (scan.kind === 'broken' || scan.lines === 0 || scan.minTs === undefined || scan.maxTs === undefined) {
      remove = true
    } else {
      if (scan.validEnd < size) handle.truncate(scan.validEnd)
      handle.flush()
      target = { minTs: scan.minTs, maxTs: scan.maxTs }
    }
  } finally {
    handle.close()
  }
  if (remove) {
    await dirs.active.removeEntry(name).catch(() => {})
    return false
  }
  if (!target) return false
  const dest = opts.upload ? dirs.pending : dirs.done
  try {
    await file.move(dest, await freeName(dest, target.minTs, target.maxTs, tabId))
    return true
  } catch {
    return false
  }
}

async function list(dir: FileSystemDirectoryHandle, state: Entry['state']): Promise<Entry[]> {
  const out: Entry[] = []
  for await (const [name, handle] of dir.entries()) {
    const parsed = parseSegmentName(name)
    if (!parsed || handle.kind !== 'file') continue
    try {
      // getFile() works on files another worker has open (docs/design/benchmark.html)
      const size = (await (handle as FileSystemFileHandle).getFile()).size
      out.push({ dir, state, name, parsed, size })
    } catch {
      // removed meanwhile
    }
  }
  return out
}
