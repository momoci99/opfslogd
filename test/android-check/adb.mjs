// Drive browsers on a real Android phone over USB (docs/design/benchmark.html#android).
// adb reverse lets the phone open the Mac's server as http://localhost (a secure context, so
// OPFS works). Each browser exposes a DevTools socket while USB debugging is on; we forward
// it and connect Playwright over CDP. Playwright's _android.launchBrowser() is not used: it
// needs a Chrome flag set by hand and does not cover Samsung Internet.

import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

export const BROWSERS = [
  { name: 'chrome', label: 'android chrome', pkg: 'com.android.chrome', socket: 'chrome_devtools_remote', port: 9322 },
  { name: 'samsung', label: 'android samsung', pkg: 'com.sec.android.app.sbrowser', socket: 'Terrace_devtools_remote', port: 9323 },
]

export const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const withTimeout = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`timeout: ${what}`)))])

export function pid(b) {
  try {
    return adb('shell', 'pidof', b.pkg)
  } catch {
    return '' // pidof exits 1 when not running
  }
}

let stayOnBefore
const reversed = []

// One phone, authorized, screen kept on while plugged in. Returns the installed browsers.
export function setUp(serverPorts) {
  let devices
  try {
    devices = adb('devices').split('\n').slice(1).filter(Boolean)
  } catch {
    throw new Error('adb not found. Install Android platform-tools (macOS: brew install --cask android-platform-tools).')
  }
  if (devices.length !== 1) throw new Error(`need exactly one phone, adb devices shows ${devices.length}`)
  if (!devices[0].endsWith('\tdevice')) throw new Error(`phone not ready: ${devices[0]} (accept the USB debugging prompt)`)
  for (const port of serverPorts) {
    adb('reverse', `tcp:${port}`, `tcp:${port}`)
    reversed.push(port)
  }
  // The screen turning off hides the page and stops it; the setting is put back in tearDown().
  stayOnBefore = adb('shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in')
  adb('shell', 'svc', 'power', 'stayon', 'usb')
  const installed = BROWSERS.filter((b) => {
    try {
      return adb('shell', 'pm', 'path', b.pkg).startsWith('package:')
    } catch {
      return false
    }
  })
  for (const b of installed) adb('forward', `tcp:${b.port}`, `localabstract:${b.socket}`)
  return installed
}

export function tearDown() {
  try {
    for (const port of reversed) adb('reverse', '--remove', `tcp:${port}`)
    for (const b of BROWSERS) adb('forward', '--remove', `tcp:${b.port}`)
  } catch {}
  try {
    if (stayOnBefore !== undefined) adb('shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', stayOnBefore)
  } catch {}
}

// Open a URL with an intent, which brings the browser to the front, then find the tab over CDP.
// A browser in the background does not answer on its DevTools socket.
export async function openTab(b, url) {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, '-p', b.pkg)
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const browser = await withTimeout(chromium.connectOverCDP(`http://localhost:${b.port}`), 5000, 'connect')
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === url)
      if (page) return { browser, page }
      await browser.close() // for a CDP connection this only disconnects
    } catch {}
  }
  throw new Error(`${b.name}: tab not found: ${url}`)
}

// Close a tab through the DevTools HTTP endpoint (Playwright's page.close() hangs in Samsung Internet).
export async function closeTab(b, page) {
  try {
    const cdp = await page.context().newCDPSession(page)
    const { targetInfo } = await cdp.send('Target.getTargetInfo')
    await withTimeout(fetch(`http://localhost:${b.port}/json/close/${targetInfo.targetId}`), 5000, 'close')
  } catch {}
}

// Close every tab still on our origin (tabs restored after a kill pile up otherwise).
export async function closeTabsOn(b, origin) {
  try {
    const targets = await (await withTimeout(fetch(`http://localhost:${b.port}/json/list`), 5000, 'list')).json()
    for (const t of targets) {
      if (t.type === 'page' && t.url.startsWith(origin)) {
        await withTimeout(fetch(`http://localhost:${b.port}/json/close/${t.id}`), 5000, 'close').catch(() => {})
      }
    }
  } catch {}
}

export async function version(b) {
  try {
    const v = await (await withTimeout(fetch(`http://localhost:${b.port}/json/version`), 5000, 'version')).json()
    return v.Browser
  } catch {
    return '?'
  }
}
