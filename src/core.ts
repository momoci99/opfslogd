// Main-thread logger: queue, flush triggers, worker lifecycle (#017, #018, #020, #028-#033, #038, #040, #041, #062).

import { mergeContext, serializeContext, type Context } from './context'
import { ErrorReporter, OpfslogdError, type OpfslogdErrorCode } from './errors'
import { isValidNamespace, lockNames, newTabId } from './names'
import type { FromWorker, ToWorker, WorkerCall } from './protocol'
import type { Prepared, UploadMeta } from './upload-worker'
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
const DEFAULT_RETENTION_MAX_BYTES = 50_000_000 // #052
const DEFAULT_RETENTION_MAX_AGE_MS = 7 * 86_400_000 // #051
/** Retention (and later upload) runs this often after the first idle run (#053). */
const MAINTAIN_INTERVAL_MS = 60_000
/** Fallback wait where requestIdleCallback is missing (Safari) (#049). */
const IDLE_FALLBACK_MS = 1_000
const DEFAULT_UPLOAD_INTERVAL_MS = 60_000 // #049
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000 // #045
const DEFAULT_NAMESPACE = 'default'
const OPFS_ROOT = 'opfslogd'

/** Second argument of `send()` (#048). */
export interface SendMeta extends UploadMeta {
  /** Aborted after `upload.timeoutMs`; pass it to fetch() (#045). */
  signal: AbortSignal
}

