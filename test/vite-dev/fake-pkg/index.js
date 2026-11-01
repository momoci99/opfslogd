// Stands in for the published package: starts its worker the way #009 says.
export function startWorker() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'opfslogd' })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply in 3s')), 3000)
    worker.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event.data)
    }
    worker.onerror = (event) => {
      clearTimeout(timer)
      reject(new Error(`worker error: ${event.message || 'failed to load'}`))
    }
    worker.postMessage('ping')
  })
}
