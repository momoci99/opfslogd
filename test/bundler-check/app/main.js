// Uses the built package the way an app would, then reads the record back from OPFS.
// Same check as test/vite-dev/real-app/main.js. entry.js runs it on load; the Next.js page
// (next-app/app/check.js) calls run() after hydration.
import { flush, init, logger } from 'opfslogd'

const NS = 'bundler-check'

export async function run() {
  const errors = []
  // ?workerUrl=... : the app copied worker.js itself and passes its URL (README, #009, #081)
  const workerUrl = new URLSearchParams(location.search).get('workerUrl') ?? undefined
  init({ namespace: NS, workerUrl, onError: (e) => errors.push(e.code) })
  logger.info('hello from a bundler')
  const flushed = await flush(10_000)
  if (errors.length) return { ok: false, error: errors.join(',') }
  const opfs = await navigator.storage.getDirectory()
  const active = await (await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(NS)).getDirectoryHandle('active')
  let text = ''
  for await (const [, handle] of active.entries()) text += await (await handle.getFile()).text()
  const found = text.includes('hello from a bundler')
  return { ok: flushed && found, error: found ? undefined : 'record missing' }
}
