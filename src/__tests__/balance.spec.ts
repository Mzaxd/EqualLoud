import { describe, it, expect } from 'vitest'

import { computeBalanceGains, shouldThrottleBalance, type BalanceableTab } from '@/audio/balance'

function makeTab(overrides: Partial<BalanceableTab> = {}): BalanceableTab {
  return {
    tabId: 1,
    isCapturing: true,
    shortTerm: -14,
    blockCount: 50,
    maxGainDb: 12,
    ...overrides,
  }
}

describe('computeBalanceGains', () => {
  it('returns 0 dB when tab LUFS already matches target', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -14 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 0 }])
  })

  it('boosts a quiet tab toward the target', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -20, maxGainDb: 24 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 6 }])
  })

  it('attenuates a loud tab toward the target', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -10 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: -4 }])
  })

  it('holds unity gain for tabs without enough samples (no stale-gain freeze)', () => {
    // Previously these were skipped (returning []), which left whatever gain
    // the GainNode last held frozen in place — on jittery feed sites a tab
    // never reached MIN_BLOCKS and got stuck at its last (possibly loud) gain.
    // Now we drive it to 0 dB every pass so it self-corrects.
    const tabs = [makeTab({ tabId: 1, shortTerm: -20, blockCount: 0 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 0 }])
  })

  it('balances tabs once they reach the minimum sample count (≥1 block)', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -20, maxGainDb: 24, blockCount: 1 })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 6 }])
  })

  it('holds unity gain for tabs whose LUFS is -Infinity (not yet measured)', () => {
    // Same rationale as the too-few-samples case: don't inherit a stale gain.
    const tabs = [makeTab({ tabId: 1, shortTerm: -Infinity })]
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 0 }])
  })

  it('skips tabs that are not capturing', () => {
    const tabs = [makeTab({ tabId: 1, isCapturing: false })]
    expect(computeBalanceGains(tabs, -14)).toEqual([])
  })

  it('clamps gain to the tab maxGainDb', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -30, maxGainDb: 12 })]
    // raw = -14 - (-30) = +16, clamped down to maxGainDb 12
    expect(computeBalanceGains(tabs, -14)).toEqual([{ tabId: 1, gainDb: 12 }])
  })

  it('clamps gain to the minimum (-60 dB)', () => {
    const tabs = [makeTab({ tabId: 1, shortTerm: -10 })]
    // raw = -80 - (-10) = -70, clamped up to -60
    expect(computeBalanceGains(tabs, -80)).toEqual([{ tabId: 1, gainDb: -60 }])
  })
})

describe('shouldThrottleBalance', () => {
  it('returns true when called within the throttle window', () => {
    expect(shouldThrottleBalance(1000, 1050)).toBe(true)
  })

  it('returns false once the throttle window has elapsed', () => {
    expect(shouldThrottleBalance(1000, 1101)).toBe(false)
  })
})
