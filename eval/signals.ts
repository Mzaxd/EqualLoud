/**
 * Deterministic audio signal generators for the balance-evaluation suite.
 *
 * Everything here is seeded (mulberry32) so that every run of the eval suite
 * produces *bit-identical* audio. Reproducibility is the whole point: an
 * evaluation result must be comparable across runs, versions, and machines.
 *
 * No Web Audio, no DOM — plain Float32Array math. The pink-noise generator is
 * the same Voss-McCartney filter used by `tools/loudness-test.html` so the eval
 * material matches the project's existing manual test source.
 *
 * Convention: "dBFS-amplitude" below means the peak amplitude of a sample
 * stream expressed as `20·log10(amp)`; i.e. `amp = dbToGain(db)`. This is the
 * natural knob for synthetic test tones and is what `loudness-test.html`'s
 * gain slider already exposes.
 */

/** Convert dB → linear amplitude. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** Convert linear amplitude → dB. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain)
}

/**
 * mulberry32 — a tiny, fast, fully deterministic PRNG. Seeding it makes every
 * eval run reproducible. Returns a function that produces floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TWO_PI = Math.PI * 2

/** A single channel of samples; helpers build interleaved stereo from these. */
export interface MonoSignal {
  /** Per-sample amplitudes in [-1, 1]. */
  samples: Float32Array
  sampleRate: number
}

export interface StereoSignal {
  /** Interleaved [L, R, L, R, …] amplitudes in [-1, 1]. */
  samples: Float32Array
  sampleRate: number
  channels: 2
}

/** Interleave two mono channels into a stereo buffer. */
export function interleave(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length !== right.length) {
    throw new Error(`interleave: channel length mismatch (${left.length} vs ${right.length})`)
  }
  const out = new Float32Array(left.length * 2)
  for (let i = 0; i < left.length; i++) {
    out[i * 2] = left[i] ?? 0
    out[i * 2 + 1] = right[i] ?? 0
  }
  return out
}

/** Make a stereo signal where both channels carry identical samples. */
export function monoToStereo(mono: MonoSignal): StereoSignal {
  return {
    samples: interleave(mono.samples, mono.samples),
    sampleRate: mono.sampleRate,
    channels: 2,
  }
}

/**
 * Generate a pure sine tone at a given dBFS peak amplitude.
 *
 * A *full-scale* 1 kHz sine (0 dBFS) is the canonical reference for which
 * ITU-R BS.1770's K-weighting has a known, closed-form gain — see references.ts.
 * So sine tones are the natural anchor for absolute-loudness checks.
 */
export function sine(args: {
  sampleRate: number
  durationSec: number
  freqHz: number
  /** Peak amplitude in dBFS. 0 = full scale. */
  amplitudeDb: number
  phase?: number
}): MonoSignal {
  const { sampleRate, durationSec, freqHz, amplitudeDb } = args
  const amp = dbToGain(amplitudeDb)
  const n = Math.floor(durationSec * sampleRate)
  const samples = new Float32Array(n)
  const phase = args.phase ?? 0
  for (let i = 0; i < n; i++) {
    samples[i] = Math.sin((TWO_PI * freqHz * i) / sampleRate + phase) * amp
  }
  return { samples, sampleRate }
}

/**
 * Voss-McCartney pink noise. Same filter chain as `tools/loudness-test.html`
 * so the eval material matches the project's existing manual test source.
 * Pink noise is the right test signal for balancing because its spectrum is
 * close to natural speech/music and its LUFS stabilises within seconds.
 *
 * `amplitudeDb` scales the *reference* output (the `* 0.11` factor in the
 * original is folded in here as the 0 dBFS point).
 *
 * Overloads pin the return type to `StereoSignal` when `channels: 2` (the
 * common case for balance tests) so callers don't have to narrow a union.
 */
export function pinkNoise(args: {
  sampleRate: number
  durationSec: number
  amplitudeDb: number
  seed: number
  channels: 2
}): StereoSignal
export function pinkNoise(args: {
  sampleRate: number
  durationSec: number
  amplitudeDb: number
  seed: number
  channels?: 1
}): MonoSignal
export function pinkNoise(args: {
  sampleRate: number
  durationSec: number
  amplitudeDb: number
  seed: number
  channels?: 1 | 2
}): MonoSignal | StereoSignal {
  const { sampleRate, durationSec, amplitudeDb, seed } = args
  const channels = args.channels ?? 1
  const n = Math.floor(durationSec * sampleRate)
  const scale = dbToGain(amplitudeDb)

  // Generate each channel from its own seeded PRNG so L ≠ R but the whole
  // buffer is still reproducible.
  const chans: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const rand = mulberry32(seed + c * 0x9e3779b9)
    const data = new Float32Array(n)
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.969 * b2 + white * 0.153852
      b3 = 0.8665 * b3 + white * 0.3104856
      b4 = 0.55 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.115926) * 0.11 * scale
      b6 = white * 0.5362
    }
    chans.push(data)
  }

  if (channels === 1) {
    return { samples: chans[0]!, sampleRate }
  }
  return { samples: interleave(chans[0]!, chans[1]!), sampleRate, channels: 2 }
}

