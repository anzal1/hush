import { expect, test } from 'claude-code/testing'
import {
  auroraCells,
  BACKGROUND,
  bayer,
  canShowImages,
  captionLines,
  chooseLayout,
  coverKey,
  coverUrls,
  cropRect,
  EIGHTHS,
  encodeCells,
  enhance,
  FALLBACK_COLORS,
  fromBase64,
  GRID,
  halfBlockCells,
  palette,
  panelGeometry,
  panelSvg,
  panelWidths,
  parseBmp,
  pillColor,
  placeholderCells,
  PANEL_BG,
  progressBar,
  progressEighths,
  progressRuns,
  QUADRANTS,
  quadrantCells,
  quadrantFit,
  quadrantSnap,
  snapColor,
  SVG_LIMIT,
  timeLabels,
  toBase64,
} from '../hooks/panel.mjs'
// @ts-expect-error plain JS module, no declarations
import { humView, lyricWindow, parseArgs, route } from '../hooks/logic.mjs'

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
  const blocks = QUADRANTS.map((q: string) => q.codePointAt(0))
  for (const words of [quadrantCells(image.rgba, 4, 4, 20, 10), placeholderCells(20, 10, FALLBACK_COLORS)]) {
    expect(words).toHaveLength(20 * 10 * 3)
    for (let i = 0; i < words.length; i += 3) {
      expect(blocks).toContain(words[i])
      expect(words[i + 1]).toBeLessThanOrEqual(0xffffff)
      expect(words[i + 2]).toBeLessThanOrEqual(0xffffff)
    }
  }
  for (const words of [halfBlockCells(image.rgba, 4, 4, 16, 8)]) {
    for (let i = 0; i < words.length; i += 3) expect(words[i]).toBe(0x2580)
  }
})

test('quadrant blocks: the sixteen glyphs are the standard ones, in mask order', () => {
  expect(QUADRANTS).toHaveLength(16)
  expect(QUADRANTS.join('')).toBe(' \u2598\u259d\u2580\u2596\u258c\u259e\u259b\u2597\u259a\u2590\u259c\u2584\u2599\u259f\u2588')
  expect(QUADRANTS[0b0011]).toBe('\u2580')
  expect(QUADRANTS[0b0101]).toBe('\u258c')
  expect(QUADRANTS[0b1010]).toBe('\u2590')
  expect(QUADRANTS[0b1100]).toBe('\u2584')
})

test('quadrantFit picks the glyph and two colours that leave the least error', () => {
  const red = [255, 0, 0]
  const blue = [0, 0, 255]
  const white = [255, 255, 255]
  // red on top, blue below: an upper half block, the lighter colour in the foreground
  const half = quadrantFit([red, red, blue, blue])
  expect(String.fromCodePoint(half.glyph)).toBe('\u2580')
  expect(half.fg).toEqual(red)
  expect(half.bg).toEqual(blue)
  // a left half: red left, blue right
  const left = quadrantFit([red, blue, red, blue])
  expect(String.fromCodePoint(left.glyph)).toBe('\u258c')
  // one odd corner: white in the lower right of dark pixels is a single quadrant block
  const corner = quadrantFit([blue, blue, blue, white])
  expect(String.fromCodePoint(corner.glyph)).toBe('\u2597')
  expect(corner.fg).toEqual(white)
  expect(corner.bg).toEqual(blue)
  // a diagonal
  const diagonal = quadrantFit([white, blue, blue, white])
  expect(String.fromCodePoint(diagonal.glyph)).toBe('\u259a')
  // one flat colour is a space of that colour
  const flat = quadrantFit([red, red, red, red])
  expect(flat.glyph).toBe(0x20)
  expect(flat.fg).toEqual(red)
  expect(flat.bg).toEqual(red)
  // three colours: the two that fit best, and the odd one out takes the nearer
  const three = quadrantFit([red, red, [250, 10, 10], blue])
  expect(String.fromCodePoint(three.glyph)).not.toBe(' ')
})

