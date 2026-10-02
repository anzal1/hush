// Pure parts of Hush's big panel: no host calls, so tests can run them directly.
//
// The panel is the richer view above the prompt while a song plays through hum: the cover,
// an aurora in the cover's colours, the title, artist and lyric line, progress and buttons.
// This file reads the cover's pixels (a small BMP that /usr/bin/sips wrote), picks the
// colours, makes the cell art for the terminal and the SVG for the desktop, and decides
// which layout fits.

export const BACKGROUND = [8, 7, 11];
export const BACKGROUND_HEX = "#08070b";
export const BONE = "#f6f2ec";
export const BONE_SOFT = "#b9b1a6";
export const BONE_DIM = "#8a8379";

// hum's own warm colours, used until a cover has been read or when there is none.
export const FALLBACK_COLORS = [
  [196, 112, 78],
  [140, 110, 214],
  [92, 142, 176],
  [14, 11, 18],
];
export const FALLBACK_ACCENT = [235, 160, 128];

export const PANEL_MIN_COLUMNS = 60;
export const PANEL_ROWS = 8;
export const PANEL_ROOM = 2;
export const COVER_COLUMNS = 16;
export const COVER_ROWS = 8;
export const RIBBON_ROWS = 2;
export const PANEL_GAP = 2;
export const PANEL_PAD = 1;
export const SVG_LIMIT = 131072;
export const SVG_WIDTH = 560;
export const SVG_HEIGHT = 140;
export const UPPER_HALF = 0x2580;

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

// Box-averages an RGBA picture down to cols x rows pixels of RGB, over the background where see-through.
function resample(rgba, width, height, cols, rows) {
  const out = new Float64Array(cols * rows * 3);
  for (let y = 0; y < rows; y += 1) {
    const y0 = Math.floor((y * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / rows));
    for (let x = 0; x < cols; x += 1) {
      const x0 = Math.floor((x * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / cols));
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
      out[to] = r / n;
      out[to + 1] = g / n;
      out[to + 2] = b / n;
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

// Stand-in cover when there is no picture: a soft diagonal wash of the palette.
export function placeholderCells(cols, rows, colors) {
  const w = cols;
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
  return halfBlockCells(rgba, w, h, cols, rows);
}

// The aurora: soft curtains of the cover's colours drifting sideways over the dark warm
// background, brightest at the top and fading as they fall. `t` is seconds and `level`
// (0 to 1) dims it. Two pixels per cell row, drawn as ▀ cells.
export function auroraCells(columns, rows, t, colors, level = 1) {
  const words = new Uint32Array(columns * rows * 3);
  const pixels = rows * 2;
  const curtains = [
    { color: colors[0], freq: 1.9, speed: 0.55, phase: 0.0, sway: 0.7, gain: 0.95 },
    { color: colors[1], freq: 1.3, speed: -0.42, phase: 2.1, sway: 1.1, gain: 0.85 },
    { color: colors[2], freq: 2.7, speed: 0.31, phase: 4.2, sway: 0.5, gain: 0.7 },
    { color: colors[3], freq: 0.9, speed: 0.2, phase: 1.3, sway: 0.9, gain: 0.6 },
  ];
  const strength = [];
  for (let x = 0; x < columns; x += 1) {
    const u = x / Math.max(1, columns - 1);
    strength.push(
      curtains.map((c) => {
        const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * c.freq + t * c.speed * 2 + c.phase);
        return Math.pow(wave, 1.6);
      }),
    );
  }
  const channel = (x, py, i) => {
    const u = x / Math.max(1, columns - 1);
    const v = py / Math.max(1, pixels - 1);
    const lift = 0.14 * Math.sin(u * 5 + t * 0.7 + curtains[i].phase) * curtains[i].sway;
    const fall = Math.pow(Math.max(0, 1 - (v + lift) * 0.85), 1.5);
    return strength[x][i] * fall * curtains[i].gain * level;
  };
  // Light adds up, so it is eased into range rather than clipped, which keeps the hue.
  const ease = (base, add) => 255 * (1 - Math.exp(-(base + add) / 255 / 0.62)) - 255 * (1 - Math.exp(-base / 255 / 0.62));
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < columns; x += 1) {
      const at = (row * columns + x) * 3;
      words[at] = UPPER_HALF;
      for (let half = 0; half < 2; half += 1) {
        const py = row * 2 + half;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < curtains.length; i += 1) {
          const k = channel(x, py, i);
          r += curtains[i].color[0] * k;
          g += curtains[i].color[1] * k;
          b += curtains[i].color[2] * k;
        }
        words[at + 1 + half] = pack(BACKGROUND[0] + ease(BACKGROUND[0], r), BACKGROUND[1] + ease(BACKGROUND[1], g), BACKGROUND[2] + ease(BACKGROUND[2], b));
      }
    }
  }
  return words;
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
export function panelWidths(columns) {
  const text = Math.max(10, columns - PANEL_PAD * 2 - COVER_COLUMNS - PANEL_GAP);
  return { cover: COVER_COLUMNS, text, bar: Math.max(6, text - 15) };
}

