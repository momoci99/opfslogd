// Runs in the checked browser. run.mjs reads window.__result.
//   ?mode=write   library worker writes batches; reports what was acked
//   ?mode=read    reads what is on disk after the browser was killed
//   ?mode=raw-quota   raw sync handle writes until QuotaExceededError; reports sizes
//   ?mode=lib-quota   library worker writes until a quota ack; checks the file has no partial line

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
const ROOT = 'opfslogd-check'
const NS = 'check'

function batch(from, count) {
  // ~200-byte lines like the bench's medium record
  let text = ''
  for (let i = from; i < from + count; i++) {
    text += JSON.stringify({ ts: 1730000000000 + i, lv: 'info', msg: `line ${i}`, ctx: { pad: 'x'.repeat(150) } }) + '\n'
  }
  return new TextEncoder().encode(text)
}

function startLibWorker() {
  const worker = new Worker('/dist/worker.js', { type: 'module' })
  const waiters = []
  worker.onmessage = (e) => waiters.shift()?.(e.data)
  const next = () => new Promise((r) => waiters.push(r))
  worker.postMessage({
    type: 'init', namespace: NS, tabId: 'check000', context: '{}',
    rotateMaxAgeMs: 3_600_000, rotateMaxBytes: 1e9, upload: false, root: ROOT,
  })
  return { worker, next }
}

async function write() {
  const { worker, next } = startLibWorker()
  const ready = await next()
  if (ready.type !== 'ready') return { error: ready }
  const batches = Number(params.get('batches') ?? 40)
  const per = 1300 // about 256K characters, one size-triggered flush (#017)
  let acked = 0
  let bytes = 0
  for (let b = 0; b < batches; b++) {
    const buf = batch(b * per, per)
    bytes += buf.length
    worker.postMessage({ type: 'write', id: b + 1, buf: buf.buffer, length: buf.length, lines: per, minTs: 0, maxTs: 0 }, [buf.buffer])
    const ack = await next()
    if (!ack.ok) return { error: ack }
    acked += per
  }
  return { acked, bytes }
}

async function read() {
  const opfs = await navigator.storage.getDirectory()
  const active = await (await (await opfs.getDirectoryHandle(ROOT)).getDirectoryHandle(NS)).getDirectoryHandle('active')
  let lines = 0
  let bytes = 0
  let badTail = 0
  for await (const [name, handle] of active.entries()) {
    const text = await (await handle.getFile()).text()
    bytes += new TextEncoder().encode(text).length
    const parts = text.split('\n')
    const tail = parts.pop() // '' when the file ends with a newline
    if (tail) badTail++
    lines += parts.length - 1 // minus the header line
    void name
  }
  await opfs.removeEntry(ROOT, { recursive: true })
  return { lines, bytes, badTail }
}

async function rawQuota() {
  const worker = new Worker('./raw-quota.worker.js', { type: 'module' })
  return new Promise((resolve) => {
    worker.onmessage = (e) => resolve(e.data)
  })
}

async function libQuota() {
  const { worker, next } = startLibWorker()
  const ready = await next()
  if (ready.type !== 'ready') return { error: ready }
  const per = 1300
  let lastOk = 0
  for (let b = 0; b < 400; b++) {
    const buf = batch(b * per, per)
    worker.postMessage({ type: 'write', id: b + 1, buf: buf.buffer, length: buf.length, lines: per, minTs: 0, maxTs: 0 }, [buf.buffer])
    const ack = await next()
    if (!ack.ok) {
      worker.postMessage({ type: 'close' })
      await next()
      // The failed write was rolled back and the segment rotated into done/.
      const opfs = await navigator.storage.getDirectory()
      const done = await (await (await opfs.getDirectoryHandle(ROOT)).getDirectoryHandle(NS)).getDirectoryHandle('done')
      const files = []
      for await (const [name, handle] of done.entries()) {
        const text = await (await handle.getFile()).text()
        const parts = text.split('\n')
        files.push({ name, lines: parts.length - 2, endsWithNewline: parts.at(-1) === '' })
      }
      await opfs.removeEntry(ROOT, { recursive: true })
      return { ack, okBatches: lastOk, linesWritten: lastOk * per, files }
    }
    lastOk = b + 1
  }
  return { error: 'no quota error after 400 batches' }
}

const run = { write, read, 'raw-quota': rawQuota, 'lib-quota': libQuota }[mode]
window.__result = run().catch((e) => ({ error: `${e.name}: ${e.message}` }))
