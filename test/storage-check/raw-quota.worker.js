// Writes 256KB chunks with a sync access handle until a write throws, and reports
// whether the failed write left part of its data in the file (#064).

const opfs = await navigator.storage.getDirectory()
const dir = await opfs.getDirectoryHandle('opfslogd-check-raw', { create: true })
const file = await dir.getFileHandle('fill.bin', { create: true })
const handle = await file.createSyncAccessHandle()
const chunk = new Uint8Array(256 * 1024).fill(0x61)
let offset = 0
let result
for (let i = 0; i < 4000; i++) {
  try {
    const n = handle.write(chunk, { at: offset })
    if (n !== chunk.length) {
      result = { kind: 'short write', offsetBefore: offset, returned: n, sizeAfter: handle.getSize() }
      break
    }
    offset += n
  } catch (e) {
    result = { kind: 'threw', name: e.name, offsetBefore: offset, sizeAfter: handle.getSize() }
    break
  }
}
handle.close()
await opfs.removeEntry('opfslogd-check-raw', { recursive: true })
self.postMessage(result ?? { kind: 'no error', offset })
