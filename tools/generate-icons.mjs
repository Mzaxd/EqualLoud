/**
 * EqualLoud icon generator.
 *
 * Renders the app icon PNGs + favicon.ico from a single high-resolution source
 * PNG (public/icons/source.png, produced by process-source-icon.mjs). All sizes
 * are downscaled from the same 1024×1024 master with Lanczos resampling for
 * crisp small sizes.
 *
 * Outputs (overwrites) — names are fixed; manifest.config.ts & index.html
 * reference them by name, so do NOT rename:
 *   public/logo@16w.png  logo@32w.png  logo@48w.png  logo@128w.png
 *   public/logo.png      (1024 px master copy of the source)
 *   public/favicon.ico   (ICO wrapping a 32×32 PNG)
 *
 * Workflow:
 *   1. node tools/process-source-icon.mjs   (one-off: crop AI image → source.png)
 *   2. node tools/generate-icons.mjs         (this: source.png → all sizes)
 *
 * To re-skin the icon later: replace 下载.jpeg, re-run step 1, then step 2.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pub = resolve(root, 'public')
const srcPath = resolve(pub, 'icons', 'source.png')

const source = await readFile(srcPath)
console.log('Generating EqualLoud icons from public/icons/source.png …')

/**
 * Wrap a single PNG buffer in a minimal ICO container (ICO-with-PNG, supported
 * by all modern browsers/OSes since Vista). Layout:
 *   ICONDIR       6 B   (reserved=0, type=1, count=1)
 *   ICONDIRENTRY 16 B   (w,h=0→256, colors=0, reserved=0, planes=1, bpp=32,
 *                        size, offset=22)
 *   PNG data      N B
 */
function pngToIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = 1 (icon)
  header.writeUInt16LE(1, 4) // count = 1 image

  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // width  (0 means 256)
  entry.writeUInt8(0, 1) // height (0 means 256)
  entry.writeUInt8(0, 2) // color palette count (0 = no palette)
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(png.length, 8) // image byte size
  entry.writeUInt32LE(22, 12) // offset to image data (6 + 16)

  return Buffer.concat([header, entry, png])
}

async function render(size, outName) {
  const png = await sharp(source)
    .resize(size, size, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
    .png()
    .toBuffer()
  await writeFile(resolve(pub, outName), png)
  console.log(`  ✓ ${outName} (${size}×${size}, ${png.length} B)`)
  return png
}

await render(16, 'logo@16w.png')
await render(32, 'logo@32w.png')
await render(48, 'logo@48w.png')
await render(128, 'logo@128w.png')
await render(1024, 'logo.png')

// favicon.ico — 32×32 PNG inside an ICO wrapper
const favPng = await sharp(source)
  .resize(32, 32, { fit: 'cover', position: 'center', kernel: 'lanczos3' })
  .png()
  .toBuffer()
await writeFile(resolve(pub, 'favicon.ico'), pngToIco(favPng))
console.log(`  ✓ favicon.ico (32×32 PNG-in-ICO, ${pngToIco(favPng).length} B)`)

console.log('Done.')
