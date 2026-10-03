// The desktop stage: the player in the Claude app's Code tab, one composed picture. The cover
// and its light on the left; the title, the lyric being sung, a progress bar and the time in
// the middle; DJ Clawd at his booth on the right. The song's next minutes are written into the
// picture (lyric lines fade in at their times, the bar glides, the time ticks), so it moves by
// itself and the band is only redrawn when something else changes (the track, play or pause,
// a question, the volume) or every two minutes to carry the timeline on. A redraw builds it
// from the current position, and the loops take their phase from the clock, so a rebuilt
// picture carries on exactly where the old one was.
import { hex } from "./panel.mjs";

export const STAGE_HEIGHT = 196;
export const STAGE_LIMIT = 126000;
const W = 760;
const BG = "#131315";
const BONE = "#f6f2ec";
const BEAT = 0.5; // a steady groove: the player's audio is sealed inside YouTube's frame

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fit = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s));
const n2 = (v) => Number(v.toFixed(2));

// The engine refuses an Svg over 131072 characters: a picture that comes out too big is built
// again with a shorter window of the song ahead, and at the last without the cover.
export function stageSvg(args) {
  for (const ahead of [150, 75, 30, 0]) {
    const svg = buildStage({ ...args, ahead });
    if (svg.length <= STAGE_LIMIT) return svg;
  }
  return buildStage({ ...args, ahead: 0, jpeg: "" });
}

