import { defineConfig } from 'tsdown'

const common = {
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
} as const

// Two builds, so worker.js shares no chunk with index.js and works on its own when an
// app copies it and passes workerUrl. It is loaded with
// new URL('./worker.js', import.meta.url) (#009, #059, #081).
export default defineConfig([
  { ...common, entry: ['src/index.ts'], dts: true, clean: true },
  { ...common, entry: ['src/worker.ts'], dts: false, clean: false },
])
