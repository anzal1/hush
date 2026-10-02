import { expect, test } from 'claude-code/testing'
import {
  auroraCells,
  BACKGROUND,
  canShowImages,
  chooseLayout,
  coverKey,
  coverUrls,
  encodeCells,
  FALLBACK_COLORS,
  fromBase64,
  halfBlockCells,
  palette,
  panelSvg,
  panelWidths,
  parseBmp,
  placeholderCells,
  progressBar,
  SVG_LIMIT,
  toBase64,
  // @ts-expect-error plain JS module, no declarations
} from '../hooks/panel.mjs'
// @ts-expect-error plain JS module, no declarations
import { parseArgs, route } from '../hooks/logic.mjs'

// What sips writes for a 4x4 picture: red, green, blue and white quarters, 24 bits, rows top down.
const SIPS_QUAD =
  'Qk1mAAAAAAAAADYAAAAoAAAABAAAAPz///8BABgAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AP8AAP8AAAD/AAD/AP8AAP8A/wAA/wAA/////////wAA/wAA////////'
const STATIONS = ['lofi', 'jazz', 'chill', 'classical', 'nature']

// A BMP of our own, to cover the shapes sips does not write here.
function bmp(width: number, height: number, bits: 24 | 32, pixel: (x: number, y: number) => number[], topDown: boolean) {
  const stride = Math.floor((bits * width + 31) / 32) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, topDown ? -height : height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, bits, true)
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      const at = row + x * (bits / 8)
      bytes[at] = b
      bytes[at + 1] = g
      bytes[at + 2] = r
    }
  }
  return bytes
}

const solid = (r: number, g: number, b: number, size = 8) => {
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i += 1) rgba.set([r, g, b, 255], i * 4)
  return rgba
}

test('base64 round trips and matches the standard encoding', () => {
  expect(toBase64(new Uint8Array([72, 105]))).toBe('SGk=')
  expect(toBase64(new Uint8Array([72, 105, 33]))).toBe('SGkh')
  expect(toBase64(new Uint8Array([]))).toBe('')
  const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 256))
  expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
})

test('a BMP from sips is read top down into RGBA', () => {
  const image = parseBmp(fromBase64(SIPS_QUAD))
  expect(image.width).toBe(4)
  expect(image.height).toBe(4)
  const at = (x: number, y: number) => Array.from(image.rgba.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4))
  expect(at(0, 0)).toEqual([255, 0, 0, 255])
  expect(at(3, 0)).toEqual([0, 255, 0, 255])
  expect(at(0, 3)).toEqual([0, 0, 255, 255])
  expect(at(3, 3)).toEqual([255, 255, 255, 255])
})

