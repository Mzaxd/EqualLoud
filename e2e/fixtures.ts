/**
 * Playwright fixtures for EqualLoud E2E tests.
 *
 * Loads the built extension from ../dist into a persistent Chromium context
 * (the only context type that can host MV3 extensions) running under the new
 * headless mode (channel: 'chromium'). Exposes the dynamically-derived
 * extension id plus helpers to open the popup and read SW state black-box.
 *
 * Reference: https://playwright.dev/docs/chrome-extensions
 */

import { existsSync, readFile } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test as base, expect, type Page, type BrowserContext } from '@playwright/test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', 'dist')
const MEDIA_TEST_PATH = resolve(__dirname, '..', 'tools', 'media-test.html')
const TOOLS_DIR = resolve(__dirname, '..', 'tools')

/** Shape of GET_STATE responses — keep in sync with src/messages/protocol.ts. */
interface GetStateResponse {
  tabs: Array<{
    tabId: number
    title: string
    url: string
    isCapturing: boolean
    shortTerm: number
    blockCount: number
    appliedGainDb: number
    maxGainDb: number
    balanceEnabled: boolean
  }>
  settings: { enabled: boolean; targetLufs: number }
  limiter: {
    enabled: boolean
    thresholdDb: number
    kneeDb: number
    ratio: number
    attackMs: number
    releaseMs: number
  }
}

interface EqualLoudFixtures {
  /** Persistent context with the extension loaded. */
  context: BrowserContext
  /** Dynamically-derived extension id (varies per launch). */
  extensionId: string
  /** The extension's service worker handle (for evaluate into SW scope). */
  serviceWorker: Page
  /** HTTP URL of the media test page (served via local http, NOT file://). */
  mediaUrl: string
}

/**
 * Start a tiny static file server for the tools/ directory.
 *
 * Why: the LUFS AudioWorklet module is declared in web_accessible_resources
 * and fetched at runtime by `audioContext.audioWorklet.addModule(url)`. Under
 * `file://` pages this fetch fails with "Unable to load a worklet's module"
 * (origin isolation/CSP). Serving the test page over http:// makes the worklet
 * loadable, which is what real users hit (every video site is http(s)).
 *
 * Returns the base URL and a teardown. Bind to port 0 for an ephemeral port.
 */
async function startStaticServer(
  rootDir: string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wav': 'audio/wav',
  }
  return new Promise((resolveServer, reject) => {
    const server = createServer((req, res) => {
      // Normalize the URL: strip query, decode, prevent path traversal.
      const urlPath = decodeURIComponent(req.url ?? '/').split('?')[0]!
      const safePath = resolve(rootDir, '.' + urlPath)
      if (!safePath.startsWith(rootDir)) {
        res.statusCode = 403
        res.end('Forbidden')
        return
      }
      readFile(safePath, (err, data) => {
        if (err) {
          res.statusCode = 404
          res.end('Not found')
          return
        }
        res.setHeader('Content-Type', mimeTypes[extname(safePath)] ?? 'application/octet-stream')
        res.end(data)
      })
    })
    server.on('error', reject)
    // Track open sockets so teardown can destroy them instead of waiting for
    // keep-alive timeouts (which hang if media pages are still open).
    const sockets = new Set<import('node:net').Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          // Force-destroy every open socket first, then close the listener.
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          return new Promise((r) => server.close(() => r()))
        },
      })
    })
  })
}

/**
 * Extract the extension id from the service worker URL.
 * The SW URL looks like `chrome-extension://<id>/service-worker.js`.
 */
async function getExtensionId(context: BrowserContext): Promise<string> {
  // The SW may not be registered the instant the context opens; wait for it.
  let worker = context.serviceWorkers()[0]
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
  }
  const url = worker.url()
  // url = "chrome-extension://<32-char-id>/service-worker-loader.js"
  const match = url.match(/chrome-extension:\/\/([^/]+)\//)
  if (!match?.[1]) {
    throw new Error(`Could not parse extension id from service worker URL: ${url}`)
  }
  return match[1]
}

/** Open the extension popup as a regular page (Playwright can't drive popups). */
async function openPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${extensionId}/index.html`)
  return page
}

/**
 * Query the service worker's GET_STATE black-box.
 *
 * We call from a popup page rather than the SW itself: MV3 SWs that
 * `runtime.sendMessage` from their own context hit "Receiving end does not
 * exist" because the message isn't re-delivered to the same context. The popup
 * page is a regular extension page whose messages the SW's onMessage reliably
 * receives. We open a dedicated long-lived popup page per context and reuse it.
 */
async function getState(context: BrowserContext, extensionId: string): Promise<GetStateResponse> {
  // Lazily create one persistent "messenger" page for the whole test.
  const messengerKey = '__equalloudMessenger'
  let page = (context as unknown as Record<symbol, Page>)[Symbol.for(messengerKey)]
  if (!page || page.isClosed()) {
    page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/index.html`)
    ;(context as unknown as Record<symbol, Page>)[Symbol.for(messengerKey)] = page
  }
  return page.evaluate(async () => {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' })
    return resp as GetStateResponse
  })
}

export const test = base.extend<EqualLoudFixtures>({
  context: async ({}, use) => {
    if (!existsSync(EXTENSION_PATH)) {
      throw new Error(
        `dist/ not found at ${EXTENSION_PATH}. Run "pnpm build" before "pnpm test:e2e".`,
      )
    }
    // Launch a persistent context with the extension. Per Playwright docs this
    // is the only way to load MV3 extensions. `channel: 'chromium'` selects the
    // new headless mode (real Chrome), the only headless channel that supports
    // extensions.
    const { chromium } = await import('@playwright/test')
    const ctx = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        // Allow autoplay of media with sound (tests "play" via click gesture,
        // but this avoids any muted-autoplay detour).
        '--autoplay-policy=no-user-gesture-required',
        // Ensure file:// URLs are reachable + that the extension can inject.
        '--allow-file-access-from-files',
        '--disable-features=Translate',
      ],
    })
    await use(ctx)
    await ctx.close()
  },

  extensionId: async ({ context }, use) => {
    const id = await getExtensionId(context)
    await use(id)
  },

  serviceWorker: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0]
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10_000 })
    }
    await use(worker)
  },

  mediaUrl: async ({}, use) => {
    // Serve tools/ over http:// so the LUFS worklet (a web_accessible_resource)
    // can be fetched — it fails under file://. Bind an ephemeral port.
    const server = await startStaticServer(TOOLS_DIR)
    const url = `${server.baseUrl}/media-test.html`
    await use(url)
    await server.close()
  },
})

export { expect, EXTENSION_PATH, MEDIA_TEST_PATH }
export type { GetStateResponse }
export { openPopup, getState }
