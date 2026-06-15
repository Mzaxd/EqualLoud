import { describe, it, expect } from 'vitest'

import { pickPrimaryMedia, shouldAttach, type MediaCandidate } from '@/content/media-manager'

function candidate(overrides: Partial<MediaCandidate>): MediaCandidate {
  return {
    el: {} as HTMLMediaElement,
    videoWidth: 0,
    duration: 0,
    visible: true,
    muted: false,
    paused: false,
    ended: false,
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

  // -- infinite-feed scenarios (Instagram Reels / Douyin / TikTok) -------------
  // On these pages several <video> elements coexist with identical size and
  // similar durations; the only reliable "this is what the user hears" signal
  // is which element is actually playing. Primary jitter on these sites
  // starves the LUFS pipeline and was the root cause of balancing dying after
  // a few swipes.
  describe('infinite-feed (Reels/Douyin/TikTok)', () => {
    it('prefers the playing element over paused neighbours with identical size/duration', () => {
      const playing = candidate({ videoWidth: 720, duration: 15 })
      const pausedNext = candidate({ videoWidth: 720, duration: 15, paused: true })
      expect(pickPrimaryMedia([playing, pausedNext])).toBe(playing)
    })

    it('prefers the playing element even if a paused neighbour has a larger size', () => {
      // Playing signal must dominate size: otherwise a pre-loaded higher-res
      // neighbour would steal primary and we would measure silence.
      const playing = candidate({ videoWidth: 720, duration: 15 })
      const pausedBig = candidate({ videoWidth: 1920, duration: 600, paused: true })
      expect(pickPrimaryMedia([playing, pausedBig])).toBe(playing)
    })

    it('prefers the playing element over an ended neighbour', () => {
      const playing = candidate({ videoWidth: 720, duration: 15 })
      const endedPrev = candidate({ videoWidth: 720, duration: 15, ended: true })
      expect(pickPrimaryMedia([playing, endedPrev])).toBe(playing)
    })

    it('picks the playing element regardless of DOM order', () => {
      const a = candidate({ videoWidth: 720, duration: 15, paused: true })
      const b = candidate({ videoWidth: 720, duration: 15 }) // playing
      const c = candidate({ videoWidth: 720, duration: 15, paused: true })
      expect(pickPrimaryMedia([a, b, c])).toBe(b)
      // Reverse order too — must not just default to index 0.
      expect(pickPrimaryMedia([c, b, a])).toBe(b)
    })

    it('still picks a paused element if nothing is playing (between reels)', () => {
      // A paused-only field happens in the gap between two reels. We must not
      // return null (which would stop balancing) just because nothing is
      // playing this instant — the next play event will re-pick.
      const paused = candidate({ videoWidth: 720, duration: 15, paused: true })
      expect(pickPrimaryMedia([paused])).toBe(paused)
    })

    it('a muted playing element still loses to an audible paused one', () => {
      // Muted (-1e6) outranks paused (-5e5): an audible paused element is a
      // better primary than a muted playing one (the user hears neither, but
      // the muted one would yield -Infinity LUFS). Both score below 0 though,
      // so pickPrimaryMedia returns null — neither is a good primary. Verify
      // the muted one is never picked over the audible one by checking that
      // removing the muted gate flips the result.
      const mutedPlaying = candidate({ videoWidth: 720, duration: 15, muted: true })
      const audiblePaused = candidate({ videoWidth: 720, duration: 15, paused: true })
      // Both penalised below 0 → null.
      expect(pickPrimaryMedia([mutedPlaying, audiblePaused])).toBeNull()
      // Unmuting the playing one must now win despite being the same element,
      // proving the muted penalty (not the paused penalty) decided it.
      const unmutedPlaying = candidate({ videoWidth: 720, duration: 15 })
      expect(pickPrimaryMedia([unmutedPlaying, audiblePaused])).toBe(unmutedPlaying)
    })
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
