import { describe, it, expect, afterEach } from 'vitest'

import { canCreateContext, clampLimiter } from '@/content/audio-graph'

/**
 * canCreateContext() is the gesture-gate that prevents EqualLoud from creating
 * the AudioContext during a muted-autoplay `play` event (which carries no user
 * activation and would emit the "AudioContext was not allowed to start"
 * warning). It is pure logic over navigator.userActivation, so we test it
 * directly; the rest of audio-graph.ts is Web-Audio/DOM-bound and validated by
 * the manual Instagram test (per AGENT.md's "pure functions only" test rule).
 */
describe('canCreateContext', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation')

  afterEach(() => {
    // Restore the real navigator.userActivation between tests.
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'userActivation', originalDescriptor)
    }
  })

  function setUserActivation(isActive: boolean | undefined): void {
    // navigator.userActivation is read-only in jsdom; define it per-test.
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: isActive === undefined ? undefined : { isActive, hasBeenActive: isActive },
    })
  }

  it('returns true when userActivation.isActive is true (real gesture)', () => {
    setUserActivation(true)
    expect(canCreateContext()).toBe(true)
  })

  it('returns false when userActivation.isActive is false (muted autoplay / no gesture)', () => {
    setUserActivation(false)
    expect(canCreateContext()).toBe(false)
  })

  it('falls back to true when userActivation is absent (old browsers never get stuck)', () => {
    setUserActivation(undefined)
    expect(canCreateContext()).toBe(true)
  })
})

/**
 * clampLimiter guards applyLimiter against out-of-range values. Without it,
 * a stale persisted ratio=30 (the default in an older extension version) is
 * fed straight to DynamicsCompressorNode.ratio.setValueAtTime, which clamps
 * silently AND logs "value 30 outside nominal range [1, 20]; value will be
 * clamped" on every SET_LIMITER. This is the regression guard for that bug.
 */
describe('clampLimiter', () => {
  it('clamps ratio above 20 down to 20 (kills the "value 30 outside nominal range" warning)', () => {
    expect(clampLimiter(30, [1, 20])).toBe(20)
  })

  it('clamps ratio below 1 up to 1', () => {
    expect(clampLimiter(0, [1, 20])).toBe(1)
  })

  it('passes an in-range value through unchanged', () => {
    expect(clampLimiter(12, [1, 20])).toBe(12)
    expect(clampLimiter(1, [1, 20])).toBe(1)
    expect(clampLimiter(20, [1, 20])).toBe(20)
  })
})
