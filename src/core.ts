// Main-thread logger: queue, flush triggers, worker lifecycle (#017, #018, #020, #028-#033, #038, #040, #041, #062).

import { mergeContext, serializeContext, type Context } from './context'
import { ErrorReporter, OpfslogdError, type OpfslogdErrorCode } from './errors'
import { isValidNamespace, newTabId } from './names'
import type { FromWorker, ToWorker } from './protocol'
import { RecordQueue, type WriteFailReason } from './queue'
import { serializeRecord, type Level } from './record'

// Drafts to settle by measurement (docs/design/benchmark.html#impl).
const FLUSH_INTERVAL_MS = 50 // #017, #077
const FLUSH_SIZE_CHARS = 256 * 1024 // #017
const ERROR_FLUSH_GAP_MS = 50 // #017
const ROTATE_MAX_BYTES = 2_000_000 // #066
const DEFAULT_ROTATE_MAX_AGE_MS = 300_000 // #021, #036
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000 // #038
/** No ack for this long while batches are in flight: the worker died or hung (#040). */
const ACK_TIMEOUT_MS = 10_000
/** close() gives up waiting for the worker after this long and terminates it. */
const CLOSE_TIMEOUT_MS = 5_000
const DEFAULT_NAMESPACE = 'default'
const OPFS_ROOT = 'opfslogd'

export interface InitOptions {
  /**
   * Separates apps on the same origin: picks the OPFS directory and prefixes lock names.
   * Two apps on one origin (for example `user.github.io/app1` and `/app2`) that keep the
   * default share one directory, and one app's `send()` uploads the other's logs.
   * Allowed: `[a-z0-9_-]`, 1-64 characters. Default `'default'`. (#034, #073)
   */
  namespace?: string
  /** URL of `worker.js`, when the bundler cannot find it next to the library (#009). */
  workerUrl?: string | URL
  /** Global context added to every exported line (#031). */
  context?: Record<string, unknown>
  rotate?: {
    /** Close a non-empty segment after this long. Default 5 minutes. (#021, #036) */
    maxAgeMs?: number
  }
  /** Internal problems. Without it, each code is printed once with console.error (#040). */
  onError?: (err: OpfslogdError) => void
}

/**
 * One record as subscribers receive it: the exported line's shape (#033, #042).
 * Treat it as read-only.
 */
export interface LogRecord {
  ts: number
  lv: Level
  msg: string
  ctx?: Record<string, unknown>
  err?: Record<string, unknown>
  tab: string
  seq: number
  /** Global context; absent when empty (#071). */
  context?: Record<string, unknown>
}

export type Subscriber = (records: LogRecord[]) => void

type State = 'idle' | 'open' | 'closed'
/** Why the logger is closed: only an app's close() warns on later log() calls (#030, #041, #062). */
type ClosedBy = 'close' | 'failure' | 'not-browser'

interface FlushWaiter {
  /** First batch id that counts; earlier batches were acked before the call. */
  first: number
  /** Last batch id to wait for; undefined until the worker exists (#038). */
  target: number | undefined
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

const encoder = new TextEncoder()

export class Core {
  private state: State
  private closedBy: ClosedBy = 'close'
  private warnedClosed = false
  private warnedInit = false
  private queue = new RecordQueue()
  private readonly reporter = new ErrorReporter()

  private context: Context = {}
  private contextJson = '{}'

  private worker: Worker | undefined
  private tabId = ''
  private readonly subscribers = new Set<Subscriber>()
  private ready = false
  private closing: Promise<void> | undefined
  private onWorkerClosed: (() => void) | undefined

  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private errorFlushPending = false
  private lastFlushAt = -Infinity
  /** Date.now() of the oldest queued record; drives the hidden-tab rule of #020. */
  private oldestQueued: number | undefined

  private lastSentId = 0
  private lastAckedId = 0
  private readonly failedIds: number[] = []
  private waiters: FlushWaiter[] = []
  private writeFailing = false
  private watchdog: ReturnType<typeof setTimeout> | undefined
  private unresponsive = false

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.flushNow()
  }
  private readonly onPageHide = (): void => this.flushNow()

