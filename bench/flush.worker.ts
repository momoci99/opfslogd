// Bench worker: the library worker, with handle.flush() after every sync handle write.
// Measures the cost #074 avoids.

import '../src/worker'

type WriteFn = (this: { flush(): void }, buffer: Uint8Array, options?: { at?: number }) => number

const proto: { write: WriteFn } = (
  self as unknown as { FileSystemSyncAccessHandle: { prototype: { write: WriteFn } } }
).FileSystemSyncAccessHandle.prototype
const write: WriteFn = proto.write

proto.write = function (buffer, options) {
  const n = write.call(this, buffer, options)
  this.flush()
  return n
}
