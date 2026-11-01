// Pages that use the built library (dist/index.js). run.mjs reads window.__result.
//   ?mode=log       log continuously (5,000 records/s); the count logged so far is kept in localStorage
//   ?mode=count     count records on disk, compare with the logged count, clean up
//   ?mode=memory    worker memory, Chromium with cross-origin isolation

import { flush, init, logger } from '/dist/index.js'

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
const NS = params.get('ns') ?? 'check'

function logContinuously() {
  init({ namespace: NS })
  let n = 0
  localStorage.setItem(`logged-${NS}`, '0')
  setInterval(() => {
    for (let i = 0; i < 50; i++) logger.info(`r${n++}`, { pad: 'x'.repeat(100) })
    localStorage.setItem(`logged-${NS}`, String(n))
  }, 10)
  return Promise.resolve({ started: true })
}

async function count() {
  const logged = Number(localStorage.getItem(`logged-${NS}`))
  const opfs = await navigator.storage.getDirectory()
  const ns = await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(NS)
  let onDisk = 0
  for (const state of ['active', 'pending', 'done']) {
    const dir = await ns.getDirectoryHandle(state)
    for await (const [, handle] of dir.entries()) {
      const text = await (await handle.getFile()).text()
      for (const line of text.split('\n')) if (line.startsWith('{"ts":')) onDisk++
    }
  }
  // A closed tab's worker can still hold its file for a moment (seen in WebKit).
  await (await opfs.getDirectoryHandle('opfslogd')).removeEntry(NS, { recursive: true }).catch(() => {})
  return { logged, onDisk, lost: logged - onDisk }
}

async function memory() {
  if (!crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return { error: 'not available' }
  const workerBytes = async () => {
    const m = await performance.measureUserAgentSpecificMemory()
    let bytes = 0
    for (const b of m.breakdown) if (b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')) bytes += b.bytes
    return { total: m.bytes, worker: bytes }
  }
  const before = await workerBytes()
  init({ namespace: NS })
  logger.info('start')
  await flush()
  const idle = await workerBytes()
  for (let i = 0; i < 100_000; i++) logger.info('checkout button clicked', { userId: `u_${i}`, total: 129.99, path: '/checkout/payment' })
  await flush(30_000)
  const afterBurst = await workerBytes()
  const opfs = await navigator.storage.getDirectory()
  await (await opfs.getDirectoryHandle('opfslogd')).removeEntry(NS, { recursive: true }).catch(() => {})
  return { before, idle, afterBurst }
}

window.__result = ({ log: logContinuously, count, memory }[mode] ?? (() => Promise.resolve({ error: 'mode?' })))().catch((e) => ({
  error: `${e.name}: ${e.message}`,
}))