  constructor() {
    // Outside a browser page (SSR, Node, a worker), stay closed for good (#062).
    if (typeof document === 'undefined') {
      this.state = 'closed'
      this.closedBy = 'not-browser'
    } else {
      this.state = 'idle'
    }
  }

  log(lv: Level, msg: unknown, ctx?: unknown): void {
    if (this.state === 'closed') {
      if (this.closedBy === 'close' && !this.warnedClosed) {
        this.warnedClosed = true
        console.warn('opfslogd: logging has stopped because close() was called; this record was discarded.')
      }
      return
    }
    const ts = Date.now()
    if (!this.queue.admit(lv, ts)) {
      // the drop line needs a flush (#019)
      this.startFlushTimer()
      return
    }
    this.queue.push(serializeRecord(ts, lv, msg, ctx), lv, ts)

    if (this.queue.queuedChars > FLUSH_SIZE_CHARS) return this.flushNow()
    if (this.oldestQueued === undefined) this.oldestQueued = ts
    // Timers in hidden tabs can be delayed by seconds or minutes; log() itself flushes
    // once the oldest record has waited a whole interval (#020).
    else if (ts - this.oldestQueued >= FLUSH_INTERVAL_MS) return this.flushNow()
    if (lv === 'error') this.scheduleErrorFlush()
    this.startFlushTimer()
  }

  init(options: InitOptions = {}): void {
    if (this.closedBy === 'not-browser') return
    if (this.closing) {
      // init() right after close(): start once the old worker is gone
      const opts = options
      void this.closing.then(() => this.init(opts))
      return
    }
    if (this.state === 'open') {
      if (!this.warnedInit) {
        this.warnedInit = true
        console.warn('opfslogd: init() was already called; the first options stay in effect. Reload the page to apply new options.')
      }
      return
    }
    this.reporter.setHandler(options.onError)
    this.state = 'open'
    this.warnedInit = false

    const namespace = options.namespace ?? DEFAULT_NAMESPACE
    if (!isValidNamespace(namespace)) {
      return this.fail('invalid-option', `namespace must match [a-z0-9_-]{1,64}, got ${JSON.stringify(namespace)}`)
    }
    const maxAgeMs = options.rotate?.maxAgeMs ?? DEFAULT_ROTATE_MAX_AGE_MS
    if (typeof maxAgeMs !== 'number' || !(maxAgeMs > 0)) {
      return this.fail('invalid-option', `rotate.maxAgeMs must be a positive number, got ${String(maxAgeMs)}`)
    }

    // init({ context }) is setContext(context) at init time; its keys win (#032).
    this.context = mergeContext(this.context, options.context)
    this.contextJson = serializeContext(this.context)

    let worker: Worker
    try {
      // Keep this expression literal: bundlers find the worker file only in this form (#059).
      worker = options.workerUrl
        ? new Worker(options.workerUrl, { type: 'module', name: 'opfslogd' })
        : new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
    } catch (e) {
      return this.fail('worker-load-failed', 'the worker could not be created', e)
    }
    this.worker = worker
    this.ready = false
    worker.onmessage = (e: MessageEvent<FromWorker>): void => this.onMessage(e.data)
    worker.onerror = (e: ErrorEvent): void => {
      // Load failures (wrong workerUrl, CSP) arrive here before 'ready'.
      if (!this.ready) {
        e.preventDefault()
        this.fail('worker-load-failed', `the worker failed to load${e.message ? `: ${e.message}` : ''}`)
      }
    }
    this.post({
      type: 'init',
      namespace,
      tabId: (this.tabId = newTabId()),
      context: this.contextJson,
      rotateMaxAgeMs: maxAgeMs,
      rotateMaxBytes: ROTATE_MAX_BYTES,
      upload: false,
      root: OPFS_ROOT,
    })
    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('pagehide', this.onPageHide)

    // Records logged before init() go out now (#028). The worker handles messages in
    // order, so they are written once it has started.
    this.flushNow()
  }

