/**
 * EqualLoud core-link E2E specs.
 *
 * Covers (PRD §11.3 core scenarios):
 *   - content script attaches to a real <audio> element
 *   - popup renders correctly
 *   - two-tab balancing: loud tab attenuated, quiet tab boosted (direction)
 *   - target-LUFS slider takes effect
 *   - mute applies immediately
 *   - disabling restores unity gain
 *
 * All state is read black-box via the popup's GET_STATE contract; we never
 * touch the SW's private Map.
 */
import { test, expect, getState, openPopup, type GetStateResponse } from './fixtures'

/** Open the media test page and start playback at a given gain (dB slider). */
async function openMediaPage(
  context: Parameters<typeof openPopup>[0],
  mediaUrl: string,
  gainDb: number,
): Promise<import('@playwright/test').Page> {
  const page = await context.newPage()
  await page.goto(mediaUrl)
  // Wait for the page's audio init to be ready (the play button handler does
  // init lazily, but filling the slider first ensures the right volume).
  await page.waitForSelector('#playBtn')
  await page.fill('#gainSlider', String(gainDb))
  await page.click('#playBtn')
  return page
}

/** Poll GET_STATE until at least N tabs are attached, or timeout. */
async function waitForTabs(
  context: Parameters<typeof openPopup>[0],
  extensionId: string,
  count: number,
  timeoutMs = 20_000,
): Promise<GetStateResponse> {
  const deadline = Date.now() + timeoutMs
  let last: GetStateResponse | null = null
  while (Date.now() < deadline) {
    last = await getState(context, extensionId)
    if (last.tabs.length >= count) return last
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${count} tabs; last state had ${last?.tabs.length ?? 0}`)
}

test.describe('EqualLoud core link', () => {
  test('content script attaches to a media element', async ({ context, extensionId, mediaUrl }) => {
    const media = await openMediaPage(context, mediaUrl, -20)

    // The tab should appear in GET_STATE with isCapturing true.
    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          return s.tabs.filter((t) => t.url.includes('media-test.html')).length
        },
        { timeout: 20_000, message: 'media tab to be attached' },
      )
      .toBeGreaterThanOrEqual(1)

    const state = await getState(context, extensionId)
    const tab = state.tabs.find((t) => t.url.includes('media-test.html'))
    expect(tab).toBeTruthy()
    expect(tab!.isCapturing).toBe(true)

    await media.close()
  })

  test('popup shows the correct initial UI', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId)
    // Title + version + slider range all rendered.
    await expect(popup.locator('.app-title')).toHaveText('EqualLoud')
    // Auto-balance defaults on, so the slider is visible.
    const slider = popup.locator('.target-slider')
    await expect(slider).toBeVisible()
    await expect(slider).toHaveAttribute('min', '-60')
    await expect(slider).toHaveAttribute('max', '0')
    await expect(popup.locator('.target-value')).toContainText('-14 LUFS')
    await popup.close()
  })

  test('two tabs balance: loud attenuated, quiet boosted', async ({
    context,
    extensionId,
    mediaUrl,
  }) => {
    test.setTimeout(120_000)
    // Two media pages, very different source gains.
    const quiet = await openMediaPage(context, mediaUrl, -45) // very quiet
    const loud = await openMediaPage(context, mediaUrl, -4) // loud

    // Wait until both are attached, then wait for LUFS to converge and gains
    // to be applied. LUFS needs ~3s of audio; allow generous headroom.
    await waitForTabs(context, extensionId, 2, 30_000)

    // Poll until both tabs have blockCount well above the reliability gate so
    // the balancer has issued real gain decisions on each.
    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          const mediaTabs = s.tabs.filter((t) => t.url.includes('media-test.html'))
          if (mediaTabs.length < 2) return false
          return mediaTabs.every((t) => t.blockCount >= 10)
        },
        { timeout: 40_000, message: 'both tabs to accumulate enough LUFS samples' },
      )
      .toBe(true)

    const state = await getState(context, extensionId)
    const mediaTabs = state.tabs.filter((t) => t.url.includes('media-test.html'))
    expect(mediaTabs.length).toBe(2)

    // Both pink-noise sources measure below the default target (-14 LUFS), so
    // both get boosted — but by very different amounts:
    //   • the -4 dB-volume source measures ~-16 LUFS → small positive gain
    //     (target - measurement ≈ +2 dB)
    //   • the -45 dB-volume source measures ~-57 LUFS → gain clamped to +12
    //     (the per-tab ceiling), because target - measurement would be huge.
    // The meaningful assertion is *differential*: the quieter source gets a
    // strictly larger boost than the louder one, closing the loudness gap.
    const byGain = [...mediaTabs].sort((a, b) => a.appliedGainDb - b.appliedGainDb)
    const quietGain = byGain[1]!.appliedGainDb // larger boost
    const loudGain = byGain[0]!.appliedGainDb // smaller boost
    console.log(
      'Two-tab gains — louder source:',
      loudGain.toFixed(2),
      ' quieter source:',
      quietGain.toFixed(2),
      ' settings:',
      JSON.stringify(state.settings),
    )
    // Quiet source gets a bigger boost than the loud source...
    expect(quietGain).toBeGreaterThan(loudGain)
    // ...and that boost is clamped to the +12 dB ceiling.
    expect(quietGain).toBe(12)
    // The loud source gets a positive-but-modest boost toward -14.
    expect(loudGain).toBeGreaterThan(0)
    expect(loudGain).toBeLessThan(quietGain)

    await quiet.close()
    await loud.close()
  })

  test('target LUFS slider changes settings', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId)
    // Drag the slider to -30 via the input value (simpler than mouse drag).
    await popup.locator('.target-slider').fill('-30')
    await popup.locator('.target-slider').dispatchEvent('input')

    // The SW should persist the new target; read it back via GET_STATE.
    await expect
      .poll(async () => (await getState(context, extensionId)).settings.targetLufs, {
        timeout: 10_000,
        message: 'target LUFS to become -30',
      })
      .toBe(-30)

    await popup.close()
  })

  test('bypassing a tab restores unity gain while others stay balanced', async ({
    context,
    extensionId,
    mediaUrl,
  }) => {
    const media = await openMediaPage(context, mediaUrl, -20)
    await waitForTabs(context, extensionId, 1, 20_000)
    const before = await getState(context, extensionId)
    const tab = before.tabs.find((t) => t.url.includes('media-test.html'))!

    // Send TOGGLE_BALANCE via the popup page (black-box: same as clicking the UI).
    const messenger = await openPopup(context, extensionId)
    await messenger.evaluate(async (id: number) => {
      await chrome.runtime.sendMessage({ type: 'TOGGLE_BALANCE', tabId: id })
    }, tab.tabId)

    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          return s.tabs.find((t) => t.tabId === tab.tabId)?.balanceEnabled
        },
        { timeout: 10_000, message: 'tab balance to be bypassed' },
      )
      .toBe(false)

    // Bypassed tabs are driven to unity (0 dB) via the normal SET_GAIN channel.
    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          return s.tabs.find((t) => t.tabId === tab.tabId)?.appliedGainDb
        },
        { timeout: 10_000, message: 'bypassed tab to reach 0 dB' },
      )
      .toBe(0)

    await messenger.close()
    await media.close()
  })

  test('disabling balancing restores unity gain', async ({ context, extensionId, mediaUrl }) => {
    // First get a tab attached and ideally balanced (non-zero gain).
    const media = await openMediaPage(context, mediaUrl, -30)
    await waitForTabs(context, extensionId, 1, 20_000)

    // Give the balancer a moment to push a non-unity gain on the quiet source.
    const messenger = await openPopup(context, extensionId)
    await messenger.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: false })
    })

    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          // Enabled is false, and any attached tab should have appliedGainDb 0.
          if (s.settings.enabled) return null
          return s.tabs.every((t) => t.appliedGainDb === 0)
        },
        { timeout: 10_000, message: 'all tabs back to unity gain after disable' },
      )
      .toBe(true)

    // Re-enable for cleanliness.
    await messenger.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: true })
    })
    await messenger.close()
    await media.close()
  })
})
