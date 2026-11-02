// Same load as test/storage-check/lib-page.js (5,000 records/s), but the logged count goes to
// the check server, since localStorage may lose its last writes when the whole app is killed.
//   ?mode=log&ns=X     log continuously until the page dies
//   ?mode=count&ns=X   count records on disk, compare with the logged count, clean up
import { init, logger } from '/dist/index.js'

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
const NS = params.get('ns') ?? 'check'
const out = document.getElementById('out')
const events = []
for (const type of ['visibilitychange', 'pagehide', 'freeze', 'resume', 'pageshow']) {
  ;(type === 'pagehide' || type === 'pageshow' ? window : document).addEventListener(type, () => {
    const e = `${type}${type === 'visibilitychange' ? ':' + document.visibilityState : ''}@${Math.round(performance.now())}`
    events.push(e)
    // DevTools keeps a page visible, so lifecycle runs detach it; events go to the server instead
    if (mode === 'log') fetch(`/event?ns=${NS}&e=${encodeURIComponent(e)}`, { method: 'POST', keepalive: true }).catch(() => {})
  })
}
window.__events = events

async function logContinuously() {
  const { start } = await (await fetch(`/start?ns=${NS}`, { method: 'POST' })).json()
  if (!start) {
    out.textContent = `restored tab, not logging (${NS})`
    return { restored: true }
  }
  init({ namespace: NS })
  let n = 0
  setInterval(() => {
    // Report the count before logging, with a synchronous request, so the server never has
    // fewer than were logged when the app dies (an async fetch can die before the records do).
    // The count can be up to 50 too high, if the app dies between the report and the loop.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/report?ns=${NS}&n=${n + 50}`, false)
    xhr.send()
    for (let i = 0; i < 50; i++) logger.info(`r${n++}`, { pad: 'x'.repeat(100) })
    out.textContent = `logging ${NS}: ${n}`
  }, 10)
  return { started: true }
}

async function count() {
  const { logged, events: logEvents } = await (await fetch(`/logged?ns=${NS}`)).json()
  const opfs = await navigator.storage.getDirectory()
  const root = await opfs.getDirectoryHandle('opfslogd')
  const ns = await root.getDirectoryHandle(NS)
  const seen = new Set()
  let partial = 0
  for (const state of ['active', 'pending', 'done']) {
    const dir = await ns.getDirectoryHandle(state)
    for await (const [, handle] of dir.entries()) {
      const text = await (await handle.getFile()).text()
      if (text && !text.endsWith('\n')) partial++
      for (const line of text.split('\n')) {
        const m = line.startsWith('{"ts":') && line.match(/"msg":"r(\d+)"/)
        if (m) seen.add(Number(m[1]))
      }
    }
  }
  let max = -1
  for (const i of seen) if (i > max) max = i
  // gaps below the highest record would mean a lost batch in the middle, not just the tail
  const gaps = max + 1 - seen.size
  await root.removeEntry(NS, { recursive: true }).catch(() => {})
  const r = { logged, onDisk: seen.size, lost: logged - seen.size, gaps, partial, events: logEvents }
  out.textContent = JSON.stringify(r)
  return r
}

window.__result = ({ log: logContinuously, count }[mode] ?? (() => Promise.resolve({ error: 'mode?' })))().catch((e) => ({
  error: `${e.name}: ${e.message}`,
}))