function buildStage({ title, artist, album = "", upNext = "", lyrics = [], pos = 0, dur = 0, playing, ducked, colors, accent, jpeg, clawd = true, clock = 0, ahead = 150 }) {
  const [c0, c1, c2] = colors.map(hex);
  const ac = hex(accent);
  const live = playing && !ducked;
  const dim = !live;
  const H = STAGE_HEIGHT;
  const phase = (d, shift = 0) => `begin="-${n2((clock + shift) % d)}s"`;
  const drift = (attr, values, d) =>
    live ? `<animate attributeName="${attr}" values="${values}" dur="${d}s" ${phase(d)} repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` : "";

  const S = 150, CX = 24, CY = (H - S) / 2;
  const art = jpeg ? `<image id="art" href="data:image/jpeg;base64,${jpeg}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>` : `<rect id="art" width="100" height="100" fill="${c0}"/>`;
  const useArt = (x, y, size) => `<use href="#art" transform="translate(${x} ${y}) scale(${n2(size / 100)})"/>`;

  const TX = 200;
  const label = ducked ? "TURNED DOWN" : playing ? "NOW PLAYING" : "PAUSED";
  const eq = live
    ? [0, 5, 10]
        .map((dx, i) => {
          const lo = [3, 8, 4][i], hi = [10, 3, 11][i], d = [0.86, 1.04, 0.72][i];
          return `<rect x="${TX + 104 + dx}" width="2.5" rx="1.25" fill="${ac}"><animate attributeName="height" values="${lo};${hi};${lo}" dur="${d}s" ${phase(d)} repeatCount="indefinite"/><animate attributeName="y" values="${46 - lo};${46 - hi};${46 - lo}" dur="${d}s" ${phase(d)} repeatCount="indefinite"/></rect>`;
        })
        .join("")
    : "";
  const sub = album && album !== title ? `<tspan fill-opacity="0.5"> · ${esc(fit(album, 24))}</tspan>` : "";
  const words = [
    `<text x="${TX}" y="46" font-size="10" font-weight="700" letter-spacing="2.3" fill="${ac}" fill-opacity="${dim ? 0.6 : 0.95}">${label}</text>${eq}`,
    `<text x="${TX}" y="78" font-size="28" font-weight="760" letter-spacing="-0.7" fill="${BONE}" fill-opacity="${dim ? 0.75 : 1}">${esc(fit(title, 22))}</text>`,
    `<text x="${TX}" y="101" font-size="14.5" fill="${BONE}" fill-opacity="${dim ? 0.48 : 0.7}">${esc(fit(artist, 30))}${sub}</text>`,
  ].join("");


  // the song: the lyric being sung over the next one, each shown for its own span; a bar that
  // glides to the end; the elapsed time ticking second by second
  const TW = 300;
  const clockText = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  let lines = "";
  const timed = lyrics.filter((l) => l && typeof l.t === "number").sort((a, b) => a.t - b.t);
  if (timed.length) {
    for (let i = 0; i < timed.length; i++) {
      const start = timed[i].t, end = i + 1 < timed.length ? timed[i + 1].t : dur || start + 8;
      if (end <= pos) continue;
      if (start - pos > ahead) break;
      const b0 = n2(Math.max(0, start - pos)), b1 = n2(end - pos);
      const shown = start <= pos;
      const now = timed[i].text?.trim() ? timed[i].text : "\u266a";
      const next = i + 1 < timed.length ? timed[i + 1].text || "" : "";
      const line = (y, size, weight, fill, op, text) => {
        const enter = shown ? "" : `<animate attributeName="opacity" from="0" to="${op}" begin="${b0}s" dur="0.28s" fill="freeze"/><animate attributeName="y" from="${y + 5}" to="${y}" begin="${b0}s" dur="0.32s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.7 0.3 1"/>`;
        const leave = live ? `<set attributeName="opacity" to="0" begin="${b1}s"/>` : "";
        return `<text x="${TX}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" opacity="${shown ? op : 0}">${esc(fit(text, size > 15 ? 34 : 42))}${live ? enter : ""}${leave}</text>`;
      };
      lines += line(126, 16.5, 650, ac, dim ? 0.6 : 1, now);
      if (next) lines += line(147, 14, 400, BONE, dim ? 0.3 : 0.42, next);
      if (!live) break;
    }
  } else {
    lines =
      `<text x="${TX}" y="126" font-size="15.5" font-style="italic" fill="${BONE}" fill-opacity="0.72">${esc(fit(album || "No synced lyrics for this one", 36))}</text>` +
      (upNext ? `<text x="${TX}" y="147" font-size="13.5" fill="${BONE}" fill-opacity="0.42">up next  \u00b7  ${esc(fit(upNext, 36))}</text>` : "");
  }
  const frac = dur > 0 ? Math.min(1, pos / dur) : 0;
  const w0 = n2(TW * frac);
  const glide = live && dur > pos ? `<animate attributeName="width" from="${w0}" to="${TW}" dur="${n2(dur - pos)}s" fill="freeze"/>` : "";
  const knob = live && dur > pos ? `<animate attributeName="cx" from="${TX + w0}" to="${TX + TW}" dur="${n2(dur - pos)}s" fill="freeze"/>` : "";
  const bar =
    `<rect x="${TX}" y="164" width="${TW}" height="3" rx="1.5" fill="${BONE}" fill-opacity="0.12"/>` +
    `<rect x="${TX}" y="164" width="${w0}" height="3" rx="1.5" fill="url(#prog)">${glide}</rect>` +
    `<circle cx="${TX + w0}" cy="165.5" r="4.5" fill="${BONE}" fill-opacity="${dim ? 0.6 : 0.95}">${knob}</circle>`;
  let ticks = "";
  if (live && dur > pos) {
    const first = Math.floor(pos);
    for (let k = first; k < Math.min(dur, first + ahead + 30); k++) {
      const b0 = n2(Math.max(0, k - pos)), b1 = n2(k + 1 - pos);
      ticks += `<tspan x="${TX}" visibility="${k === first ? "visible" : "hidden"}">${clockText(k)}${k === first ? "" : `<set attributeName="visibility" to="visible" begin="${b0}s"/>`}<set attributeName="visibility" to="hidden" begin="${b1}s"/></tspan>`;
    }
  } else {
    ticks = `<tspan x="${TX}">${clockText(pos)}</tspan>`;
  }
  const times =
    `<text y="186" font-size="11" fill="${BONE}" fill-opacity="0.62">${ticks}</text>` +
    (dur ? `<text x="${TX + TW}" y="186" text-anchor="end" font-size="11" fill="${BONE}" fill-opacity="0.38">${clockText(dur)}</text>` : "");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif">`,
    `<defs>${art}`,
    `<clipPath id="cv"><rect x="${CX}" y="${CY}" width="${S}" height="${S}" rx="14"/></clipPath>`,
    `<clipPath id="col"><rect x="${TX - 4}" y="0" width="330" height="${H}"/></clipPath>`,
    `<filter id="haze" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="44"/></filter>`,
    `<filter id="lift" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="15"/></filter>`,
    `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>`,
    `<linearGradient id="prog" x1="0" x2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${ac}"/></linearGradient>`,
    `<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="cone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}" stop-opacity="0.34"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></linearGradient>`,
    `<radialGradient id="vinyl"><stop offset="0.36" stop-color="#121214"/><stop offset="0.37" stop-color="#202024"/><stop offset="1" stop-color="#0c0c0e"/></radialGradient>`,
    `</defs>`,
    `<rect x="-2000" y="-200" width="${W + 4000}" height="${H + 400}" fill="${BG}"/>`,
    `<g opacity="${dim ? 0.3 : 0.55}" filter="url(#haze)">${useArt(-60, -200, 540)}</g>`,
    `<g filter="url(#haze)" opacity="${dim ? 0.14 : 0.3}">`,
    `<ellipse cx="120" cy="86" rx="170" ry="110" fill="${c0}">${drift("cx", "120;220;120", 19)}</ellipse>`,
    `<ellipse cx="360" cy="10" rx="180" ry="70" fill="${c1}">${drift("cx", "360;250;360", 27)}</ellipse>`,
    `<ellipse cx="660" cy="160" rx="190" ry="80" fill="${c2}">${drift("cy", "160;120;160", 23)}</ellipse>`,
    `</g>`,
    `<rect x="${CX + 10}" y="${CY + 16}" width="${S - 20}" height="${S - 10}" rx="16" fill="${c0}" filter="url(#lift)" fill-opacity="${dim ? 0.3 : 0.7}"/>`,
    `<g clip-path="url(#cv)">${useArt(CX, CY, S)}<rect x="${CX}" y="${CY}" width="${S}" height="${S}" fill="url(#sheen)"/></g>`,
    `<rect x="${CX + 0.5}" y="${CY + 0.5}" width="${S - 1}" height="${S - 1}" rx="13.5" fill="none" stroke="#fff" stroke-opacity="0.12"/>`,
    `<g clip-path="url(#col)">${words}${lines}${bar}</g>`,
    times,
    clawd ? booth({ x: 528, H, live, playing, ducked, ac, c1, phase, drift, useArt, clock }) : "",
    `</svg>`,
  ].join("");
}

