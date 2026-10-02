// Pure parts of Hush's big panel: no host calls, so tests can run them directly.
//
// The panel is the richer view above the prompt while a song plays through hum: the cover,
// an aurora in the cover's colours, the title, artist and lyric lines, progress and buttons.
// This file reads the cover's pixels (a small BMP that /usr/bin/sips wrote), picks the
// colours, makes the cell art for the terminal and the SVG for the desktop, and decides
// which layout fits.
//
// The terminal art is drawn in quadrant blocks: every cell carries 2x2 pixels in two colours,
// so a cover is twice as sharp across as half blocks give, and the aurora is dithered across
// the same sub-pixels so a glow reads as light and not as steps.

export const BACKGROUND = [8, 7, 11];
export const BACKGROUND_HEX = "#08070b";
export const BONE = "#f6f2ec";
export const BONE_SOFT = "#b9b1a6";
export const BONE_DIM = "#8a8379";
export const TRACK = [38, 35, 46];

// Claude Code paints a Raster's colours in 16 levels a channel (the nearest multiple of 17),
// whatever is sent, so the cell art is made on that grid. The panel's own background is the
// grid colour nearest hum's #08070b, so that the aurora's dark cells and the card around them
// are one colour and no box shows.
export const GRID = 17;
export const PANEL_BG = [17, 17, 17];
export const PANEL_BG_HEX = "#111111";

// hum's own warm colours, used until a cover has been read or when there is none.
export const FALLBACK_COLORS = [
  [196, 112, 78],
  [140, 110, 214],
  [92, 142, 176],
  [14, 11, 18],
];
export const FALLBACK_ACCENT = [235, 160, 128];

export const PANEL_MIN_COLUMNS = 60;
export const PANEL_MAX_COLUMNS = 120;
export const PANEL_ROWS = 8;
export const PANEL_ROWS_MAX = 10;
export const PANEL_ROOM = 2;
export const COVER_COLUMNS = 16;
export const COVER_ROWS = 8;
export const RIBBON_ROWS = 2;
export const PANEL_GAP = 2;
export const PANEL_PAD = 1;
export const SVG_LIMIT = 131072;
export const SVG_WIDTH = 560;
export const SVG_HEIGHT = 148;
export const UPPER_HALF = 0x2580;
export const EIGHTHS = [" ", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589", "\u2588"];
// Quadrant glyphs by mask: 1 upper left, 2 upper right, 4 lower left, 8 lower right.
export const QUADRANTS = [" ", "\u2598", "\u259d", "\u2580", "\u2596", "\u258c", "\u259e", "\u259b", "\u2597", "\u259a", "\u2590", "\u259c", "\u2584", "\u2599", "\u259f", "\u2588"];

export function fit(text, cells) {
  if (cells <= 0) {
    return "";
  }
  return text.length <= cells ? text : `${text.slice(0, Math.max(0, cells - 1))}…`;
}

export function clock(total) {
  const seconds = Math.floor(total);
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// ---------- bytes ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Base64 by hand: the module's environment is not promised the newer Uint8Array helpers.
export function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
    out[n++] = (a << 2) | (b >> 4);
    if (c >= 0) {
      out[n++] = ((b & 15) << 4) | (c >> 2);
    }
    if (d >= 0) {
      out[n++] = ((c & 3) << 6) | d;
    }
  }
  return out.slice(0, n);
}

// ---------- BMP ----------

// Reads an uncompressed BMP (24 or 32 bits a pixel, rows bottom up or top down, as sips
// writes them) into { width, height, rgba }. Returns null for anything else.
export function parseBmp(bytes) {
  if (!bytes || bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(10, true);
  const dib = view.getUint32(14, true);
  if (dib < 40) {
    return null;
  }
  const width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const plain = compression === 0 || (compression === 3 && bits === 32);
  if (!plain || (bits !== 24 && bits !== 32) || width < 1 || height < 1 || width > 1024 || height > 1024) {
    return null;
  }
  const stride = Math.floor((bits * width + 31) / 32) * 4;
  if (offset + stride * height > bytes.length) {
    return null;
  }
  const step = bits / 8;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = offset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * step;
      const to = (y * width + x) * 4;
      rgba[to] = bytes[at + 2];
      rgba[to + 1] = bytes[at + 1];
      rgba[to + 2] = bytes[at];
      rgba[to + 3] = 255;
    }
  }
  return { width, height, rgba };
}

