import { defineConfig } from 'tsdown'

export default defineConfig({
  // worker.ts is its own file, loaded with new URL('./worker.js', import.meta.url) (#009, #059)
  entry: ['src/index.ts', 'src/worker.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
})
