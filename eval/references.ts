/**
 * Closed-form reference ("ground truth") values for LUFS measurement checks.
 *
 * The existing tests (`lufs-processor.spec.ts`) compare the worklet against
 * `LufsCalculator` — i.e. two internal implementations against *each other*.
 * That proves parity, not correctness. This module provides correctness:
 * analytic LUFS values computed directly from the ITU-R BS.1770-4 K-weighting
 * filter coefficients, against which `LufsCalculator` can be checked.
 *
 * ## Derivation
 *
 * K-weighting is two cascaded biquads (high-shelf then high-pass). For a
 * steady-state complex exponential x[n] = A·e^{jωn}, a stable IIR filter
 * responds with gain |H(e^{jω})|. So a pure sine at frequency f, peak
 * amplitude A, has:
 *
 *   mean_square per channel (after K-weighting) = (A² / 2) · |H(f)|²
 *
 * BS.1770 loudness (stereo, equal weights w_L = w_R = 1.0):
 *
 *   LUFS = −0.691 + 10·log₁₀( Σ_channel w · mean_square )
 *        = −0.691 + 10·log₁₀( 2 · (A²/2) · |H(f)|² )
 *        = −0.691 + 10·log₁₀( A² · |H(f)|² )            [stereo, identical L/R]
 *
 * For mono (single channel, w = 1.0):
 *
 *   LUFS = −0.691 + 10·log₁₀( (A²/2) · |H(f)|² )
 *
 * So copying a mono signal into both stereo channels raises LUFS by exactly
 * 10·log₁₀(2) = 3.0103 dB — independent of frequency or amplitude. And
 * doubling the peak amplitude raises LUFS by exactly 6.0206 dB. These two
 * invariants anchor the linearity tests.
 *
 * The full-scale 1 kHz stereo sine comes out to ≈ +0.007 LUFS (≈ 0), which is
 * the natural absolute reference point.
 */

// K-weighting coefficients — duplicated from src/audio/lufs.ts (48 kHz). They
// are the algorithm's fixed constants; importing from lufs.ts would create a
// false sense of independence for a *correctness* check. If the two ever drift,
// that is itself a bug to surface.
const HS_B: readonly [number, number, number] = [
  1.53512485958697, -2.69169618940638, 1.19839281085285,
]
const HS_A: readonly [number, number, number] = [1.0, -1.69065929318241, 0.73248077421585]
const HP_B: readonly [number, number, number] = [1.0, -2.0, 1.0]
const HP_A: readonly [number, number, number] = [1.0, -1.99004745483398, 0.99007225036621]

/** Standard sample rate the algorithm is tuned for. */
export const REF_SAMPLE_RATE = 48000

/** −0.691 dB anchor constant from BS.1770-4 (the "loudness offset"). */
export const LUFS_OFFSET = -0.691

/**
 * Squared magnitude response |H(e^{jω})|² of a biquad
 *   H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 * evaluated at digital frequency ω = 2π·f/Fs.
 *
 * This is the textbook DTFT of a second-order section; it has no state and
 * involves no filtering, so it is independent of the runtime filter
 * implementation (which processes sample-by-sample with feedback state).
 */
function biquadMagSq(
  b: readonly [number, number, number],
  a: readonly [number, number, number],
  w: number,
): number {
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  // e^{-jw}: cos(w) - j·sin(w);  e^{-2jw}: cos(2w) - j·sin(2w)
  const numRe = b[0] + b[1] * c1 + b[2] * c2
  const numIm = -(b[1] * s1 + b[2] * s2)
  const denRe = 1 + a[1] * c1 + a[2] * c2
  const denIm = -(a[1] * s1 + a[2] * s2)
  const numSq = numRe * numRe + numIm * numIm
  const denSq = denRe * denRe + denIm * denIm
  return numSq / denSq
}

/**
 * Total K-weighting power gain |H_K(f)|² at frequency `freqHz` for the given
 * sample rate (coefficients are tuned for 48 kHz; passing another rate here
 * only retunes the digital frequency mapping, it does *not* re-derive the
 * analog prototype — matching what the runtime filter would do at that rate).
 */
export function kWeightingMagSq(freqHz: number, sampleRate: number = REF_SAMPLE_RATE): number {
  const w = (2 * Math.PI * freqHz) / sampleRate
  return biquadMagSq(HS_B, HS_A, w) * biquadMagSq(HP_B, HP_A, w)
}

/**
 * Analytic LUFS of a pure sine wave of peak amplitude `amplitudeDb` (dBFS),
 * where both stereo channels carry the *identical* signal.
 *
 *   LUFS = −0.691 + 10·log₁₀( A² · |H_K(f)|² )
 */
export function sineStereoLufs(freqHz: number, amplitudeDb: number): number {
  const A = Math.pow(10, amplitudeDb / 20)
  const ms = A * A * kWeightingMagSq(freqHz)
  if (ms <= 0) return -Infinity
  return LUFS_OFFSET + 10 * Math.log10(ms)
}

/**
 * Analytic LUFS of a pure sine wave carried on a single mono channel.
 *
 *   LUFS = −0.691 + 10·log₁₀( (A²/2) · |H_K(f)|² )
 */
export function sineMonoLufs(freqHz: number, amplitudeDb: number): number {
  const A = Math.pow(10, amplitudeDb / 20)
  const ms = ((A * A) / 2) * kWeightingMagSq(freqHz)
  if (ms <= 0) return -Infinity
  return LUFS_OFFSET + 10 * Math.log10(ms)
}

/** Exact dB gain from doubling peak amplitude (10·log₁₀ 4). */
export const DOUBLE_AMPLITUDE_GAIN_DB = 20 * Math.log10(2) // 6.0206

/** Exact dB gain from duplicating one channel into stereo (10·log₁₀ 2). */
export const MONO_TO_STEREO_GAIN_DB = 10 * Math.log10(2) // 3.0103

/**
 * Convenience: absolute reference points used by the measurement spec.
 * Computed at module load from the formulas above, so they always track the
 * coefficients. Comment values are what they evaluate to at 48 kHz.
 */
export const REFERENCE_POINTS = {
  /** Full-scale (0 dBFS) 1 kHz stereo sine ≈ +0.007 LUFS. */
  fullScale1kHzStereo: sineStereoLufs(1000, 0),
  /** Full-scale 100 Hz stereo sine (low-frequency K-weight attenuation ≈ −1.83 dB vs 1 kHz). */
  fullScale100HzStereo: sineStereoLufs(100, 0),
  /** Full-scale 5 kHz stereo sine (high-shelf K-weight boost ≈ +3.3 dB vs 1 kHz). */
  fullScale5kHzStereo: sineStereoLufs(5000, 0),
} as const
