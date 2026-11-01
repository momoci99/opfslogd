// Public API against real OPFS and workers (step 8, unit 5).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { close, flush, init, logger, setContext, type OpfslogdError } from '../../src/index'
import { DROP_MSG } from '../../src/queue'

const workerUrl = new URL('../../src/worker.ts', import.meta.url)

// Remember the last worker the library creates and the message types posted to it, so
// tests can talk to the failing worker and see when a flush is sent.
let lastWorker: Worker | undefined
const posted: string[] = []
const RealWorker = window.Worker
window.Worker = class extends RealWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    lastWorker = this
  }
  override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    posted.push((message as { type?: string }).type ?? '?')
    super.postMessage(message, transfer as Transferable[])
  }
}

/** Number of write messages posted so far. */
const writes = (): number => posted.filter((t) => t === 'write').length
const failingWorkerUrl = new URL('./failing.worker.ts', import.meta.url)

let ns = ''
function freshNamespace(): string {
  ns = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return ns
}

afterEach(async () => {
  await close()
  vi.restoreAllMocks()
  const opfs = await navigator.storage.getDirectory()
  const top = await opfs.getDirectoryHandle('opfslogd', { create: true })
  if (ns) await top.removeEntry(ns, { recursive: true }).catch(() => {})
})

async function dir(state: 'active' | 'pending' | 'done'): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory()
  const top = await opfs.getDirectoryHandle('opfslogd')
  return (await top.getDirectoryHandle(ns)).getDirectoryHandle(state)
}

/** Every line of every file in one state directory, file by file in name order. */
async function lines(state: 'active' | 'pending' | 'done'): Promise<Record<string, unknown>[]> {
  const d = await dir(state)
  const names: string[] = []
  for await (const name of d.keys()) names.push(name)
  const out: Record<string, unknown>[] = []
  for (const name of names.sort()) {
    const text = await (await (await d.getFileHandle(name)).getFile()).text()
    for (const l of text.trimEnd().split('\n')) if (l) out.push(JSON.parse(l) as Record<string, unknown>)
  }
  return out
}

const msgs = (rs: Record<string, unknown>[]): unknown[] => rs.filter((r) => 'ts' in r).map((r) => r.msg)

describe('logger lifecycle', () => {
  it('writes records and resolves flush() once they are on disk (#038)', async () => {
    init({ namespace: freshNamespace(), workerUrl, context: { version: '2.3.1' } })
    logger.info('a', { k: 1 })
    logger.warn('b')
    expect(await flush()).toBe(true)
    const rs = await lines('active')
    expect(rs[0]).toMatchObject({ format: 1, seq0: 0, context: { version: '2.3.1' } })
    expect(msgs(rs)).toEqual(['a', 'b'])
    expect(rs[1]).toMatchObject({ lv: 'info', msg: 'a', ctx: { k: 1 } })
  })

  it('flushes on the timer without flush() (#017)', async () => {
    init({ namespace: freshNamespace(), workerUrl })
    logger.info('timer')
    await expect.poll(async () => msgs(await lines('active')), { timeout: 2000 }).toEqual(['timer'])
  })

  it('flushes on pagehide (#020)', async () => {
    init({ namespace: freshNamespace(), workerUrl })
    await flush()
    logger.info('before hide')
    const before = writes()
    window.dispatchEvent(new Event('pagehide'))
    expect(writes()).toBe(before + 1) // sent at once, not on the timer
    await flush()
    expect(msgs(await lines('active'))).toEqual(['before hide'])
  })

  it('flushes an error record soon (#017)', async () => {
    init({ namespace: freshNamespace(), workerUrl })
    await flush()
    await new Promise((r) => setTimeout(r, 60)) // past the 50ms gap since the last flush
    const before = writes()
    logger.error('boom', new Error('x'))
    expect(writes()).toBe(before) // not inside log()
    await Promise.resolve()
    expect(writes()).toBe(before + 1) // in a microtask, not on the timer
    await flush()
    expect(msgs(await lines('active'))).toEqual(['boom'])
  })

  it('starts a new segment when the context changes (#031, #032)', async () => {
    init({ namespace: freshNamespace(), workerUrl, context: { version: '1' } })
    logger.info('before')
    setContext({ userId: 'u42' })
    setContext({ userId: 'u42' }) // same value: no new segment
    logger.info('after')
    await flush()
    const old = await lines('done')
    expect(old[0]).toMatchObject({ context: { version: '1' } })
    expect(msgs(old)).toEqual(['before'])
    const cur = await lines('active')
    expect(cur[0]).toMatchObject({ seq0: 1, context: { version: '1', userId: 'u42' } })
    expect(msgs(cur)).toEqual(['after'])
  })

  it('close() moves the segment out of active/, then discards and warns once (#030)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    init({ namespace: freshNamespace(), workerUrl })
    logger.info('kept')
    await close()
    expect(await lines('active')).toEqual([])
    expect(msgs(await lines('done'))).toEqual(['kept'])
    logger.info('dropped 1')
    logger.info('dropped 2')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await flush()).toBe(true)
  })

  it('starts again after close(), with a clean context (#030, #032)', async () => {
    init({ namespace: freshNamespace(), workerUrl, context: { a: 1 } })
    await close()
    init({ namespace: ns, workerUrl })
    logger.info('second run')
    await flush()
    const rs = await lines('active')
    expect(rs[0]).toMatchObject({ context: {} })
    expect(msgs(rs)).toEqual(['second run'])
  })

  it('ignores a second init() with one warning (#029)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    init({ namespace: freshNamespace(), workerUrl })
    init({ namespace: 'other', workerUrl })
    init({ namespace: 'other', workerUrl })
    expect(warn).toHaveBeenCalledTimes(1)
    logger.info('x')
    await flush()
    expect(msgs(await lines('active'))).toEqual(['x'])
  })
})