export interface UploadOptions {
  /**
   * Sends one closed segment: `file` is JSON Lines (application/x-ndjson) in the exported
   * shape. Resolve when the backend has it; reject to retry on the next run. Delivery is
   * at least once: dedupe on `meta.segmentId`. (#007, #045 - #048)
   */
  send: (file: Blob, meta: SendMeta) => Promise<unknown>
  /** Time between upload runs. Default 1 minute. (#049) */
  intervalMs?: number
  /** Abort `meta.signal` and count the attempt as failed after this long. Default 1 minute. (#045) */
  timeoutMs?: number
}

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
  retention?: {
    /** Delete closed segments once all files in the namespace pass this size. Default 50MB. (#050, #052) */
    maxBytes?: number
    /** Delete closed segments whose last record is older than this. Default 7 days. (#050, #051) */
    maxAgeMs?: number
  }
  /**
   * Upload closed segments with your own `send()`. Without it, closed segments are kept
   * locally only; segments closed while it is not set are never uploaded later (#068).
   */
  upload?: UploadOptions
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

  private namespace = DEFAULT_NAMESPACE
  private upload: Required<UploadOptions> | undefined
  private uploadTimer: ReturnType<typeof setTimeout> | undefined
  private uploadStarted = false
  private uploading = false
  private readonly unreadableReported = new Set<string>()
  private readonly calls = new Map<number, (value: unknown) => void>()
  private nextCallId = 1
  private maintainTimer: ReturnType<typeof setTimeout> | undefined
  private cancelIdle: (() => void) | undefined
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
    const retentionMaxBytes = options.retention?.maxBytes ?? DEFAULT_RETENTION_MAX_BYTES
    const retentionMaxAgeMs = options.retention?.maxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS
    const upload = options.upload
    if (upload !== undefined && (typeof upload !== 'object' || upload === null || typeof upload.send !== 'function')) {
      return this.fail('invalid-option', 'upload.send must be a function')
    }
    const uploadIntervalMs = upload?.intervalMs ?? DEFAULT_UPLOAD_INTERVAL_MS
    const uploadTimeoutMs = upload?.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS
    for (const [name, value] of [
      ['rotate.maxAgeMs', maxAgeMs],
      ['retention.maxBytes', retentionMaxBytes],
      ['retention.maxAgeMs', retentionMaxAgeMs],
      ['upload.intervalMs', uploadIntervalMs],
      ['upload.timeoutMs', uploadTimeoutMs],
    ] as const) {
      if (typeof value !== 'number' || !(value > 0)) {
        return this.fail('invalid-option', `${name} must be a positive number, got ${String(value)}`)
      }
    }
    this.namespace = namespace
    this.upload = upload ? { send: upload.send, intervalMs: uploadIntervalMs, timeoutMs: uploadTimeoutMs } : undefined
    this.uploadStarted = false

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
      upload: this.upload !== undefined,
      retentionMaxBytes,
      retentionMaxAgeMs,
      root: OPFS_ROOT,
    })
    this.scheduleMaintenance()
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
      case 'maintained':
        if (msg.dropped) {
          // written as a drop line at the next flush (#061, #070)
          const { segments, bytes, from, to } = msg.dropped
          this.queue.addRetention(segments, bytes, from, to)
          this.startFlushTimer()
        }
        // The first upload run follows the first retention run (#053).
        if (this.upload && !this.uploadStarted) {
          this.uploadStarted = true
          void this.uploadLoop()
        }
        return
      case 'reply':
        this.calls.get(msg.id)?.(msg.value)
        this.calls.delete(msg.id)
        return
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

  /**
   * First run once the page has loaded and is idle, then every minute (#049, #053).
   * Every tab asks; the worker runs only if it gets the lock (#022).
   */
  private scheduleMaintenance(): void {
    const run = (): void => {
      this.cancelIdle = undefined
      if (this.state !== 'open') return
      this.post({ type: 'maintain' })
      this.maintainTimer = setTimeout(run, MAINTAIN_INTERVAL_MS)
    }
    const whenIdle = (): void => {
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 10_000 })
        this.cancelIdle = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(run, IDLE_FALLBACK_MS)
        this.cancelIdle = () => clearTimeout(id)
      }
    }
    if (document.readyState === 'complete') return whenIdle()
    const onLoad = (): void => whenIdle()
    window.addEventListener('load', onLoad, { once: true })
    this.cancelIdle = () => window.removeEventListener('load', onLoad)
  }

  private async uploadLoop(): Promise<void> {
    await this.uploadRun()
    if (this.state === 'open' && this.upload) {
      this.uploadTimer = setTimeout(() => void this.uploadLoop(), this.upload.intervalMs)
    }
  }

  /**
   * One upload run in the tab that gets the upload lock (#022): pending segments oldest
   * first, one at a time, stopping at the first failure (#046, #047).
   */
  private async uploadRun(): Promise<void> {
    const upload = this.upload
    if (!upload || this.uploading || this.state !== 'open') return
    this.uploading = true
    try {
      await navigator.locks.request(lockNames(this.namespace).upload, { ifAvailable: true }, async (lock) => {
        if (!lock) return
        const names = (await this.call({ op: 'list-pending' })) as string[] | undefined
        for (const name of names ?? []) {
          if (this.state !== 'open') return
          const prepared = (await this.call({ op: 'prepare', name })) as Prepared | undefined
          if (!prepared || prepared.kind === 'skip') continue
          if (prepared.kind === 'unreadable') {
            if (!this.unreadableReported.has(name)) {
              this.unreadableReported.add(name)
              this.reporter.report(new OpfslogdError('unreadable-file', `skipped ${name}: written by a newer version`))
            }
            continue
          }
          if (!(await sendOnce(upload, prepared.file, prepared.meta))) return
          await this.call({ op: 'mark-done', name })
        }
      })
    } catch {
      // the run ends; the next one retries (#046)
    } finally {
      this.uploading = false
    }
  }

  /** Asks the worker for one upload step; resolves undefined if the logger closes first. */
  private call(call: WorkerCall): Promise<unknown> {
    if (!this.worker) return Promise.resolve(undefined)
    const id = this.nextCallId++
    return new Promise((resolve) => {
      this.calls.set(id, resolve)
      this.post({ type: 'call', id, call })
    })
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
    clearTimeout(this.maintainTimer)
    this.maintainTimer = undefined
    clearTimeout(this.uploadTimer)
    this.uploadTimer = undefined
    this.upload = undefined
    for (const resolve of this.calls.values()) resolve(undefined)
    this.calls.clear()
    this.cancelIdle?.()
    this.cancelIdle = undefined
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

/**
 * Calls send() once with a timeout (#045). True when it resolved in time. A late result
 * is ignored; a late success means the segment is sent again later (at least once, #007).
 */
async function sendOnce(upload: Required<UploadOptions>, file: Blob, meta: UploadMeta): Promise<boolean> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('upload.timeoutMs passed', 'TimeoutError'))
      resolve(false)
    }, upload.timeoutMs)
  })
  try {
    const sent = (async (): Promise<true> => {
      await upload.send(file, { ...meta, signal: controller.signal })
      return true
    })()
    return await Promise.race([sent.catch(() => false as const), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