// The progress bar as filled and empty cell counts.
export function progressBar(pos, dur, cells) {
  const share = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const filled = Math.round(share * cells);
  return { filled, empty: cells - filled };
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
// desktop's Svg) and thumb.bmp (read in JS for the cell art and the colours), all with sips.
// A folder that already has the three files is only touched, which keeps the newest ones.
export const COVER_SCRIPT = `
set -e
d="$1"; root="$2"; keep="$3"; shift 3
if [ -s "$d/cover.png" ] && [ -s "$d/cover.jpg" ] && [ -s "$d/thumb.bmp" ]; then /usr/bin/touch "$d"; exit 0; fi
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
/usr/bin/sips -z 160 160 -s format png sq.png --out cover.png >/dev/null
/usr/bin/sips -z 144 144 -s format jpeg -s formatOptions 62 sq.png --out cover.jpg >/dev/null
/usr/bin/sips -z 32 32 -s format bmp sq.png --out thumb.bmp >/dev/null
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

// The desktop's picture: the cover on a glow of its colours, with the title and artist. The
// glow drifts by SMIL when `animated`. It holds nothing that changes while a song plays
// (no lyric, no clock), so the same source is drawn every second and the animation keeps going.
export function panelSvg({ title, artist, colors, accent, jpeg, animated, dim }) {
  const [c0, c1, c2, c3] = colors.map(hex);
  const move = (attr, values, dur) =>
    animated ? `<animate attributeName="${attr}" values="${values}" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` : "";
  const blob = (cx, cy, r, color, opacity, moves) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${Math.round(r * 0.7)}" fill="${color}" fill-opacity="${opacity}">${moves}</ellipse>`;
  const glowOpacity = dim ? 0.3 : 0.62;
  const picture = jpeg
    ? `<image href="data:image/jpeg;base64,${jpeg}" x="18" y="18" width="104" height="104" clip-path="url(#cover)" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="18" y="18" width="104" height="104" rx="10" fill="url(#wash)"/>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif">`,
    `<defs>`,
    `<clipPath id="frame"><rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" rx="14"/></clipPath>`,
    `<clipPath id="cover"><rect x="18" y="18" width="104" height="104" rx="10"/></clipPath>`,
    `<clipPath id="words"><rect x="142" y="0" width="${SVG_WIDTH - 142 - 16}" height="${SVG_HEIGHT}"/></clipPath>`,
    `<filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="30"/></filter>`,
    `<linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.6" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`,
    `</defs>`,
    `<g clip-path="url(#frame)">`,
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${BACKGROUND_HEX}"/>`,
    `<g filter="url(#soft)">`,
    blob(120, 40, 150, c0, glowOpacity, move("cx", "120;260;120", 17) + move("cy", "40;70;40", 23)),
    blob(330, 110, 170, c1, glowOpacity, move("cx", "330;180;330", 21) + move("cy", "110;50;110", 19)),
    blob(500, 30, 150, c2, glowOpacity, move("cx", "500;400;500", 25) + move("cy", "30;80;30", 29)),
    blob(60, 130, 110, c3, glowOpacity + 0.1, move("cx", "60;150;60", 31)),
    `</g>`,
    `<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="${BACKGROUND_HEX}" fill-opacity="0.18"/>`,
    `<rect x="18" y="18" width="104" height="104" rx="10" fill="${c0}" filter="url(#soft)" fill-opacity="0.5"/>`,
    picture,
    `<rect x="18.5" y="18.5" width="103" height="103" rx="9.5" fill="none" stroke="${BONE}" stroke-opacity="0.14"/>`,
    `<g clip-path="url(#words)">`,
    `<text x="142" y="46" font-size="10" letter-spacing="2.4" fill="${hex(accent)}" fill-opacity="0.95">NOW PLAYING</text>`,
    `<text x="142" y="80" font-size="24" font-weight="700" fill="${BONE}">${esc(fit(title, 30))}</text>`,
    `<text x="142" y="106" font-size="15" fill="${BONE}" fill-opacity="0.68">${esc(fit(artist, 46))}</text>`,
    `</g>`,
    `</g>`,
    `</svg>`,
  ].join("");
  // Too big only if the picture is: draw it again without.
  if (svg.length > SVG_LIMIT && jpeg) {
    return panelSvg({ title, artist, colors, accent, jpeg: null, animated, dim });
  }
  return svg;
}