  setContext(partial: unknown): void {
    if (this.closedBy === 'not-browser' && this.state === 'closed') return
    const next = mergeContext(this.context, partial)
    const json = serializeContext(next)
    if (json === this.contextJson) return
    // Records logged before the change carry the old context (#031): flush them first,
    // so the file and subscribers (#042) both see the old one.
    const running = this.state === 'open' && this.worker !== undefined
    if (running) this.flushNow()
    this.context = next
    this.contextJson = json
    if (running) this.post({ type: 'context', context: json })
  }

  flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
    if (this.state === 'closed') return Promise.resolve(true)
    const nothingQueued = !this.queue.hasData
    if (nothingQueued && this.lastAckedId === this.lastSentId) return Promise.resolve(true)
    this.flushNow()
    return new Promise((resolve) => {
      const waiter: FlushWaiter = {
        first: this.lastAckedId + 1,
        target: this.worker ? this.lastSentId : undefined,
        resolve,
        timer: setTimeout(() => this.settle(waiter, false), timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.state !== 'open') {
      if (this.closedBy !== 'not-browser') this.toClosed('close')
      return Promise.resolve()
    }
    const worker = this.worker
    if (!worker) {
      // init() failed validation: nothing to stop
      this.toClosed('close')
      return Promise.resolve()
    }
    // Send what is queued, then stop accepting records (#030).
    this.flushNow()
    const lastId = this.lastSentId
    this.state = 'closed'
    this.closedBy = 'close'
    this.warnedClosed = false
    this.closing = (async (): Promise<void> => {
      await this.waitForAck(lastId, CLOSE_TIMEOUT_MS)
      const closed = new Promise<void>((resolve) => {
        this.onWorkerClosed = resolve
      })
      worker.postMessage({ type: 'close' } satisfies ToWorker)
      await Promise.race([closed, delay(CLOSE_TIMEOUT_MS)])
      this.toClosed('close')
    })().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }

  private onMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true
        return
      case 'ack':
        return this.onAck(msg.id, msg.ok, msg.ok ? undefined : msg.reason)
      case 'closed':
        this.onWorkerClosed?.()
        this.onWorkerClosed = undefined
        return
      case 'fatal':
        return this.fail(msg.code, `storage could not start (${msg.name}: ${msg.message})`)
    }
  }

  private onAck(id: number, ok: boolean, reason: WriteFailReason | undefined): void {
    this.queue.ack(id, ok, reason)
    this.lastAckedId = id
    if (ok) {
      this.writeFailing = false
    } else {
      this.failedIds.push(id)
      // Report once when failures start, again only after a success (#064).
      if (!this.writeFailing) {
        this.writeFailing = true
        this.reporter.report(
          reason === 'quota'
            ? new OpfslogdError('quota-exceeded', 'storage is full; records are being dropped')
            : new OpfslogdError('write-failed', 'a segment write failed; records were dropped'),
        )
      }
      this.startFlushTimer() // the drop line (#064)
    }
    this.unresponsive = false
    this.restartWatchdog()
    for (const w of [...this.waiters]) if (w.target !== undefined && w.target <= id) this.settle(w, true)
  }

  /** Empties the queue into one write message. */
  private flushNow(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.errorFlushPending = false
    if (this.state !== 'open' || !this.worker) return
    const batch = this.queue.take(Date.now())
    this.oldestQueued = undefined
    if (!batch) return
    // After the batch is built, before it is sent (#023). No cost without subscribers.
    if (this.subscribers.size > 0) this.deliver(batch.text, batch.seq0)
    this.lastFlushAt = performance.now()
    const buf = new Uint8Array(batch.text.length * 3) // UTF-8 upper bound
    const { written } = encoder.encodeInto(batch.text, buf)
    this.post(
      {
        type: 'write',
        id: batch.id,
        buf: buf.buffer,
        length: written,
        lines: batch.lines,
        minTs: batch.minTs,
        maxTs: batch.maxTs,
      },
      [buf.buffer],
    )
    this.lastSentId = batch.id
    for (const w of this.waiters) if (w.target === undefined) w.target = batch.id
    if (this.watchdog === undefined) this.restartWatchdog()
  }

