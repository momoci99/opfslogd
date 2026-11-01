// Worker entry, built as dist/worker.js (#009, #059). One worker per tab (#006).

import { lockNames } from './names'
import { openDirs } from './opfs'
import type { FromWorker, ToWorker } from './protocol'
import { SegmentWriter } from './writer'

let writer: SegmentWriter | undefined
let releaseLock: (() => void) | undefined

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
    case 'close':
      await writer?.close()
      writer = undefined
      releaseLock?.()
      releaseLock = undefined
      post({ type: 'closed' })
      return
  }
}

async function start(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  try {
    if (!('createSyncAccessHandle' in FileSystemFileHandle.prototype) || !navigator.locks) {
      throw new DOMException('createSyncAccessHandle or Web Locks is missing', 'NotSupportedError')
    }
    const dirs = await openDirs(msg.root, msg.namespace)
    // Hold the tab lock before any file exists in active/. Otherwise another tab could
    // see the new file without a lock and recover it as an orphan (#012).
    await holdLock(lockNames(msg.namespace).tab(msg.tabId))
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
