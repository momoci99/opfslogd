// Messages between the main thread and the worker (#018, #031, #064). Internal, not public API.

import type { WriteFailReason } from './queue'
import type { RetentionDrops } from './retention'

export type ToWorker =
  | {
      type: 'init'
      namespace: string
      tabId: string
      /** Global context, already serialized (#031). */
      context: string
      /** Rotate a non-empty active segment after this long (#021, #036). */
      rotateMaxAgeMs: number
      /** Rotate once the active segment reaches this many bytes (#066). */
      rotateMaxBytes: number
      /** Closed segments go to `pending/` when true, `done/` when false (#068). */
      upload: boolean
      retentionMaxBytes: number
      retentionMaxAgeMs: number
      /** OPFS directory under the root. Tests override it; always 'opfslogd' otherwise. */
      root: string
    }
  | {
      type: 'write'
      id: number
      /** UTF-8 bytes of the batch; only the first `length` bytes are used. */
      buf: ArrayBuffer
      length: number
      /** Number of lines in the batch (#064). */
      lines: number
      minTs: number
      maxTs: number
    }
  /** New global context: the next segment carries it (#031). */
  | { type: 'context'; context: string }
  /** Move the active segment out of `active/`, release the tab lock, and stop (#030). */
  | { type: 'close' }
  /** Run retention if no other tab is running it (#022, #053). */
  | { type: 'maintain' }
  /** Upload steps, asked by the main thread while it holds the upload lock (#007). */
  | { type: 'call'; id: number; call: WorkerCall }

export type WorkerCall =
  | { op: 'list-pending' }
  | { op: 'prepare'; name: string }
  | { op: 'mark-done'; name: string }
  | { op: 'export'; from?: number; to?: number }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'ack'; id: number; ok: true }
  | { type: 'ack'; id: number; ok: false; reason: WriteFailReason }
  | { type: 'closed' }
  /** A maintenance run ended; `ran` is false when another tab held the lock. */
  | { type: 'maintained'; ran: boolean; dropped?: RetentionDrops }
  /** Answer to a `call`: string[] for list-pending, Prepared for prepare, boolean for mark-done, ExportResult for export. */
  | { type: 'reply'; id: number; value: unknown }
  /** Storage could not start (#041). */
  | { type: 'fatal'; code: 'opfs-unavailable'; name: string; message: string }