describe('errors (#040, #041)', () => {
  it('reports an invalid namespace and stays closed without warnings (#073)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors: OpfslogdError[] = []
    init({ namespace: 'My App', workerUrl, onError: (e) => errors.push(e) })
    expect(errors.map((e) => e.code)).toEqual(['invalid-option'])
    logger.info('x')
    expect(warn).not.toHaveBeenCalled()
    expect(await flush()).toBe(true)
  })

  it('prints each code once with console.error when there is no onError', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    init({ namespace: 'Bad' })
    await close()
    init({ namespace: 'Bad' })
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('reports worker-load-failed for a worker that cannot load', async () => {
    const errors: OpfslogdError[] = []
    init({
      namespace: freshNamespace(),
      workerUrl: new URL('./does-not-exist.worker.js', import.meta.url),
      onError: (e) => errors.push(e),
    })
    logger.info('x')
    await expect.poll(() => errors.map((e) => e.code), { timeout: 5000 }).toEqual(['worker-load-failed'])
    expect(await flush()).toBe(true) // closed (#041)
  })

  it('reports quota once, returns false from flush(), and writes a drop line (#064, #070)', async () => {
    const errors: OpfslogdError[] = []
    init({ namespace: freshNamespace(), workerUrl: failingWorkerUrl, onError: (e) => errors.push(e) })
    logger.info('ok')
    expect(await flush()).toBe(true)
    // make the next write fail the way Chromium does on a full quota
    failNextWrite()
    logger.info('lost 1')
    logger.info('lost 2')
    expect(await flush()).toBe(false)
    expect(errors.map((e) => e.code)).toEqual(['quota-exceeded'])

    logger.info('after')
    expect(await flush()).toBe(true)
    const rs = await lines('active')
    const drop = rs.find((r) => r.msg === DROP_MSG)
    expect(drop).toMatchObject({ lv: 'warn', ctx: { reason: 'quota', dropped: { info: 2 } } })
    // the gap falls between segments: 1 kept line, then seq0 = 3 (#064)
    expect(rs[0]).toMatchObject({ seq0: 3 })
    expect(msgs(rs)).toEqual(['after', DROP_MSG])
  })
})

/** Tells the failing test worker to make its next write short. */
function failNextWrite(): void {
  if (!lastWorker) throw new Error('no worker created')
  lastWorker.postMessage({ type: 'test-fail', name: 'short' })
}
