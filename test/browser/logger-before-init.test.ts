// The before-init() state exists only once per page, before the first init() (#028, #030).
// Its own file, so Vitest gives it a fresh module.

import { afterAll, expect, it } from 'vitest'
import { close, flush, init, logger } from '../../src/index'

const ns = `t-${Date.now().toString(36)}-early`

afterAll(async () => {
  await close()
  const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('opfslogd', { create: true })
  await top.removeEntry(ns, { recursive: true }).catch(() => {})
})

it('keeps records logged before init() and writes them after (#028, #038)', async () => {
  logger.info('early 1')
  logger.error('early 2')
  const done = flush()
  init({ namespace: ns, workerUrl: new URL('../../src/worker.ts', import.meta.url) })
  expect(await done).toBe(true)

  const opfs = await navigator.storage.getDirectory()
  const active = await (await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(ns)).getDirectoryHandle('active')
  const texts: string[] = []
  for await (const [, handle] of active.entries()) texts.push(await (await (handle as FileSystemFileHandle).getFile()).text())
  const msgs = texts
    .join('')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as { msg?: string })
    .flatMap((r) => (r.msg ? [r.msg] : []))
  expect(msgs).toEqual(['early 1', 'early 2'])
})
