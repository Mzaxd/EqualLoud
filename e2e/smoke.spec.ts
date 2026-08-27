/**
 * Smoke test #1 — verify the E2E pipeline works before writing more specs.
 *
 * Validates the riskiest assumptions:
 *   1. The MV3 extension loads under channel:'chromium' headless.
 *   2. The service worker registers and we can derive the extension id.
 *   3. The popup page is reachable and renders the EqualLoud title.
 *   4. GET_STATE is answerable (black-box SW contract).
 *
 * If this passes, the rest of the suite is plumbing.
 */
import { test, expect, getState, openPopup } from './fixtures'

test.describe('EqualLoud smoke', () => {
  test('extension loads and service worker is registered', async ({ context, extensionId }) => {
    // Extension id is a 32-char lowercase hex string.
    expect(extensionId).toMatch(/^[a-z]{32}$/)
    // At least one service worker is registered for the extension.
    const workers = context.serviceWorkers()
    expect(workers.length).toBeGreaterThanOrEqual(1)
    expect(workers[0]!.url()).toContain(`chrome-extension://${extensionId}/`)
  })

  test('popup page renders the EqualLoud title', async ({ context, extensionId }) => {
    const popup = await openPopup(context, extensionId)
    // v2.0 popup uses the serif wordmark (.name with <b>Loud</b> inside).
    await expect(popup.locator('.name')).toContainText('EqualLoud')
    await popup.close()
  })

  test('GET_STATE responds with default settings', async ({ context, extensionId }) => {
    const state = await getState(context, extensionId)
    expect(state.settings.enabled).toBe(true)
    expect(state.settings.targetLufs).toBe(-14)
    // Limiter default-on per PRD §17 Q1; threshold lowered −2 → −1 dBTP in
    // 2.0 to align with EBU R128's delivery ceiling.
    expect(state.limiter.enabled).toBe(true)
    expect(state.limiter.thresholdDb).toBe(-1)
  })
})
