// Messages between the main thread and the worker (#018, #031, #064). Internal, not public API.

import type { WriteFailReason } from './queue'

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

export type FromWorker =
  | { type: 'ready' }
  | { type: 'ack'; id: number; ok: true }
  | { type: 'ack'; id: number; ok: false; reason: WriteFailReason }
  | { type: 'closed' }
  /** Storage could not start (#041). */
  | { type: 'fatal'; code: 'opfs-unavailable'; name: string; message: string }
