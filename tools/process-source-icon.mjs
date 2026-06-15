/**
 * Process the AI-generated source image (下载.jpeg) into a clean icon tile.
 *
 * The source (1024×1024) has a dark rounded-square tile centered on a lighter
 * gradient border. The tile itself carries a navy→gold vertical gradient with
 * white geometric audio bars. Two problems to fix:
 *
 *  1. Border: crop 95px each side (measured; see verify-crop.mjs) removes the
 *     light border on the straight edges.
 *  2. Rounded corners: the tile's corners curve inward, exposing the light
 *     border gradient in the corners even after cropping. We repaint those
 *     corner regions with a color sampled from the adjacent tile edge, so the
 *     final icon is a clean square (Chrome/OS applies its own corner rounding).
 *
 * Output: public/icons/source.png (1024×1024) — the master for generate-icons.mjs.
 *
 * Run: node tools/process-source-icon.mjs
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
      `This script is a one-off that crops the original AI-generated icon source.\n` +
      `The processed result already lives at public/icons/source.png.\n` +
      `To re-skin: drop a new square image (≥1024×1024) at the repo root as\n` +
      `"下载.jpeg", then re-run this script.`,
  )
  process.exit(1)
}

const meta = await sharp(src).metadata()
const W = meta.width
const H = meta.height
console.log(`source: ${W}×${H} (${meta.format})`)

// 1) Crop the straight-edge border.
const b = 95
const tileW = W - 2 * b
const tileH = H - 2 * b
console.log(`crop ${b}px border → {${tileW}×${tileH}}`)

const cropped = sharp(src).extract({ left: b, top: b, width: tileW, height: tileH })

// Work in raw RGB to repaint corners.
const CC = 3
const cr = await cropped.removeAlpha().raw().toBuffer()
// Derive dimensions from the buffer: extract guarantees cw===ch (square crop),
// and removeAlpha → 3 channels.
const cw = tileW
const ch = tileH
if (cr.length !== cw * ch * CC) {
  throw new Error(`buffer mismatch: have ${cr.length}, expected ${cw * ch * CC}`)
}
const at = (x, y) => (y * cw + x) * CC
const lum = (i) => 0.299 * cr[i] + 0.587 * cr[i + 1] + 0.114 * cr[i + 2]

// 2) Repaint bright corner regions. The tile interior is never bright (lum<190);
// any pixel with lum>150 in the corner quadrants is border bleed. For each such
// pixel, replace it with the color of the nearest non-bright pixel along the
// same row/column (i.e. the tile's local gradient color at that position).
//
// Process corner by corner. For the top corners, the local tile color is dark
// (navy); for bottom corners, gold. Sampling inward along the row/col gives the
// right local gradient color automatically.
const CORNER = Math.floor(cw * 0.18) // treat outer 18% as corner zones
const BRIGHT = 150

function repaintCorner(xRange, yRange) {
  // xRange/yRange are [start,end) pixel ranges forming the corner quadrant.
  for (let y = yRange[0]; y < yRange[1]; y++) {
    for (let x = xRange[0]; x < xRange[1]; x++) {
      const i = at(x, y)
      if (lum(i) <= BRIGHT) continue // already tile-colored, leave it
      // Find nearest non-bright color by scanning inward (toward image center).
      let ref = null
      // try same row, moving toward center
      const xStep = x < cw / 2 ? 1 : -1
      for (let xx = x + xStep; xx >= 0 && xx < cw; xx += xStep) {
        const ii = at(xx, y)
        if (lum(ii) <= BRIGHT) {
          ref = ii
          break
        }
      }
      // also try same column toward center, pick closer match
      if (ref === null) {
        const yStep = y < ch / 2 ? 1 : -1
        for (let yy = y + yStep; yy >= 0 && yy < ch; yy += yStep) {
          const ii = at(x, yy)
          if (lum(ii) <= BRIGHT) {
            ref = ii
            break
          }
        }
      }
      if (ref !== null) {
        cr[i] = cr[ref]
        cr[i + 1] = cr[ref + 1]
        cr[i + 2] = cr[ref + 2]
      }
    }
  }
}

console.log('repainting rounded corners with local tile color…')
repaintCorner([0, CORNER], [0, CORNER]) // TL
repaintCorner([cw - CORNER, cw], [0, CORNER]) // TR
repaintCorner([0, CORNER], [ch - CORNER, ch]) // BL
repaintCorner([cw - CORNER, cw], [ch - CORNER, ch]) // BR

const out = resolve(root, 'public/icons/source.png')
await sharp(cr, { raw: { width: cw, height: ch, channels: CC } })
  .resize(1024, 1024, { fit: 'cover', position: 'center' })
  .png()
  .toFile(out)

console.log(`\n✓ wrote clean tile → public/icons/source.png (1024×1024)`)