// ---------- colour ----------

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) {
    return [l, l, l].map((v) => Math.round(v * 255));
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A few characterful colours from a cover, in the spirit of hum's public/palette.js: pixels
// are bucketed, saturated mid tones score highest, and near duplicates are dropped. Returns
// { colors: four glow colours (the last a deep shade), accent: a light one for text }.
export function palette(rgba) {
  const buckets = new Map();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) {
      continue;
    }
    const key = (rgba[i] >> 4) * 256 + (rgba[i + 1] >> 4) * 16 + (rgba[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n += 1;
    b.r += rgba[i];
    b.g += rgba[i + 1];
    b.b += rgba[i + 2];
    buckets.set(key, b);
  }
  if (buckets.size === 0) {
    return { colors: FALLBACK_COLORS.map((c) => c.slice()), accent: FALLBACK_ACCENT.slice() };
  }
  // A grey cover has no colour to take: hum's own warm colours stand in rather than an arbitrary hue.
  let colourful = 0;
  for (const b of buckets.values()) {
    if (rgbToHsl([b.r / b.n, b.g / b.n, b.b / b.n])[1] > 0.14) {
      colourful += b.n;
    }
  }
  if (colourful < rgba.length / 4 / 40) {
    return { colors: FALLBACK_COLORS.map((c) => c.slice()), accent: FALLBACK_ACCENT.slice() };
  }
  const ranked = [...buckets.values()]
    .map((b) => {
      const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
      const [, s, l] = rgbToHsl(rgb);
      return { rgb, score: b.n * (0.25 + s * 1.6) * (l < 0.07 || l > 0.95 ? 0.15 : 1) };
    })
    .sort((a, b) => b.score - a.score);
  const picks = [];
  for (const r of ranked) {
    if (picks.every((p) => distance(p, r.rgb) > 58)) {
      picks.push(r.rgb);
    }
    if (picks.length === 4) {
      break;
    }
  }
  while (picks.length < 4) {
    const [h, s, l] = rgbToHsl(picks[0] || [90, 60, 140]);
    picks.push(hslToRgb([(h + 0.08 * picks.length) % 1, s, l]));
  }
  // Lifted into a glowing but dark range, so text reads on top.
  const colors = picks.map((rgb, i) => {
    const [h, s, l] = rgbToHsl(rgb);
    return hslToRgb([h, Math.max(s, 0.38), i === 3 ? 0.07 : Math.min(Math.max(l, 0.3), 0.52)]);
  });
  const vivid = [...picks].sort((a, b) => rgbToHsl(b)[1] - rgbToHsl(a)[1])[0];
  const [ah, as] = rgbToHsl(vivid);
  return { colors, accent: hslToRgb([ah, Math.max(as, 0.55), 0.7]) };
}

export function hex(rgb) {
  return `#${rgb.map((v) => clampByte(v).toString(16).padStart(2, "0")).join("")}`;
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function pack(r, g, b) {
  return (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
}

// ---------- terminal cells ----------

// Cell words for a Raster: [code point, foreground, background] per cell, row by row.
// Base64 of the little-endian bytes is the Raster's `cells`.
export function encodeCells(words) {
  const bytes = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    bytes[i * 4] = w & 255;
    bytes[i * 4 + 1] = (w >>> 8) & 255;
    bytes[i * 4 + 2] = (w >>> 16) & 255;
    bytes[i * 4 + 3] = (w >>> 24) & 255;
  }
  return toBase64(bytes);
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// A colour kept in its hue at the lightness asked for (0 to 1), and at least `minSat` saturated.
export function tone(rgb, lightness, minSat = 0) {
  const [h, s] = rgbToHsl(rgb);
  return hslToRgb([h, Math.max(s, minSat), lightness]);
}

// A deep shade of the cover's strongest colour for the play button. Yellows and greens turn to
// mud when they are darkened, so they are swung towards amber first.
export function pillColor(rgb) {
  const [h] = rgbToHsl(rgb);
  const swung = h > 0.1 && h < 0.3 ? 0.1 - (0.3 - h) * 0.15 : h;
  return hslToRgb([swung, 0.6, 0.36]);
}

function luma(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// The part of a picture that fits a cols x rows block of cells. A cell is about twice as tall
// as it is wide, so the block's own shape is cols : 2 * rows, and a picture of another shape is
// cropped from its middle rather than squeezed.
export function cropRect(width, height, cols, rows) {
  const shape = cols / (rows * 2);
  let cw = width;
  let ch = height;
  if (width / height > shape) {
    cw = Math.max(1, Math.round(height * shape));
  } else {
    ch = Math.max(1, Math.round(width / shape));
  }
  return { x0: Math.floor((width - cw) / 2), y0: Math.floor((height - ch) / 2), cw, ch };
}

// Box-averages a part of an RGBA picture down to cols x rows pixels of RGB, over the background where see-through.
function resample(rgba, width, height, cols, rows, rect = { x0: 0, y0: 0, cw: width, ch: height }) {
  const out = new Float64Array(cols * rows * 3);
  for (let y = 0; y < rows; y += 1) {
    const y0 = rect.y0 + Math.floor((y * rect.ch) / rows);
    const y1 = Math.max(y0 + 1, rect.y0 + Math.floor(((y + 1) * rect.ch) / rows));
    for (let x = 0; x < cols; x += 1) {
      const x0 = rect.x0 + Math.floor((x * rect.cw) / cols);
      const x1 = Math.max(x0 + 1, rect.x0 + Math.floor(((x + 1) * rect.cw) / cols));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const at = (sy * width + sx) * 4;
          const a = rgba[at + 3] / 255;
          r += rgba[at] * a + BACKGROUND[0] * (1 - a);
          g += rgba[at + 1] * a + BACKGROUND[1] * (1 - a);
          b += rgba[at + 2] * a + BACKGROUND[2] * (1 - a);
          n += 1;
        }
      }
      const to = (y * cols + x) * 3;
      const k = Math.max(1, n);
      out[to] = r / k;
      out[to + 1] = g / k;
      out[to + 2] = b / k;
    }
  }
  return out;
}

// A picture as half blocks: each cell is ▀ with the upper pixel as its foreground and the
// lower as its background, so cols x rows cells carry cols x 2*rows pixels.
export function halfBlockCells(rgba, width, height, cols, rows) {
  const px = resample(rgba, width, height, cols, rows * 2);
  const words = new Uint32Array(cols * rows * 3);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const top = (y * 2 * cols + x) * 3;
      const bottom = ((y * 2 + 1) * cols + x) * 3;
      const at = (y * cols + x) * 3;
      words[at] = UPPER_HALF;
      words[at + 1] = pack(px[top], px[top + 1], px[top + 2]);
      words[at + 2] = pack(px[bottom], px[bottom + 1], px[bottom + 2]);
    }
  }
  return words;
}

