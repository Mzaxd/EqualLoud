/**
 * Driver for the REAL extension action popup (the toolbar-click widget).
 *
 * Why this file exists: neither Playwright nor Puppeteer can wrap the popup
 * that `chrome.action.openPopup()` creates. The popup is born as a CDP target
 * of type 'other' (a tab-less widget window) and only later flips to 'page',
 * and both automation stacks decide whether to adopt a target exactly once —
 * at creation. So the popup never gets a Page wrapper (`page()` returns null
 * forever) even though `Target.getTargets` clearly lists it. Verified
 * empirically against Playwright 1.60 and Puppeteer 25.
 *
 * The target is still a perfectly addressable CDP endpoint, and Puppeteer
 * exposes an official raw session for any target via `createCDPSession()`.
 * So this driver launches Puppeteer with Playwright's own Chromium binary
 * (zero extra browser downloads), asks the service worker to open the popup,
 * then drives the popup over raw CDP:
 *   - evaluate():  Runtime.evaluate with returnByValue + awaitPromise
 *   - click():     the REAL input pipeline via Input.dispatchMouseEvent at
 *                  the element's bounding-rect center — hit-testing, hover,
 *                  focus and event ordering are all Chromium's own
 *   - errors:      console errors / uncaught exceptions / Log entries,
 *                  captured from popup open onward
 *
 * Regular tabs get the same treatment (DriverTab): puppeteer's high-level
 * Page API (page.click etc.) hangs on Runtime.callFunctionOn here, while raw
 * sessions respond instantly — and raw input dispatch grants the real user
 * activation the page needs for playback.
 *
 * Emulation is disabled (defaultViewport: null) so geometry reflects the true
 * popup window Chrome sized to <body> (348px floor) — the property that
 * distinguishes the real popup from index.html opened as a 1280px test tab.
 *
 * Lifecycle rule: like for a real user, the popup dismisses when anything
 * steals focus (e.g. opening a tab). Tests must therefore finish ALL tab
 * setup BEFORE calling openPopup(), and never create a surface afterwards.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'
import puppeteer, { type Browser, type CDPSession, type Page, type Target } from 'puppeteer-core'

import type { GetStateResponse } from './fixtures'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXTENSION_PATH = resolve(__dirname, '..', 'dist')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── Raw-CDP primitives, shared by the popup and regular tabs ────────────────

async function evaluateOn<T>(session: CDPSession, expression: string): Promise<T> {
  const res = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(`evaluate failed: ${d.text} ${d.exception?.description ?? ''}`)
  }
  return res.result.value as T
}

async function waitForSelectorOn(
  session: CDPSession,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      await evaluateOn<boolean>(session, `!!document.querySelector(${JSON.stringify(selector)})`)
    ) {
      return
    }
    await sleep(100)
  }
  throw new Error(`waitForSelector timed out: ${selector}`)
}

async function clickOn(session: CDPSession, selector: string): Promise<void> {
  const sel = JSON.stringify(selector)
  const { x, y } = await evaluateOn<{ x: number; y: number }>(
    session,
    `(() => {
      const el = document.querySelector(${sel})
      if (!el) throw new Error('missing: ' + ${sel})
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) throw new Error('zero-size: ' + ${sel})
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`,
  )
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
  }
}

async function fillInputOn(session: CDPSession, selector: string, value: string): Promise<void> {
  const sel = JSON.stringify(selector)
  const val = JSON.stringify(value)
  await evaluateOn(
    session,
    `(() => {
      const el = document.querySelector(${sel})
      if (!el) throw new Error('missing: ' + ${sel})
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, ${val})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`,
  )
}

// ── Driver tab: a regular browser tab over its own raw session ──────────────

export class DriverTab {
  constructor(
    private readonly session: CDPSession,
    private readonly page: Page,
  ) {}

  evaluate<T = unknown>(expression: string): Promise<T> {
    return evaluateOn<T>(this.session, expression)
  }

  waitForSelector(selector: string, timeoutMs = 10_000): Promise<void> {
    return waitForSelectorOn(this.session, selector, timeoutMs)
  }

  click(selector: string): Promise<void> {
    return clickOn(this.session, selector)
  }

  fillInput(selector: string, value: string): Promise<void> {
    return fillInputOn(this.session, selector, value)
  }

  async close(): Promise<void> {
    try {
      await this.session.detach()
    } catch {
      // already gone
    }
    await this.page.close()
  }
}

// ── Popup driver ─────────────────────────────────────────────────────────────

export class PopupDriver {
  private constructor(
    readonly browser: Browser,
    readonly extensionId: string,
    readonly popupUrl: string,
    private readonly swSession: CDPSession,
    private popupSession: CDPSession | null,
    /** Console errors / uncaught exceptions / Log errors, since popup open. */
    readonly errors: string[],
  ) {}

  /**
   * Launch Chromium with the built extension. The real popup is NOT opened
   * yet — call openPopup() after any tab setup (it dismisses on focus loss).
   */
  static async launch(): Promise<PopupDriver> {
    const browser = await puppeteer.launch({
      // Playwright's channel-'chromium' binary (full Chrome, new headless) —
      // the same one the rest of the e2e suite runs on.
      executablePath: chromium.executablePath(),
      headless: true,
      defaultViewport: null,
      protocolTimeout: 30_000,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=Translate',
      ],
    })

    const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', {
      timeout: 15_000,
    })
    const extensionId = new URL(swTarget.url()).host
    const swSession = await swTarget.createCDPSession()
    await swSession.send('Runtime.enable')

    return new PopupDriver(
      browser,
      extensionId,
      `chrome-extension://${extensionId}/index.html`,
      swSession,
      null,
      [],
    )
  }

  /**
   * Open the real action popup via chrome.action.openPopup() and attach the
   * raw CDP session used by every popup interaction below.
   */
  async openPopup(): Promise<void> {
    if (this.popupSession) throw new Error('popup already open')

    // Fresh profile → runtime.onInstalled fires and the SW opens the
    // first-run onboarding tab. That tab steals focus when it lands, and the
    // popup dismisses on focus loss — so wait for it BEFORE opening (opening
    // the popup is itself an activation; nothing may land after it).
    await this.browser
      .waitForTarget((t) => t.url().includes('onboarding.html'), { timeout: 3_000 })
      .catch(() => {})

    const opened = await this.swSession.send('Runtime.evaluate', {
      expression: 'chrome.action.openPopup()',
      awaitPromise: true,
    })
    if (opened.exceptionDetails) {
      throw new Error(
        `chrome.action.openPopup() rejected: ${JSON.stringify(opened.exceptionDetails)}`,
      )
    }

    // The popup target exists already but may still be mid other→page
    // transition; waitForTarget polls until it reports as our page.
    let popupTarget: Target | undefined
    try {
      popupTarget = await this.browser.waitForTarget(
        (t) => t.type() === 'page' && t.url() === this.popupUrl,
        { timeout: 10_000 },
      )
    } catch {
      throw new Error('real popup target never appeared after openPopup()')
    }

    const popupSession = await popupTarget.createCDPSession()
    await popupSession.send('Runtime.enable')
    await popupSession.send('Log.enable')
    popupSession.on('Runtime.consoleAPICalled', (e) => {
      if (e.type === 'error') {
        this.errors.push(e.args.map((a) => String(a.value ?? a.description ?? '')).join(' '))
      }
    })
    popupSession.on('Runtime.exceptionThrown', (e) => {
      this.errors.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)
    })
    popupSession.on('Log.entryAdded', (e) => {
      if (e.entry.level === 'error') this.errors.push(`${e.entry.source}: ${e.entry.text}`)
    })

    this.popupSession = popupSession
  }

  private session(): CDPSession {
    if (!this.popupSession) throw new Error('popup not open — call openPopup() first')
    return this.popupSession
  }

  /** Whether the real popup target still exists (popups close on focus loss). */
  isPopupAlive(): boolean {
    return this.browser.targets().some((t) => t.type() === 'page' && t.url() === this.popupUrl)
  }

  /** Evaluate an expression in the popup and return its JSON value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return evaluateOn<T>(this.session(), expression)
  }

  /** Black-box SW state read from the popup (an extension page → onMessage). */
  async getState(): Promise<GetStateResponse> {
    return this.evaluate<GetStateResponse>(`chrome.runtime.sendMessage({ type: 'GET_STATE' })`)
  }

  /** Whether the selector currently matches anything. */
  async exists(selector: string): Promise<boolean> {
    return this.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  }

  /** Poll until the selector matches, like Playwright's waitForSelector. */
  async waitForSelector(selector: string, timeoutMs = 10_000): Promise<void> {
    return waitForSelectorOn(this.session(), selector, timeoutMs)
  }

  /** innerText of the selector (throws if missing). */
  async textOf(selector: string): Promise<string> {
    const sel = JSON.stringify(selector)
    return this.evaluate<string>(
      `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('missing: ' + ${sel}); return el.innerText })()`,
    )
  }

  /** Click through Chromium's real input pipeline (hover → press → release). */
  async click(selector: string): Promise<void> {
    return clickOn(this.session(), selector)
  }

  /**
   * Set an <input> value like a real edit: the native value setter plus a
   * bubbling input/change event pair (Vue binds to input). CDP drag-coordinates
   * for a range slider add math for no extra coverage — the store reacts to
   * the same input event either way.
   */
  async fillInput(selector: string, value: string): Promise<void> {
    return fillInputOn(this.session(), selector, value)
  }

  /** Open a regular browser tab driven over its own raw CDP session. */
  async openTab(url: string): Promise<DriverTab> {
    const page = await this.browser.newPage()
    const tabSession = await page.target().createCDPSession()
    await tabSession.send('Runtime.enable')
    const tab = new DriverTab(tabSession, page)
    await page.goto(url)
    return tab
  }

  /** Detach and tear down the whole browser. */
  async close(): Promise<void> {
    if (this.popupSession) {
      try {
        await this.popupSession.detach()
      } catch {
        // popup already dismissed
      }
      this.popupSession = null
    }
    try {
      await this.swSession.detach()
    } catch {
      // SW already gone
    }
    await this.browser.close()
  }
}
