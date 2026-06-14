/**
 * SW restart recovery — regression test for the "切出去再切回来就失效" bug.
 *
 * Reproduces the user's report: after Chrome destroys and re-creates the MV3
 * service worker (which happens on idle / when the tab is backgrounded), the
 * in-memory `tabs` Map in background.ts is wiped. Before the fix, LUFS_REPORT
 * heartbeats were silently dropped (`if (!t) return`) and scanTabs iterated the
 * empty Map, so balancing never resumed.
 *
 * We simulate the SW teardown+recreate cycle via the DevTools Protocol
 * (ServiceWorker.stopWorker / waiting for re-registration on next message),
 * then assert that within a few seconds the media tab is re-balancing.
 */
import type { Page } from '@playwright/test'

import { test, expect, getState, openPopup } from './fixtures'

/** Stop the extension's service worker; it will be re-created on next event. */
async function killServiceWorker(
  context: import('@playwright/test').BrowserContext,
): Promise<void> {
  // Use CDP to find and terminate the SW target. Chrome auto-restarts it on
  // the next message/event directed at the extension.
  const session = await context.newCDPSession(await context.newPage())
  const { targetInfos } = (await session.send('Target.getTargets' as never)) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>
  }
  const sw = targetInfos.find(
    (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
  )
  if (!sw) throw new Error('service worker target not found')
  await session.send('Target.closeTarget' as never, { targetId: sw.targetId } as never)
  await session.detach()
}

/** Wait for the SW to be registered again and return its handle. */
async function awaitServiceWorker(
  context: import('@playwright/test').BrowserContext,
): Promise<Page> {
  // A message to the extension forces SW re-creation; use the popup page.
  const worker = context.serviceWorkers()[0]
  if (worker) return worker
  return context.waitForEvent('serviceworker', { timeout: 10_000 })
}

test.describe('SW restart recovery', () => {
  test('balancing resumes after service worker is destroyed and re-created', async ({
    context,
    extensionId,
    mediaUrl,
  }) => {
    test.setTimeout(90_000)

    // 1. Get a media tab attached and confirm it's being balanced.
    const media = await context.newPage()
    await media.goto(mediaUrl)
    await media.fill('#gainSlider', '-30')
    await media.click('#playBtn')

    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          return s.tabs.filter((t) => t.url.includes('media-test.html')).length
        },
        { timeout: 20_000, message: 'media tab attached before SW kill' },
      )
      .toBeGreaterThanOrEqual(1)

    // Wait until LUFS has genuinely started accumulating — blockCount > 0 means
    // the worklet is producing real readings, which is the precondition for the
    // whole recovery assertion.
    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          return s.tabs.find((t) => t.url.includes('media-test.html'))?.blockCount ?? 0
        },
        { timeout: 20_000, message: 'LUFS to start accumulating before SW kill' },
      )
      .toBeGreaterThan(0)

    const beforeKill = await getState(context, extensionId)
    const tabBefore = beforeKill.tabs.find((t) => t.url.includes('media-test.html'))!
    console.log('Before SW kill: blockCount', tabBefore.blockCount, 'gain', tabBefore.appliedGainDb)
    const blockCountBefore = tabBefore.blockCount

    // 2. Kill the service worker (simulates Chrome destroying it on idle).
    await killServiceWorker(context)

    // 3. Force the SW to re-create by sending a message (any popup-side request).
    //    Then wait for the new SW registration.
    //    The pop-then-message pattern wakes the SW; scanTabs also fires on load.
    const wake = await openPopup(context, extensionId) // triggers SW restart
    await awaitServiceWorker(context)
    await wake.close()

    // 4. Assert: within a few seconds the tab is known again (blockCount keeps
    //    climbing past the pre-kill value) — proving LUFS reporting resumed.
    await expect
      .poll(
        async () => {
          const s = await getState(context, extensionId)
          const t = s.tabs.find((x) => x.url.includes('media-test.html'))
          // Tab must be re-registered AND accumulating new LUFS blocks.
          return t ? t.blockCount : -1
        },
        {
          timeout: 30_000,
          message: 'tab to re-register and resume LUFS reporting after SW restart',
        },
      )
      .toBeGreaterThan(blockCountBefore)

    const afterRecover = await getState(context, extensionId)
    const tabAfter = afterRecover.tabs.find((t) => t.url.includes('media-test.html'))!
    console.log(
      'After SW restart: blockCount',
      tabAfter.blockCount,
      '(+',
      tabAfter.blockCount - blockCountBefore,
      ')',
      'gain',
      tabAfter.appliedGainDb,
    )
    // The recovered tab must have a real gain decision again (not stuck at 0).
    expect(Math.abs(tabAfter.appliedGainDb)).toBeGreaterThan(0)

    await media.close()
  })
})
