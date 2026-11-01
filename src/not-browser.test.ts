// @vitest-environment node
// Outside a browser page the library does nothing, silently (#062).

import { expect, it, vi } from 'vitest'
import { close, flush, init, logger, setContext } from './index'

it('does nothing and prints nothing without a document', async () => {
  const warn = vi.spyOn(console, 'warn')
  const error = vi.spyOn(console, 'error')
  logger.info('server side')
  init({ namespace: 'Bad Name' }) // would report invalid-option in a browser
  setContext({ a: 1 })
  logger.error('still nothing')
  expect(await flush()).toBe(true)
  await close()
  expect(warn).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
})
