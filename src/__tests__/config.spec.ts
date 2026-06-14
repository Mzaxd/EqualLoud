import { describe, it, expect } from 'vitest'

import {
  BOOST_REPORT_HZ,
  BOOST_REPORT_MS,
  GAIN_ATTACK_TC,
  GAIN_SMOOTH_TC,
  LUFS_REPORT_HZ,
} from '@/audio/config'

/**
 * Invariants for the latency-reduction tuning knobs. These relationships are
 * what make the warm-up fast path actually faster than steady state — if any
 * of them flip, the optimisation silently becomes a no-op (or worse, slower).
 */
describe('latency-tuning config invariants', () => {
  it('boosted report rate is faster than the steady rate', () => {
    expect(BOOST_REPORT_HZ).toBeGreaterThan(LUFS_REPORT_HZ)
  })

  it('boost window is positive and finite', () => {
    expect(BOOST_REPORT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(BOOST_REPORT_MS)).toBe(true)
  })

  it('gain attack (decrease) is faster than gain release (increase)', () => {
    // Asymmetric smoothing: pulling a loud tab DOWN must be quicker than
    // pushing a quiet tab UP, because a decrease never clicks while an
    // increase can. If this flips, loud tabs take longer to tame than quiet
    // tabs take to boost — the opposite of what we want.
    expect(GAIN_ATTACK_TC).toBeLessThan(GAIN_SMOOTH_TC)
    expect(GAIN_ATTACK_TC).toBeGreaterThan(0)
    expect(GAIN_SMOOTH_TC).toBeGreaterThan(0)
  })
})
