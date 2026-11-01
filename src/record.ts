// Turns one log() call into one JSON line (#011, #014, #016, #024-#027).

export type Level = 'debug' | 'info' | 'warn' | 'error'

/** Levels of `cause` stored below the top error (#026). */
const MAX_CAUSE_DEPTH = 5

/** Error fields that win over the error's own properties of the same name (#027). */
const FIXED_ERR_KEYS = new Set(['name', 'message', 'stack', 'cause'])

/**
 * Serializes one record to a JSON line without the trailing newline.
 * Key order is ts, lv, msg, ctx, err so every line starts with ts and lv (#016).
 * Never throws (#011).
 */
export function serializeRecord(ts: number, lv: Level, msg: unknown, ctx?: unknown): string {
  try {
    const m = typeof msg === 'string' ? msg : safeString(msg)
    let c: unknown = ctx
    let err: Record<string, unknown> | undefined

    if (ctx instanceof Error) {
      // logger.error('x', e): the error itself, no ctx (#025)
      err = errorToJson(ctx, new Set(), MAX_CAUSE_DEPTH)
      c = undefined
    } else if (typeof ctx === 'object' && ctx !== null && (ctx as { err?: unknown }).err instanceof Error) {
      // { err: e, ...rest }: copy so the caller's object is not changed (#025)
      const { err: e, ...rest } = ctx as { err: Error }
      err = errorToJson(e, new Set(), MAX_CAUSE_DEPTH)
      c = Object.keys(rest).length > 0 ? rest : undefined
    }

    try {
      return JSON.stringify({ ts, lv, msg: m, ctx: c, err })
    } catch (e) {
      // err is already safe; only ctx can fail here (#011)
      return JSON.stringify({ ts, lv, msg: m, ctx: unserializable(e), err })
    }
  } catch (e) {
    // A getter on ctx or on the error threw. Keep the line, lose the payload.
    return JSON.stringify({ ts, lv, msg: typeof msg === 'string' ? msg : '', ctx: unserializable(e) })
  }
}

function errorToJson(e: Error, seen: Set<Error>, causesLeft: number): Record<string, unknown> {
  seen.add(e)
  const out: Record<string, unknown> = {
    name: safeValue(e.name),
    message: safeValue(e.message),
    stack: safeValue(e.stack),
  }
  for (const key of Object.keys(e)) {
    if (!FIXED_ERR_KEYS.has(key)) out[key] = safeValue((e as unknown as Record<string, unknown>)[key])
  }
  const cause: unknown = e.cause
  if (cause instanceof Error) {
    // a cycle or the depth limit ends the chain (#026)
    if (!seen.has(cause) && causesLeft > 0) out.cause = errorToJson(cause, seen, causesLeft - 1)
  } else if (cause !== undefined) {
    out.cause = safeValue(cause)
  }
  return out
}

/** Returns the value if JSON.stringify accepts it, else the #011 placeholder. Used only on the error path. */
function safeValue(v: unknown): unknown {
  try {
    JSON.stringify(v)
    return v
  } catch (e) {
    return unserializable(e)
  }
}

function unserializable(e: unknown): { _unserializable: string } {
  let reason = 'unknown'
  try {
    reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  } catch {
    // keep 'unknown'
  }
  return { _unserializable: reason }
}

function safeString(v: unknown): string {
  try {
    return String(v)
  } catch {
    return ''
  }
}