// A gentle lift before the picture is cut down to a few pixels, which is what makes a cover
// read crisply at this size: a little more contrast and colour, then an unsharp mask (the
// picture minus a blur of itself, added back). `px` is w x h pixels of RGB, 0 to 255; the
// pixels are twice as tall as they are wide on screen, so the blur is narrower downwards.
export function enhance(px, w, h, { contrast = 1.1, saturation = 1.2, sharpen = 0.75 } = {}) {
  const out = new Float64Array(px.length);
  for (let i = 0; i < px.length; i += 3) {
    const l = luma([px[i], px[i + 1], px[i + 2]]);
    for (let k = 0; k < 3; k += 1) {
      let v = l + (px[i + k] - l) * saturation;
      v = 127.5 + (v - 127.5) * contrast;
      out[i + k] = Math.max(0, Math.min(255, v));
    }
  }
  if (!(sharpen > 0) || w < 3 || h < 3) {
    return out;
  }
  const across = new Float64Array(px.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = (y * w + Math.max(0, x - 1)) * 3;
      const b = (y * w + x) * 3;
      const c = (y * w + Math.min(w - 1, x + 1)) * 3;
      for (let k = 0; k < 3; k += 1) {
        across[b + k] = (out[a + k] + 2 * out[b + k] + out[c + k]) / 4;
      }
    }
  }
  const sharp = new Float64Array(px.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = (Math.max(0, y - 1) * w + x) * 3;
      const b = (y * w + x) * 3;
      const c = (Math.min(h - 1, y + 1) * w + x) * 3;
      for (let k = 0; k < 3; k += 1) {
        const blur = (across[a + k] + 6 * across[b + k] + across[c + k]) / 8;
        sharp[b + k] = Math.max(0, Math.min(255, out[b + k] + sharpen * (out[b + k] - blur)));
      }
    }
  }
  return sharp;
}

// The best way to show four pixels (upper left, upper right, lower left, lower right; each
// [r, g, b]) in one cell: a glyph of the sixteen quadrant blocks and a colour for each side,
// whichever leaves the least squared error. The lighter side is the foreground. When
// nothing beats one flat colour the cell is a space of that colour. Returns { glyph, fg, bg }.
export function quadrantFit(p) {
  const mean = (mask) => {
    let n = 0;
    const sum = [0, 0, 0];
    for (let i = 0; i < 4; i += 1) {
      if (mask & (1 << i)) {
        n += 1;
        sum[0] += p[i][0];
        sum[1] += p[i][1];
        sum[2] += p[i][2];
      }
    }
    return [sum[0] / n, sum[1] / n, sum[2] / n];
  };
  const error = (mask, c) => {
    let e = 0;
    for (let i = 0; i < 4; i += 1) {
      if (mask & (1 << i)) {
        e += (p[i][0] - c[0]) ** 2 + (p[i][1] - c[1]) ** 2 + (p[i][2] - c[2]) ** 2;
      }
    }
    return e;
  };
  const flat = mean(15);
  const flatError = error(15, flat);
  let best = null;
  for (let m = 1; m <= 7; m += 1) {
    const a = mean(m);
    const b = mean(15 - m);
    const e = error(m, a) + error(15 - m, b);
    if (best === null || e < best.e) {
      best = { m, a, b, e };
    }
  }
  if (best === null || best.e + 1 >= flatError) {
    return { glyph: 0x20, fg: flat, bg: flat };
  }
  return luma(best.a) >= luma(best.b)
    ? { glyph: QUADRANTS[best.m].codePointAt(0), fg: best.a, bg: best.b }
    : { glyph: QUADRANTS[15 - best.m].codePointAt(0), fg: best.b, bg: best.a };
}

