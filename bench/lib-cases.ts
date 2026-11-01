// Measurements that use the library code (step 8). docs/design/benchmark.html#impl

import type { Result } from './harness'
import { measureSync, sink } from './harness'
import { newTabId } from '../src/names'
import type { FromWorker, ToWorker } from '../src/protocol'
import { RecordQueue } from '../src/queue'
import { serializeRecord } from '../src/record'

export interface LibRow extends Result {
  group: string
  note?: string
}

const BASE_TS = 1_730_000_000_000

// Same medium record as cases.ts, passed the way an app calls log(msg, ctx).
function mediumCtx(i: number): Record<string, unknown> {
  return { userId: `u_${48213 + (i % 100)}`, cartItems: 3, total: 129.99, path: '/checkout/payment', experiments: ['new-cta', 'fast-pay'] }
}

const POOL = 1024
const ctxPool = Array.from({ length: POOL }, (_, i) => mediumCtx(i))
const errPool = Array.from({ length: POOL }, (_, i) => {
  const inner = Object.assign(new TypeError('Failed to fetch'), { status: 503 })
  return { err: new Error(`upload ${i} failed`, { cause: inner }), fileId: `f${i}` }
})

/** Batch of medium records just over the 256K-character size trigger (#017). */
const FLUSH_CHARS = 256 * 1024

export async function runLib(log: (row: LibRow) => void): Promise<LibRow[]> {
  const rows: LibRow[] = []
  const add = (group: string, r: Result, note?: string): void => {
    const row = { group, ...r, note }
    rows.push(row)
    log(row)
  }
  const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  // 5. One log() call on the main thread: admit + serializeRecord + push (#014, #019).
  {
    let q = new RecordQueue()
    let i = 0
    const logOnce = (ctx: unknown): void => {
      const ts = BASE_TS + i++
      if (q.admit('info', ts)) q.push(serializeRecord(ts, 'info', 'checkout button clicked', ctx), 'info', ts)
      // keep the queue small so the cap never rejects
      if (q.queuedChars > FLUSH_CHARS) {
        q = new RecordQueue()
      }
    }
    add('5. log()', measureSync('medium record', () => logOnce(ctxPool[i & (POOL - 1)])))
    add('5. log()', measureSync('error with cause and props', () => logOnce(errPool[i & (POOL - 1)])))
    const full = new RecordQueue(1000)
    full.push('"' + 'x'.repeat(998) + '"', 'info', 0)
    add('5. log()', measureSync('rejected (over 80%)', () => full.admit('info', BASE_TS)), 'no stringify')
    await yieldToPage()
  }

  // 6. One flush on the main thread: take() + encodeInto (#015, #017).
  const encoder = new TextEncoder()
  const fillQueue = (): RecordQueue => {
    const q = new RecordQueue()
    let i = 0
    while (q.queuedChars < FLUSH_CHARS) {
      const ts = BASE_TS + i
      q.push(serializeRecord(ts, 'info', 'checkout button clicked', ctxPool[i++ & (POOL - 1)]), 'info', ts)
    }
    return q
  }
  const sample = fillQueue().take(BASE_TS)
  const lines = sample?.lines ?? 0
  const bytesPerBatch = encoder.encode(sample?.text ?? '').length
  {
    // Fill queues outside the timed part, then time take() + encodeInto on 16 of them.
    const perFlushUs: number[] = []
    for (let round = 0; round < 15; round++) {
      const queues = Array.from({ length: 16 }, fillQueue)
      const t0 = performance.now()
      for (const q of queues) {
        const text = q.take(BASE_TS)?.text ?? ''
        const buf = new Uint8Array(text.length * 3)
        sink.value = encoder.encodeInto(text, buf).written
      }
      perFlushUs.push(((performance.now() - t0) / queues.length) * 1000)
      await yieldToPage()
    }
    const sorted = [...perFlushUs].sort((a, b) => a - b)
    add(
      '6. flush',
      { name: 'take() + encodeInto', medianUs: sorted[7] ?? NaN, minUs: sorted[0] ?? NaN, calls: 16 },
      `${lines} lines, ${(bytesPerBatch / 1024).toFixed(0)} KB`,
    )
  }

  // 7. Worker write round trip: transfer, handle.write(), ack (#018, #074).
  const payload = encoder.encode(sample?.text ?? '')
  for (const url of [new URL('../src/worker.ts', import.meta.url), new URL('./flush.worker.ts', import.meta.url)]) {
    const r = await roundTrips(url, payload, lines)
    add('7. worker write', r, `${(bytesPerBatch / 1024).toFixed(0)} KB per batch; median of 3 runs of 40, incl. a copy of the batch`)
    await yieldToPage()
  }
  return rows
}

async function roundTrips(url: URL, payload: Uint8Array, lines: number): Promise<Result> {
  const root = `opfslogd-bench-${Date.now()}`
  const worker = new Worker(url, { type: 'module' })
  const waiters: ((m: FromWorker) => void)[] = []
  worker.onmessage = (e: MessageEvent<FromWorker>): void => waiters.shift()?.(e.data)
  worker.onerror = (e): void => console.log(`worker error: ${e.message}`)
  // A worker that never answers would hang the whole run; fail after 30s instead.
  const next = (): Promise<FromWorker> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer from ${url.pathname} in 30s`)), 30_000)
      waiters.push((m) => {
        clearTimeout(timer)
        resolve(m)
      })
    })
  const send = (m: ToWorker, t: Transferable[] = []): void => worker.postMessage(m, t)

  send({
    type: 'init',
    namespace: 'bench',
    tabId: newTabId(),
    context: '{}',
    rotateMaxAgeMs: 300_000,
    rotateMaxBytes: 2_000_000,
    upload: false,
    root,
  })
  const ready = await next()
  if (ready.type !== 'ready') throw new Error(`worker did not start: ${JSON.stringify(ready)}`)
  // performance.now() can be as coarse as 1ms, so time 40 batches together.
  const run40 = async (firstId: number): Promise<number> => {
    const t0 = performance.now()
    for (let id = firstId; id < firstId + 40; id++) {
      const copy = payload.slice() // transfer detaches it
      send({ type: 'write', id, buf: copy.buffer, length: copy.length, lines, minTs: BASE_TS, maxTs: BASE_TS }, [copy.buffer])
      await next()
    }
    return ((performance.now() - t0) / 40) * 1000
  }
  await run40(1) // warm-up
  const times = [await run40(41), await run40(81), await run40(121)]
  send({ type: 'close' })
  await next()
  worker.terminate()
  await (await navigator.storage.getDirectory()).removeEntry(root, { recursive: true }).catch(() => {})
  const sorted = [...times].sort((a, b) => a - b)
  return { name: `round trip, ${url.pathname.endsWith('flush.worker.ts') ? 'flush() every write' : 'no flush()'}`, medianUs: sorted[Math.floor(sorted.length / 2)] ?? NaN, minUs: sorted[0] ?? NaN, calls: 40 }
}
