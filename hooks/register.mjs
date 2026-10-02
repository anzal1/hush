// Hush: free radio and any song, in one quiet line above the prompt, with a small
// DJ Clawd who listens along.
//
// Radio comes from bin/hush, a small native helper that streams with the system
// AVPlayer and listens on a unix socket. Songs come from hum, a free player that plays
// through YouTube's own embed in a window you can see. Hush starts hum when it is not
// running and talks to its loopback remote over HTTP. hooks/logic.mjs holds the pure parts.
//
//   /music                     start the last station, or pause and resume
//   /music <song or artist>    play it in hum: /music frank ocean nights
//   /music next | prev | pause | stop
//   /music lofi | jazz | chill | classical | nature | radio
//   /music vol 40
//   /music clawd               show or hide DJ Clawd
//   /music big                 toggle the big panel (cover, aurora, lyric line) for songs
//
// When Claude asks a permission question the music steps down and Clawd lifts one
// headphone cup. Both come back when the question is answered. The host reads
// on(...) and $.noun.method(...) from source, so they are written out in full.
//
// The big panel (hooks/panel.mjs holds its pure parts) draws the cover, an aurora in the
// cover's colours, the title, artist, lyric line, progress and buttons while a song plays
// through hum. The terminal gets cells and a picture where it can show one, the desktop a
// single SVG. Radio keeps the one-line band.

import { clamp, duckCommand, humView, livePosition, parseArgs, route, VOLUME_STEP } from "./logic.mjs";
import {
  auroraCells,
  BACKGROUND_HEX,
  BONE,
  BONE_DIM,
  BONE_SOFT,
  canShowImages,
  chooseLayout,
  clock,
  COVER_COLUMNS,
  COVER_KEEP,
  COVER_ROWS,
  COVER_SCRIPT,
  coverKey,
  coverUrls,
  encodeCells,
  FALLBACK_ACCENT,
  FALLBACK_COLORS,
  fit,
  fromBase64,
  halfBlockCells,
  hex,
  PANEL_GAP,
  PANEL_PAD,
  palette,
  panelSvg,
  panelWidths,
  parseBmp,
  placeholderCells,
  progressBar,
  RIBBON_ROWS,
} from "./panel.mjs";

const STATIONS = [
  { id: "lofi", name: "lofi", color: "#d97757", url: "https://radio.nia.nc/radio/8020/lofi-hq-stream.aac" },
  { id: "jazz", name: "jazz", color: "#e0af68", url: "https://smoothjazz.cdnstream1.com/2585_128.mp3" },
  { id: "chill", name: "chill", color: "#9b87f5", url: "https://0n-chillout.radionetz.de/0n-chillout.aac" },
  { id: "classical", name: "classical", color: "#7fb7a0", url: "https://stream.srg-ssr.ch/m/rsc_de/aacp_96" },
  { id: "nature", name: "nature", color: "#6fa8c7", url: "https://purenature-mynoise.radioca.st/stream" },
];
const HUM_COLOR = "#d97757";
const CLAWD_COLOR = "#d97757";

const RELEASE_URL = "https://github.com/anzal1/hush/releases/latest/download/hush-macos";
const HUM_INSTALL = "github:anzal1/hum";
const HUM_DEFAULT_PORT = 3737;
const POLL_MS = 2500;
const HUM_POLL_MS = 1000;
const HUM_STATE_MS = 1500;
const HUM_PLAY_MS = 25000;
const HUM_WAIT_MS = 20000;
const HUM_MISSES = 10;
const BAR_CELLS = 10;
const COLLAPSE_CELLS = 4;
const MAX_COLUMNS = 100;
const CLAWD_ZONE = 12;
const AURORA_MS = 125;
const AURORA_MISSES = 20;
const AURORA_STALE_MS = 4000;
const COVER_MS = 30000;
const PROBE_MS = 1500;
const EPOCH = Date.now();
const SESSION = Math.random().toString(36).slice(2, 8);