test('bottom up rows, row padding and 32 bit pixels are read the same way', () => {
  const pixel = (x: number, y: number) => [x * 40, y * 40, 7]
  for (const bits of [24, 32] as const) {
    for (const topDown of [true, false]) {
      // width 3 at 24 bits needs a padding byte per row
      const image = parseBmp(bmp(3, 2, bits, pixel, topDown))
      expect(image.width).toBe(3)
      expect(image.height).toBe(2)
      expect(Array.from(image.rgba.slice(0, 4))).toEqual([0, 0, 7, 255])
      expect(Array.from(image.rgba.slice((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4))).toEqual([80, 40, 7, 255])
    }
  }
})

test('anything that is not a plain 24 or 32 bit BMP is refused', () => {
  const good = bmp(2, 2, 24, () => [1, 2, 3], true)
  expect(parseBmp(good)).not.toBeNull()
  expect(parseBmp(new Uint8Array([]))).toBeNull()
  expect(parseBmp(new Uint8Array(100))).toBeNull()
  expect(parseBmp(good.slice(0, good.length - 4))).toBeNull()
  const eight = good.slice()
  new DataView(eight.buffer).setUint16(28, 8, true)
  expect(parseBmp(eight)).toBeNull()
  const packed = good.slice()
  new DataView(packed.buffer).setUint32(30, 1, true)
  expect(parseBmp(packed)).toBeNull()
  const huge = good.slice()
  new DataView(huge.buffer).setInt32(18, 5000, true)
  expect(parseBmp(huge)).toBeNull()
})

test('the palette finds a cover\'s colours and keeps them in a glowing, readable range', () => {
  // half deep blue, a quarter orange, a quarter near white
  const size = 8
  const rgba = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = y < 4 ? [20, 60, 200] : x < 4 ? [230, 120, 20] : [250, 250, 245]
      rgba.set([...color, 255], (y * size + x) * 4)
    }
  }
  const { colors, accent } = palette(rgba)
  expect(colors).toHaveLength(4)
  const [r0, , b0] = colors[0]
  expect(b0).toBeGreaterThan(r0)
  const hasOrange = colors.some(([r, g, b]: number[]) => r > g && g > b)
  expect(hasOrange).toBe(true)
  for (const [r, g, b] of colors.slice(0, 3)) {
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 510
    expect(lightness).toBeGreaterThan(0.28)
    expect(lightness).toBeLessThan(0.54)
  }
  const [dr, dg, db] = colors[3]
  expect((Math.max(dr, dg, db) + Math.min(dr, dg, db)) / 510).toBeLessThan(0.09)
  expect(Math.max(...accent)).toBeGreaterThan(150)
})

test('a single colour cover still gives four colours, and a see-through one gives the fallback', () => {
  const one = palette(solid(200, 40, 40))
  expect(one.colors).toHaveLength(4)
  expect(one.colors[0][0]).toBeGreaterThan(one.colors[0][2])
  const clear = new Uint8Array(64 * 4)
  expect(palette(clear).colors).toEqual(FALLBACK_COLORS)
})

test('half blocks put the upper pixel in the foreground and the lower in the background', () => {
  // 1 wide, 2 tall: red above, blue below
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255])
  const words = halfBlockCells(rgba, 1, 2, 1, 1)
  expect(Array.from(words)).toEqual([0x2580, 0xff0000, 0x0000ff])
})

test('half blocks average a larger picture down to the cells', () => {
  const image = parseBmp(fromBase64(SIPS_QUAD))
  // 4x4 into 2 cells across and 1 down: 2x2 pixels, so each pixel is one quarter
  const words = halfBlockCells(image.rgba, 4, 4, 2, 1)
  expect(words).toHaveLength(6)
  expect(Array.from(words)).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
  // a quarter of each colour averages to grey-ish, never out of range
  const squeezed = halfBlockCells(image.rgba, 4, 4, 1, 1)
  expect(Array.from(squeezed.slice(1, 3)).every((c: number) => c >= 0 && c <= 0xffffff)).toBe(true)
})

test('cells encode as little-endian u32 triplets in base64', () => {
  const encoded = encodeCells(Uint32Array.of(0x2580, 0xff8800, 0x01000000))
  const bytes = fromBase64(encoded)
  expect(Array.from(bytes)).toEqual([0x80, 0x25, 0, 0, 0x00, 0x88, 0xff, 0, 0, 0, 0, 1])
  expect(encoded.length).toBe(16)
})

test('every cell of the cover and the stand-in is a width-1 glyph with a plain colour', () => {
  const image = parseBmp(fromBase64(SIPS_QUAD))
  for (const words of [halfBlockCells(image.rgba, 4, 4, 16, 8), placeholderCells(16, 8, FALLBACK_COLORS)]) {
    expect(words).toHaveLength(16 * 8 * 3)
    for (let i = 0; i < words.length; i += 3) {
      expect(words[i]).toBe(0x2580)
      expect(words[i + 1]).toBeLessThanOrEqual(0xffffff)
      expect(words[i + 2]).toBeLessThanOrEqual(0xffffff)
    }
  }
})

