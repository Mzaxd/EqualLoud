/**
 * Process the AI-generated source image (下载.jpeg) into a clean icon tile.
 *
 * The source (1024×1024 JPEG) carries the icon on a **checkerboard background**
 * — the AI tool baked the "transparency indicator" pattern directly into the
 * pixels (JPEG has no alpha channel, so what looks transparent is actually an
 * 8px-cycle grey checker: light squares ≈rgb(237,237,237), dark squares
 * ≈rgb(181,181,181)). The tile itself is a navy→gold gradient with white audio
 * bars, and is a rounded square.
 *
 * Two-step pipeline:
 *
 *  1. Key out the checkerboard → real alpha (see keying notes below). The AI
 *     tool baked the "transparency indicator" pattern into the pixels (JPEG has
 *     no alpha), so we synthesize one: every checker pixel becomes transparent,
 *     and the tile's rounded corners fall out naturally. Chrome / the OS then
 *     applies its own corner rounding on top — no manual corner repair needed
 *     (which is the defect the old crop-and-repaint pipeline produced).
 *
 *  2. Normalize coverage to 92%. The source leaves the tile floating at ~83%
 *     of the frame (≈8% padding per side), so it renders smaller than other
 *     extensions in the toolbar. We tight-crop to the subject's bounding box
 *     and re-pad to the Chrome-extension safe area (~4% margin per side),
 *     matching the visual size of neighboring icons.
 *
 * Pixel analysis (probe confirms, see git history) showed the subject's colors
 * are disjoint from the checkerboard along TWO axes: the checker is low-
 * saturation grey at high luminance (L>155), while the subject is either
 * saturated (navy/gold) OR dark (navy shadows, L<90). A saturation+luminance
 * key (sat<25 && L>155) cleanly separates them: 100% of the border keys, 0%
 * of the central subject keys. The luminance floor is essential — pure
 * saturation keying punches holes in the navy's near-grey dark regions.
 *
 * Output: public/icons/source.png (1024×1024, RGBA, real alpha) — the master
 * for generate-icons.mjs.
 *
 * Run: node tools/process-source-icon.mjs
 *
 * To re-skin later: drop a new square image (≥1024×1024) at the repo root as
 * "下载.jpeg", then re-run this script.
 */
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = resolve(root, '下载.jpeg')

if (!existsSync(src)) {
  console.error(
    `Source image not found: 下载.jpeg\n` +
      `Drop a new square image (≥1024×1024) at the repo root as "下载.jpeg",\n` +
      `then re-run this script.`,
  )
  process.exit(1)
}

// Saturation + luminance key. The subject (navy tile + gold waveform) and the
// checkerboard separate cleanly along BOTH axes:
//   light square  L≈249, sat≈0.7   →  sat<KEY_SAT && L>LUM_FLOOR  ✓ keyed
//   dark  square  L≈178, sat≈1.4   →  sat<KEY_SAT && L>LUM_FLOOR  ✓ keyed
//   navy tile L≈27 sat 45-165      →  L<LUM_FLOOR                ✓ kept
//   navy shadow L≈27 sat 5-25      →  L<LUM_FLOOR (sat passes!)   ✓ kept ← the
//                                                                    luminance
//                                                                    floor is
//                                                                    essential
//   gold wave   sat > 50           →  sat>=KEY_SAT               ✓ kept
// The subject's darkest navy has near-grey saturation (sat≈5–25), so a pure
// saturation key punched 12k holes in the tile. The L>155 floor excludes that
// dark subject region while keeping every checker square (the darkest checker
// square still clears L≈159). Grid search confirmed: 100% of border pixels
// key correctly, 0% of the central 60% subject region keys.
const KEY_SAT = 25
const LUM_FLOOR = 155

const meta = await sharp(src).metadata()
const W = meta.width
const H = meta.height
console.log(`source: ${W}×${H} (${meta.format})`)

// Read as RGB (the JPEG has no real alpha). We synthesize alpha ourselves.
const CC = 3
const rgb = await sharp(src).removeAlpha().raw().toBuffer()
if (rgb.length !== W * H * CC) {
  throw new Error(`buffer mismatch: have ${rgb.length}, expected ${W * H * CC}`)
}
const at = (x, y) => (y * W + x) * CC

// Build RGBA buffer: copy RGB through, compute alpha from the checker key.
// Hard key (full transparency below the threshold, full opacity above) since
// the threshold sits in empty checkerboard space — no anti-aliasing band to
// feather. The tile's own rounded edge is already anti-aliased against the
// checkerboard in the source, so its fringe pixels are low-sat high-lum and
// get correctly keyed out, leaving a naturally smooth transparent edge.
const rgba = Buffer.alloc(W * H * 4)
let keyed = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = at(x, y)
    const r = rgb[i]
    const g = rgb[i + 1]
    const b = rgb[i + 2]
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    const isChecker = sat < KEY_SAT && lum > LUM_FLOOR
    if (isChecker) keyed++

    const o = (y * W + x) * 4
    rgba[o] = r
    rgba[o + 1] = g
    rgba[o + 2] = b
    rgba[o + 3] = isChecker ? 0 : 255
  }
}
const pct = ((100 * keyed) / (W * H)).toFixed(1)
console.log(`keyed ${keyed} checkerboard pixels → transparent (${pct}% of image)`)

// Normalize the subject to fill the canvas. The AI source leaves the tile
// floating at ~83% of the frame (≈8% padding per side), which renders smaller
// than other extensions in the toolbar. We tight-crop to the opaque subject's
// bounding box, then re-pad to TARGET_COVERAGE (92% — the Chrome extension
// safe-area norm, ~4% margin per side) so the icon visually matches neighbors.
// Aspect ratio is preserved (the bbox is ~square; any sub-pixel drift is
// absorbed by fitting the longer edge and centering).
const TARGET_COVERAGE = 0.92
let minX = W
let minY = H
let maxX = 0
let maxY = 0
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (rgba[(y * W + x) * 4 + 3] > 128) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
const bw = maxX - minX + 1
const bh = maxY - minY + 1
console.log(
  `subject bbox: ${bw}×${bh} at (${minX},${minY}) — ` +
    `${((100 * bw) / W).toFixed(0)}% of canvas, padding to 92%`,
)

// Target frame the subject should occupy, centered, with equal margins.
const target = Math.round(W * TARGET_COVERAGE)
const margin = Math.round((W - target) / 2)
// Composite the cropped subject into a transparent W×W canvas at the target
// position; sharp's resize+extent does this cleanly for near-square subjects.
const out = resolve(root, 'public/icons/source.png')
await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left: minX, top: minY, width: bw, height: bh })
  .resize(target, target, {
    // fit=contain keeps aspect ratio; the bbox is ~square so this is a near-
    // uniform scale. Background is transparent so no letterbox fill leaks.
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: margin,
    bottom: W - target - margin,
    left: margin,
    right: W - target - margin,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toFile(out)

console.log(`\n✓ wrote transparent tile → public/icons/source.png (${W}×${H}, RGBA, 92% coverage)`)
