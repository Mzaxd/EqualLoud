/**
 * Real-popup completeness specs — the part every other suite must skip.
 *
 * Everywhere else the popup is exercised by opening index.html as a full-size
 * tab (fixtures.openPopup), because automation stacks can't click the toolbar
 * icon. These specs reach the REAL action popup: PopupDriver (popup-driver.ts)
 * asks the service worker to chrome.action.openPopup() and drives the true
 * toolbar-click widget over a raw CDP session — real 348px window geometry,
 * real input-pipeline clicks, live popup→SW wiring.
 *
 * Runner/expect stay Playwright; only the browser+popup transport differs.
 */
import { readFileSync } from 'node:fs'

import { expect, test as base } from './fixtures'
import { PopupDriver } from './popup-driver'
// Extend the shared fixtures' test so the mediaUrl static-server fixture is
// available; the Playwright context fixtures stay unused for these specs.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

const test = base.extend<{ popup: PopupDriver }>({
  popup: async ({}, use) => {
    const driver = await PopupDriver.launch()
    await driver.openPopup()
    await use(driver)
    await driver.close()
  },
})

test.describe('real action popup (chrome.action.openPopup)', () => {
  test('openPopup shows the true popup — body-sized, not a tab', async ({ popup }) => {
    await popup.waitForSelector('.power')

    // The decisive geometry check: Chrome sizes the action popup to <body>
    // (348px floor per the global CSS). A tab opened via fixtures.openPopup
    // would be the full ~1280px window instead — this assertion is what makes
    // these specs evidence about the real widget.
    const geo = await popup.evaluate<{ w: number; h: number; href: string }>(
      '({ w: innerWidth, h: innerHeight, href: location.href })',
    )
    expect(geo.href).toBe(popup.popupUrl)
    expect(geo.w).toBeGreaterThanOrEqual(348)
    expect(geo.w).toBeLessThan(800)
    expect(geo.h).toBeGreaterThan(0)
    expect(geo.h).toBeLessThan(600) // Chrome caps popups at 600px
  })

  test('popup renders the complete UI', async ({ popup }) => {
    await popup.waitForSelector('.name')

    // Wordmark + master power (auto-balance defaults on → .on state).
    expect(await popup.textOf('.name')).toBe('EqualLoud')
    expect(await popup.exists('.power.on')).toBe(true)

    // Target slider at production defaults (−14 LUFS inside −60..0).
    await popup.waitForSelector('.target-slider')
    const slider = await popup.evaluate(`(() => {
      const el = document.querySelector('.target-slider')
      return { min: el.min, max: el.max, value: el.value }
    })()`)
    expect(slider).toEqual({ min: '-60', max: '0', value: '-14' })
    expect(await popup.textOf('.target-row .v')).toContain('-14 LUFS')

    // Footer version tracks package.json — the manifest/popup contract
    // (manifest.config.ts reads this same version at build time).
    expect(await popup.textOf('.pri')).toContain(`EqualLoud · v${pkg.version}`)

    // No media playing → the calm empty state, not a phantom tab row.
    expect(await popup.exists('.empty-state')).toBe(true)
    expect(await popup.exists('.tab')).toBe(false)
  })

  test('master power click in the real popup drives SW state', async ({ popup }) => {
    await popup.waitForSelector('.power')

    // A real input-pipeline click on the standby button must reach the SW.
    await popup.click('.power')
    await expect
      .poll(async () => (await popup.getState()).settings.enabled, {
        timeout: 10_000,
        message: 'global enabled to flip to false after the power click',
      })
      .toBe(false)
    expect(await popup.exists('.power.on')).toBe(false)

    // Second click re-enables (also restores state for later specs).
    await popup.click('.power')
    await expect.poll(async () => (await popup.getState()).settings.enabled).toBe(true)
    expect(await popup.exists('.power.on')).toBe(true)
  })

  test('target slider in the real popup persists to the SW', async ({ popup }) => {
    await popup.waitForSelector('.target-slider')
    await popup.fillInput('.target-slider', '-30')

    await expect
      .poll(async () => (await popup.getState()).settings.targetLufs, {
        timeout: 10_000,
        message: 'target LUFS to become -30 from the real popup',
      })
      .toBe(-30)

    // Restore production defaults.
    await popup.fillInput('.target-slider', '-14')
    await expect.poll(async () => (await popup.getState()).settings.targetLufs).toBe(-14)
  })

  test('tab list tracks a live capturing tab; row click bypasses it', async ({ mediaUrl }) => {
    // Tab setup MUST happen before the popup opens: the real popup dismisses
    // on focus loss (see the lifecycle spec below), so no tab may be created
    // while it is open. Hence no fixture here — manual driver management.
    const driver = await PopupDriver.launch()
    try {
      const media = await driver.openTab(mediaUrl)
      await media.waitForSelector('#playBtn', 10_000)
      await media.fillInput('#gainSlider', '-20')
      // Real input dispatch → real user activation → playback actually starts.
      await media.click('#playBtn')

      // Popup opens after playback starts; its tab list must show the media
      // row as soon as the content script attaches and the SW broadcasts it.
      // (All state reads go through the popup session from here on — the
      // popup must be open before any GET_STATE.)
      await driver.openPopup()
      await driver.waitForSelector('.tab', 20_000)
      expect(await driver.exists('.empty-state')).toBe(false)

      // Click the row in the real popup — per-tab A/B toggle must reach the SW.
      await driver.click('.tab')
      await expect
        .poll(
          async () => {
            const s = await driver.getState()
            return s.tabs.find((t) => t.url.includes('media-test.html'))?.balanceEnabled
          },
          { timeout: 10_000, message: 'row click to bypass the tab' },
        )
        .toBe(false)
      // Bypass drives the tab to unity gain through the normal SET_GAIN channel.
      await expect
        .poll(
          async () => {
            const s = await driver.getState()
            return s.tabs.find((t) => t.url.includes('media-test.html'))?.appliedGainDb
          },
          { timeout: 10_000 },
        )
        .toBe(0)
    } finally {
      await driver.close()
    }
  })

  test('the real popup dismisses when focus moves away (lifecycle)', async ({ popup }) => {
    await popup.waitForSelector('.power')
    expect(popup.isPopupAlive()).toBe(true)

    // Chrome's own popup rule: any other surface taking focus closes it. This
    // is exactly the behaviour tab-based tests can never exercise.
    const blank = await popup.openTab('about:blank')
    await expect
      .poll(() => popup.isPopupAlive(), {
        timeout: 10_000,
        message: 'popup to dismiss when a new tab takes focus',
      })
      .toBe(false)
    await blank.close()
  })

  test('popup session is console-clean under real interaction', async ({ popup }) => {
    await popup.waitForSelector('.power')

    await popup.click('.power')
    await popup.click('.power') // toggle back — two full popup↔SW round-trips
    await popup.fillInput('.target-slider', '-20')
    await popup.fillInput('.target-slider', '-14')
    // Let async work settle (port messages, storage writes, icon loads).
    await new Promise((r) => setTimeout(r, 1_500))

    expect(popup.errors, popup.errors.join('\n')).toEqual([])
  })
})