test('the aurora is the right size, moves with time, and is dark when the level is zero', () => {
  const colors = FALLBACK_COLORS
  const a = auroraCells(60, 2, 0, colors)
  const b = auroraCells(60, 2, 3, colors)
  expect(a).toHaveLength(60 * 2 * 3)
  expect(Array.from(a)).not.toEqual(Array.from(b))
  expect(Array.from(auroraCells(60, 2, 3, colors))).toEqual(Array.from(b))
  const dark = auroraCells(60, 2, 5, colors, 0)
  const bg = (BACKGROUND[0] << 16) | (BACKGROUND[1] << 8) | BACKGROUND[2]
  for (let i = 0; i < dark.length; i += 3) {
    expect(dark[i + 1]).toBe(bg)
    expect(dark[i + 2]).toBe(bg)
  }
})

test('the aurora is brighter at the top and fades as it falls', () => {
  const words = auroraCells(80, 3, 1.5, FALLBACK_COLORS)
  const sum = (c: number) => (c >> 16) + ((c >> 8) & 255) + (c & 255)
  let top = 0
  let bottom = 0
  for (let x = 0; x < 80; x += 1) {
    top += sum(words[x * 3 + 1])
    bottom += sum(words[(2 * 80 + x) * 3 + 2])
  }
  expect(top).toBeGreaterThan(bottom)
})

test('the layout: the panel needs big, a song, room, and a surface that draws it', () => {
  const base = { big: true, isSong: true, surface: 'terminal', columns: 100, rows: 30, canImages: false }
  expect(chooseLayout(base)).toEqual({ mode: 'panel', cover: 'cells' })
  expect(chooseLayout({ ...base, canImages: true })).toEqual({ mode: 'panel', cover: 'image' })
  expect(chooseLayout({ ...base, big: false })).toEqual({ mode: 'band' })
  expect(chooseLayout({ ...base, isSong: false })).toEqual({ mode: 'band' })
})

test('the terminal panel gives way to the band below 60 columns or without rows', () => {
  const base = { big: true, isSong: true, surface: 'terminal', columns: 60, rows: 30, canImages: false }
  expect(chooseLayout(base).mode).toBe('panel')
  expect(chooseLayout({ ...base, columns: 59 }).mode).toBe('band')
  expect(chooseLayout({ ...base, columns: 20 }).mode).toBe('band')
  // the real band gets 11 rows on a 34 row terminal; the panel is 8, and 9 with the focus hint
  expect(chooseLayout({ ...base, rows: 11 }).mode).toBe('panel')
  expect(chooseLayout({ ...base, rows: 10 }).mode).toBe('panel')
  expect(chooseLayout({ ...base, rows: 9 }).mode).toBe('band')
  expect(chooseLayout({ ...base, rows: 4 }).mode).toBe('band')
})

test('the desktop panel is one Svg whatever the width, and other surfaces keep the band', () => {
  const base = { big: true, isSong: true, columns: 50, rows: 4, canImages: true }
  expect(chooseLayout({ ...base, surface: 'desktop' })).toEqual({ mode: 'panel', cover: 'svg' })
  expect(chooseLayout({ ...base, surface: 'vscode' })).toEqual({ mode: 'band' })
  expect(chooseLayout({ ...base, surface: 'mobile' })).toEqual({ mode: 'band' })
})

