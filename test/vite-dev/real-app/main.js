// Uses the built package (dist/) the way an app would, then reads the file back.
import { flush, init, logger } from 'opfslogd'

const NS = 'vite-check'

async function run() {
  const errors = []
  init({ namespace: NS, onError: (e) => errors.push(e.code) })
  logger.info('hello from vite')
  const flushed = await flush(10_000)
  if (errors.length) return { ok: false, error: errors.join(',') }
  const opfs = await navigator.storage.getDirectory()
  const active = await (await (await opfs.getDirectoryHandle('opfslogd')).getDirectoryHandle(NS)).getDirectoryHandle('active')
  let text = ''
  for await (const [, handle] of active.entries()) text += await (await handle.getFile()).text()
  const found = text.includes('hello from vite')
  return { ok: flushed && found, opfs: found ? 'ok' : 'record missing' }
}

window.__result = run().catch((e) => ({ ok: false, error: String(e) }))