test('quadrantFit is never worse than a half block pair for four pixels', () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255
  const err = (p: number[][], fg: number[], bg: number[], mask: number) => {
    let e = 0
    for (let i = 0; i < 4; i += 1) {
      const c = mask & (1 << i) ? fg : bg
      e += (p[i][0] - c[0]) ** 2 + (p[i][1] - c[1]) ** 2 + (p[i][2] - c[2]) ** 2
    }
    return e
  }
  const mean = (list: number[][]) => [0, 1, 2].map((k) => list.reduce((s, c) => s + c[k], 0) / list.length)
  for (let n = 0; n < 40; n += 1) {
    const p = [0, 1, 2, 3].map(() => [rnd(), rnd(), rnd()])
    const fit = quadrantFit(p)
    const mask = QUADRANTS.indexOf(String.fromCodePoint(fit.glyph))
    const got = mask <= 0 ? err(p, fit.fg, fit.bg, 0) : err(p, fit.fg, fit.bg, mask)
    const upper = err(p, mean([p[0], p[1]]), mean([p[2], p[3]]), 0b0011)
    expect(got).toBeLessThanOrEqual(upper + 1e-6)
  }
})

test('quadrantSnap keeps colours it was given, from the pixels themselves', () => {
  const a = [17, 34, 51]
  const b = [204, 187, 170]
  const c = [221, 187, 170]
  const fit = quadrantSnap([a, a, b, b])
  expect(String.fromCodePoint(fit.glyph)).toBe('\u2584')
  expect(fit.fg).toEqual(b)
  expect(fit.bg).toEqual(a)
  // three colours: the pair kept is among the pixels, never an average
  const mixed = quadrantSnap([a, b, c, a])
  for (const v of [mixed.fg, mixed.bg]) expect([a, b, c].some((x) => x.join() === v.join())).toBe(true)
  expect(quadrantSnap([a, a, a, a]).glyph).toBe(0x20)
})

test('a picture is cut to the shape of the cells and sampled in quadrants', () => {
  // a cell is twice as tall as wide, so a 20 x 10 block is square, and a wide picture is cropped from the middle
  expect(cropRect(64, 64, 20, 10)).toEqual({ x0: 0, y0: 0, cw: 64, ch: 64 })
  expect(cropRect(160, 90, 20, 10)).toEqual({ x0: 35, y0: 0, cw: 90, ch: 90 })
  expect(cropRect(90, 160, 20, 10)).toEqual({ x0: 0, y0: 35, cw: 90, ch: 90 })
  expect(cropRect(64, 64, 16, 10)).toMatchObject({ cw: 51, ch: 64 })
  // red top left, green top right, blue bottom left, white bottom right, cut to one cell: four pixels, so a 2x2 split
  const image = parseBmp(fromBase64(SIPS_QUAD))
  const words = quadrantCells(image.rgba, 4, 4, 1, 1, { contrast: 1, saturation: 1, sharpen: 0 })
  expect(words).toHaveLength(3)
  // colours on the engine's grid: red stays red, white stays white
  const cell = quadrantFit([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]])
  expect(cell.glyph).toBeGreaterThan(0x20)
  const wide = quadrantCells(image.rgba, 4, 4, 8, 2, { sharpen: 0 })
  expect(wide).toHaveLength(8 * 2 * 3)
})