// The nearest colour on the 16-level grid Claude Code paints a Raster in.
export function snapColor(c) {
  return [0, 1, 2].map((k) => Math.max(0, Math.min(255, Math.round(c[k] / GRID) * GRID)));
}

// Like quadrantFit for pixels that already sit on the grid: the two colours are chosen from the
// pixels themselves, so nothing has to be averaged off the grid, whichever pair leaves
// the least squared error. The lighter is the foreground.
export function quadrantSnap(p) {
  const uniq = [];
  for (const c of p) {
    if (!uniq.some((u) => u[0] === c[0] && u[1] === c[1] && u[2] === c[2])) {
      uniq.push(c);
    }
  }
  if (uniq.length === 1) {
    return { glyph: 0x20, fg: uniq[0], bg: uniq[0] };
  }
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  let best = null;
  for (let i = 0; i < uniq.length; i += 1) {
    for (let j = i + 1; j < uniq.length; j += 1) {
      const light = luma(uniq[i]) >= luma(uniq[j]) ? uniq[i] : uniq[j];
      const dark = light === uniq[i] ? uniq[j] : uniq[i];
      let mask = 0;
      let e = 0;
      for (let k = 0; k < 4; k += 1) {
        const dl = dist(p[k], light);
        const dd = dist(p[k], dark);
        if (dl <= dd) {
          mask |= 1 << k;
          e += dl;
        } else {
          e += dd;
        }
      }
      if (best === null || e < best.e) {
        best = { e, mask, light, dark };
      }
    }
  }
  if (best.mask === 0 || best.mask === 15) {
    return { glyph: 0x20, fg: best.light, bg: best.light };
  }
  return { glyph: QUADRANTS[best.mask].codePointAt(0), fg: best.light, bg: best.dark };
}

// Cells from a grid of sub-pixels (rgb, 2 * cols wide and 2 * rows tall). With `onGrid` the
// pixels are on the colour grid already and the cell's colours are picked from them; without, they
// are averaged and then snapped to the grid.
function quadrantWords(sub, cols, rows, onGrid = false) {
  const words = new Uint32Array(cols * rows * 3);
  const sw = cols * 2;
  const at = (x, y) => {
    const i = (y * sw + x) * 3;
    return [sub[i], sub[i + 1], sub[i + 2]];
  };
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const four = [at(col * 2, row * 2), at(col * 2 + 1, row * 2), at(col * 2, row * 2 + 1), at(col * 2 + 1, row * 2 + 1)];
      const cell = onGrid ? quadrantSnap(four) : quadrantFit(four);
      const fg = onGrid ? cell.fg : snapColor(cell.fg);
      const bg = onGrid ? cell.bg : snapColor(cell.bg);
      const to = (row * cols + col) * 3;
      words[to] = cell.glyph;
      words[to + 1] = pack(fg[0], fg[1], fg[2]);
      words[to + 2] = pack(bg[0], bg[1], bg[2]);
    }
  }
  return words;
}

// A picture as quadrant blocks: cols x rows cells carrying 2 * cols x 2 * rows pixels, each cell
// two colours and a glyph. The picture is cropped to the block's shape, cut down, given the
// lift of `enhance`, then every cell is fitted (see quadrantFit). Pass `{ sharpen: 0 }` and the
// like to change the lift.
export function quadrantCells(rgba, width, height, cols, rows, lift) {
  const sw = cols * 2;
  const sh = rows * 2;
  const px = resample(rgba, width, height, sw, sh, cropRect(width, height, cols, rows));
  return quadrantWords(enhance(px, sw, sh, lift), cols, rows);
}

// Stand-in cover when there is no picture: a soft diagonal wash of the palette.
export function placeholderCells(cols, rows, colors) {
  const w = cols * 2;
  const h = rows * 2;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = (x / Math.max(1, w - 1) + y / Math.max(1, h - 1)) / 2;
      const from = k < 0.5 ? colors[0] : colors[1];
      const to = k < 0.5 ? colors[1] : colors[2];
      const f = k < 0.5 ? k * 2 : (k - 0.5) * 2;
      const at = (y * w + x) * 4;
      rgba[at] = from[0] + (to[0] - from[0]) * f;
      rgba[at + 1] = from[1] + (to[1] - from[1]) * f;
      rgba[at + 2] = from[2] + (to[2] - from[2]) * f;
      rgba[at + 3] = 255;
    }
  }
  return quadrantCells(rgba, w, h, cols, rows, { contrast: 1, saturation: 1, sharpen: 0 });
}

// ---------- aurora ----------

// An ordered dither threshold in (0, 1) for a sub-pixel, from the 4x4 Bayer matrix.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export function bayer(x, y) {
  return (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
}

