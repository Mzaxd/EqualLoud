/**
 * Generate the EqualLoud toolbar icons from the redesign's brand mark.
 *
 * Brand mark (from onboarding.html): three rounded bars of increasing height
 * crossed by a horizontal line with a dot at the midpoint — "everything
 * levelled to one target". The bars are neutral warm greys (the content);
 * the single honey line is the target every bar converges to.
 *
 * Two variants:
 *  - detail (48/128): full mark incl. the midpoint dot
 *  - small   (16/32): dot dropped, line thickened, bars nudged apart so the
 *                     mark stays legible at 16px (sub-pixel detail just smears)
 *
 * Colours are the honey token hues, pre-converted to sRGB hex (see below).
 */
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.resolve(__dirname, '..', 'public')

// ── Brand colours: bars darkened for light-chrome legibility ───────────────
// The prototype drew low-chroma LIGHT bars (oklch L 58/74/90) meant for the
// dark popup header. Lifted verbatim onto a WHITE toolbar those near-white bars
// vanish into the chrome. Here the bars keep the same warm-grey hue + low
// chroma (so they still read as neutral "content" vs the single gold target
// line) but are shifted darker (L 35/47/59), giving ≥4:1 contrast on white.
//
// NOTE: written as sRGB hex, NOT oklch. sharp's SVG rasteriser (resvg) cannot
// parse the oklch() function and silently falls back to black (the bug that
// produced an all-black icon in an earlier cut). Values below are the exact
// sRGB of the chosen oklch, converted via culori.
const BAR1 = '#4a3625' // oklch(35% 0.04 60) — short bar, deep warm brown
const BAR2 = '#6c5644' // oklch(47% 0.04 60) — mid bar, mid warm brown
const BAR3 = '#907866' // oklch(59% 0.04 60) — tall bar, light warm brown
const LINE = '#f1bf51' // oklch(83% 0.138 84) — honey accent: the cross-line
const DOT = '#f1bf51' // oklch(83% 0.138 84) — honey accent: the midpoint dot

/** Full-detail mark (used at 48 + 128 px). 24×24 artboard, no background tile. */
function detailSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128">
  <rect x="3" y="11" width="4" height="9" rx="1.3" fill="${BAR1}"/>
  <rect x="10" y="7" width="4" height="13" rx="1.3" fill="${BAR2}"/>
  <rect x="17" y="4" width="4" height="16" rx="1.3" fill="${BAR3}"/>
  <path d="M1.5 14.5H23.5" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="12" cy="14.5" r="1.9" fill="${DOT}"/>
</svg>`
}

/** Simplified mark for tiny sizes (16 + 32 px): no dot, thicker line + bars. */
function smallSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128">
  <rect x="3" y="10" width="4.5" height="10" rx="1.3" fill="${BAR1}"/>
  <rect x="9.75" y="6" width="4.5" height="14" rx="1.3" fill="${BAR2}"/>
  <rect x="16.5" y="3" width="4.5" height="17" rx="1.3" fill="${BAR3}"/>
  <path d="M1.5 14.5H23.5" stroke="${LINE}" stroke-width="2.2" stroke-linecap="round"/>
</svg>`
}

/** Render an SVG string to a sized PNG, supersampling for crisp edges. */
async function render(svgSrc, size, file) {
  const supersample = Math.max(4, Math.round(512 / size))
  const buf = await sharp(Buffer.from(svgSrc))
    .resize(size * supersample, size * supersample, { fit: 'fill' })
    .png()
    .toBuffer()
  await sharp(buf).resize(size, size, { fit: 'fill' }).png().toFile(file)
  const stat = fs.statSync(file)
  console.log(`  ${path.basename(file)}  ${size}×${size}  ${(stat.size / 1024).toFixed(1)} KB`)
}

/** Build a multi-size favicon.ico (PNG-in-ICO; supported by all modern browsers). */
async function buildFavicon() {
  const png16 = fs.readFileSync(path.join(OUT, 'logo@16w.png'))
  const png32 = fs.readFileSync(path.join(OUT, 'logo@32w.png'))
  const png48 = fs.readFileSync(path.join(OUT, 'logo@48w.png'))

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(3, 4) // 3 images

  const dataOffset = 6 + 16 * 3
  const mk = (size, png, offset) => {
    const b = Buffer.alloc(16)
    b.writeUInt8(size, 0) // width
    b.writeUInt8(size, 1) // height
    b.writeUInt8(0, 2) // colors
    b.writeUInt8(0, 3) // reserved
    b.writeUInt16LE(1, 4) // planes
    b.writeUInt16LE(32, 6) // bpp
    b.writeUInt32LE(png.length, 8) // size
    b.writeUInt32LE(offset, 12) // offset
    return b
  }
  const e16 = mk(16, png16, dataOffset)
  const e32 = mk(32, png32, dataOffset + png16.length)
  const e48 = mk(48, png48, dataOffset + png16.length + png32.length)
  const ico = Buffer.concat([header, e16, e32, e48, png16, png32, png48])
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico)
  console.log(`  favicon.ico  ${ico.length} bytes (16+32+48 PNG-in-ICO)`)
}

/** High-res source file for editing / store listings. */
async function buildSource() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="512" height="512">
  <rect x="3" y="11" width="4" height="9" rx="1.3" fill="${BAR1}"/>
  <rect x="10" y="7" width="4" height="13" rx="1.3" fill="${BAR2}"/>
  <rect x="17" y="4" width="4" height="16" rx="1.3" fill="${BAR3}"/>
  <path d="M1.5 14.5H23.5" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="12" cy="14.5" r="1.9" fill="${DOT}"/>
</svg>`
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, 'icons', 'source.png'))
  console.log('  icons/source.png  512×512')
}

async function main() {
  console.log('Rendering EqualLoud toolbar icons (design-original palette) →')
  const detail = detailSvg()
  const small = smallSvg()
  await render(detail, 128, path.join(OUT, 'logo@128w.png'))
  await render(detail, 48, path.join(OUT, 'logo@48w.png'))
  await render(small, 32, path.join(OUT, 'logo@32w.png'))
  await render(small, 16, path.join(OUT, 'logo@16w.png'))
  await buildFavicon()
  await buildSource()
  console.log('done.')
}

// Only run when invoked directly, not when required — guards against the
// side-effect of re-rendering if this file is ever imported by another script.
if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}

module.exports = { detailSvg, smallSvg, render, buildFavicon, buildSource, main }
