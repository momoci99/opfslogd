// Playground: try the public API by hand against the source in src/ (no build needed).
// Run: pnpm playground

import { close, exportLogs, flush, init, logger, setContext, subscribe } from '../src/index'
import type { InitOptions, Level, LogRecord, OpfslogdError } from '../src/index'

const workerUrl = new URL('../src/worker.ts', import.meta.url)
const STORE_KEY = 'opfslogd-playground'
const MAX_SHOWN = 2000
const MAX_TEXT = 200_000

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}
const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id)

// ---- options form ----

interface FormValues {
  ns: string
  context: string
  rotateAge: string
  retBytes: string
  retAge: string
  upload: boolean
  upInterval: string
  upTimeout: string
  autoInit: boolean
}

const DEFAULTS: FormValues = {
  ns: 'playground',
  context: '{"app":"playground"}',
  rotateAge: '30000',
  retBytes: '',
  retAge: '',
  upload: true,
  upInterval: '10000',
  upTimeout: '5000',
  autoInit: false,
}
const PLACEHOLDERS: Partial<Record<keyof FormValues, string>> = {
  rotateAge: '300000',
  retBytes: '50000000',
  retAge: '604800000',
  upInterval: '60000',
  upTimeout: '60000',
}

function readForm(): FormValues {
  return {
    ns: input('ns').value,
    context: input('context').value,
    rotateAge: input('rotateAge').value,
    retBytes: input('retBytes').value,
    retAge: input('retAge').value,
    upload: input('upload').checked,
    upInterval: input('upInterval').value,
    upTimeout: input('upTimeout').value,
    autoInit: input('autoInit').checked,
  }
}

function writeForm(v: FormValues): void {
  for (const key of Object.keys(v) as (keyof FormValues)[]) {
    const el = input(key)
    const value = v[key]
    if (typeof value === 'boolean') el.checked = value
    else el.value = value
    const ph = PLACEHOLDERS[key]
    if (ph) el.placeholder = `default ${ph}`
  }
}

function saveForm(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(readForm()))
  } catch {
    // storage blocked; the form still works
  }
}

function loadForm(): FormValues {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved) return { ...DEFAULTS, ...(JSON.parse(saved) as Partial<FormValues>) }
  } catch {
    // fall through
  }
  return DEFAULTS
}

const num = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s))

function parseJson(text: string, what: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // reported below
  }
  showError(`${what}: not a JSON object`)
  return undefined
}

// ---- status ----

let running = false
let tabId = '?'
let namespace = DEFAULTS.ns

function setStatus(): void {
  $('status').textContent = running ? `running · namespace ${namespace} · tab ${tabId}` : 'closed'
}

// ---- subscribe / onError ----

let shownRecords = 0
function addLine(box: HTMLElement, text: string, cls = ''): HTMLElement {
  const div = document.createElement('div')
  div.textContent = text
  if (cls) div.className = cls
  box.append(div)
  return div
}

