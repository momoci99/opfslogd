// Holds one sync access handle open, like the library's worker holds its active segment.

let handle
let size = 0
const encoder = new TextEncoder()

function append(text) {
  size += handle.write(encoder.encode(text), { at: size })
  handle.flush()
}

self.onmessage = async (event) => {
  try {
    const { op } = event.data
    if (op === 'ping') {
      self.postMessage({ ok: true })
    } else if (op === 'open') {
      const root = await navigator.storage.getDirectory()
      const file = await root.getFileHandle(`bfcache-check-${Date.now()}.jsonl`, { create: true })
      handle = await file.createSyncAccessHandle()
      append('before navigation\n')
      self.postMessage({ ok: true, size })
    } else if (op === 'write') {
      append('after back\n')
      self.postMessage({ ok: true, size })
    }
  } catch (e) {
    self.postMessage({ ok: false, error: `${e.name}: ${e.message}` })
  }
}