function lattice(ix, iy, seed) {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smooth value noise, 0 to 1.
function noise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, seed);
  const b = lattice(ix + 1, iy, seed);
  const c = lattice(ix, iy + 1, seed);
  const d = lattice(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Three octaves of it, 0 to 1 and mostly near the middle.
export function fbm(x, y, seed) {
  return noise(x, y, seed) * 0.57 + noise(x * 2.03 + 17.1, y * 2.03 + 3.7, seed + 1) * 0.29 + noise(x * 4.1 + 5.3, y * 4.1 + 9.2, seed + 2) * 0.14;
}

const AURORA_HUES = 20;
const AURORA_PEAK = 135;

// The aurora: a slow ribbon of the cover's colours, brightest where its lobes gather and gone
// to nothing at its ends and edges, so it glows out of the dark. `t` is seconds and `level`
// (0 to 1) dims it. It is worked out on a grid of quadrant sub-pixels (twice as many across
// and down as there are cells) in smooth noise. Claude Code paints a Raster in 16 levels a
// channel, which on a dark glow is a few steps and shows as bands, so each sub-pixel is
// rounded to the grid with an ordered (Bayer) dither: the two nearest colours are woven into
// each other and the eye reads the level between. Each cell then takes the quadrant block that
// fits its four sub-pixels.
export function auroraCells(columns, rows, t, colors, level = 1) {
  const words = new Uint32Array(columns * rows * 3);
  if (columns < 1 || rows < 1) {
    return words;
  }
  const sw = columns * 2;
  const sh = rows * 2;
  const drift = t * 0.045;
  const edge = Math.min(18, Math.max(3, columns * 0.22));
  const lobe = new Float64Array(sw);
  const centre = new Float64Array(sw);
  const spread = new Float64Array(sw);
  const hue = [];
  const glow = [];
  // Light of the cover's colours, kept lively: a dull cover still gives a glow with some colour in it.
  const ramp = [colors[0], colors[1], colors[2]].map((c) => {
    const [h, s, l] = rgbToHsl(c);
    return hslToRgb([h, Math.max(s, 0.5), Math.min(0.62, Math.max(l, 0.46))]);
  });
  for (let sx = 0; sx < sw; sx += 1) {
    const x = (sx + 0.5) / 2;
    const gather = smooth(0.26, 0.8, fbm(x * 0.06 + drift * 2.2, 1.7, 11));
    const ray = 0.8 + 0.2 * noise(x * 0.8 - drift * 5, 4.2, 23);
    const ends = smooth(0, edge, x) * smooth(0, edge, columns - x);
    lobe[sx] = (0.1 + 0.9 * gather) * ray * ends * ends;
    centre[sx] = sh * (0.5 + 0.2 * (fbm(x * 0.04 - drift * 2.4, 8.3, 31) - 0.5) * 2);
    spread[sx] = Math.max(1.1, sh * (0.22 + 0.08 * fbm(x * 0.07 + drift * 2, 2.2, 41)));
    const g = 0.1 + (x / columns) * 0.6 + 0.32 * fbm(x * 0.03 - drift * 1.4, 5.9, 53) + drift * 0.5;
    const step = Math.round((((g % 1) + 1) % 1) * AURORA_HUES) / AURORA_HUES;
    const k = step * 3;
    const i = Math.floor(k) % 3;
    const f = smooth(0, 1, k - Math.floor(k));
    const c = mix(ramp[i], ramp[(i + 1) % 3], f);
    hue.push(c);
    // the same peak brightness for any colour: a pale yellow is held back, a deep purple pushed
    glow.push(Math.max(0.9, Math.min(1.7, AURORA_PEAK / Math.max(40, luma(c)))));
  }
  const sub = new Float64Array(sw * sh * 3);
  for (let sy = 0; sy < sh; sy += 1) {
    const y = sy + 0.5;
    const fadeIn = Math.min(2.4, sh * 0.36);
    const window = smooth(0, fadeIn, y) * smooth(0, fadeIn * 1.15, sh - y);
    for (let sx = 0; sx < sw; sx += 1) {
      const d = (y - centre[sx]) / spread[sx];
      // a bright core in a wide, faint haze, so it reads as light spilling and not as a bar
      const light = Math.max(0, (Math.exp(-0.5 * d * d) * 0.82 + Math.exp(-0.5 * (d / 3) * (d / 3)) * 0.45) * lobe[sx] * window * level);
      const threshold = bayer(sx, sy);
      const at = (sy * sw + sx) * 3;
      const c = hue[sx];
      for (let k = 0; k < 3; k += 1) {
        const value = PANEL_BG[k] + c[k] * glow[sx] * light;
        sub[at + k] = Math.max(0, Math.min(15, Math.floor(value / GRID + threshold))) * GRID;
      }
    }
  }
  return quadrantWords(sub, columns, rows, true);
}

// ---------- layout ----------

// Which view to draw. `big` is the person's choice, `isSong` is true while hum has a track
// (the radio always keeps its band). `rows` is the room the band may take.
// Returns { mode: "band" } or { mode: "panel", cover: "image" | "cells" | "svg" }.
export function chooseLayout({ big, isSong, surface, columns, rows, canImages }) {
  const band = { mode: "band" };
  if (!big || !isSong) {
    return band;
  }
  if (surface === "terminal") {
    if (!(columns >= PANEL_MIN_COLUMNS) || !(rows >= PANEL_ROWS + PANEL_ROOM)) {
      return band;
    }
    return { mode: "panel", cover: canImages ? "image" : "cells" };
  }
  if (surface === "desktop") {
    return { mode: "panel", cover: "svg" };
  }
  return band;
}

// Whether this terminal draws pictures: kitty and Ghostty do, and tmux passes none through.
// `env` holds the values of TERM_PROGRAM, TERM, KITTY_WINDOW_ID, GHOSTTY_RESOURCES_DIR and TMUX,
// and HUSH_COVER ("cells" or "image") forces the answer.
export function canShowImages(env) {
  const forced = String(env.HUSH_COVER || "").toLowerCase();
  if (forced === "cells") {
    return false;
  }
  if (forced === "image") {
    return true;
  }
  if (env.TMUX) {
    return false;
  }
  const program = String(env.TERM_PROGRAM || "").toLowerCase();
  const term = String(env.TERM || "").toLowerCase();
  return Boolean(env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) || program === "ghostty" || term.includes("kitty") || term.includes("ghostty");
}

// Cells across the panel's right-hand column: what is left after padding, the cover and the gap.
export function panelWidths(columns, cover = COVER_COLUMNS, gap = PANEL_GAP) {
  const text = Math.max(10, columns - PANEL_PAD * 2 - cover - gap);
  return { cover, gap, text, bar: Math.max(6, text - 15) };
}

// How big the terminal panel is, measured from the room the engine gives (`maxRows`, what the
// band may take) and the cells across. The cover is square (twice as many columns as rows, a
// cell being about twice as tall as wide) and as tall as the room allows, 8 to 10 rows, leaving
// one row of slack for the focus hint. The words beside it are a two row ribbon of aurora and six
// lines (title, artist, two caption lines, progress, buttons); a ninth row adds a gap under the
// artist and a tenth another above the progress. Narrow terminals keep the smaller cover. A row
// of padding above and below is added when there is plenty of room.
// Returns { rows, cover, gap, text, bar, ribbon, gapA, gapB, pad }.
export function panelGeometry(columns, maxRows) {
  let rows = Math.max(PANEL_ROWS, Math.min(PANEL_ROWS_MAX, Math.floor(maxRows) - PANEL_ROOM));
  if (columns < 76) {
    rows = Math.min(rows, PANEL_ROWS);
  }
  const cover = rows * 2;
  const gap = rows >= 9 ? 3 : PANEL_GAP;
  const w = panelWidths(columns, cover, gap);
  return {
    rows,
    cover,
    gap,
    text: w.text,
    bar: Math.max(6, w.text - 12),
    ribbon: RIBBON_ROWS,
    gapA: rows >= 9 ? 1 : 0,
    gapB: rows >= 10 ? 1 : 0,
    pad: maxRows >= rows + 4 ? 1 : 0,
  };
}

// ---------- progress ----------

// The progress bar as filled and empty cell counts.
export function progressBar(pos, dur, cells) {
  const share = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const filled = Math.round(share * cells);
  return { filled, empty: cells - filled };
}

// The bar to eighths of a cell: whole cells, then one of ▏▎▍▌▋▊▉ for the part, then the rest.
export function progressEighths(pos, dur, cells) {
  const share = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const eighths = Math.round(share * cells * 8);
  return { full: Math.floor(eighths / 8), part: eighths % 8, cells, eighths };
}

// The bar as runs of text to draw: { text, color: [r, g, b], track }. The filled part is
// a gradient from `from` to `to` across the filled cells (so both colours show from the start),
// cut into a few steps so neighbouring cells share a run; the part cell is an eighth block over the
// track; the rest is track (a run of spaces on a dim background).
export function progressRuns(pos, dur, cells, from, to) {
  const { full, part } = progressEighths(pos, dur, cells);
  const filled = full + (part > 0 ? 1 : 0);
  const runs = [];
  const push = (text, color, track) => {
    const last = runs[runs.length - 1];
    if (last && last.track === track && last.color[0] === color[0] && last.color[1] === color[1] && last.color[2] === color[2] && !last.single) {
      last.text += text;
    } else {
      runs.push({ text, color, track });
    }
  };
  for (let i = 0; i < full; i += 1) {
    const k = filled > 1 ? Math.round((i / (filled - 1)) * 8) / 8 : 0;
    push(EIGHTHS[8], mix(from, to, k).map(Math.round), false);
  }
  if (part > 0) {
    const k = filled > 1 ? 1 : 0;
    runs.push({ text: EIGHTHS[part], color: mix(from, to, k).map(Math.round), track: true, single: true });
  }
  if (cells - filled > 0) {
    push(" ".repeat(cells - filled), TRACK, true);
  }
  return runs;
}

// Times that keep their width, so the bar does not shift as the minutes roll over: both are
// as wide as the song's length.
export function timeLabels(pos, dur) {
  const total = dur > 0 ? clock(dur) : "";
  const width = Math.max(total.length, 4);
  return { elapsed: clock(pos).padStart(width, " "), total: total === "" ? "" : total.padStart(width, " ") };
}

// ---------- caption ----------

// The two lines under the artist. With synced lyrics: the line being sung (an interlude is
// three dots) and the next one. Without: the album, and what is up next, so there is never a
// gap. Each is { role, label, text }; role is "now", "next", "album", "queue" or "quiet".
export function captionLines(song) {
  const queue = song.upNext ? { role: "queue", label: "up next", text: song.upNext } : null;
  if (song.hasLyrics) {
    return {
      kind: "lyrics",
      first: { role: "now", label: "", text: song.line || "· · ·" },
      second: song.next ? { role: "next", label: "", text: song.next } : queue || { role: "quiet", label: "", text: "· · ·" },
    };
  }
  return {
    kind: "about",
    first: { role: "album", label: "", text: song.album || "no synced lyrics for this one" },
    second: queue || { role: "quiet", label: "", text: song.album ? "no synced lyrics for this one" : "end of the queue" },
  };
}

// ---------- cover files ----------

// A folder name for a track: its id when it is a plain one, else a hash of title and artist.
export function coverKey(track) {
  const id = track && typeof track.id === "string" ? track.id : "";
  if (/^[A-Za-z0-9_-]{4,40}$/.test(id)) {
    return id;
  }
  const text = `${track?.title || ""}|${track?.artist || ""}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
  }
  return `t${hash.toString(16)}`;
}

// Where to fetch a cover from: hum's art, then YouTube's thumbnail. http and https only.
export function coverUrls(track) {
  const urls = [];
  if (track && typeof track.art === "string" && /^https?:\/\//.test(track.art)) {
    urls.push(track.art);
  }
  if (track && typeof track.id === "string" && /^[A-Za-z0-9_-]{6,20}$/.test(track.id)) {
    urls.push(`https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`);
  }
  return urls;
}

export const COVER_KEEP = 40;

// A shell script for one cover, run by /bin/sh with: folder, art folder, how many to keep, then
// the urls. It downloads with curl and makes cover.png (the terminal's Image), cover.jpg (the
// desktop's Svg) and cells.bmp (read in JS for the cell art and the colours), all with sips.
// cells.bmp is 64 pixels square, enough for a 20 column cover at two pixels a cell with room to
// average. A folder that already has the three files is only touched, which keeps the newest ones.
export const COVER_SCRIPT = `
set -e
d="$1"; root="$2"; keep="$3"; shift 3
if [ -s "$d/cover.png" ] && [ -s "$d/cover.jpg" ] && [ -s "$d/cells.bmp" ]; then /usr/bin/touch "$d"; exit 0; fi
/bin/mkdir -p "$d"
trap 'rc=$?; [ "$rc" -ne 0 ] && /bin/rm -rf "$d"; exit "$rc"' EXIT
cd "$d"
got=0
for u in "$@"; do
  if /usr/bin/curl -fsSL --proto '=http,https' --max-time 10 --max-filesize 8000000 -o raw "$u" 2>/dev/null; then got=1; break; fi
done
[ "$got" = 1 ]
w=$(/usr/bin/sips -g pixelWidth raw | /usr/bin/awk '/pixelWidth/ {print $2}')
h=$(/usr/bin/sips -g pixelHeight raw | /usr/bin/awk '/pixelHeight/ {print $2}')
s=$(( w < h ? w : h ))
/usr/bin/sips -c "$s" "$s" -s format png raw --out sq.png >/dev/null
/usr/bin/sips -z 192 192 -s format png sq.png --out cover.png >/dev/null
/usr/bin/sips -z 216 216 -s format jpeg -s formatOptions 68 sq.png --out cover.jpg >/dev/null
/usr/bin/sips -z 64 64 -s format bmp sq.png --out cells.bmp >/dev/null
/bin/rm -f raw sq.png
trap - EXIT
if [ -n "$root" ] && [ "$keep" -gt 0 ]; then
  cd "$root"
  /bin/ls -1t | /usr/bin/tail -n +"$((keep + 1))" | while IFS= read -r old; do /bin/rm -rf "$root/$old"; done
fi
`;

// ---------- desktop svg ----------

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The desktop's picture: the cover with rounded corners on a haze of itself (the cover blown
// up and blurred, so the card takes its colours), a soft shadow of its first colour, a drifting
// glow, then the title, artist and album and three bars that dance while it plays. The glow and
// bars move by SMIL when `animated`. It holds nothing that changes while a song plays (no
// lyric, no clock), so the same source is drawn every second and the animation keeps going.
export function panelSvg({ title, artist, album = "", colors, accent, jpeg, animated, dim }) {
  const [c0, c1, c2, c3] = colors.map(hex);
  const ac = hex(accent);
  const move = (attr, values, dur) =>
    animated ? `<animate attributeName="${attr}" values="${values}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` : "";
  const blob = (cx, cy, r, color, opacity, moves) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${Math.round(r * 0.7)}" fill="${color}" fill-opacity="${opacity}">${moves}</ellipse>`;
  const bar = (x, low, high, dur) => {
    const h = animated ? low : Math.round((low + high) / 2);
    const motion = animated
      ? `<animate attributeName="height" values="${low};${high};${low}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` +
        `<animate attributeName="y" values="${46 - low};${46 - high};${46 - low}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>`
      : "";
    return `<rect x="${x}" y="${46 - h}" width="3" height="${h}" rx="1.5" fill="${ac}" fill-opacity="${dim ? 0.45 : 0.95}">${motion}</rect>`;
  };
  const glowOpacity = dim ? 0.18 : 0.42;
  const hazeOpacity = dim ? 0.3 : 0.62;
  const art = jpeg
    ? `<image id="art" href="data:image/jpeg;base64,${jpeg}" width="108" height="108" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect id="art" width="108" height="108" fill="url(#wash)"/>`;
  const sub = album && album !== title ? `<text x="152" y="130" font-size="12" fill="${BONE}" fill-opacity="0.42">${esc(fit(album, 52))}</text>` : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif">`,
    `<defs>`,
    art,
    `<clipPath id="frame"><rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" rx="16"/></clipPath>`,
    `<clipPath id="cover"><rect x="20" y="20" width="108" height="108" rx="14"/></clipPath>`,
    `<clipPath id="words"><rect x="152" y="0" width="${SVG_WIDTH - 152 - 20}" height="${SVG_HEIGHT}"/></clipPath>`,
    `<filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="30"/></filter>`,
    `<filter id="haze" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="38"/></filter>`,
    `<filter id="lift" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="13"/></filter>`,
    `<linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.6" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`,
    `<linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BACKGROUND_HEX}" stop-opacity="0.12"/><stop offset="0.32" stop-color="${BACKGROUND_HEX}" stop-opacity="0.55"/><stop offset="1" stop-color="${BACKGROUND_HEX}" stop-opacity="0.72"/></linearGradient>`,
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="0.45" stop-color="#ffffff" stop-opacity="0"/></linearGradient>`,
    `</defs>`,
    `<g clip-path="url(#frame)">`,
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${BACKGROUND_HEX}"/>`,
    `<g filter="url(#haze)" opacity="${hazeOpacity}"><use href="#art" transform="translate(-110 -170) scale(7.4)"/></g>`,
    `<g filter="url(#soft)">`,
    blob(150, 40, 150, c0, glowOpacity, move("cx", "150;270;150", 17) + move("cy", "40;80;40", 23)),
    blob(360, 120, 170, c1, glowOpacity, move("cx", "360;210;360", 21) + move("cy", "120;60;120", 19)),
    blob(520, 30, 140, c2, glowOpacity, move("cx", "520;420;520", 25) + move("cy", "30;84;30", 29)),
    blob(60, 140, 110, c3, glowOpacity + 0.1, move("cx", "60;150;60", 31)),
    `</g>`,
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="url(#shade)"/>`,
    `<rect x="26" y="34" width="96" height="104" rx="16" fill="${c0}" filter="url(#lift)" fill-opacity="${dim ? 0.35 : 0.8}"/>`,
    `<g clip-path="url(#cover)"><use href="#art" x="20" y="20"/><rect x="20" y="20" width="108" height="108" fill="url(#sheen)"/></g>`,
    `<rect x="20.5" y="20.5" width="107" height="107" rx="13.5" fill="none" stroke="${BONE}" stroke-opacity="0.16"/>`,
    `<g clip-path="url(#words)">`,
    `<text x="152" y="44" font-size="10" font-weight="600" letter-spacing="2.6" fill="${ac}" fill-opacity="${dim ? 0.6 : 0.95}">NOW PLAYING</text>`,
    bar(256, 4, 12, 0.9),
    bar(262, 10, 4, 1.1),
    bar(268, 6, 13, 0.8),
    `<text x="152" y="82" font-size="26" font-weight="700" letter-spacing="-0.3" fill="${BONE}"${dim ? ' fill-opacity="0.78"' : ""}>${esc(fit(title, 28))}</text>`,
    `<text x="152" y="107" font-size="15" fill="${BONE}" fill-opacity="${dim ? 0.5 : 0.74}">${esc(fit(artist, 46))}</text>`,
    sub,
    `</g>`,
    `</g>`,
    `</svg>`,
  ].join("");
  // Too big only if the picture is: draw it again without.
  if (svg.length > SVG_LIMIT && jpeg) {
    return panelSvg({ title, artist, album, colors, accent, jpeg: null, animated, dim });
  }
  return svg;
}