function time(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

subscribe((records: LogRecord[]) => {
  const first = records[0]
  if (first && first.tab !== tabId) {
    tabId = first.tab
    setStatus()
  }
  const box = $('records')
  const showDebug = input('showDebug').checked
  const start = Math.max(0, records.length - MAX_SHOWN)
  const frag = document.createDocumentFragment()
  for (const r of records.slice(start)) {
    if (r.lv === 'debug' && !showDebug) continue
    const div = document.createElement('div')
    div.className = `lv-${r.lv}`
    const { ts, lv, msg, tab, seq, ...rest } = r
    void tab
    const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''
    div.textContent = `${time(ts)} #${seq} ${lv.padEnd(5)} ${msg}${extra}`
    frag.append(div)
  }
  box.append(frag)
  while (box.childElementCount > MAX_SHOWN) box.firstElementChild?.remove()
  shownRecords += records.length
  $('recCount').textContent = `(${shownRecords.toLocaleString()} received)`
  if (input('follow').checked) box.scrollTop = box.scrollHeight
})

function showError(text: string): void {
  const box = $('errors')
  addLine(box, `${time(Date.now())} ${text}`, 'bad')
  box.scrollTop = box.scrollHeight
}

function onError(e: OpfslogdError): void {
  showError(`[${e.code}] ${e.message}`)
  if (e.code === 'opfs-unavailable' || e.code === 'worker-load-failed' || e.code === 'invalid-option') {
    running = false
    setStatus()
  }
}

// ---- upload (fake send) ----

type UploadMode = 'ok' | 'slow' | 'fail' | 'hang'
let uploadMode: UploadMode = 'ok'

function uploadLine(text: string, cls = ''): void {
  const box = $('uploads')
  addLine(box, `${time(Date.now())} ${text}`, cls)
  box.scrollTop = box.scrollHeight
}

const send: NonNullable<InitOptions['upload']>['send'] = async (file, meta) => {
  const mode = uploadMode
  const lines = (await file.text()).split('\n').length - 1
  uploadLine(`send ${meta.segmentId} · ${lines} lines · ${fmtBytes(meta.size)} · sha256 ${meta.sha256.slice(0, 12)}… · ${mode}`)
  try {
    await new Promise<void>((resolve, reject) => {
      meta.signal.addEventListener('abort', () => reject(new Error('aborted (timeoutMs)')))
      if (mode === 'ok') resolve()
      else if (mode === 'slow') setTimeout(resolve, 3000)
      else if (mode === 'fail') reject(new Error('fake backend error'))
    })
  } catch (e) {
    uploadLine(`  ✗ ${meta.segmentId}: ${(e as Error).message}, stays in pending/`, 'bad')
    throw e
  }
  uploadLine(`  ✓ ${meta.segmentId} moves to done/`, 'ok')
}

for (const btn of $('upMode').querySelectorAll<HTMLButtonElement>('button')) {
  btn.addEventListener('click', () => {
    uploadMode = btn.dataset.mode as UploadMode
    for (const b of $('upMode').querySelectorAll('button')) b.classList.toggle('on', b === btn)
  })
}

// ---- init / close ----

function start(): void {
  if (running) {
    showError('already running: close() first to apply new options')
    return
  }
  const v = readForm()
  saveForm()
  const options: InitOptions = {
    namespace: v.ns,
    workerUrl,
    onError,
    rotate: { maxAgeMs: num(v.rotateAge) },
    retention: { maxBytes: num(v.retBytes), maxAgeMs: num(v.retAge) },
  }
  const context = parseJson(v.context, 'context')
  if (context) options.context = context
  if (v.upload) options.upload = { send, intervalMs: num(v.upInterval), timeoutMs: num(v.upTimeout) }
  namespace = v.ns
  running = true
  tabId = '?'
  init(options)
  setStatus()
  void refreshFiles()
}

async function stop(): Promise<void> {
  stopStream()
  $('status').textContent = 'closing…'
  await close()
  running = false
  setStatus()
  void refreshFiles()
}

$('init').addEventListener('click', start)
$('close').addEventListener('click', () => void stop())
$('reset').addEventListener('click', () => {
  writeForm(DEFAULTS)
  saveForm()
})
for (const el of document.querySelectorAll('#ns, #context, #rotateAge, #retBytes, #retAge, #upload, #upInterval, #upTimeout, #autoInit')) {
  el.addEventListener('change', saveForm)
}

// ---- log ----

function logOne(lv: Level, msg: string, ctx?: object): void {
  logger[lv](msg, ctx)
}

$('log').addEventListener('click', () => {
  const ctx = parseJson(input('ctx').value, 'ctx')
  logOne($<HTMLSelectElement>('lv').value as Level, input('msg').value, ctx)
})

$('logErr').addEventListener('click', () => {
  const err = new Error('save failed', { cause: new TypeError('network down', { cause: { status: 503 } }) })
  logger.error('could not save the draft', { err, draftId: 42 })
})

$('logBig').addEventListener('click', () => {
  logger.info('big record', { blob: 'x'.repeat(100_000) })
})

$('burst').addEventListener('click', () => {
  const n = Number(input('burstN').value) || 0
  const t0 = performance.now()
  for (let i = 0; i < n; i++) logger.info('burst', { i })
  const ms = performance.now() - t0
  $('flushOut').textContent = `logged ${n.toLocaleString()} in ${ms.toFixed(1)} ms (${((ms * 1000) / Math.max(n, 1)).toFixed(2)} µs each)`
})

let streamTimer: ReturnType<typeof setInterval> | undefined
let streamCount = 0
function stopStream(): void {
  if (streamTimer !== undefined) clearInterval(streamTimer)
  streamTimer = undefined
  $('stream').textContent = 'start'
  $('stream').classList.remove('on')
}
$('stream').addEventListener('click', () => {
  if (streamTimer !== undefined) return stopStream()
  const perTick = Math.max(1, Math.round((Number(input('rate').value) || 0) / 20))
  streamTimer = setInterval(() => {
    for (let i = 0; i < perTick; i++) {
      const n = streamCount++
      logger[n % 50 === 0 ? 'warn' : n % 7 === 0 ? 'debug' : 'info']('stream', { n })
    }
  }, 50)
  $('stream').textContent = 'stop'
  $('stream').classList.add('on')
})

$('setContext').addEventListener('click', () => {
  const partial = parseJson(input('setCtx').value, 'setContext')
  if (partial) setContext(partial)
})

$('flush').addEventListener('click', async () => {
  const t0 = performance.now()
  const ok = await flush()
  const out = $('flushOut')
  out.textContent = `flush() → ${ok} in ${(performance.now() - t0).toFixed(1)} ms`
  out.className = ok ? 'note ok' : 'note bad'
  void refreshFiles()
})

// ---- export ----

async function runExport(): Promise<{ file: Blob; text: string } | undefined> {
  const ago = num(input('expFrom').value)
  const t0 = performance.now()
  const { file, skipped } = await exportLogs(ago === undefined ? {} : { from: Date.now() - ago })
  const text = await file.text()
  const lines = text === '' ? 0 : text.split('\n').length - 1
  $('expOut').textContent =
    `${lines.toLocaleString()} lines · ${fmtBytes(file.size)} · ${(performance.now() - t0).toFixed(0)} ms · ` +
    `skipped: ${skipped.activeOtherTabs} active segments of other tabs, ${skipped.unreadable} unreadable`
  return { file, text }
}

$('export').addEventListener('click', async () => {
  const r = await runExport()
  if (!r || r.file.size === 0) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(r.file)
  a.download = `opfslogd-${namespace}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

$('exportView').addEventListener('click', async () => {
  const r = await runExport()
  if (r) showText('exportLogs()', r.text)
})

// ---- OPFS files ----

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function showText(name: string, text: string): void {
  $('fileName').textContent = name
  const cut = text.length > MAX_TEXT
  $('fileBody').textContent = (cut ? text.slice(0, MAX_TEXT) : text) + (cut ? `\n… (${(text.length - MAX_TEXT).toLocaleString()} more chars)` : '')
}

async function nsDir(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const root = await navigator.storage.getDirectory()
    const top = await root.getDirectoryHandle('opfslogd')
    return await top.getDirectoryHandle(input('ns').value)
  } catch {
    return undefined
  }
}

let refreshing = false
async function refreshFiles(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const est = await navigator.storage.estimate().catch(() => undefined)
    $('estimate').textContent = est ? `origin usage ${fmtBytes(est.usage ?? 0)} of ${fmtBytes(est.quota ?? 0)}` : ''
    const body = $('files')
    const dir = await nsDir()
    const rows: HTMLTableRowElement[] = []
    if (!dir) {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td class="note">no files for this namespace yet</td>'
      rows.push(tr)
    } else {
      for (const state of ['active', 'pending', 'done']) {
        let sub: FileSystemDirectoryHandle
        try {
          sub = await dir.getDirectoryHandle(state)
        } catch {
          continue
        }
        const files: { name: string; size: number | undefined; handle: FileSystemFileHandle }[] = []
        for await (const [name, h] of sub.entries()) {
          if (h.kind !== 'file') continue
          const handle = h as FileSystemFileHandle
          // Chromium cannot read a file while a worker holds its sync access handle.
          const size = await handle.getFile().then((f) => f.size, () => undefined)
          files.push({ name, size, handle })
        }
        files.sort((a, b) => a.name.localeCompare(b.name))
        const total = files.reduce((s, f) => s + (f.size ?? 0), 0)
        const head = document.createElement('tr')
        head.innerHTML = `<th class="dir">${state}/</th><th class="dir">${files.length} files</th><th class="dir num">${fmtBytes(total)}</th>`
        rows.push(head)
        for (const f of files) {
          const tr = document.createElement('tr')
          tr.className = 'file'
          const name = document.createElement('td')
          name.textContent = f.name
          name.colSpan = 2
          const size = document.createElement('td')
          size.className = 'num'
          size.textContent = f.size === undefined ? 'locked' : fmtBytes(f.size)
          tr.append(name, size)
          tr.addEventListener('click', () => void openFile(`${state}/${f.name}`, f.handle))
          rows.push(tr)
        }
      }
    }
    body.replaceChildren(...rows)
  } catch {
    // a file moved or the namespace was deleted mid-listing; the next refresh catches up
  } finally {
    refreshing = false
  }
}

async function openFile(label: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    showText(label, await (await handle.getFile()).text())
  } catch (e) {
    const err = e as Error
    const why =
      err.name === 'NotFoundError'
        ? 'it moved (rotated, uploaded) or was deleted since the list was drawn'
        : 'a worker holds it open; "exportLogs() and show" includes this tab\'s active segment'
    showText(label, `cannot read: ${err.name}: ${err.message}\n(${why})`)
  }
}

$('refresh').addEventListener('click', () => void refreshFiles())
setInterval(() => {
  if (input('autoRefresh').checked && document.visibilityState === 'visible') void refreshFiles()
}, 1000)

$('wipe').addEventListener('click', async () => {
  const ns = input('ns').value
  if (!confirm(`Close the logger and delete opfslogd/${ns}/ ? Other tabs using it keep their open files.`)) return
  await stop()
  try {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd')
    await top.removeEntry(ns, { recursive: true })
  } catch (e) {
    showError(`delete failed: ${(e as Error).name} ${(e as Error).message}`)
  }
  void refreshFiles()
})

// ---- start ----

writeForm(loadForm())
setStatus()
void refreshFiles()
if (input('autoInit').checked) start()
