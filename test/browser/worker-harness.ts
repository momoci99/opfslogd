// Talks to the library worker directly with protocol messages, against real OPFS.
// Shared by the worker-level browser tests.

import { afterEach, expect } from 'vitest'
import { newTabId } from '../../src/names'
import type { FromWorker, ToWorker } from '../../src/protocol'
import { serializeRecord, type Level } from '../../src/record'
import { removeRoot, uniqueRoot } from './opfs-worker-client'

export const NS = 'test'

export type Init = Extract<ToWorker, { type: 'init' }>

export interface Harness {
  root: string
  tabId: string
  send(msg: ToWorker, transfer?: Transferable[]): void
  next(type: FromWorker['type']): Promise<FromWorker>
  /** Sends one batch of records and waits for its ack. */
  write(records: [number, Level, string][]): Promise<FromWorker>
  stop(): void
}

const running: Harness[] = []

afterEach(async () => {
  for (const h of running.splice(0)) {
    h.stop()
    await removeRoot(h.root)
  }
})

export async function start(opts: Partial<Init> = {}, failing = false): Promise<Harness> {
  const root = uniqueRoot()
  const tabId = newTabId()
  // the root is fixed per harness; a second start() on the same root shares its files
  const worker = failing
    ? new Worker(new URL('./failing.worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('../../src/worker.ts', import.meta.url), { type: 'module' })
  const inbox: FromWorker[] = []
  const waiters: { type: string; resolve: (m: FromWorker) => void }[] = []
  worker.onmessage = (e: MessageEvent<FromWorker>): void => {
    const i = waiters.findIndex((w) => w.type === e.data.type)
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(e.data)
    else inbox.push(e.data)
  }
  let nextId = 1
  const h: Harness = {
    root,
    tabId,
    send: (msg, transfer = []) => worker.postMessage(msg, transfer),
    next: (type) => {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0] as FromWorker)
      return new Promise((resolve) => waiters.push({ type, resolve }))
    },
    write: (records) => {
      const text = records.map(([ts, lv, msg]) => serializeRecord(ts, lv, msg)).join('\n') + '\n'
      const bytes = new TextEncoder().encode(text)
      const tss = records.map((r) => r[0])
      h.send(
        {
          type: 'write',
          id: nextId++,
          buf: bytes.buffer,
          length: bytes.length,
          lines: records.length,
          minTs: Math.min(...tss),
          maxTs: Math.max(...tss),
        },
        [bytes.buffer],
      )
      return h.next('ack')
    },
    stop: () => worker.terminate(),
  }
  running.push(h)
  h.send({
    type: 'init',
    namespace: NS,
    tabId,
    context: '{}',
    rotateMaxAgeMs: 300_000,
    rotateMaxBytes: 2_000_000,
    upload: false,
    retentionMaxBytes: 50_000_000,
    retentionMaxAgeMs: 7 * 86_400_000,
    root,
    ...opts,
  })
  expect(await h.next('ready')).toEqual({ type: 'ready' })
  return h
}

export async function dir(h: Harness, state: 'active' | 'pending' | 'done'): Promise<FileSystemDirectoryHandle> {
  const opfs = await navigator.storage.getDirectory()
  const top = await opfs.getDirectoryHandle(h.root)
  const ns = await top.getDirectoryHandle(NS)
  return ns.getDirectoryHandle(state)
}

export async function list(h: Harness, state: 'active' | 'pending' | 'done'): Promise<string[]> {
  const names: string[] = []
  for await (const name of (await dir(h, state)).keys()) names.push(name)
  return names.sort()
}

export async function read(h: Harness, state: 'active' | 'pending' | 'done', name: string): Promise<string[]> {
  const file = await (await dir(h, state)).getFileHandle(name)
  return (await (await file.getFile()).text()).trimEnd().split('\n')
}

export function header(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? '') as Record<string, unknown>
}

