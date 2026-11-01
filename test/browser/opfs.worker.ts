// Test worker: runs OPFS operations on request, the way the library's worker will.
// One sync access handle at a time, kept open until `close`.

import type { Request, Response } from './opfs-worker-client'

interface SyncHandle {
  write(buffer: BufferSource, options?: { at?: number }): number
  flush(): void
  close(): void
}

interface MovableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>
  move(dest: FileSystemDirectoryHandle, name: string): Promise<void>
}

let open: SyncHandle | undefined

async function dirAt(path: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const name of path) dir = await dir.getDirectoryHandle(name, { create: true })
  return dir
}

async function fileAt(path: string[], name: string, create = false): Promise<MovableFileHandle> {
  const dir = await dirAt(path)
  return (await dir.getFileHandle(name, { create })) as MovableFileHandle
}

async function run(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'openAndWrite': {
      const file = await fileAt(req.dir, req.name, true)
      open = await file.createSyncAccessHandle()
      open.write(new TextEncoder().encode(req.text), { at: 0 })
      open.flush()
      return undefined
    }
    case 'close': {
      open?.close()
      open = undefined
      return undefined
    }
    case 'move': {
      const file = await fileAt(req.fromDir, req.name)
      await file.move(await dirAt(req.toDir), req.name)
      return undefined
    }
    case 'read': {
      const file = await fileAt(req.dir, req.name)
      return await (await file.getFile()).text()
    }
    case 'exists': {
      try {
        await fileAt(req.dir, req.name)
        return true
      } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return false
        throw e
      }
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>): Promise<void> => {
  const req = event.data
  let res: Response
  try {
    res = { id: req.id, ok: true, value: await run(req) }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    res = { id: req.id, ok: false, name: err.name, message: `${req.op}: ${err.message}` }
  }
  self.postMessage(res)
}
