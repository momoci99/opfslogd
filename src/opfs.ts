// OPFS types missing from the DOM lib, and directory helpers. Worker-side only.

import { closedName } from './names'

/** FileSystemSyncAccessHandle; only in Dedicated Workers, so not in the DOM lib. */
export interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export interface WorkerFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
  move(dest: FileSystemDirectoryHandle, name: string): Promise<void>
}

export interface Dirs {
  active: FileSystemDirectoryHandle
  pending: FileSystemDirectoryHandle
  done: FileSystemDirectoryHandle
}

/** Opens (and creates) `{root}/{namespace}/{active,pending,done}` (#012, #034). */
export async function openDirs(root: string, namespace: string): Promise<Dirs> {
  const opfs = await navigator.storage.getDirectory()
  const top = await opfs.getDirectoryHandle(root, { create: true })
  const ns = await top.getDirectoryHandle(namespace, { create: true })
  const [active, pending, done] = await Promise.all([
    ns.getDirectoryHandle('active', { create: true }),
    ns.getDirectoryHandle('pending', { create: true }),
    ns.getDirectoryHandle('done', { create: true }),
  ])
  return { active, pending, done }
}

/**
 * The closed name (#012, #067), or the same name with `maxTs` raised by 1ms per clash.
 * Two segments of one tab clash only when all their records share one millisecond;
 * moving onto an existing name would replace that file (#075).
 */
export async function freeName(dir: FileSystemDirectoryHandle, minTs: number, maxTs: number, tabId: string): Promise<string> {
  for (let end = maxTs; ; end++) {
    const name = closedName(minTs, end, tabId)
    try {
      await dir.getFileHandle(name)
    } catch {
      return name
    }
  }
}
