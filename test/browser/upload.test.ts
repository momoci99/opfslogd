// upload through the public API, against real OPFS, workers, and Web Locks (step 8, unit 8).

import { afterEach, describe, expect, it } from 'vitest'
import { close, flush, init, logger, setContext, type OpfslogdError, type SendMeta } from '../../src/index'
import { closedName } from '../../src/names'

const workerUrl = new URL('../../src/worker.ts', import.meta.url)
let ns = ''

afterEach(async () => {
  await close()
  const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd', { create: true })
  await top.removeEntry(ns, { recursive: true }).catch(() => {})
})

function freshNamespace(): string {
  ns = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return ns
}

async function names(state: 'active' | 'pending' | 'done'): Promise<string[]> {
  const opfs = await navigator.storage.getDirectory()
  const d = await (await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(ns)).getDirectoryHandle(state)
  const out: string[] = []
  for await (const name of d.keys()) out.push(name)
  return out.sort()
}

/** Logs one record per segment: setContext() closes the current segment (#031). */
async function makePending(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    logger.info(`segment ${i}`, { i })
    setContext({ n: i })
  }
  await flush()
}

interface Call {
  text: string
  meta: SendMeta
}

describe('upload', () => {
  it('sends each pending segment as exported JSONL and moves it to done/ (#007, #033, #048)', async () => {
    const calls: Call[] = []
    init({
      namespace: freshNamespace(),
      workerUrl,
      context: { app: 'test' },
      upload: {
        async send(file, meta) {
          calls.push({ text: await file.text(), meta })
          expect(file.type).toBe('application/x-ndjson')
        },
        intervalMs: 200,
      },
    })
    await makePending(2)
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(2)
    await expect.poll(() => names('pending'), { timeout: 2000 }).toEqual([])
    expect(await names('done')).toHaveLength(2)

    const [first] = calls
    const rec = JSON.parse(first?.text.trimEnd() ?? '') as Record<string, unknown>
    expect(rec).toMatchObject({ lv: 'info', msg: 'segment 0', ctx: { i: 0 }, seq: 0, context: { app: 'test' } })
    expect(rec.tab).toMatch(/^[0-9a-z]{8}$/)

    const meta = first?.meta
    const bytes = new TextEncoder().encode(first?.text)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    expect(meta?.sha256).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''))
    expect(meta?.size).toBe(bytes.length)
    expect(meta?.segmentId).toBe(closedName(rec.ts as number, rec.ts as number, rec.tab as string).replace('.seg', ''))
    expect(meta).toMatchObject({ from: rec.ts, to: rec.ts })
    expect(meta?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a failed segment pending, stops the run, and retries later (#046)', async () => {
    let attempts = 0
    const sent: string[] = []
    init({
      namespace: freshNamespace(),
      workerUrl,
      upload: {
        async send(file, meta) {
          attempts++
          if (attempts === 1) throw new Error('backend down')
          sent.push(meta.segmentId)
          void file
        },
        intervalMs: 300,
      },
    })
    await makePending(2)
    // first run: one failed attempt, nothing else tried
    await expect.poll(() => attempts, { timeout: 5000 }).toBeGreaterThanOrEqual(1)
    expect(sent).toEqual([])
    // next run: both go
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(2)
    expect(await names('pending')).toEqual([])
  })

  it('aborts a send() that does not settle and moves on in the next run (#045)', async () => {
    const signals: AbortSignal[] = []
    let hang = true
    init({
      namespace: freshNamespace(),
      workerUrl,
      upload: {
        send(_file, meta) {
          signals.push(meta.signal)
          if (hang) {
            hang = false
            return new Promise(() => {}) // never settles
          }
          return Promise.resolve()
        },
        intervalMs: 200,
        timeoutMs: 300,
      },
    })
    await makePending(1)
    await expect.poll(() => signals[0]?.aborted, { timeout: 5000 }).toBe(true)
    // the lock was released, so the next run sends it
    await expect.poll(() => names('pending'), { timeout: 5000 }).toEqual([])
    expect(signals.length).toBeGreaterThanOrEqual(2)
  })

  it('does not upload while another tab holds the upload lock (#022)', async () => {
    let calls = 0
    let release = (): void => {}
    freshNamespace()
    await new Promise<void>((granted) => {
      void navigator.locks.request(`opfslogd:${ns}:upload`, () => {
        granted()
        return new Promise<void>((r) => (release = r))
      })
    })
    init({
      namespace: ns,
      workerUrl,
      upload: {
        async send() {
          calls++
        },
        intervalMs: 200,
      },
    })
    await makePending(1)
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls).toBe(0)
    release()
    await expect.poll(() => calls, { timeout: 5000 }).toBe(1)
  })

  it('reports a pending file in a newer format once and uploads the rest (#013, #040)', async () => {
    freshNamespace()
    const opfs = await navigator.storage.getDirectory()
    const nsDir = await (await opfs.getDirectoryHandle('opfslogd', { create: true })).getDirectoryHandle(ns, { create: true })
    const pending = await nsDir.getDirectoryHandle('pending', { create: true })
    const newer = closedName(Date.now() - 5000, Date.now() - 4000, 'newertab')
    const w = await (await pending.getFileHandle(newer, { create: true })).createWritable()
    await w.write('{"format":9,"minReader":9,"tab":"newertab","seq0":0,"context":{}}\nbinary\n')
    await w.close()

    const errors: OpfslogdError[] = []
    const sent: string[] = []
    init({
      namespace: ns,
      workerUrl,
      onError: (e) => errors.push(e),
      upload: {
        async send(_file, meta) {
          sent.push(meta.segmentId)
        },
        intervalMs: 200,
      },
    })
    await makePending(1)
    await expect.poll(() => sent.length, { timeout: 5000 }).toBe(1)
    await new Promise((r) => setTimeout(r, 600)) // a few more runs
    expect(errors.map((e) => e.code)).toEqual(['unreadable-file'])
    expect(await names('pending')).toEqual([newer])
  })

  it('reports an upload option without send() (#073)', () => {
    const errors: OpfslogdError[] = []
    init({
      namespace: freshNamespace(),
      workerUrl,
      upload: { intervalMs: 1000 } as never,
      onError: (e) => errors.push(e),
    })
    expect(errors.map((e) => e.code)).toEqual(['invalid-option'])
  })
})
