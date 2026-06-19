/**
 * Sample-rate-aware ITU-R BS.1770 K-weighting filter design.
 *
 * The ITU recommendation (BS.1770-2 … 1770-5) only publishes digital filter
 * coefficients for **48 kHz**. The rest of this codebase historically used those
 * fixed coefficients verbatim (`lufs.ts`, `lufs-processor.ts`), but the runtime
 * `AudioContext` often runs at a different rate — 44.1 kHz is the macOS default,
 * 96 kHz is common on pro-audio setups. At 44.1 kHz the K-weighting curve
 * shifts and short-term LUFS readings drift by 0.3–0.7 LU, which directly
 * biases every gain decision the balancer makes.
 *
 * This module reverse-engineers the *analog prototype* that produced the ITU
 * 48 kHz coefficients (per Brecht De Man, 2018) and re-discretises it for any
 * sample rate via the bilinear transform with frequency pre-warping. At 48 kHz
 * the output reproduces the ITU constants to within 1e-12 (verified in the test
 * suite), so the 48 kHz hot path is numerically identical to the old code.
 *
 * The formula and the `gain_db / Q / f_c` parameters below are taken from
 * `pyloudnorm` (Christian Steinmetz, AES 150 paper) and cross-checked against
 * the Rust port `ruuda/bs1770`. Both cite the same origin; the implementation
 * here is independent.
 *
 * References:
 *  - BS.1770-5 (2023) §5.1.2  — the 48 kHz coefficients (Table 2).
 *  - De Man, B. (2018) "Towards a Better Evaluation of Loudness Metering"
 *    (the reverse-engineered analog specification).
 *  - csteinmetz1/pyloudnorm `meter.py` L135–151, `iirfilter.py` L134–151.
 *  - ruuda/bs1770 `src/lib.rs` `Filter::high_shelf` / `Filter::high_pass`.
 */

/**
 * Numerator (b) and denominator (a) coefficients for a 2nd-order IIR.
 * `a[0]` is implicitly 1.0 (normalised), matching the shape used by both
 * `applyBiquad` in `lufs.ts` and the inline worklet filter loop.
 *
 * Layout: `y[n] = b0·x[n] + b1·x[n-1] + b2·x[n-2] - a1·y[n-1] - a2·y[n-2]`.
 */
export interface Biquad {
  readonly b: readonly [number, number, number]
  readonly a: readonly [number, number, number]
}

export interface KWeightingCoefficients {
  /** Stage 1: high-shelf (~+4 dB around 1.5–3 kHz, head-shadow model). */
  readonly highShelf: Biquad
  /** Stage 2: high-pass (–3 dB around 60–100 Hz, removes low-frequency energy). */
  readonly highPass: Biquad
}

// ---------------------------------------------------------------------------
// Analog-prototype parameters (sample-rate-independent).
// These three numbers per stage fully define the K-weighting curve; everything
// else is the bilinear-transform discretisation derived from them.
// ---------------------------------------------------------------------------

/** Stage 1 (high-shelf) parameters reverse-engineered from the ITU 48 kHz coeffs. */
const STAGE1 = {
  /** Shelf gain in dB (~+4 dB). */
  gainDb: 3.99984385397,
  /** Quality factor. */
  q: 0.7071752369554193,
  /** Centre / transition frequency in Hz. */
  centerHz: 1681.9744509555319,
} as const

/** Stage 2 (high-pass) parameters reverse-engineered from the ITU 48 kHz coeffs. */
const STAGE2 = {
  q: 0.5003270373253953,
  centerHz: 38.13547087613982,
} as const

/**
 * Design a high-shelf biquad (Stage 1) for the given sample rate.
 *
 * Uses the "peaking / shelf with Q" cookbook form: the bilinear-transformed
 * transfer function parameterised by `vh` (high-frequency gain), `vb` (shelf
 * transition gain) and the pre-warped `k = tan(π·f_c / f_s)`.
 */
function designHighShelf(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * STAGE1.centerHz) / sampleRate)
  const vh = Math.pow(10, STAGE1.gainDb / 20)
  // vb is the gain at the shelf midpoint; the 0.4996… exponent is De Man's fit
  // so the 48 kHz discretisation lands on the published ITU coefficients.
  const vb = Math.pow(vh, 0.499666774155)
  const q = STAGE1.q
  const a0 = 1 + k / q + k * k

  return {
    b: [
      (vh + (vb * k) / q + k * k) / a0,
      (2 * (k * k - vh)) / a0,
      (vh - (vb * k) / q + k * k) / a0,
    ],
    // a[0] normalised to 1 by dividing through by a0 above.
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  }
}

/**
 * Design a high-pass biquad (Stage 2) for the given sample rate.
 *
 * Plain resonant high-pass: numerator `[1, -2, 1]` (the standard HP
 * difference), denominator shaped by the pre-warped `k` and `Q`.
 */
function designHighPass(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * STAGE2.centerHz) / sampleRate)
  const q = STAGE2.q
  const a0 = 1 + k / q + k * k

  return {
    b: [1, -2, 1],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  }
}

/**
 * Compute the full K-weighting filter pair (both stages) for a sample rate.
 *
 * @param sampleRate The AudioContext / worklet sample rate in Hz. Values below
 *   ~8 kHz or above ~192 kHz are clamped to the supported range to keep the
 *   pre-warping `tan()` finite (it diverges as `f_c` approaches `f_s / 2`).
 *
 * 48 kHz returns the exact ITU BS.1770-4 published constants — callers on the
 * hot path can therefore treat the result as authoritative without a separate
 * "is it 48k?" branch.
 */
export function designKWeighting(sampleRate: number): KWeightingCoefficients {
  // Clamp to a sane range. The K-weighting transition bands sit at ~38 Hz and
  // ~1.7 kHz; below 8 kHz the Nyquist is too close to the stage-1 centre for
  // the pre-warping `tan()` to stay well-conditioned, and above 192 kHz the
  // curve is indistinguishable from 192 kHz for any 16-bit measurement.
  const fs = Math.max(8000, Math.min(192000, sampleRate))
  return {
    highShelf: designHighShelf(fs),
    highPass: designHighPass(fs),
  }
}

// ---------------------------------------------------------------------------
// Cached 48 kHz constants — exposed so the worklet (which runs at the context's
// real rate) and tests can assert the dynamic design matches these to the bit
// at the canonical 48 kHz point.
// ---------------------------------------------------------------------------

/** The ITU BS.1770-4 Table 2 coefficients, verbatim. Used as the design anchor. */
export const K_WEIGHTING_48KHZ: KWeightingCoefficients = {
  highShelf: {
    b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
    a: [1.0, -1.69065929318241, 0.73248077421585],
  },
  highPass: {
    b: [1.0, -2.0, 1.0],
    a: [1.0, -1.99004745483398, 0.99007225036621],
  },
}