test('pictures are drawn by kitty and Ghostty, not by tmux or a plain terminal', () => {
  expect(canShowImages({ TERM: 'xterm-kitty' })).toBe(true)
  expect(canShowImages({ KITTY_WINDOW_ID: '3' })).toBe(true)
  expect(canShowImages({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  expect(canShowImages({ TERM: 'xterm-ghostty' })).toBe(true)
  expect(canShowImages({ GHOSTTY_RESOURCES_DIR: '/x' })).toBe(true)
  expect(canShowImages({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1/default,1,0' })).toBe(false)
  expect(canShowImages({ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  expect(canShowImages({})).toBe(false)
  expect(canShowImages({ TERM: 'xterm-256color', HUSH_COVER: 'image' })).toBe(true)
  expect(canShowImages({ TERM: 'xterm-kitty', HUSH_COVER: 'cells' })).toBe(false)
})

test('the panel\'s columns add up, and the progress bar fills in proportion', () => {
  const w = panelWidths(100)
  expect(w.cover + 2 + w.text + 2).toBe(100)
  expect(panelWidths(60).text).toBe(40)
  expect(progressBar(0, 200, 20)).toEqual({ filled: 0, empty: 20 })
  expect(progressBar(100, 200, 20)).toEqual({ filled: 10, empty: 10 })
  expect(progressBar(999, 200, 20)).toEqual({ filled: 20, empty: 0 })
  expect(progressBar(30, 0, 20)).toEqual({ filled: 0, empty: 20 })
})

test('a cover is cached under the track id, or a hash when the id is odd', () => {
  expect(coverKey({ id: 'dQw4w9WgXcQ', title: 'a' })).toBe('dQw4w9WgXcQ')
  const odd = coverKey({ id: '../../etc', title: 'Nights', artist: 'Frank' })
  expect(odd).toMatch(/^t[0-9a-f]+$/)
  expect(coverKey({ id: '', title: 'Nights', artist: 'Frank' })).toBe(odd)
  expect(coverKey({ id: '', title: 'Nights', artist: 'Other' })).not.toBe(odd)
  expect(coverKey(null)).toMatch(/^t/)
})

test('cover urls are hum\'s art, then the YouTube thumbnail, http and https only', () => {
  expect(coverUrls({ id: 'dQw4w9WgXcQ', art: 'https://lh3.example/a.jpg' })).toEqual([
    'https://lh3.example/a.jpg',
    'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
  ])
  expect(coverUrls({ id: 'dQw4w9WgXcQ', art: 'file:///etc/passwd' })).toEqual(['https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'])
  expect(coverUrls({ id: 'bad id; rm', art: '' })).toEqual([])
  expect(coverUrls(null)).toEqual([])
})

test('the desktop svg holds the cover, animates only when asked, and stays under its limit', () => {
  const input = {
    title: 'Nights',
    artist: 'Frank Ocean',
    colors: FALLBACK_COLORS,
    accent: [235, 160, 128],
    jpeg: 'QUJD',
    animated: true,
    dim: false,
  }
  const svg = panelSvg(input)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(svg).toContain('data:image/jpeg;base64,QUJD')
  expect(svg).toContain('<animate ')
  expect(svg).toContain('#08070b')
  expect(svg).toContain('Frank Ocean')
  expect(panelSvg({ ...input, animated: false })).not.toContain('<animate ')
  // the same input is the same source, so a redraw does not restart the animation
  expect(panelSvg(input)).toBe(svg)
  // no cover: a wash of the palette stands in
  expect(panelSvg({ ...input, jpeg: null })).not.toContain('data:image')
  // markup in a title is text, not markup
  const hostile = panelSvg({ ...input, title: '<script>alert(1)</script> & "x"' })
  expect(hostile).not.toContain('<script>')
  expect(hostile).toContain('&lt;script&gt;')
  // a picture too big for the limit is left out
  const huge = panelSvg({ ...input, jpeg: 'A'.repeat(SVG_LIMIT) })
  expect(huge.length).toBeLessThanOrEqual(SVG_LIMIT)
  expect(huge).not.toContain('data:image')
})

test('/music big is a bare word that toggles, and stays local whatever the source', () => {
  expect(parseArgs('big', STATIONS)).toEqual({ kind: 'big' })
  expect(parseArgs('BIG', STATIONS)).toEqual({ kind: 'big' })
  expect(parseArgs('big thief', STATIONS)).toEqual({ kind: 'search', query: 'big thief' })
  expect(route({ kind: 'big' }, { source: 'hum', humLive: true })).toEqual({ target: 'local', action: 'big' })
  expect(route({ kind: 'big' }, { source: 'radio', humLive: false })).toEqual({ target: 'local', action: 'big' })
})
