// subscribe() against a real worker (step 8, unit 6; #023, #042, #043).

import { afterEach, expect, it, vi } from 'vitest'
import { close, flush, init, logger, setContext, subscribe, type LogRecord } from '../../src/index'
import { DROP_MSG } from '../../src/queue'

const workerUrl = new URL('../../src/worker.ts', import.meta.url)
let ns = ''

function start(context?: Record<string, unknown>): void {
  ns = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  init({ namespace: ns, workerUrl, context })
}

afterEach(async () => {
  await close()
  const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd', { create: true })
  await top.removeEntry(ns, { recursive: true }).catch(() => {})
})

it('delivers each flush as parsed records in the exported shape (#042)', async () => {
  const batches: LogRecord[][] = []
  subscribe((records) => batches.push(records))
  start({ version: '2.3.1' })
  logger.info('a', { k: 1 })
  logger.error('b', new Error('x'))
  await flush()
  logger.warn('c')
  await flush()

  expect(batches).toHaveLength(2)
  const all = batches.flat()
  expect(all.map((r) => [r.msg, r.seq])).toEqual([
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ])
  expect(all[0]).toMatchObject({ lv: 'info', ctx: { k: 1 }, context: { version: '2.3.1' } })
  expect(all[0]?.tab).toMatch(/^[0-9a-z]{8}$/)
  expect(all[1]?.err).toMatchObject({ name: 'Error', message: 'x' })
})

it('leaves out an empty context and follows setContext (#031, #071)', async () => {
  const records: LogRecord[] = []
  subscribe((rs) => records.push(...rs))
  start()
  logger.info('anon')
  setContext({ userId: 'u42' })
  logger.info('known')
  await flush()
  expect(records[0]).not.toHaveProperty('context')
  expect(records[1]).toMatchObject({ msg: 'known', context: { userId: 'u42' } })
})

it('passes the same array to every subscriber and isolates a throwing one (#023)', async () => {
  const seen: LogRecord[][] = []
  subscribe(() => {
    throw new Error('subscriber bug')
  })
  subscribe((rs) => seen.push(rs))
  subscribe((rs) => seen.push(rs))
  start()
  logger.info('x')
  expect(await flush()).toBe(true)
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
})

it('includes drop lines (#019, #044)', async () => {
  const records: LogRecord[] = []
  subscribe((rs) => records.push(...rs))
  start()
  // one task with more than the 80% limit (about 17,000 medium records)
  for (let i = 0; i < 25_000; i++) logger.info('flood', { userId: `u_${i}`, total: 129.99, path: '/checkout/payment', pad: 'x'.repeat(60) })
  await flush(30_000)
  const drop = records.find((r) => r.msg === DROP_MSG)
  expect(drop).toMatchObject({ lv: 'warn', ctx: { reason: 'overload' } })
  // seq has no gaps across batches
  expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i))
})

it('stops after unsubscribe; calling it twice is safe (#043)', async () => {
  const fn = vi.fn()
  const off = subscribe(fn)
  start()
  logger.info('a')
  await flush()
  off()
  off()
  logger.info('b')
  await flush()
  expect(fn).toHaveBeenCalledTimes(1)
})

it('close() removes all subscribers (#043)', async () => {
  const fn = vi.fn()
  subscribe(fn)
  start()
  logger.info('last')
  await close()
  expect(fn).toHaveBeenCalledTimes(1) // the final flush of close()
  start()
  logger.info('next run')
  await flush()
  expect(fn).toHaveBeenCalledTimes(1)
})