  /** Adds a subscriber; returns a function that removes it, safe to call twice (#043). */
  subscribe(fn: Subscriber): () => void {
    if (this.closedBy === 'not-browser' && this.state === 'closed') return () => {}
    if (typeof fn !== 'function') return () => {}
    // a wrapper, so the same function subscribed twice is called twice and removed once per off()
    const entry: Subscriber = (records) => fn(records)
    this.subscribers.add(entry)
    return () => {
      this.subscribers.delete(entry)
    }
  }

  /** Parses the batch once and hands the same array to every subscriber (#042). */
  private deliver(text: string, seq0: number): void {
    let records: LogRecord[]
    try {
      const context = this.contextJson === '{}' ? undefined : (JSON.parse(this.contextJson) as Record<string, unknown>)
      const lines = text.split('\n')
      lines.pop() // the batch ends with a newline
      records = lines.map((line, i) => {
        const r = JSON.parse(line) as LogRecord
        r.tab = this.tabId
        r.seq = seq0 + i
        if (context) r.context = context
        return r
      })
    } catch {
      return
    }
    for (const fn of [...this.subscribers]) {
      try {
        fn(records)
      } catch {
        // a throwing subscriber must not affect logging (#023)
      }
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer === undefined && this.state === 'open') {
      this.flushTimer = setTimeout(() => this.flushNow(), FLUSH_INTERVAL_MS)
    }
  }

  /** error records flush in a microtask, at most every 50ms (#017). */
  private scheduleErrorFlush(): void {
    if (this.errorFlushPending) return
    this.errorFlushPending = true
    queueMicrotask(() => {
      if (!this.errorFlushPending) return
      const wait = this.lastFlushAt + ERROR_FLUSH_GAP_MS - performance.now()
      if (wait <= 0) return this.flushNow()
      clearTimeout(this.flushTimer)
      this.flushTimer = setTimeout(() => this.flushNow(), wait)
    })
  }

  private restartWatchdog(): void {
    clearTimeout(this.watchdog)
    this.watchdog = undefined
    if (this.lastAckedId >= this.lastSentId || this.state !== 'open') return
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined
      if (this.unresponsive) return
      this.unresponsive = true
      this.reporter.report(new OpfslogdError('worker-unresponsive', `no write acknowledgement for ${ACK_TIMEOUT_MS / 1000}s`))
    }, ACK_TIMEOUT_MS)
  }

  private waitForAck(id: number, timeoutMs: number): Promise<boolean> {
    if (this.lastAckedId >= id) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiter: FlushWaiter = {
        first: this.lastAckedId + 1,
        target: id,
        resolve,
        timer: setTimeout(() => this.settle(waiter, false), timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  private settle(w: FlushWaiter, acked: boolean): void {
    const i = this.waiters.indexOf(w)
    if (i < 0) return
    this.waiters.splice(i, 1)
    clearTimeout(w.timer)
    const target = w.target ?? 0
    w.resolve(acked && !this.failedIds.some((id) => id >= w.first && id <= target))
  }

  /** Storage cannot start or an option is invalid: report and behave as closed (#041, #073). */
  private fail(code: OpfslogdErrorCode, message: string, cause?: unknown): void {
    this.reporter.report(new OpfslogdError(code, message, cause === undefined ? undefined : { cause }))
    this.toClosed('failure')
  }

  /** Drops the worker, the queue, and the context; later log() calls are discarded. */
  private toClosed(by: ClosedBy): void {
    this.state = 'closed'
    this.closedBy = by
    this.warnedClosed = false
    this.worker?.terminate()
    this.worker = undefined
    this.ready = false
    this.onWorkerClosed = undefined
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    clearTimeout(this.watchdog)
    this.watchdog = undefined
    this.errorFlushPending = false
    this.oldestQueued = undefined
    this.queue = new RecordQueue()
    this.lastSentId = this.lastAckedId = 0
    this.failedIds.length = 0
    this.writeFailing = false
    this.unresponsive = false
    for (const w of [...this.waiters]) this.settle(w, false)
    // close() clears the context so a later init() starts clean (#032)
    this.context = {}
    this.contextJson = '{}'
    // close() removes all subscribers (#043); a failed logger delivers nothing (#041)
    this.subscribers.clear()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
      window.removeEventListener('pagehide', this.onPageHide)
    }
  }

  private post(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