// What the radio helper last said: { state, station, title, volume, ducked, pos, dur }.
let status = { state: "off", station: "", title: "", volume: 55, ducked: false, pos: 0, dur: 0 };
let stationIndex = 0;
let source = "radio";
let hum = null;
let humPort = HUM_DEFAULT_PORT;
let humMisses = 0;
let humBusy = false;
let humDucked = false;
let humSeen = "";
let finding = "";
let timer = null;
let timerMs = 0;
let failures = 0;
let isLit = false;
let clawdOn = true;
let big = false;
let canImages = false;
let cover = emptyCover("");
let panelSite = null;
let auroraTimer = null;
let auroraBusy = false;
let auroraMisses = 0;
let auroraBlocked = "";
let imagesBlocked = false;
let probed = "";
let walk = CLAWD_ZONE - 7;
let nod = false;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "music",
      description: "Free radio and any song above the prompt",
      argumentHint: "[song or artist | next | prev | pause | stop | lofi | jazz | chill | classical | nature | radio | vol <0-100> | clawd]",
      immediate: true,
    });
    const kept = await $.store.get("station").catch(() => undefined);
    if (typeof kept === "number" && kept >= 0 && kept < STATIONS.length) {
      stationIndex = kept;
    }
    const saved = await $.store.get("volume").catch(() => undefined);
    if (typeof saved === "number") {
      status.volume = saved;
    }
    const port = Number.parseInt((await $.env.get("HUM_PORT").catch(() => undefined)) ?? "", 10);
    humPort = port > 0 && port < 65536 ? port : HUM_DEFAULT_PORT;
    const clawd = await $.store.get("clawd").catch(() => undefined);
    if (typeof clawd === "boolean") {
      clawdOn = clawd;
    }
    const wide = await $.store.get("big").catch(() => undefined);
    if (typeof wide === "boolean") {
      big = wide;
    }
    const term = {
      TERM_PROGRAM: (await $.env.get("TERM_PROGRAM").catch(() => undefined)) ?? "",
      TERM: (await $.env.get("TERM").catch(() => undefined)) ?? "",
      KITTY_WINDOW_ID: (await $.env.get("KITTY_WINDOW_ID").catch(() => undefined)) ?? "",
      GHOSTTY_RESOURCES_DIR: (await $.env.get("GHOSTTY_RESOURCES_DIR").catch(() => undefined)) ?? "",
      TMUX: (await $.env.get("TMUX").catch(() => undefined)) ?? "",
      HUSH_COVER: (await $.env.get("HUSH_COVER").catch(() => undefined)) ?? "",
    };
    canImages = canShowImages(term);
    const running = await ask($, "status");
    if (running && (running.state === "playing" || running.state === "loading" || running.state === "paused")) {
      adopt(running);
      watch($);
    }
    return started;
  });

  on("command.run", { command: "music" }, async ($, e) => {
    const text = await runCommand($, e.args.trim());
    return { text };
  });

  // Claude Code's own guard hides classic.PermissionRequest from installed mods, so the
  // question is caught here instead: the verdict "ask" means a dialog is about to open.
  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    if (verdict && verdict.decision === "ask") {
      await duck($, true);
    }
    return verdict;
  });

  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    await duck($, true);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (clawdOn && isPlaying() && !isDucked()) {
      nod = true;
      $.ui.invalidate("ui.render");
      $.clock.after(220, () => {
        nod = false;
        $.ui.invalidate("ui.render");
      });
    }
    return next(e);
  });

  // The classic.* events are hidden from installed mods when an organization guard is loaded, so
  // the music comes back on events that are not: a tool result being recorded, a turn ending, or
  // a new prompt.
  on("session.append", { door: "tool-result" }, async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("classic.PostToolUse", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("classic.PostToolUseFailure", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("classic.PermissionDenied", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("classic.Stop", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    await duck($, false);
    return next(e);
  });

  on("ui.focus", async ($, e, next) => {
    const wasLit = isLit;
    isLit = e.component === "AbovePrompt" && e.plugin === $.plugin.name && Boolean(e.element);
    if (isLit !== wasLit) {
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey || !isActive()) {
      leavePanel($, e);
      return next(e);
    }
    const ui = $.ui.resolve(e);
    const width = e.props.bodyColumns ?? 80;
    const columns = Math.min(width - COLLAPSE_CELLS, MAX_COLUMNS);
    const song = source === "hum" && finding === "" ? humView(hum, now()) : null;
    const layout = chooseLayout({
      big,
      isSong: song !== null,
      surface: e.surface,
      columns: width,
      rows: e.props.maxRows ?? 0,
      canImages: canImages && !imagesBlocked,
    });
    const beneath = await next(e);
    if (layout.mode === "panel") {
      const drawn = e.surface === "desktop" ? desktopPanel($, ui, song, columns) : terminalPanel($, ui, e, layout, song, columns);
      return ui.Box({ flexDirection: "column", children: [drawn, beneath] });
    }
    leavePanel($, e);
    return ui.Box({ flexDirection: "column", children: [band($, ui, columns), beneath] });
  });

  on("session.end", async ($, e, next) => {
    await duck($, false);
    stop();
    return next(e);
  });
}

// ---------- helper process ----------

async function paths($) {
  const home = await $.env.get("HOME");
  const dir = `${home}/.claude/hush`;
  return { bin: `${$.plugin.root}/bin/hush`, socket: `${dir}/h.sock` };
}

// Sends one command; resolves the helper's JSON reply, or null when it is not running.
async function ask($, command) {
  const { bin, socket } = await paths($);
  try {
    const run = await $.process.run([bin, "ctl", socket, command], { timeoutMs: 4000 });
    if (run.exitCode !== 0) {
      return null;
    }
    return JSON.parse(run.stdout.trim());
  } catch {
    return null;
  }
}

async function exists($, path) {
  const run = await $.process.run(["/bin/test", "-x", path]).catch(() => ({ exitCode: 1 }));
  return run.exitCode === 0;
}

// Makes sure the helper runs, building it from source (or downloading it) when the binary is missing.
async function ensureHelper($) {
  if (await ask($, "status")) {
    return true;
  }
  const { bin, socket } = await paths($);
  const root = $.plugin.root;
  if (!(await exists($, bin))) {
    const built = (await exists($, "/usr/bin/swiftc"))
      ? await $.process
          .run(["/usr/bin/swiftc", "-O", `${root}/native/hush.swift`, "-o", bin], { timeoutMs: 180000 })
          .catch(() => ({ exitCode: 1 }))
      : await download($, RELEASE_URL, bin);
    if (built.exitCode !== 0) {
      return false;
    }
  }
  await $.process.run(
    ["/bin/sh", "-c", 'mkdir -p "$(dirname "$1")"; nohup "$0" daemon "$1" >/dev/null 2>&1 &', bin, socket],
    { timeoutMs: 5000 },
  );
  for (let i = 0; i < 25; i += 1) {
    await $.clock.sleep(120);
    if (await ask($, "status")) {
      return true;
    }
  }
  return false;
}

async function download($, url, target) {
  return $.process
    .run(["/bin/sh", "-c", 'mkdir -p "$(dirname "$2")" && curl -fsSL "$1" -o "$2" && chmod +x "$2"', "sh", url, target], {
      timeoutMs: 240000,
    })
    .catch(() => ({ exitCode: 1 }));
}

// ---------- hum ----------

function humUrl(path) {
  return `http://127.0.0.1:${humPort}${path}`;
}

function now() {
  return Date.now();
}

// One request to hum's loopback remote. Resolves the parsed JSON, or null when hum does not answer in time.
async function humFetch($, path, init, ms) {
  let timeout;
  const late = new Promise((resolve) => {
    timeout = $.clock.after(ms, () => resolve(null));
  });
  const reply = await Promise.race([$.http.fetch(humUrl(path), init).catch(() => null), late]);
  timeout.cancel();
  if (!reply || !reply.ok) {
    return null;
  }
  try {
    return JSON.parse(reply.text);
  } catch {
    return null;
  }
}

async function humState($) {
  return humFetch($, "/api/remote/state", undefined, HUM_STATE_MS);
}

async function humSend($, body, ms = HUM_STATE_MS) {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return humFetch($, "/api/remote", init, ms);
}

// Starts hum's server, detached. hum only opens its own tab when it has a terminal, so
// HUM_NO_OPEN is set and Hush opens the visible player itself once the server answers.
async function startHum($) {
  await $.process
    .run(
      [
        "/bin/sh",
        "-c",
        'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; HUM_NO_OPEN=1 PORT="$1" nohup npx -y -p "$2" hum >/dev/null 2>&1 &',
        "sh",
        String(humPort),
        HUM_INSTALL,
      ],
      { timeoutMs: 5000 },
    )
    .catch(() => undefined);
}

async function openHum($) {
  await $.process.run(["/usr/bin/open", `http://localhost:${humPort}`], { timeoutMs: 5000 }).catch(() => undefined);
}

// Makes sure a hum window is open: starts the server when nothing answers, opens the player
// when the server has no window, then waits for a window to connect.
async function ensureHum($) {
  let state = await humState($);
  if (state && state.connected > 0) {
    return "";
  }
  finding = "opening hum…";
  $.ui.invalidate("ui.render");
  if (!state) {
    await startHum($);
  }
  let opened = false;
  for (let waited = 0; ; waited += 500) {
    if (state && state.connected > 0) {
      return "";
    }
    if (state && !opened) {
      await openHum($);
      opened = true;
    }
    if (waited >= HUM_WAIT_MS) {
      break;
    }
    await $.clock.sleep(500);
    state = await humState($);
  }
  if (state) {
    return `hum is running but its player window is not open. Open http://localhost:${humPort} and run /music again.`;
  }
  return `hum needs to be open to play songs. Start it with: npx -y -p ${HUM_INSTALL} hum, then run /music again.`;
}

// Sends a song to hum, which plays it in its own visible YouTube player.
async function playOnHum($, cmd) {
  finding = `finding ${cmd.query}…`;
  $.ui.invalidate("ui.render");
  try {
    const problem = await ensureHum($);
    if (problem) {
      return problem;
    }
    finding = `finding ${cmd.query}…`;
    $.ui.invalidate("ui.render");
    await quietRadio($);
    const reply = await humSend($, cmd, HUM_PLAY_MS);
    if (!reply) {
      return "hum did not answer. Check that its player window is still open.";
    }
    if (!reply.ok) {
      return reply.text || "hum could not play that.";
    }
    source = "hum";
    humMisses = 0;
    humSeen = "";
    hum = (await humState($)) ?? hum;
    watch($);
    cue($);
    wantCover($);
    return reply.text || `Playing ${cmd.query} in hum`;
  } finally {
    finding = "";
    $.ui.invalidate("ui.render");
  }
}

// Stops the radio before a song starts, so the two never play together.
async function quietRadio($) {
  stopTimer();
  if (status.state === "playing" || status.state === "loading" || status.state === "paused") {
    await ask($, "stop");
  }
  status = { ...status, state: "off", title: "", ducked: false, pos: 0, dur: 0 };
}

// Hands the sound back to the radio: hum is paused (and restored if it was stepped down).
async function leaveHum($) {
  if (source !== "hum") {
    return;
  }
  const view = humView(hum, now());
  if (view && view.state === "playing") {
    await humSend($, { cmd: "pause" });
  }
  if (humDucked) {
    await humSend($, { cmd: "unduck" });
  }
  dropHum();
}

function dropHum() {
  stopTimer();
  stopAurora();
  cover = emptyCover("");
  source = "radio";
  hum = null;
  humDucked = false;
  humMisses = 0;
  humSeen = "";
}

async function pollHum($) {
  if (humBusy || source !== "hum") {
    return;
  }
  humBusy = true;
  try {
    const state = await humState($);
    if (source !== "hum") {
      return;
    }
    const view = humView(state, now());
    if (!view) {
      humMisses += 1;
      if (state) {
        hum = state;
      }
      if (humMisses >= HUM_MISSES) {
        stop();
      }
      $.ui.invalidate("ui.render");
      return;
    }
    humMisses = 0;
    const before = humView(hum, now());
    hum = state;
    if (!before || before.title !== view.title) {
      cue($);
    }
    wantCover($);
    syncAurora($);
    const seen = [view.name, view.line, view.state, view.ducked, view.volume, Math.floor(view.pos)].join("|");
    if (seen !== humSeen) {
      humSeen = seen;
      $.ui.invalidate("ui.render");
    }
  } finally {
    humBusy = false;
  }
}

// ---------- commands ----------

async function runCommand($, args) {
  return perform($, parseArgs(args, STATIONS.map((s) => s.id)));
}

// Works out what an intent means for the current source, then does it.
async function perform($, intent) {
  const view = humView(hum, now());
  const plan = route(intent, {
    source,
    humLive: view !== null,
    radioActive: isActive(),
    radioVolume: status.volume,
    humVolume: view ? view.volume : 0,
    stationIndex,
  });
  if (plan.target === "hum") {
    return performHum($, plan);
  }
  if (plan.target === "radio") {
    return performRadio($, plan);
  }
  if (plan.action === "big") {
    big = !big;
    await $.store.set("big", big).catch(() => undefined);
    if (big) {
      wantCover($);
    } else {
      panelSite = null;
      auroraBlocked = "";
      stopAurora();
    }
    $.ui.invalidate("ui.render");
    return big
      ? "Big panel on. Songs through hum get it; radio keeps its band"
      : "Big panel off. Back to the one-line band";
  }
  clawdOn = !clawdOn;
  await $.store.set("clawd", clawdOn).catch(() => undefined);
  $.ui.invalidate("ui.render");
  return clawdOn ? "DJ Clawd is back" : "DJ Clawd is off";
}

async function performHum($, plan) {
  if (plan.action === "play") {
    return playOnHum($, plan.cmd);
  }
  if (plan.action === "volume") {
    if (!plan.cmd) {
      return `Volume is ${humView(hum, now())?.volume ?? 0}. Use /music vol 0-100`;
    }
    hum = { ...hum, volume: plan.level };
    $.ui.invalidate("ui.render");
    await humSend($, plan.cmd);
    return `Volume ${plan.level}`;
  }
  const reply = await humSend($, plan.cmd);
  if (plan.action === "stop") {
    dropHum();
    $.ui.invalidate("ui.render");
    return "Music stopped";
  }
  if (!reply) {
    return "hum did not answer. Check that its player window is still open.";
  }
  if (!reply.ok) {
    return reply.text || "hum could not do that.";
  }
  if (plan.action === "next" || plan.action === "prev") {
    return reply.text || (plan.action === "next" ? "Next song" : "Previous song");
  }
  const playing = plan.cmd.cmd === "resume" || (plan.cmd.cmd === "toggle" && hum && !hum.playing);
  hum = { ...hum, playing, position: livePosition(hum, now()), at: now() };
  syncAurora($);
  $.ui.invalidate("ui.render");
  return playing ? "Playing" : "Paused";
}

async function performRadio($, plan) {
  await leaveHum($);
  if (plan.action === "station") {
    return startStation($, plan.index);
  }
  if (plan.action === "next") {
    return startStation($, stationIndex + 1);
  }
  if (plan.action === "prev") {
    return startStation($, stationIndex - 1);
  }
  if (plan.action === "stop") {
    await ask($, "stop");
    stop();
    $.ui.invalidate("ui.render");
    return "Music stopped";
  }
  if (plan.action === "volume") {
    if (plan.level === null) {
      return `Volume is ${status.volume}. Use /music vol 0-100`;
    }
    await setVolume($, plan.level);
    return `Volume ${status.volume}`;
  }
  return toggle($);
}

async function toggle($) {
  await togglePause($);
  return status.state === "paused" ? "Paused" : "Playing";
}

async function startStation($, index) {
  stationIndex = (index + STATIONS.length) % STATIONS.length;
  const station = STATIONS[stationIndex];
  if (!(await ensureHelper($))) {
    return "Hush could not start its player. It needs macOS, and either Xcode's command line tools or a network connection to GitHub.";
  }
  await ask($, `vol ${status.volume}`);
  await ask($, "resume");
  const reply = await ask($, `play ${station.url} ${station.name}`);
  if (reply) {
    adopt(reply);
  }
  await $.store.set("station", stationIndex).catch(() => undefined);
  watch($);
  cue($);
  $.ui.invalidate("ui.render");
  return `Playing ${station.name}. ctrl+x tab for controls`;
}

async function togglePause($) {
  const paused = status.state === "paused";
  const reply = await ask($, paused ? "resume" : "pause");
  if (reply) {
    adopt(reply);
  }
  $.ui.invalidate("ui.render");
}

async function setVolume($, value) {
  const clamped = clamp(value, 0, 100);
  status = { ...status, volume: clamped };
  await ask($, `vol ${clamped}`);
  await $.store.set("volume", clamped).catch(() => undefined);
  $.ui.invalidate("ui.render");
}

// Steps the sound down for a question and back up after, on whichever source is playing.
async function duck($, wanted) {
  if (source === "hum") {
    const body = duckCommand(wanted, humDucked);
    if (!body || (wanted && !isActive())) {
      return;
    }
    humDucked = wanted;
    if (hum) {
      hum = { ...hum, ducked: wanted };
    }
    syncAurora($);
    $.ui.invalidate("ui.render");
    await humSend($, body);
    return;
  }
  if (!isActive() || status.ducked === wanted) {
    return;
  }
  status = { ...status, ducked: wanted };
  $.ui.invalidate("ui.render");
  await ask($, `${wanted ? "duck" : "unduck"} ${SESSION}`);
}

// ---------- state ----------

function isActive() {
  if (finding !== "") {
    return true;
  }
  if (source === "hum") {
    return humView(hum, now()) !== null;
  }
  return status.state === "playing" || status.state === "loading" || status.state === "paused";
}

function isPlaying() {
  if (source === "hum") {
    return humView(hum, now())?.state === "playing";
  }
  return status.state === "playing";
}

function isDucked() {
  return source === "hum" ? humDucked || Boolean(hum?.ducked) : status.ducked;
}

function adopt(reply) {
  const index = STATIONS.findIndex((s) => s.name === reply.station);
  if (index >= 0) {
    stationIndex = index;
  }
  status = { ...status, ...reply };
}

// Polls the source that is playing: the radio helper every 2.5 s, hum every second.
function watch($) {
  const ms = source === "hum" ? HUM_POLL_MS : POLL_MS;
  if (timer && timerMs === ms) {
    return;
  }
  stopTimer();
  timerMs = ms;
  timer = $.clock.every(ms, () => {
    void (source === "hum" ? pollHum($) : poll($));
  });
}

function stopTimer() {
  if (timer) {
    timer.cancel();
    timer = null;
  }
}

function stop() {
  dropHum();
  finding = "";
  status = { ...status, state: "off", title: "", ducked: false, pos: 0, dur: 0 };
}

async function poll($) {
  const reply = await ask($, "status");
  if (!reply || reply.state === "idle") {
    stop();
    $.ui.invalidate("ui.render");
    return;
  }
  if (reply.state === "failed") {
    failures += 1;
    if (failures <= STATIONS.length) {
      await startStation($, stationIndex + 1);
      return;
    }
    stop();
    await ask($, "stop");
    $.ui.invalidate("ui.render");
    return;
  }
  failures = 0;
  const moved = reply.state === "playing" && Math.abs((reply.pos ?? 0) - (status.pos ?? 0)) >= 2;
  const changed = reply.state !== status.state || reply.title !== status.title || reply.ducked !== status.ducked || moved;
  adopt(reply);
  if (changed) {
    $.ui.invalidate("ui.render");
  }
}

// DJ Clawd walks in from the left of his spot whenever a new song or station starts.
function cue($) {
  if (!clawdOn) {
    return;
  }
  walk = 0;
  const step = () => {
    walk += 1;
    $.ui.invalidate("ui.render");
    if (walk < CLAWD_ZONE - 7) {
      $.clock.after(120, step);
    }
  };
  $.clock.after(120, step);
}

// ---------- drawing ----------

// A hotkey makes the engine draw a "h:" prefix, so only the focused band carries them.
function keyed(letter) {
  return isLit ? { hotkey: letter } : {};
}

// DJ Clawd: the banner mascot's head with headphones. One cup lifts when you are being asked something.
function clawdFace() {
  if (isDucked()) {
    return "(▐▛█▜▌ '";
  }
  return nod ? "(▐▙█▟▌)" : "(▐▛█▜▌)";
}

// One line: note, title, a tag, a bar, buttons, DJ Clawd. Narrower terminals drop the
// bar first, then the tag, then DJ Clawd, then the buttons.
function band($, ui, columns) {
  const { Box, Text, Button } = ui;
  const song = source === "hum" ? humView(hum, now()) : null;
  const isSong = song !== null;
  const view = song ?? status;
  const station = STATIONS[stationIndex];
  const accent = isSong ? HUM_COLOR : station.color;
  const ducked = isDucked();
  const quiet = ducked || view.state === "paused";
  const loading = finding !== "" || view.state === "loading";
  let title = status.title || `${station.name} radio`;
  if (finding) {
    title = finding;
  } else if (isSong) {
    title = song.name;
  } else if (status.state === "loading") {
    title = "tuning…";
  }
  const tag = isSong ? (view.dur > 0 ? `${clock(view.pos)} / ${clock(view.dur)}` : "") : `${station.name} · live`;
  // A song with lyrics gives the bar's room to the lyric line; the clock in the tag shows progress.
  const showBar = columns >= 70 && !(isSong && song.hasLyrics);
  const showTag = columns >= 56 && tag !== "";
  const showButtons = columns >= 44;
  const showClawd = clawdOn && columns >= 84 && view.state === "playing" && !finding;
  const lit = isLit && showButtons;
  const showVolButtons = lit && columns >= 70;
  const barText = showBar ? BAR_CELLS + 1 : 0;
  const tagText = showTag ? tag.length + 2 : 0;
  let buttonsText = 0;
  if (showButtons) {
    buttonsText = showVolButtons ? 40 : lit ? 24 : 12;
  }
  const clawdText = showClawd ? CLAWD_ZONE + 2 : 0;
  const titleCells = Math.max(8, columns - 2 - tagText - barText - buttonsText - clawdText - 1);

  const parts = [Text({ color: accent, dimColor: quiet, children: "♪ " })];
  if (isSong && song.hasLyrics && !finding && titleCells >= 40) {
    // Title and artist keep a fixed share, so the buttons stay put while the lyric changes.
    const nameCells = Math.min(song.name.length, Math.max(16, Math.floor(titleCells * 0.5)));
    const lyricCells = titleCells - nameCells - 2;
    parts.push(Text({ dimColor: quiet, children: fit(song.name, nameCells).padEnd(nameCells) }));
    parts.push(Text({ children: "  " }));
    parts.push(Text({ color: accent, dimColor: quiet, italic: true, children: fit(song.line, lyricCells).padEnd(lyricCells) }));
  } else {
    parts.push(Text({ dimColor: quiet || loading, children: fit(title, titleCells).padEnd(titleCells) }));
  }
  if (showTag) {
    parts.push(Text({ dimColor: true, children: `  ${tag}` }));
  }
  if (showBar) {
    let filled;
    if (isSong) {
      filled = view.dur > 0 ? Math.round((view.pos / view.dur) * BAR_CELLS) : 0;
    } else {
      const effective = ducked ? Math.round(status.volume * 0.35) : status.volume;
      filled = status.state === "paused" ? 0 : Math.round((effective / 100) * BAR_CELLS);
    }
    filled = clamp(filled, 0, BAR_CELLS);
    parts.push(Text({ children: " " }));
    parts.push(Text({ color: accent, dimColor: quiet, children: "━".repeat(filled) }));
    parts.push(Text({ dimColor: true, children: "─".repeat(BAR_CELLS - filled) }));
  }
  if (showButtons) {
    parts.push(Text({ children: "  " }));
    parts.push(
      Button({ key: "prev", label: "‹", ...keyed("h"), plain: true, dimColor: !lit, onPress: () => void press($, "prev") }),
    );
    parts.push(Text({ children: " " }));
    parts.push(
      Button({
        key: "play",
        label: view.state === "paused" ? "play" : "pause",
        ...keyed("p"),
        plain: true,
        autoFocus: true,
        dimColor: !lit,
        onPress: () => void press($, "pause"),
      }),
    );
    parts.push(Text({ children: " " }));
    parts.push(
      Button({ key: "next", label: "›", ...keyed("l"), plain: true, dimColor: !lit, onPress: () => void press($, "next") }),
    );
    if (showVolButtons) {
      parts.push(Text({ children: "  " }));
      parts.push(Button({ key: "down", label: "-", hotkey: "j", plain: true, onPress: () => void press($, "down") }));
      parts.push(Text({ dimColor: true, children: ` vol ${view.volume} ` }));
      parts.push(Button({ key: "up", label: "+", hotkey: "k", plain: true, onPress: () => void press($, "up") }));
    }
  }
  if (showClawd) {
    parts.push(Text({ children: " ".repeat(Math.max(1, walk + 1)) }));
    parts.push(Text({ color: CLAWD_COLOR, children: clawdFace() }));
  }
  const row = Box({ flexDirection: "row", paddingX: 1, children: parts });
  if (!lit) {
    return row;
  }
  const hint = Text({
    dimColor: true,
    children: showVolButtons
      ? ` p pause · h l ${isSong ? "song" : "station"} · j k volume · esc back to the prompt`
      : ` p pause · h l ${isSong ? "song" : "station"} · esc back to the prompt`,
  });
  return Box({ flexDirection: "column", children: [row, hint] });
}

// ---------- big panel ----------

function emptyCover(key) {
  return { key, state: "none", png: "", jpg: "", cells: "", colors: FALLBACK_COLORS, accent: FALLBACK_ACCENT, filler: "" };
}

// Starts reading the cover of the song that plays, when the big panel is on and it is a new song.
// The work runs in the background; the panel draws a stand-in until the cover is ready.
function wantCover($) {
  if (!big || source !== "hum" || !hum || !hum.track) {
    return;
  }
  const key = coverKey(hum.track);
  if (cover.key === key) {
    return;
  }
  cover = emptyCover(key);
  void loadCover($, key, hum.track);
}

// Downloads the cover and makes its files with sips (see COVER_SCRIPT), then reads them.
async function loadCover($, key, track) {
  const home = await $.env.get("HOME").catch(() => undefined);
  const urls = coverUrls(track);
  let found = null;
  if (home && urls.length > 0) {
    const root = `${home}/.claude/hush/art`;
    const dir = `${root}/${key}`;
    const run = await $.process
      .run(["/bin/sh", "-c", COVER_SCRIPT, "sh", dir, root, String(COVER_KEEP), ...urls], { timeoutMs: COVER_MS })
      .catch(() => ({ exitCode: 1 }));
    if (run.exitCode === 0) {
      found = await readCover($, dir);
    }
  }
  if (cover.key !== key) {
    return;
  }
  cover = found ? { ...emptyCover(key), ...found, state: "ready" } : emptyCover(key);
  $.ui.invalidate("ui.render");
}

async function readCover($, dir) {
  try {
    const thumb = await $.fs.read(`${dir}/thumb.bmp`, { as: "bytes" });
    const image = parseBmp(fromBase64(thumb.base64));
    if (!image) {
      return null;
    }
    const jpg = await $.fs.read(`${dir}/cover.jpg`, { as: "bytes" });
    const png = canImages ? await $.fs.read(`${dir}/cover.png`, { as: "bytes" }) : { base64: "" };
    const found = palette(image.rgba);
    const words = halfBlockCells(image.rgba, image.width, image.height, COVER_COLUMNS, COVER_ROWS);
    return { png: png.base64, jpg: jpg.base64, cells: encodeCells(words), colors: found.colors, accent: found.accent };
  } catch {
    return null;
  }
}

// The aurora moves while the terminal panel is on screen and the song plays: one Raster
// repainted about ten times a second with $.ui.blit, never the whole tree. It stops when the
// music is paused or stepped down, the panel is replaced, or the band has not been drawn for a while.
function auroraTime() {
  return (now() - EPOCH) / 1000;
}

function syncAurora($) {
  const wanted = panelSite !== null && siteKey(panelSite) !== auroraBlocked && source === "hum" && isPlaying() && !isDucked();
  if (!wanted) {
    stopAurora();
    return;
  }
  if (!auroraTimer) {
    auroraTimer = $.clock.every(AURORA_MS, () => {
      void auroraFrame($);
    });
  }
}

// A surface that keeps refusing the blits is left alone until the panel is drawn again from scratch.
function siteKey(site) {
  return `${site.requestId}:${site.columns}x${site.rows}`;
}

function stopAurora() {
  if (auroraTimer) {
    auroraTimer.cancel();
    auroraTimer = null;
  }
  auroraMisses = 0;
}

async function auroraFrame($) {
  const site = panelSite;
  if (auroraBusy) {
    return;
  }
  if (!site || now() - site.at > AURORA_STALE_MS) {
    stopAurora();
    return;
  }
  auroraBusy = true;
  try {
    const cells = encodeCells(auroraCells(site.columns, site.rows, auroraTime(), cover.colors, 1));
    const result = await $.ui.blit({ requestId: site.requestId, key: "aurora", cells, columns: site.columns, rows: site.rows });
    auroraMisses = result && result.deny ? auroraMisses + 1 : 0;
  } catch {
    auroraMisses += 1;
  } finally {
    auroraBusy = false;
  }
  if (auroraMisses >= AURORA_MISSES) {
    auroraBlocked = siteKey(site);
    stopAurora();
  }
}

// The terminal's name in the environment is only a hint: the engine decides whether it really
// draws pictures, and a blit is refused when it draws the alt instead. When that stays so, the
// cover is drawn as cell art. The first look comes after the terminal has had time to answer.
function probeImage($, requestId, png, key, attempt) {
  $.clock.after(attempt === 0 ? PROBE_MS : PROBE_MS * 2, async () => {
    if (cover.key !== key || panelSite === null) {
      return;
    }
    const result = await $.ui.blit({ requestId, key: "cover", source: { png } }).catch(() => undefined);
    if (!result || !result.deny || !result.deny.includes("alt")) {
      return;
    }
    if (attempt === 0) {
      probeImage($, requestId, png, key, 1);
      return;
    }
    imagesBlocked = true;
    $.ui.invalidate("ui.render");
  });
}

// The panel is not drawn (band, survey or nothing playing): the aurora has nothing to paint.
function leavePanel($, e) {
  if (e.surface === "terminal") {
    panelSite = null;
    auroraBlocked = "";
    stopAurora();
  }
}

function glowLevel(song) {
  if (isDucked()) {
    return 0.3;
  }
  return song.state === "paused" ? 0.45 : 1;
}

function timeLabel(song) {
  return song.dur > 0 ? `${clock(song.pos)} / ${clock(song.dur)}` : clock(song.pos);
}

// Prev, play or pause, next, then the volume (when focused and there is room) and DJ Clawd.
// `room` is how many cells the row has. DJ Clawd stays in big mode, at the end of this row.
function controlsRow($, ui, song, columns, room) {
  const { Box, Text, Button } = ui;
  const lit = isLit;
  const parts = [
    Button({ key: "prev", label: "‹ prev", ...keyed("h"), dimColor: !lit, onPress: () => void press($, "prev") }),
    Text({ children: "  " }),
    Button({
      key: "play",
      label: song.state === "paused" ? "play" : "pause",
      ...keyed("p"),
      autoFocus: true,
      onPress: () => void press($, "pause"),
    }),
    Text({ children: "  " }),
    Button({ key: "next", label: "next ›", ...keyed("l"), dimColor: !lit, onPress: () => void press($, "next") }),
  ];
  let left = room - 33;
  if (lit && left >= 16) {
    parts.push(Text({ children: "  " }));
    parts.push(Button({ key: "down", label: "-", hotkey: "j", plain: true, onPress: () => void press($, "down") }));
    parts.push(Text({ color: BONE_DIM, children: ` vol ${song.volume} ` }));
    parts.push(Button({ key: "up", label: "+", hotkey: "k", plain: true, onPress: () => void press($, "up") }));
    left -= 16;
  }
  if (clawdOn && columns >= 84 && song.state === "playing" && left >= CLAWD_ZONE + 2) {
    parts.push(Text({ children: " ".repeat(Math.max(1, walk + 1)) }));
    parts.push(Text({ color: CLAWD_COLOR, children: clawdFace() }));
  }
  return Box({ flexDirection: "row", children: parts });
}

function progressRow(ui, song, cells, accent, quiet) {
  const { Box, Text } = ui;
  const bar = progressBar(song.pos, song.dur, cells);
  return Box({
    flexDirection: "row",
    children: [
      Text({ color: accent, dimColor: quiet, children: "━".repeat(bar.filled) }),
      Text({ color: BONE_DIM, children: "─".repeat(bar.empty) }),
      Text({ color: BONE_DIM, children: `  ${timeLabel(song)}` }),
    ],
  });
}

function hintRow(ui) {
  return ui.Text({ color: BONE_DIM, children: " p pause · h l song · j k volume · esc back to the prompt" });
}

// Terminal: the cover on the left (a picture where the terminal shows one, else half-block
// cells), and on the right an aurora Raster over the title, artist, lyric, progress and buttons.
function terminalPanel($, ui, e, layout, song, columns) {
  const { Box, Text, Raster, Image } = ui;
  const w = panelWidths(columns);
  const quiet = isDucked() || song.state === "paused";
  const accent = hex(cover.accent);
  panelSite = { requestId: e.requestId, columns: w.text, rows: RIBBON_ROWS, at: now() };
  syncAurora($);
  if (layout.cover === "image" && cover.png && probed !== cover.key) {
    probed = cover.key;
    probeImage($, e.requestId, cover.png, cover.key, 0);
  }
  const glow = encodeCells(auroraCells(w.text, RIBBON_ROWS, auroraTime(), cover.colors, glowLevel(song)));
  if (!cover.cells && !cover.filler) {
    cover.filler = encodeCells(placeholderCells(COVER_COLUMNS, COVER_ROWS, cover.colors));
  }
  const art =
    layout.cover === "image" && cover.png
      ? Image({ key: "cover", source: { png: cover.png }, columns: COVER_COLUMNS, rows: COVER_ROWS, alt: "cover" })
      : Raster({ key: "cover", columns: COVER_COLUMNS, rows: COVER_ROWS, cells: cover.cells || cover.filler });
  const text = Box({
    flexDirection: "column",
    width: w.text,
    children: [
      Raster({ key: "aurora", columns: w.text, rows: RIBBON_ROWS, cells: glow }),
      Text({ bold: true, color: BONE, dimColor: quiet, wrap: "truncate-end", children: song.title }),
      Text({ color: BONE_SOFT, dimColor: quiet, wrap: "truncate-end", children: song.artist || " " }),
      Text({ children: " " }),
      Text({ color: accent, dimColor: quiet, italic: true, wrap: "truncate-end", children: song.line || " " }),
      progressRow(ui, song, w.bar, accent, quiet),
      controlsRow($, ui, song, columns, w.text),
    ],
  });
  const body = Box({
    flexDirection: "row",
    gap: PANEL_GAP,
    children: [Box({ width: COVER_COLUMNS, height: COVER_ROWS, flexShrink: 0, children: art }), text],
  });
  return Box({
    flexDirection: "column",
    backgroundColor: BACKGROUND_HEX,
    paddingX: PANEL_PAD,
    children: isLit ? [body, hintRow(ui)] : [body],
  });
}

// Desktop: one Svg with the cover on a drifting glow, with the title and artist. It holds
// nothing that changes each second, so its source stays the same while the song plays and
// the animation is not restarted. The lyric line, progress and buttons are native elements.
function desktopPanel($, ui, song, columns) {
  const { Box, Text, Svg } = ui;
  const ducked = isDucked();
  const quiet = ducked || song.state === "paused";
  const accent = hex(cover.accent);
  const picture = Svg({
    source: panelSvg({
      title: song.title,
      artist: song.artist,
      colors: cover.colors,
      accent: cover.accent,
      jpeg: cover.jpg,
      animated: song.state === "playing" && !ducked,
      dim: quiet,
    }),
    alt: song.artist ? `${song.title} by ${song.artist}` : song.title,
    isInteractive: true,
  });
  const cells = Math.max(12, Math.min(60, columns - 24));
  return Box({
    flexDirection: "column",
    backgroundColor: BACKGROUND_HEX,
    paddingBottom: 1,
    children: [
      picture,
      Box({
        flexDirection: "column",
        paddingX: 2,
        paddingTop: 1,
        children: [
          Text({ color: accent, dimColor: quiet, italic: true, wrap: "truncate-end", children: song.line || " " }),
          progressRow(ui, song, cells, accent, quiet),
          Text({ children: " " }),
          controlsRow($, ui, song, columns, columns - 4),
          ...(isLit ? [hintRow(ui)] : []),
        ],
      }),
    ],
  });
}

async function press($, what) {
  const keys = {
    pause: { kind: "toggle" },
    next: { kind: "next" },
    prev: { kind: "prev" },
    up: { kind: "vol", delta: VOLUME_STEP },
    down: { kind: "vol", delta: -VOLUME_STEP },
  };
  if (keys[what]) {
    await perform($, keys[what]);
  }
}