/**
 * A segment of a dynamic test signal: one amplitude level held for an interval.
 * Scenarios compose several of these to model e.g. "podcast, then a loud ad,
 * then back to podcast".
 */
export interface LevelSegment {
  /** Peak amplitude during this segment, in dBFS. */
  amplitudeDb: number
  /** How long to hold this level. */
  durationSec: number
}

/**
 * Concatenate per-segment pink noise into one continuous stereo buffer. Each
 * segment uses its own seed-derived noise (no cross-seam continuity needed;
 * pink noise is stationary). Used for dynamic scenarios (ads, level jumps…).
 */
export function pinkNoiseScenario(
  sampleRate: number,
  segments: LevelSegment[],
  seed: number,
): StereoSignal {
  const totalSec = segments.reduce((s, seg) => s + seg.durationSec, 0)
  const total = Math.floor(totalSec * sampleRate) * 2
  const out = new Float32Array(total)
  let offset = 0
  let segIdx = 0
  for (const seg of segments) {
    const segSig = pinkNoise({
      sampleRate,
      durationSec: seg.durationSec,
      amplitudeDb: seg.amplitudeDb,
      seed: seed + segIdx * 101,
      channels: 2,
    }) as StereoSignal
    for (let i = 0; i < segSig.samples.length; i++) {
      out[offset + i] = segSig.samples[i] ?? 0
    }
    offset += segSig.samples.length
    segIdx++
  }
  return { samples: out, sampleRate, channels: 2 }
}

/** A pure-silence stereo buffer (for the "silence gap" scenarios). */
export function silence(sampleRate: number, durationSec: number): StereoSignal {
  return {
    samples: new Float32Array(Math.floor(durationSec * sampleRate) * 2),
    sampleRate,
    channels: 2,
  }
}

/**
 * Pink-noise peak amplitude (dBFS) that yields a given measured LUFS.
 *
 * Pink noise's measured LUFS sits a fixed 11.85 dB below its peak dBFS
 * amplitude (verified empirically — see references.ts for why pink noise has
 * a stable LUFS regardless of seed). So to synthesise a tab that *measures*
 * −24 LUFS we generate pink noise at ≈ −12.15 dBFS. Centralised here so the
 * specs and the tuner share one source of truth instead of re-deriving it.
 */
export function pinkAmpDbFor(lufs: number): number {
  return lufs + 11.85
}

/**
 * Append two stereo buffers end-to-end. Used to stitch e.g.
 * `podcast → silence → podcast`.
 */
export function concatStereo(a: StereoSignal, b: StereoSignal): StereoSignal {
  if (a.sampleRate !== b.sampleRate) {
    throw new Error(`concatStereo: sample-rate mismatch (${a.sampleRate} vs ${b.sampleRate})`)
  }
  const out = new Float32Array(a.samples.length + b.samples.length)
  out.set(a.samples, 0)
  out.set(b.samples, a.samples.length)
  return { samples: out, sampleRate: a.sampleRate, channels: 2 }
}

// ---------------------------------------------------------------------------
// Synthetic "difficult" signals — closer to real-world audio than flat pink
// noise. These exist to stress the limiter and gain smoother in ways pink noise
// cannot: sharp transients (drum hits, plosives) trigger zipper noise on fast
// gain changes; band-limited spectra (voice) expose frequency-dependent limiter
// behaviour. No real audio needed — the *statistical* properties are what matter.
// ---------------------------------------------------------------------------

/**
 * Pink noise with periodic sharp transient bursts superimposed.
 *
 * Models drum hits / plosives / explosion SFX: a low-level noise bed (the
 * "program material") punctuated every `intervalMs` by a short high-amplitude
 * spike (the "transient"). The transient is a decaying pulse a few ms long —
 * short enough to be gone before the balance loop reacts, but loud enough to
 * make the limiter and gain smoother work.
 *
 * This is the signal that punishes overly-fast gain time constants: if the
 * smoother reacts within the transient's duration it will modulate audible
 * gain *during* the transient, producing a click or "breathing" artefact.
 *
 * @param intervalMs  Time between transients (e.g. 500 ms = 2 hits/sec).
 * @param transientDb Peak amplitude of the transient burst in dBFS (e.g. −3).
 * @param transientMs Duration of the burst envelope (e.g. 5 ms).
 */