// ---------------- DJ Clawd

// His routine over 16 beats, in half beats: which pose each arm holds. d = hands on the decks,
// s = working the record, e = holding an ear cup, u = a hand raised. Looks follow the work.
const ROUTINE = {
  left: "dddddddd" + "sdsdsdsd" + "dddddddd" + "eeeedddd",
  right: "dddddddd" + "dddddddd" + "sdsdsdsd" + "dddduudd",
};
const LOOK = "00000000" + "LLLLLLLL" + "RRRRRRRR" + "00000000"; // where his eyes are turned
const BLINKS = [13, 27]; // half beats at which he blinks

function booth({ x, H, live, playing, ducked, ac, c1, phase, drift, useArt, clock }) {
  const u = 6.5;
  const O = "#d97757", E = "#1b1410", P = "#2a2a2e";
  const top = H - 56; // the desk's top edge
  const bw = 216;
  const ox = bw / 2 - 6 * u, oy = top - 5 * u; // where Clawd stands
  const cycle = BEAT * 16, slots = 32;
  const keyTimes = Array.from({ length: slots }, (_, i) => n2(i / slots)).join(";");
  // one switch per half beat, so poses change like frames of a sprite
  const frames = (seq, on) =>
    live
      ? `<animate attributeName="opacity" values="${[...seq].map((c) => (c === on ? 1 : 0)).join(";")}" keyTimes="${keyTimes}" calcMode="discrete" dur="${cycle}s" ${phase(cycle)} repeatCount="indefinite"/>`
      : "";
  const px = (x0, y0, w, h, fill = O) => `<rect x="${n2(x0 * u)}" y="${n2(y0 * u)}" width="${n2(w * u)}" height="${n2(h * u)}" fill="${fill}"/>`;
  // one arm in each pose, drawn for the left side; the right is its mirror
  const POSES = {
    d: px(-2.4, 2, 2.4, 1) + px(-3.4, 2, 1, 3.6) + px(-4, 5.4, 2.2, 1.1),
    s: px(-2.4, 2, 2.4, 1) + px(-4, 2, 1, 3.6) + px(-4.8, 5.4, 2.2, 1.1),
    e: px(-1.2, 2.2, 1.2, 1) + px(-1.9, 0.6, 1, 2.6) + px(-2.1, 0.2, 1.3, 1.1),
    u: px(-1.2, 2, 1.2, 1) + px(-2, -2.4, 1, 4.4) + px(-2.3, -3.3, 1.6, 1.1),
  };
  const restPose = ducked ? { left: "d", right: "e" } : { left: "d", right: "d" };
  const arm = (side) => {
    const seq = ROUTINE[side];
    const mirror = side === "right" ? ` transform="matrix(-1 0 0 1 ${12 * u} 0)"` : "";
    const poses = Object.entries(POSES)
      .map(([k, shape]) => {
        const shown = live ? seq[0] === k : restPose[side] === k;
        return `<g opacity="${shown ? 1 : 0}">${shape}${frames(seq, k)}</g>`;
      })
      .join("");
    return `<g${mirror}>${poses}</g>`;
  };
  const body = [[1, 0], [11, 0], [11, 2], [12, 2], [12, 4], [11, 4], [11, 6], [1, 6], [1, 4], [0, 4], [0, 2], [1, 2]]
    .map(([a, b], i) => `${i ? "L" : "M"}${a * u} ${b * u}`)
    .join(" ");
  // eyes: they glance at the deck being worked, blink now and then, and look to the prompt when asked
  const lookX = ducked ? -0.6 * u : 0;
  const glance = live
    ? `<animateTransform attributeName="transform" type="translate" values="${[...LOOK].map((c) => (c === "L" ? `${-0.5 * u} 0` : c === "R" ? `${0.5 * u} 0` : "0 0")).join(";")}" keyTimes="${keyTimes}" calcMode="discrete" dur="${cycle}s" ${phase(cycle)} repeatCount="indefinite"/>`
    : "";
  const blink = live
    ? `<animate attributeName="height" values="${Array.from({ length: slots }, (_, i) => (BLINKS.includes(i) ? n2(u * 0.2) : u)).join(";")}" keyTimes="${keyTimes}" calcMode="discrete" dur="${cycle}s" ${phase(cycle)} repeatCount="indefinite"/>`
    : "";
  const eye = (ex) => `<rect x="${ex * u + lookX}" y="${u}" width="${u}" height="${playing || ducked ? u : n2(u * 0.35)}" fill="${E}">${blink}</rect>`;
  const cupLifted = ducked;
  const clawd = [
    `<g transform="translate(${ox} ${oy})" shape-rendering="crispEdges">`,
    `<g>`,
    live ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${n2(u * 0.35)};0 0" dur="${BEAT}s" ${phase(BEAT)} repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>` : "",
    `<path d="${body} Z" fill="${O}"/>`,
    `<g>${glance}${eye(3)}${eye(8)}</g>`,
    `<path d="M ${-0.2 * u} ${2 * u} Q ${6 * u} ${-5 * u} ${12.2 * u} ${2 * u}" fill="none" stroke="${P}" stroke-width="${u * 0.9}" stroke-linecap="round"/>`,
    px(-1, 1, 2, 3, P),
    `<g${cupLifted ? ` transform="translate(${u * 1.6} ${-u * 1.8}) rotate(26 ${12 * u} ${2 * u})"` : ""}>${px(11, 1, 2, 3, P)}</g>`,
    `</g>`,
    `</g>`,
  ].join("");
  const arms = `<g transform="translate(${ox} ${oy})" shape-rendering="crispEdges"><g>${live ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 ${n2(u * 0.35)};0 0" dur="${BEAT}s" ${phase(BEAT)} repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>` : ""}${arm("left")}${arm("right")}</g></g>`;

  const spin = (d) => (live ? `<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="${d}s" ${phase(d)} repeatCount="indefinite"/>` : "");
  const deck = (cx) => {
    const cy = top + 9;
    return [
      `<g transform="translate(${cx} ${cy}) scale(1 0.34)">`,
      `<circle r="40" fill="#09090b"/><circle r="37" fill="url(#vinyl)"/>`,
      [30, 25, 20].map((r) => `<circle r="${r}" fill="none" stroke="#2c2c31" stroke-width="0.8"/>`).join(""),
      `<g>${spin(1.8)}`,
      `<clipPath id="lab${cx}"><circle r="12.5"/></clipPath><g clip-path="url(#lab${cx})">${useArt(-12.5, -12.5, 25)}</g>`,
      `<path d="M -34 -6 A 35 35 0 0 1 -6 -34" stroke="#fff" stroke-opacity="0.16" stroke-width="2" fill="none"/>`,
      `</g><circle r="2" fill="#ccc"/></g>`,
      `<g transform="translate(${cx + 32} ${cy - 10}) rotate(${playing ? 28 : 8})"><rect x="-1" y="0" width="2" height="22" rx="1" fill="#8a8a92"/><rect x="-2.5" y="20" width="5" height="4" rx="1" fill="#b9b9c2"/></g>`,
      `<circle cx="${cx + 32}" cy="${cy - 10}" r="3" fill="#55555c"/>`,
    ].join("");
  };
  const meter = (mx, d0) => {
    let s = "";
    for (let k = 0; k < 8; k++) {
      const fill = k >= 6 ? ac : k >= 4 ? c1 : "#7fd1a8";
      const op = live ? (k < 3 ? 0.9 : 0.12) : k < 1 ? 0.5 : 0.1;
      const flick = live && k >= 3 ? `<animate attributeName="fill-opacity" values="0.12;0.9;0.12;0.12" keyTimes="0;${n2(0.12 + k * 0.02)};${n2(0.4 + k * 0.03)};1" dur="${n2(BEAT * (k % 2 ? 1 : 2))}s" begin="-${n2((clock + d0 + k * 0.07) % BEAT)}s" repeatCount="indefinite"/>` : "";
      s += `<rect x="${mx}" y="${top + 41 - k * 4.2}" width="7" height="3" rx="1" fill="${fill}" fill-opacity="${op}">${flick}</rect>`;
    }
    return s;
  };
  return [
    `<g transform="translate(${x} 0)">`,
    `<path d="M ${bw / 2 - 30} -10 L ${bw / 2 + 30} -10 L ${bw + 10} ${top + 10} L -10 ${top + 10} Z" fill="url(#cone)" filter="url(#soft)" opacity="${live ? 0.9 : 0.35}">${drift("opacity", "0.7;1;0.7", BEAT * 8)}</path>`,
    clawd,
    `<rect x="0" y="${top}" width="${bw}" height="${H - top + 20}" rx="10" fill="#1b1b1f"/>`,
    `<rect x="1" y="${top}" width="${bw - 2}" height="1.5" fill="${ac}" fill-opacity="${live ? 0.55 : 0.2}"/>`,
    `<rect x="0" y="${top + 26}" width="${bw}" height="${H - top}" fill="#151518"/>`,
    `<text x="20" y="${top + 46}" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="15" fill="${BONE}" fill-opacity="0.26">hum</text>`,
    deck(46),
    deck(bw - 46),
    arms,
    meter(bw / 2 - 12, 0.11),
    meter(bw / 2 + 5, 0.27),
    `<rect x="${bw / 2 - 16}" y="${top + 49}" width="32" height="2" rx="1" fill="#2e2e33"/>`,
    `<rect y="${top + 46}" width="7" height="7" rx="1.5" fill="#c9c9d1" x="${bw / 2 - 12}">${live ? `<animate attributeName="x" values="${bw / 2 - 12};${bw / 2 + 5};${bw / 2 - 12}" dur="${BEAT * 32}s" ${phase(BEAT * 32)} repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>` : ""}</rect>`,
    `</g>`,
  ].join("");
}
