import { startWorker } from 'fake-opfslogd'

window.__result = startWorker().then(
  (reply) => ({ ok: reply.opfs === 'ok', ...reply }),
  (e) => ({ ok: false, error: String(e) }),
)