test('the lift sharpens edges and adds a little colour and contrast', () => {
  // a 6 x 6 picture: dark left half, light right half, mid grey
  const w = 6
  const px = new Float64Array(w * w * 3)
  for (let y = 0; y < w; y += 1) for (let x = 0; x < w; x += 1) px.set(x < 3 ? [90, 90, 90] : [170, 170, 170], (y * w + x) * 3)
  const flat = enhance(px, w, w, { contrast: 1, saturation: 1, sharpen: 0 })
  expect(Array.from(flat)).toEqual(Array.from(px))
  const sharp = enhance(px, w, w, { contrast: 1, saturation: 1, sharpen: 1 })
  // beside the edge the dark side goes darker and the light side lighter: an overshoot
  expect(sharp[(3 * w + 2) * 3]).toBeLessThan(90)
  expect(sharp[(3 * w + 3) * 3]).toBeGreaterThan(170)
  // far from the edge nothing changes
  expect(Math.abs(sharp[(3 * w + 0) * 3] - 90)).toBeLessThan(1)
  // contrast spreads values about the middle and keeps them in range
  const punchy = enhance(px, w, w, { contrast: 1.5, saturation: 1, sharpen: 0 })
  expect(punchy[0]).toBeLessThan(90)
  expect(punchy[(0 * w + 5) * 3]).toBeGreaterThan(170)
  // saturation pushes a colour away from its grey
  const colour = new Float64Array([200, 100, 100, 200, 100, 100, 200, 100, 100, 200, 100, 100])
  const richer = enhance(colour, 2, 2, { contrast: 1, saturation: 1.5, sharpen: 0 })
  expect(richer[0] - richer[1]).toBeGreaterThan(100)
  for (const v of enhance(px, w, w, { contrast: 3, saturation: 3, sharpen: 3 })) {
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(255)
  }
})

test('a grey cover takes hum\'s warm colours, not a hue out of nowhere', () => {
  const grey = new Uint8Array(8 * 8 * 4)
  for (let i = 0; i < 64; i += 1) grey.set([i * 3, i * 3, i * 3, 255], i * 4)
  expect(palette(grey).colors).toEqual(FALLBACK_COLORS)
})

test('the eighth block bar: whole cells, then one of eight steps, then the rest', () => {
  expect(EIGHTHS).toEqual([' ', '\u258f', '\u258e', '\u258d', '\u258c', '\u258b', '\u258a', '\u2589', '\u2588'])
  expect(progressEighths(0, 200, 20)).toMatchObject({ full: 0, part: 0, eighths: 0 })
  expect(progressEighths(100, 200, 20)).toMatchObject({ full: 10, part: 0 })
  // 1/160 of a 20 cell bar is one eighth of a cell
  expect(progressEighths(1.25, 200, 20)).toMatchObject({ full: 0, part: 1 })
  expect(progressEighths(100 + 1.25 * 3, 200, 20)).toMatchObject({ full: 10, part: 3 })
  expect(progressEighths(999, 200, 20)).toMatchObject({ full: 20, part: 0 })
  expect(progressEighths(30, 0, 20)).toMatchObject({ full: 0, part: 0 })
})

test('progress runs: a gradient from the first colour to the second over a dim track, always the full width', () => {
  const from = [200, 100, 50]
  const to = [50, 100, 200]
  const total = (runs: any[]) => runs.reduce((n, r) => n + r.text.length, 0)
  for (const pos of [0, 3, 50, 99.4, 100, 150, 199.9, 200]) {
    expect(total(progressRuns(pos, 200, 40, from, to))).toBe(40)
  }
  const runs = progressRuns(100 + 5 * 1.5, 200, 40, from, to)
  // the filled part comes first, in full blocks
  expect(runs[0].track).toBe(false)
  expect(runs[0].text).toMatch(/^\u2588+$/)
  // its first colour is the start of the gradient and its last the end
  const filled = runs.filter((r: any) => !r.track)
  expect(filled[0].color).toEqual(from)
  expect(filled[filled.length - 1].color).toEqual(to)
  // then the part cell is one of the eighth blocks over the track, then spaces
  const part = runs.find((r: any) => r.track && r.text !== ' '.repeat(r.text.length))
  expect(part.text).toHaveLength(1)
  expect(EIGHTHS).toContain(part.text)
  expect(runs[runs.length - 1].text).toMatch(/^ +$/)
  // nothing played yet: only the track
  expect(progressRuns(0, 200, 10, from, to)).toEqual([{ text: ' '.repeat(10), color: expect.anything(), track: true }])
  // everything played: only fill
  expect(progressRuns(200, 200, 10, from, to).every((r: any) => !r.track)).toBe(true)
  // an unknown length draws the track
  expect(progressRuns(30, 0, 10, from, to).every((r: any) => r.track)).toBe(true)
})

