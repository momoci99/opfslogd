// Public API (docs/design/api.html). Everything exported here is public.

import { Core, type InitOptions, type Subscriber } from './core'
import type { Level } from './record'

export type { InitOptions, LogRecord, Subscriber } from './core'
export { OpfslogdError, type OpfslogdErrorCode } from './errors'
export type { Level } from './record'

const core = new Core()

export interface Logger {
  /**
   * `ctx` is stored as the record's `ctx`. Pass an error as `{ err: e }` or as `ctx` itself;
   * an Error deeper inside `ctx` is stored as `{}` (#024, #025).
   */
  debug(msg: string, ctx?: object): void
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

function method(lv: Level): (msg: string, ctx?: object) => void {
  return (msg, ctx) => core.log(lv, msg, ctx)
}

/** The logger. Records logged before `init()` wait in memory (#028). Never throws. */
export const logger: Logger = {
  debug: method('debug'),
  info: method('info'),
  warn: method('warn'),
  error: method('error'),
}

/** Starts storage. Call once at the app's entry point; later calls are ignored (#029). */
export function init(options?: InitOptions): void {
  core.init(options)
}

/** Shallow-merges into the global context; `undefined` removes a key (#032). */
export function setContext(partial: Record<string, unknown>): void {
  core.setContext(partial)
}

/**
 * Writes what is queued. Resolves `true` once it is on disk, `false` after `timeoutMs`
 * (default 5s) or if a write failed. Never rejects (#038).
 */
export function flush(timeoutMs?: number): Promise<boolean> {
  return core.flush(timeoutMs)
}

/** Writes what is queued, closes the current segment, and stops logging (#030). */
export function close(): Promise<void> {
  return core.close()
}

/**
 * Calls `fn` at each flush with the records written in it, in the exported shape, drop
 * lines included. For debugging: in-app log panels, console output during development,
 * tests. Use `upload` to send logs to a server. Returns a function that unsubscribes.
 * (#023, #042, #043)
 */
export function subscribe(fn: Subscriber): () => void {
  return core.subscribe(fn)
}