export function transientBurst(args: {
  sampleRate: number
  durationSec: number
  /** Peak amplitude of the noise bed, in dBFS. */
  bedAmplitudeDb: number
  /** Peak amplitude of each transient burst, in dBFS. */
  transientDb: number
  /** Time between transients, in ms. */
  intervalMs: number
  /** Duration of each transient burst's decay envelope, in ms. */
  transientMs: number
  seed: number
}): StereoSignal {
  const { sampleRate, durationSec, bedAmplitudeDb, transientDb, intervalMs, transientMs, seed } =
    args
  const n = Math.floor(durationSec * sampleRate)
  const intervalSamples = Math.floor((intervalMs / 1000) * sampleRate)
  const transientSamples = Math.floor((transientMs / 1000) * sampleRate)
  const bedAmp = dbToGain(bedAmplitudeDb)
  const transAmp = dbToGain(transientDb)

  const out = new Float32Array(n * 2)
  // Two independent pink-noise beds for L/R, seeded for reproducibility.
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(seed + ch * 0x9e3779b9)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    let nextTransient = intervalSamples // first transient after one interval
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1
      b0 = 0.99886 * b0 + white * 0.0555179
      b1 = 0.99332 * b1 + white * 0.0750759
      b2 = 0.969 * b2 + white * 0.153852
      b3 = 0.8665 * b3 + white * 0.3104856
      b4 = 0.55 * b4 + white * 0.5329522
      b5 = -0.7616 * b5 - white * 0.016898
      let sample = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.115926) * 0.11 * bedAmp
      b6 = white * 0.5362

      // Transient: schedule + exponential decay envelope.
      if (i >= nextTransient && i < nextTransient + transientSamples) {
        const intoTransient = i - nextTransient
        // Exponential decay from 1 → ~0.01 over transientSamples.
        const env = Math.exp(-5 * (intoTransient / transientSamples))
        // The transient is a sharp click-like pulse (high-frequency weighted).
        sample += white * transAmp * env
      } else if (i >= nextTransient + transientSamples) {
        nextTransient += intervalSamples
      }
      out[i * 2 + ch] = sample
    }
  }
  return { samples: out, sampleRate, channels: 2 }
}

/**
 * Band-limited noise approximating the human voice spectrum (300 Hz – 3 kHz).
 *
 * Real speech concentrates energy in the 300 Hz–3 kHz range. A flat-spectrum
 * test signal like white/pink noise does not stress the limiter or K-weighting
 * filter the same way. This generator produces pink noise then applies a simple
 * band-pass to emulate the voice band, giving the tuner a spectrally-distinct
 * scenario without needing real recordings.
 *
 * The band-pass is a one-pole high-pass at 300 Hz cascaded with a one-pole
 * low-pass at 3 kHz — crude but sufficient to shift the spectral centroid into
 * the voice range, which is all the tuner needs to detect frequency-dependent
 * parameter biases.
 */
export function voiceBandNoise(args: {
  sampleRate: number
  durationSec: number
  amplitudeDb: number
  seed: number
}): StereoSignal {
  const { sampleRate, durationSec, amplitudeDb, seed } = args
  const n = Math.floor(durationSec * sampleRate)
  const scale = dbToGain(amplitudeDb)

  // One-pole filter coefficients.
  // High-pass at 300 Hz: y = x − lp(x), where lp has coeff α = 1 − e^(−2πf/fs).
  const hpAlpha = 1 - Math.exp((-2 * Math.PI * 300) / sampleRate)
  // Low-pass at 3 kHz: α = 1 − e^(−2πf/fs).
  const lpAlpha = 1 - Math.exp((-2 * Math.PI * 3000) / sampleRate)

  const out = new Float32Array(n * 2)
  for (let ch = 0; ch < 2; ch++) {
    const rand = mulberry32(seed + ch * 0x9e3779b9)
    let lpState = 0 // for the high-pass's internal low-pass
    let lpFinal = 0 // for the output low-pass
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1
      // First: make it pink-ish (so the band-passed result isn't pure white).
      // Minimal pink filter (1 stage) for spectral tilt.
      lpState += hpAlpha * (white - lpState)
      const highPassed = white - lpState
      // Second: low-pass at 3 kHz.
      lpFinal += lpAlpha * (highPassed - lpFinal)
      out[i * 2 + ch] = lpFinal * scale
    }
  }
  return { samples: out, sampleRate, channels: 2 }
}