test('times keep their width so the bar does not shift', () => {
  expect(timeLabels(22, 468)).toEqual({ elapsed: '0:22', total: '7:48' })
  expect(timeLabels(22, 3600)).toEqual({ elapsed: ' 0:22', total: '60:00' })
  expect(timeLabels(600, 3600).elapsed.length).toBe(timeLabels(5, 3600).elapsed.length)
  expect(timeLabels(22, 0)).toEqual({ elapsed: '0:22', total: '' })
})

test('the lines under the artist: lyric and the next one, or the album and what is up next, never a gap', () => {
  const song = { hasLyrics: true, line: 'I once was lost', next: 'but now I am found', album: 'Whales', upNext: 'Nights \u00b7 Frank Ocean' }
  const synced = captionLines(song)
  expect(synced.kind).toBe('lyrics')
  expect(synced.first).toMatchObject({ role: 'now', text: 'I once was lost' })
  expect(synced.second).toMatchObject({ role: 'next', text: 'but now I am found' })
  // an interlude is three dots, and the last line gives way to what is up next
  expect(captionLines({ ...song, line: '' }).first.text).toBe('\u00b7 \u00b7 \u00b7')
  expect(captionLines({ ...song, next: '' }).second).toMatchObject({ role: 'queue', label: 'up next', text: 'Nights \u00b7 Frank Ocean' })
  expect(captionLines({ ...song, next: '', upNext: '' }).second.text).not.toBe('')
  // no synced lyrics: the album, then up next
  const plain = captionLines({ hasLyrics: false, line: '', next: '', album: 'Currents', upNext: 'Let It Happen \u00b7 Tame Impala' })
  expect(plain.kind).toBe('about')
  expect(plain.first).toMatchObject({ role: 'album', text: 'Currents' })
  expect(plain.second).toMatchObject({ role: 'queue', label: 'up next', text: 'Let It Happen \u00b7 Tame Impala' })
  // nothing known: still two lines of words
  const bare = captionLines({ hasLyrics: false, line: '', next: '', album: '', upNext: '' })
  expect(bare.first.text.length).toBeGreaterThan(0)
  expect(bare.second.text.length).toBeGreaterThan(0)
  expect(captionLines({ hasLyrics: false, line: '', next: '', album: 'Currents', upNext: '' }).second.text.length).toBeGreaterThan(0)
})

test('lyricWindow: the line being sung, the next one, and when it starts', () => {
  const lyrics = [
    { t: 10, text: 'one' },
    { t: 20, text: '' },
    { t: 30, text: 'two' },
    { t: 40, text: 'three' },
  ]
  expect(lyricWindow(lyrics, 0)).toEqual({ line: '', next: 'one', nextIn: 10 - 0.15 })
  expect(lyricWindow(lyrics, 12)).toMatchObject({ line: 'one', next: 'two' })
  // the blank line is an interlude: shown as empty, and skipped as the next line
  expect(lyricWindow(lyrics, 25)).toMatchObject({ line: '', next: 'two' })
  expect(lyricWindow(lyrics, 35).next).toBe('three')
  expect(lyricWindow(lyrics, 45)).toEqual({ line: 'three', next: '', nextIn: null })
  expect(lyricWindow(lyrics, 9.9).line).toBe('one')
  expect(lyricWindow(undefined, 3)).toEqual({ line: '', next: '', nextIn: null })
  expect(lyricWindow([], 3)).toEqual({ line: '', next: '', nextIn: null })
  // unsorted input gives the same answer
  expect(lyricWindow([...lyrics].reverse(), 12)).toMatchObject({ line: 'one', next: 'two' })
})

