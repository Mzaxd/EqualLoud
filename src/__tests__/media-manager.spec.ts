import { describe, it, expect } from 'vitest'

import { pickPrimaryMedia, shouldAttach, type MediaCandidate } from '@/content/media-manager'

function candidate(overrides: Partial<MediaCandidate>): MediaCandidate {
  return {
    el: {} as HTMLMediaElement,
    videoWidth: 0,
    duration: 0,
    visible: true,
    muted: false,
    ...overrides,
  }
}

describe('pickPrimaryMedia', () => {
  it('returns null for an empty set', () => {
    expect(pickPrimaryMedia([])).toBeNull()
  })

  it('returns the single candidate directly', () => {
    const c = candidate({ videoWidth: 1280 })
    expect(pickPrimaryMedia([c])).toBe(c)
  })

  it('prefers the larger video element', () => {
    const small = candidate({ videoWidth: 320, duration: 300 })
    const big = candidate({ videoWidth: 1920, duration: 300 })
    expect(pickPrimaryMedia([small, big])).toBe(big)
  })

  it('prefers the longer element when sizes tie', () => {
    const short = candidate({ videoWidth: 1280, duration: 15 })
    const long = candidate({ videoWidth: 1280, duration: 600 })
    expect(pickPrimaryMedia([short, long])).toBe(long)
  })

  it('strongly avoids invisible elements', () => {
    const invisible = candidate({ videoWidth: 1920, duration: 600, visible: false })
    const visible = candidate({ videoWidth: 320, duration: 30, visible: true })
    expect(pickPrimaryMedia([invisible, visible])).toBe(visible)
  })

  it('strongly avoids muted elements', () => {
    const muted = candidate({ videoWidth: 1920, duration: 600, muted: true })
    const audible = candidate({ videoWidth: 320, duration: 30, muted: false })
    expect(pickPrimaryMedia([muted, audible])).toBe(audible)
  })

  it('treats audio (videoWidth 0) via duration', () => {
    const podcast = candidate({ videoWidth: 0, duration: 1800 })
    const blip = candidate({ videoWidth: 0, duration: 5 })
    expect(pickPrimaryMedia([podcast, blip])).toBe(podcast)
  })
})

describe('shouldAttach', () => {
  function fakeEl(opts: { connected?: boolean; duration?: number }): HTMLMediaElement {
    return {
      isConnected: opts.connected ?? true,
      duration: opts.duration ?? NaN,
    } as HTMLMediaElement
  }

  it('attaches to a connected element with unknown duration (streaming)', () => {
    expect(shouldAttach(fakeEl({ duration: NaN }))).toBe(true)
  })

  it('attaches to a connected element with positive duration', () => {
    expect(shouldAttach(fakeEl({ duration: 120 }))).toBe(true)
  })

  it('skips a disconnected element', () => {
    expect(shouldAttach(fakeEl({ connected: false, duration: 120 }))).toBe(false)
  })

  it('skips an ultra-short blip (<0.2s)', () => {
    expect(shouldAttach(fakeEl({ duration: 0.1 }))).toBe(false)
  })
})
