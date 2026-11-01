// Errors reported to the app through init({ onError }) (#040, #064, #073).

export type OpfslogdErrorCode =
  | 'opfs-unavailable'
  | 'worker-load-failed'
  | 'quota-exceeded'
  | 'write-failed'
  | 'worker-unresponsive'
  | 'unreadable-file'
  | 'invalid-option'

/** An internal problem of the logger. The library never throws it into app code. */
export class OpfslogdError extends Error {
  override name = 'OpfslogdError'
  /** Stable code to branch on. New codes may be added in minor versions. */
  readonly code: OpfslogdErrorCode

  constructor(code: OpfslogdErrorCode, message: string, options?: { cause?: unknown }) {
    super(`opfslogd: ${message}`, options)
    this.code = code
  }
}

/**
 * Sends errors to `onError`, or prints each code once with console.error when there is
 * no handler (#040). A throwing handler is ignored.
 */
export class ErrorReporter {
  private handler: ((err: OpfslogdError) => void) | undefined
  private readonly printed = new Set<OpfslogdErrorCode>()

  setHandler(handler: ((err: OpfslogdError) => void) | undefined): void {
    this.handler = handler
  }

  report(err: OpfslogdError): void {
    const handler = this.handler
    if (handler) {
      try {
        handler(err)
      } catch {
        // the app's handler must not break logging
      }
      return
    }
    if (this.printed.has(err.code)) return
    this.printed.add(err.code)
    console.error(err)
  }
}
