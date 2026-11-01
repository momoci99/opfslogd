// Main-thread side of opfs.worker.ts.

type Op =
  | { op: 'openAndWrite'; dir: string[]; name: string; text: string }
  | { op: 'close' }
  | { op: 'move'; fromDir: string[]; toDir: string[]; name: string }
  | { op: 'read'; dir: string[]; name: string }
  | { op: 'exists'; dir: string[]; name: string }

export type Request = Op & { id: number }

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; name: string; message: string }

/** Error thrown inside the worker, with its DOMException name kept. */
export class WorkerError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

export interface OpfsWorker {
  call(op: Op): Promise<unknown>
  terminate(): void
}

export function startOpfsWorker(): OpfsWorker {
  const worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, (res: Response) => void>()
  let nextId = 0

  worker.onmessage = (event: MessageEvent<Response>): void => {
    waiting.get(event.data.id)?.(event.data)
    waiting.delete(event.data.id)
  }

  return {
    call(op: Op): Promise<unknown> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        waiting.set(id, (res) => {
          if (res.ok) resolve(res.value)
          else reject(new WorkerError(res.name, res.message))
        })
        worker.postMessage({ ...op, id })
      })
    },
    terminate(): void {
      worker.terminate()
    },
  }
}

/** A fresh OPFS directory name per test, removed with `removeRoot`. */
export function uniqueRoot(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function removeRoot(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory()
  await root.removeEntry(name, { recursive: true }).catch(() => {})
}
