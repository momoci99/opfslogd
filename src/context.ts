// Global context: shallow merge and serialization (#031, #032).

export type Context = Record<string, unknown>

/**
 * Merges `partial` into `current` at the top level; `undefined` removes a key (#032).
 * Returns a new object; neither argument is changed.
 */
export function mergeContext(current: Context, partial: unknown): Context {
  const next: Context = { ...current }
  if (typeof partial !== 'object' || partial === null) return next
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Serializes a context for the segment header; never throws (#011, #014). */
export function serializeContext(context: Context): string {
  try {
    const json = JSON.stringify(context)
    if (json !== undefined) return json
  } catch (e) {
    let reason = 'unknown'
    try {
      reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    } catch {
      // keep 'unknown'
    }
    return JSON.stringify({ _unserializable: reason })
  }
  return '{}'
}
