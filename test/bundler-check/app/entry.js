// Entry for the plain bundles (webpack, rollup, esbuild, parcel): run the check on load.
import { run } from './main.js'

window.__result = run().catch((e) => ({ ok: false, error: String(e) }))