test('humView carries the next line, the album and what is up next', () => {
  const state = {
    connected: 1,
    playing: true,
    at: 1000,
    position: 12,
    duration: 200,
    volume: 50,
    track: { title: 'Nights', artist: 'Frank Ocean', album: 'Blonde', id: 'abc', art: '' },
    lyrics: [
      { t: 10, text: 'first' },
      { t: 20, text: 'second' },
    ],
    upNext: ['Pink + White \u00b7 Frank Ocean', 'Ivy \u00b7 Frank Ocean'],
  }
  const view = humView(state, 1000)
  expect(view.line).toBe('first')
  expect(view.next).toBe('second')
  expect(view.album).toBe('Blonde')
  expect(view.upNext).toBe('Pink + White \u00b7 Frank Ocean')
  expect(Math.abs(view.nextIn - (20 - 12.15))).toBeLessThan(1e-6)
  // an album that repeats the title is not shown, and a bare state has none of it
  expect(humView({ ...state, track: { ...state.track, album: 'Nights' } }, 1000).album).toBe('')
  const bare = humView({ connected: 1, playing: false, position: 0, duration: 0, track: { title: 'x' } }, 0)
  expect(bare).toMatchObject({ next: '', album: '', upNext: '', hasLyrics: false, line: '' })
})

test('the panel grows with the room the engine gives, 8 to 10 rows, and the cover stays square', () => {
  const sizes = [10, 11, 12, 13, 14, 20].map((room) => panelGeometry(100, room))
  expect(sizes.map((g) => g.rows)).toEqual([8, 9, 10, 10, 10, 10])
  for (const g of sizes) {
    expect(g.cover).toBe(g.rows * 2)
    // the words column adds up: padding, cover, gap and text fill the width
    expect(2 + g.cover + g.gap + g.text).toBe(Math.min(100, 120) - 0)
  }
  // every row of the words column is used: ribbon, title, artist, gaps, two lines, progress, buttons
  for (const g of sizes) expect(g.ribbon + 1 + 1 + g.gapA + 2 + g.gapB + 1 + 1).toBe(g.rows)
  // leaves a row for the focus hint, and pads above and below only when there is plenty
  expect(sizes.map((g) => g.pad)).toEqual([0, 0, 0, 0, 1, 1])
  for (const [room, g] of [[10, sizes[0]], [11, sizes[1]], [12, sizes[2]]] as const) expect(g.rows + 1).toBeLessThanOrEqual(room)
  // a narrow terminal keeps the small cover
  expect(panelGeometry(70, 20).rows).toBe(8)
  expect(panelGeometry(60, 20).text).toBe(60 - 2 - 16 - 2)
  expect(panelGeometry(76, 20).rows).toBe(10)
  // a wide terminal grows the words, not the cover
  expect(panelGeometry(136, 14).cover).toBe(20)
  expect(panelGeometry(136, 14).text).toBeGreaterThan(panelGeometry(100, 14).text)
  // and the bar leaves room for the two times
  const g = panelGeometry(100, 14)
  expect(g.bar).toBeLessThan(g.text)
})

test('the play button takes a deep shade of the cover, with yellows and greens swung towards amber', () => {
  const lightness = (c: number[]) => (Math.max(...c) + Math.min(...c)) / 510
  for (const c of [[220, 60, 60], [60, 160, 220], [235, 200, 40], [40, 200, 80]]) {
    const pill = pillColor(c)
    expect(lightness(pill)).toBeGreaterThan(0.3)
    expect(lightness(pill)).toBeLessThan(0.42)
  }
  // yellow does not stay olive: red leads green
  const [r, g] = pillColor([235, 200, 40])
  expect(r).toBeGreaterThan(g)
  // blue stays blue
  const [pr, , pb] = pillColor([60, 100, 220])
  expect(pb).toBeGreaterThan(pr)
})

const pack = (c: number[]) => (c[0] << 16) | (c[1] << 8) | c[2]
const unpack = (w: number) => [(w >> 16) & 255, (w >> 8) & 255, w & 255]

test('the aurora is the right size, moves with time, and is dark when the level is zero', () => {
  const colors = FALLBACK_COLORS
  const a = auroraCells(60, 2, 0, colors)
  const b = auroraCells(60, 2, 40, colors)
  expect(a).toHaveLength(60 * 2 * 3)
  expect(Array.from(a)).not.toEqual(Array.from(b))
  expect(Array.from(auroraCells(60, 2, 40, colors))).toEqual(Array.from(b))
  const dark = auroraCells(60, 2, 5, colors, 0)
  const bg = pack(PANEL_BG)
  for (let i = 0; i < dark.length; i += 3) {
    expect(dark[i]).toBe(0x20)
    expect(dark[i + 1]).toBe(bg)
    expect(dark[i + 2]).toBe(bg)
  }
})

