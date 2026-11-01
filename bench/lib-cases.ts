// Measurements that use the library code (step 8). docs/design/benchmark.html#impl

import type { Result } from './harness'
import { measureSync, sink } from './harness'
import { Core } from '../src/core'
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
    retentionMaxBytes: 50_000_000,
    retentionMaxAgeMs: 7 * 86_400_000,
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

// ---- 8, 9: need the main-thread logger (unit 5) ----


interface CoreInternals {
  flushNow(): void
  onMessage(msg: FromWorker): void
  queue: RecordQueue
}

const coreWorkerUrl = new URL('../src/worker.ts', import.meta.url)

async function withCore<T>(fn: (core: Core, internals: CoreInternals) => Promise<T>): Promise<T> {
  const ns = `bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const core = new Core()
  core.init({ namespace: ns, workerUrl: coreWorkerUrl })
  try {
    return await fn(core, core as unknown as CoreInternals)
  } finally {
    await core.close()
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd', { create: true })
    await top.removeEntry(ns, { recursive: true }).catch(() => {})
  }
}

/** Drop counts the queue holds for its next drop line. */
function overloadDrops(internals: CoreInternals): number {
  const o = (internals.queue as unknown as { overload?: { counts: Record<string, number> } }).overload
  return o ? Object.values(o.counts).reduce((a, b) => a + b, 0) : 0
}

export async function runLib2(log: (row: LibRow) => void): Promise<LibRow[]> {
  const rows: LibRow[] = []
  const add = (group: string, r: Result, note?: string): void => {
    const row = { group, ...r, note }
    rows.push(row)
    log(row)
  }
  const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const single = (name: string, us: number, note?: string): Result & { note?: string } => ({ name, medianUs: us, minUs: us, calls: 1, note })

  // 8. Fixed cost of one flush on the main thread (#017): flushNow() with one record
  //    (take, encode, postMessage) plus handling its ack. Sets the flush interval:
  //    the interval must be at least 100x this for flush cost <= 1% of main-thread time.
  await withCore(async (core, internals) => {
    await core.flush()
    const orig = internals.onMessage.bind(core)
    let ackUs = 0
    internals.onMessage = (msg: FromWorker): void => {
      const t0 = performance.now()
      orig(msg)
      ackUs += (performance.now() - t0) * 1000
    }
    const N = 400
    let flushUs = 0
    for (let k = 0; k < N; k++) {
      core.log('info', 'page view')
      const t0 = performance.now()
      internals.flushNow()
      flushUs += (performance.now() - t0) * 1000
      await core.flush()
    }
    const perFlush = flushUs / N
    const perAck = ackUs / N
    add('8. flush fixed cost', single('flushNow() with 1 record', perFlush))
    add('8. flush fixed cost', single('ack handling', perAck))
    add(
      '8. flush fixed cost',
      single('total per flush', perFlush + perAck),
      `1% of main thread at a ${((perFlush + perAck) / 10).toFixed(1)}ms interval`,
    )
  })
  await yieldToPage()

  // 9. Overload (#018, #019).
  //    a) N medium records in one task: acks cannot run until the task ends, so in-flight
  //       data piles up and the 80% / 100% limits apply.
  for (const n of [10_000, 20_000, 50_000]) {
    await withCore(async (core, internals) => {
      await core.flush()
      for (let i = 0; i < n; i++) core.log('info', 'checkout button clicked', ctxPool[i & (POOL - 1)])
      const dropped = overloadDrops(internals)
      add('9. overload', single(`${n} info records in one task`, 0), `accepted ${n - dropped}, dropped ${dropped}`)
      await core.flush(30_000)
    })
    await yieldToPage()
  }
  //    b) 100k records over about 1 second, 1,000 per task (a 100k/s burst with yields).
  await withCore(async (core, internals) => {
    await core.flush()
    let dropped = 0
    const t0 = performance.now()
    for (let task = 0; task < 100; task++) {
      for (let i = 0; i < 1000; i++) core.log('info', 'checkout button clicked', ctxPool[i & (POOL - 1)])
      dropped = Math.max(dropped, overloadDrops(internals))
      await new Promise((r) => setTimeout(r, 0))
    }
    const ms = performance.now() - t0
    const after = overloadDrops(internals)
    add('9. overload', single('100k info records, 1,000 per task', 0), `took ${ms.toFixed(0)}ms, dropped ${Math.max(dropped, after)}`)
    await core.flush(30_000)
  })
  return rows
}
