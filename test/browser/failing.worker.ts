// Test worker: the library worker, with sync handle writes that can be made to fail.
// { type: 'test-fail', name, skip } lets `skip` writes pass, then makes the next one
// store half its bytes and throw a DOMException with that name. With name 'short', it
// stores half and returns a wrong count instead, as Chromium does when storage is full.

import '../../src/worker'

type WriteFn = (this: unknown, buffer: Uint8Array, options?: { at?: number }) => number

const proto: { write: WriteFn } = (
  self as unknown as { FileSystemSyncAccessHandle: { prototype: { write: WriteFn } } }
).FileSystemSyncAccessHandle.prototype
const write: WriteFn = proto.write
let fail: { name: string; skip: number } | undefined

proto.write = function (buffer, options) {
  if (!fail || fail.skip-- > 0) return write.call(this, buffer, options)
  const { name } = fail
  fail = undefined
  write.call(this, buffer.subarray(0, Math.floor(buffer.length / 2)), options)
  if (name === 'short') return 4294967288
  throw new DOMException('test failure', name)
}

self.addEventListener('message', (e: MessageEvent<{ type: string; name: string; skip?: number }>) => {
  if (e.data.type === 'test-fail') fail = { name: e.data.name, skip: e.data.skip ?? 0 }
})
