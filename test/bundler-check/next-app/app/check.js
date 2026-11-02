'use client'
// Imports opfslogd at the top, as an app would, so the server render also loads the module.
// The shared check (../main.js) runs in the browser after hydration.
import { useEffect } from 'react'
import { run } from '../main.js'

export default function Check() {
  useEffect(() => {
    window.__result = run().catch((e) => ({ ok: false, error: String(e) }))
  }, [])
  return <p>opfslogd bundler check</p>
}
