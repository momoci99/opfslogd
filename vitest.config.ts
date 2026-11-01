import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        // Real browsers, for OPFS, Workers, and Web Locks (#058).
        test: {
          name: 'browser',
          include: ['test/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [
              { browser: 'chromium' },
              { browser: 'firefox' },
              {
                browser: 'webkit',
                // WebKit blocks OPFS in Playwright's default throwaway context
                // (getDirectory() throws UnknownError, as in Safari private browsing).
                // A persistent context needs one page at a time.
                provider: playwright({ persistentContext: 'node_modules/.cache/vitest-webkit-profile' }),
                fileParallelism: false,
              },
            ],
          },
        },
      },
    ],
  },
})
