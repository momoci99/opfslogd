// The measurements from docs/design/benchmark.html#speed that need no library code.

import { type Result, measure, measureSync } from './harness'

// Records in the stored shape (#011). Three sizes; the medium one is the main case.
const BASE_TS = 1_730_000_000_000

function small(i: number): object {
  return { ts: BASE_TS + i, lv: 'info', msg: 'page view' }
}

function medium(i: number): object {
  return {
    ts: BASE_TS + i,
    lv: 'info',
    msg: 'checkout button clicked',
    ctx: { userId: `u_${48213 + (i % 100)}`, cartItems: 3, total: 129.99, path: '/checkout/payment', experiments: ['new-cta', 'fast-pay'] },
  }
}

function large(i: number): object {
  return {
    ts: BASE_TS + i,
    lv: 'warn',
    msg: 'cart sync returned partial data',
    ctx: {
      userId: `u_${48213 + (i % 100)}`,
      requestId: `req_${(i * 7919).toString(36)}`,
      items: Array.from({ length: 10 }, (_, k) => ({ sku: `SKU-${1000 + k}`, name: `Product number ${k}`, qty: k + 1, price: 9.99 + k })),
    },
  }
}

const POOL = 1024
const pools = {
  small: Array.from({ length: POOL }, (_, i) => small(i)),
  medium: Array.from({ length: POOL }, (_, i) => medium(i)),
  large: Array.from({ length: POOL }, (_, i) => large(i)),
}

// Batch sizes for one flush: 200ms at 10k/s (sustained target) and at 100k/s (burst target).
const BATCHES = [2_000, 20_000]

export interface Row extends Result {
  group: string
  note?: string
}

export async function runAll(log: (row: Row) => void): Promise<Row[]> {
  const rows: Row[] = []
  const add = (group: string, r: Result, note?: string): void => {
    const row = { group, ...r, note }
    rows.push(row)
    log(row)
  }
  const yieldToPage = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  // 1. JSON.stringify of one record (#014). Target: a few µs per log() call.
  for (const [size, pool] of Object.entries(pools)) {
    const bytes = new TextEncoder().encode(JSON.stringify(pool[0])).length
    let i = 0
    add('1. stringify', measureSync(`stringify ${size} record`, () => JSON.stringify(pool[i++ & (POOL - 1)])), `${bytes} bytes`)
    await yieldToPage()
  }

  // 2. Keep strings and encode once at flush, vs encodeInto on every call (#014, #015).
  const lines = pools.medium.map((r) => `${JSON.stringify(r)}\n`)
  const encoder = new TextEncoder()
  const buffer = new Uint8Array(16 * 1024 * 1024)
  for (const n of BATCHES) {
    add('2. buffer', measureSync(`strings: push x${n}`, () => {
      const queue: string[] = []
      for (let k = 0; k < n; k++) queue.push(lines[k & (POOL - 1)] as string)
      return queue
    }))
    const queue = Array.from({ length: n }, (_, k) => lines[k & (POOL - 1)] as string)
    add('2. buffer', measureSync(`strings: flush (join + encode) x${n}`, () => encoder.encode(queue.join(''))))
    add('2. buffer', measureSync(`encodeInto: x${n} calls`, () => {
      let at = 0
      for (let k = 0; k < n; k++) at += encoder.encodeInto(lines[k & (POOL - 1)] as string, buffer.subarray(at)).written
      return at
    }))
    let filled = 0
    for (let k = 0; k < n; k++) filled += encoder.encodeInto(lines[k & (POOL - 1)] as string, buffer.subarray(filled)).written
    add('2. buffer', measureSync(`encodeInto: flush (copy out) x${n}`, () => buffer.slice(0, filled)), `${(filled / 1024).toFixed(0)} KB`)
    await yieldToPage()
  }

  // 3. JSON.parse of one flush batch for subscribers (#042). Burst batch: 20,000 lines.
  const batch = Array.from({ length: 20_000 }, (_, k) => lines[k & (POOL - 1)] as string)
  add('3. parse', measureSync('parse x20000, one JSON.parse per line', () => batch.map((l) => JSON.parse(l))))
  add('3. parse', measureSync('parse x20000, one JSON.parse of "[" + join(",") + "]"', () => JSON.parse(`[${batch.join(',')}]`)))
  await yieldToPage()

  // 4. Scan an 8MB segment by the leading ts string, without parsing (#016, #055).
  const header = `${JSON.stringify({ v: 1, tab: 'tab-1', seq: 0, context: { app: 'bench' } })}\n`
  const parts = [header]
  let size = header.length
  let count = 0
  while (size < 8 * 1024 * 1024) {
    const line = `${JSON.stringify(medium(count++))}\n`
    parts.push(line)
    size += line.length
  }
  const blob = new Blob(parts, { type: 'application/x-ndjson' })
  const text = await blob.text()
  // Keep the middle half of the time range.
  const from = String(BASE_TS + Math.floor(count / 4))
  const to = String(BASE_TS + Math.floor((count * 3) / 4))
  const scan = (s: string): number => {
    let matched = 0
    let start = s.indexOf('\n') + 1 // skip the header line
    while (start < s.length) {
      let end = s.indexOf('\n', start)
      if (end === -1) end = s.length
      // Lines start with {"ts":<13 digits> (#016).
      const ts = s.slice(start + 6, start + 19)
      if (ts >= from && ts <= to) matched++
      start = end + 1
    }
    return matched
  }
  const note = `${(blob.size / 1024 / 1024).toFixed(1)} MB, ${count} lines`
  add('4. scan', await measure('8MB: Blob.text()', () => blob.text()), note)
  add('4. scan', measureSync('8MB: scan lines by ts (string already decoded)', () => scan(text)), note)
  add('4. scan', await measure('8MB: Blob.text() + scan', async () => scan(await blob.text())), note)

  return rows
}
