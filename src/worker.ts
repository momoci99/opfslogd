// Worker entry, built as dist/worker.js (#009, #059). One worker per tab (#006).

import { lockNames } from './names'
import { openDirs, type Dirs } from './opfs'
import type { FromWorker, ToWorker } from './protocol'
import { runRetention } from './retention'
import { listPending, markDone, prepare } from './upload-worker'
import { SegmentWriter } from './writer'

type InitMsg = Extract<ToWorker, { type: 'init' }>

let writer: SegmentWriter | undefined
let releaseLock: (() => void) | undefined
let setup: { dirs: Dirs; init: InitMsg } | undefined
let maintaining = false

// Messages are handled one at a time, in arrival order. Opening a file is async,
// and a write must not start before the previous one finished.
let chain: Promise<void> = Promise.resolve()

function schedule(task: () => Promise<void>): void {
  chain = chain.then(task).catch(() => {})
}

function post(msg: FromWorker): void {
  self.postMessage(msg)
}

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const msg = event.data
  schedule(() => handle(msg))
}

async function handle(msg: ToWorker): Promise<void> {
  switch (msg.type) {
    case 'init':
      return start(msg)
    case 'write': {
      const result = writer
        ? await writer.write(new Uint8Array(msg.buf, 0, msg.length), msg.lines, msg.minTs, msg.maxTs)
        : 'write-failed'
      post(result === true ? { type: 'ack', id: msg.id, ok: true } : { type: 'ack', id: msg.id, ok: false, reason: result })
      return
    }
    case 'context':
      await writer?.setContext(msg.context)
      return
    case 'maintain':
      // Not awaited: the run lists, reads, and moves other files while writes go on.
      // It never touches this tab's active file, whose tab lock is held.
      void maintain()
      return
    case 'call':
      // Upload steps read and move pending/ files only; like retention, they run beside writes.
      void answer(msg.id, msg.call)
      return
    case 'close':
      await writer?.close()
      writer = undefined
      setup = undefined
      releaseLock?.()
      releaseLock = undefined
      post({ type: 'closed' })
      return
  }
}

/** One retention run, in at most one tab at a time (#022, #050, #053). */
async function maintain(): Promise<void> {
  if (!setup || maintaining) return post({ type: 'maintained', ran: false })
  maintaining = true
  const { dirs, init } = setup
  const locks = lockNames(init.namespace)
  try {
    await navigator.locks.request(locks.retention, { ifAvailable: true }, async (lock) => {
      if (!lock) return post({ type: 'maintained', ran: false })
      const result = await runRetention(dirs, {
        tabLock: locks.tab,
        maxBytes: init.retentionMaxBytes,
        maxAgeMs: init.retentionMaxAgeMs,
        upload: init.upload,
        now: Date.now(),
      })
      post(result.dropped ? { type: 'maintained', ran: true, dropped: result.dropped } : { type: 'maintained', ran: true })
    })
  } catch {
    post({ type: 'maintained', ran: false })
  } finally {
    maintaining = false
  }
}

async function answer(id: number, call: Extract<ToWorker, { type: 'call' }>['call']): Promise<void> {
  let value: unknown
  try {
    if (!setup) throw new Error('not started')
    const { dirs } = setup
    value =
      call.op === 'list-pending' ? await listPending(dirs) : call.op === 'prepare' ? await prepare(dirs, call.name) : await markDone(dirs, call.name)
  } catch {
    value = call.op === 'list-pending' ? [] : call.op === 'prepare' ? { kind: 'skip' } : false
  }
  post({ type: 'reply', id, value })
}

async function start(msg: InitMsg): Promise<void> {
  try {
    if (!('createSyncAccessHandle' in FileSystemFileHandle.prototype) || !navigator.locks) {
      throw new DOMException('createSyncAccessHandle or Web Locks is missing', 'NotSupportedError')
    }
    const dirs = await openDirs(msg.root, msg.namespace)
    // Hold the tab lock before any file exists in active/. Otherwise another tab could
    // see the new file without a lock and recover it as an orphan (#012).
    await holdLock(lockNames(msg.namespace).tab(msg.tabId))
    setup = { dirs, init: msg }
    writer = new SegmentWriter(dirs, {
      tabId: msg.tabId,
      context: msg.context,
      rotateMaxAgeMs: msg.rotateMaxAgeMs,
      rotateMaxBytes: msg.rotateMaxBytes,
      upload: msg.upload,
      schedule,
    })
    post({ type: 'ready' })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    post({ type: 'fatal', code: 'opfs-unavailable', name: err.name, message: err.message })
  }
}

/** Resolves once the lock is granted; the lock stays held until `releaseLock()` or the worker ends. */
function holdLock(name: string): Promise<void> {
  return new Promise((granted, failed) => {
    navigator.locks
      .request(name, () => {
        granted()
        return new Promise<void>((release) => {
          releaseLock = release
        })
      })
      .catch(failed)
  })
}
