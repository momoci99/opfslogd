// Small timing harness. Vitest's `bench` does not run in browser mode, and this page
// must also open on phones (docs/design/benchmark.html).

export interface Result {
  name: string
  /** Median time per call, in microseconds. */
  medianUs: number
  /** Fastest sample, per call, in microseconds. */
  minUs: number
  /** Calls per sample. */
  calls: number
}

// Keeps results alive so engines cannot drop the measured work.
export const sink: { value: unknown } = { value: undefined }

const SAMPLE_MS = 50
const SAMPLES = 15

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/**
 * Runs `fn` in samples of about 50ms each (timers in browsers can be as coarse as 1ms)
 * and reports the time per call.
 */
export async function measure(name: string, fn: () => unknown | Promise<unknown>): Promise<Result> {
  // Warm up and find how many calls fill one sample.
  let calls = 1
  for (;;) {
    const t0 = performance.now()
    for (let i = 0; i < calls; i++) sink.value = await fn()
    const dt = performance.now() - t0
    if (dt >= SAMPLE_MS || calls >= 1 << 24) break
    calls = dt < 1 ? calls * 16 : Math.ceil((calls * SAMPLE_MS * 1.2) / dt)
  }

  const perCallUs: number[] = []
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now()
    for (let i = 0; i < calls; i++) sink.value = await fn()
    perCallUs.push(((performance.now() - t0) / calls) * 1000)
  }
  return { name, medianUs: median(perCallUs), minUs: Math.min(...perCallUs), calls }
}

/** Same as `measure`, for synchronous work: no `await` per call. */
export function measureSync(name: string, fn: () => unknown): Result {
  let calls = 1
  for (;;) {
    const t0 = performance.now()
    for (let i = 0; i < calls; i++) sink.value = fn()
    const dt = performance.now() - t0
    if (dt >= SAMPLE_MS || calls >= 1 << 24) break
    calls = dt < 1 ? calls * 16 : Math.ceil((calls * SAMPLE_MS * 1.2) / dt)
  }

  const perCallUs: number[] = []
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now()
    for (let i = 0; i < calls; i++) sink.value = fn()
    perCallUs.push(((performance.now() - t0) / calls) * 1000)
  }
  return { name, medianUs: median(perCallUs), minUs: Math.min(...perCallUs), calls }
}

export function formatUs(us: number): string {
  if (us >= 1000) return `${(us / 1000).toFixed(2)} ms`
  if (us >= 10) return `${us.toFixed(1)} µs`
  return `${us.toFixed(3)} µs`
}