test('the aurora moves slowly: a tenth of a second later it is almost the same picture', () => {
  const a = auroraCells(80, 2, 10, FALLBACK_COLORS)
  const b = auroraCells(80, 2, 10.125, FALLBACK_COLORS)
  let same = 0
  for (let i = 0; i < a.length; i += 1) if (a[i] === b[i]) same += 1
  expect(same / a.length).toBeGreaterThan(0.8)
})

test('the aurora is painted on the 16 level grid Claude Code uses, so nothing is lost to rounding', () => {
  for (const t of [0, 7, 33]) {
    const words = auroraCells(70, 3, t, FALLBACK_COLORS)
    for (let i = 0; i < words.length; i += 3) {
      for (const k of [1, 2]) for (const v of unpack(words[i + k])) expect(v % GRID).toBe(0)
      // a block glyph or a space, never anything else
      expect(QUADRANTS.map((q: string) => q.codePointAt(0))).toContain(words[i])
    }
  }
  expect(snapColor([8, 7, 11])).toEqual([0, 0, 17])
  expect(snapColor([255, 250, 130])).toEqual([255, 255, 136])
})

test('the aurora glows out of the dark: bright in the middle, gone at the ends and at the top and bottom', () => {
  const columns = 80
  const rows = 3
  const words = auroraCells(columns, rows, 3, FALLBACK_COLORS)
  const energy = (cell: number) => {
    let e = 0
    for (const k of [1, 2]) for (const v of unpack(words[cell * 3 + k])) e += v - 17
    return e
  }
  const column = (x: number) => {
    let e = 0
    for (let r = 0; r < rows; r += 1) e += energy(r * columns + x)
    return e
  }
  let middle = 0
  let ends = 0
  for (let x = 20; x < 60; x += 1) middle += column(x)
  for (let x = 0; x < 4; x += 1) ends += column(x) + column(columns - 1 - x)
  expect(middle / 40).toBeGreaterThan(4 * (ends / 8))
  // the top and bottom rows are dimmer than the middle one
  let top = 0
  let mid = 0
  let bottom = 0
  for (let x = 0; x < columns; x += 1) {
    top += energy(x)
    mid += energy(columns + x)
    bottom += energy(2 * columns + x)
  }
  expect(mid).toBeGreaterThan(top)
  expect(mid).toBeGreaterThan(bottom)
})

test('the dither weaves two grid colours instead of stepping: a smooth ramp uses cells in between', () => {
  // a plain ramp of one light level rounds to the grid unevenly: the Bayer threshold decides each sub-pixel
  const seen = new Set<number>()
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) seen.add(Math.floor(30 / GRID + bayer(x, y)))
  expect(Array.from(seen).sort()).toEqual([1, 2])
  const thresholds = new Set<number>()
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) thresholds.add(bayer(x, y))
  expect(thresholds.size).toBe(16)
  for (const t of thresholds) {
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)
  }
  // and in the aurora a mid-glow cell is a mixed block more often than a flat one
  const words = auroraCells(80, 2, 12, FALLBACK_COLORS)
  let mixed = 0
  let cells = 0
  for (let i = 0; i < words.length; i += 3) {
    if (words[i + 1] !== words[i + 2]) mixed += 1
    cells += 1
  }
  expect(mixed / cells).toBeGreaterThan(0.1)
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
  expect(w.cover + w.gap + w.text + 2).toBe(100)
  expect(panelWidths(60).text).toBe(40)
  const big = panelWidths(100, 20, 3)
  expect(big.cover + big.gap + big.text + 2).toBe(100)
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
    album: 'Blonde',
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
  expect(svg).toContain('Blonde')
  expect(svg).toContain('rx="14"')
  expect(panelSvg({ ...input, album: '' })).not.toContain('Blonde')
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
