// Hush: free radio and any song, in one quiet line above the prompt, with a small
// DJ Clawd who listens along.
//
// Audio comes from bin/hush, a small native helper that streams with the system
// AVPlayer and listens on a unix socket. This file only talks to it. Songs are
// found with yt-dlp, which Hush downloads once, the first time you ask for a song.
//
//   /music                     start the last station, or pause and resume
//   /music <song or artist>    play it: /music frank ocean nights
//   /music next | prev | pause | stop
//   /music lofi | jazz | chill | classical | nature
//   /music vol 40
//   /music clawd               show or hide DJ Clawd
//
// When Claude asks a permission question the music steps down and Clawd lifts one
// headphone cup. Both come back when the question is answered. The host reads
// on(...) and $.noun.method(...) from source, so they are written out in full.

const STATIONS = [
  { id: "lofi", name: "lofi", color: "#d97757", url: "https://radio.nia.nc/radio/8020/lofi-hq-stream.aac" },
  { id: "jazz", name: "jazz", color: "#e0af68", url: "https://smoothjazz.cdnstream1.com/2585_128.mp3" },
  { id: "chill", name: "chill", color: "#9b87f5", url: "https://0n-chillout.radionetz.de/0n-chillout.aac" },
  { id: "classical", name: "classical", color: "#7fb7a0", url: "https://stream.srg-ssr.ch/m/rsc_de/aacp_96" },
  { id: "nature", name: "nature", color: "#6fa8c7", url: "https://purenature-mynoise.radioca.st/stream" },
];
const SONG_COLOR = "#d97757";
const CLAWD_COLOR = "#d97757";

const RELEASE_URL = "https://github.com/anzal1/hush/releases/latest/download/hush-macos";
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
const POLL_MS = 2500;
const VOLUME_STEP = 10;
const BAR_CELLS = 10;
const COLLAPSE_CELLS = 4;
const MAX_COLUMNS = 100;
const SEARCH_RESULTS = 5;
const CLAWD_ZONE = 12;
const SESSION = Math.random().toString(36).slice(2, 8);

// What the helper last said: { state, station, title, volume, ducked, pos, dur }.
let status = { state: "off", station: "", title: "", volume: 55, ducked: false, pos: 0, dur: 0 };
let stationIndex = 0;
let mode = "radio";
let queue = [];
let queueIndex = 0;
let finding = "";
let timer = null;
let failures = 0;
let isLit = false;
let clawdOn = true;
let walk = CLAWD_ZONE - 7;
let nod = false;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "music",
      description: "Free radio and any song above the prompt",
      argumentHint: "[song or artist | next | prev | pause | stop | lofi | jazz | chill | classical | nature | vol <0-100> | clawd]",
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
    const clawd = await $.store.get("clawd").catch(() => undefined);
    if (typeof clawd === "boolean") {
      clawdOn = clawd;
    }
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

  on("classic.PermissionRequest", async ($, e, next) => {
    await duck($, true);
    return next(e);
  });

  on("tool.call", { tool: "AskUserQuestion" }, async ($, e, next) => {
    await duck($, true);
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (clawdOn && status.state === "playing" && !status.ducked) {
      nod = true;
      $.ui.invalidate("ui.render");
      $.clock.after(220, () => {
        nod = false;
        $.ui.invalidate("ui.render");
      });
    }
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
    if (e.surface !== "terminal" || e.props.hasSurvey || !isActive()) {
      return next(e);
    }
    const ui = $.ui.resolve(e);
    const columns = Math.min((e.props.bodyColumns ?? 80) - COLLAPSE_CELLS, MAX_COLUMNS);
    const beneath = await next(e);
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
  return { bin: `${$.plugin.root}/bin/hush`, socket: `${dir}/h.sock`, ytdlp: `${dir}/yt-dlp` };
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

// ---------- songs ----------

async function ensureYtdlp($) {
  const { ytdlp } = await paths($);
  if (await exists($, ytdlp)) {
    return true;
  }
  $.ui.toast("Hush is fetching its song finder (once, about 35 MB)", { timeoutMs: 8000 });
  const got = await download($, YTDLP_URL, ytdlp);
  return got.exitCode === 0;
}

async function runYtdlp($, args, timeoutMs) {
  const { ytdlp } = await paths($);
  return $.process
    .run([ytdlp, "--no-warnings", ...args], { timeoutMs })
    .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
}

async function updateYtdlp($) {
  const { ytdlp } = await paths($);
  await $.process.run([ytdlp, "-U"], { timeoutMs: 120000 }).catch(() => undefined);
}

async function searchSongs($, query) {
  const args = [
    `ytsearch${SEARCH_RESULTS * 2}:${query}`,
    "--flat-playlist",
    "--print",
    "%(id)s\t%(title)s\t%(channel)s\t%(duration)s",
  ];
  let run = await runYtdlp($, args, 90000);
  if (run.exitCode !== 0 || !run.stdout.trim()) {
    await updateYtdlp($);
    run = await runYtdlp($, args, 90000);
  }
  const found = [];
  for (const line of run.stdout.split("\n")) {
    const [id, title, channel, duration] = line.split("\t");
    const seconds = Number.parseInt(duration ?? "", 10);
    if (id && title && seconds >= 30 && seconds <= 1200) {
      found.push({ id, title, channel: channel && channel !== "NA" ? channel : "", duration: seconds });
    }
  }
  return found.slice(0, SEARCH_RESULTS);
}

async function streamUrl($, id) {
  const run = await runYtdlp(
    $,
    ["-f", "bestaudio[ext=m4a]/bestaudio", "--no-playlist", "-g", `https://www.youtube.com/watch?v=${id}`],
    90000,
  );
  const url = run.stdout.split("\n")[0]?.trim();
  return run.exitCode === 0 && url?.startsWith("http") ? url : "";
}

async function playQuery($, query) {
  if (!(await ensureHelper($))) {
    return "Hush could not start its player. It needs macOS, and either Xcode's command line tools or a network connection to GitHub.";
  }
  if (!(await ensureYtdlp($))) {
    return "Hush could not fetch its song finder. Check your connection and try again.";
  }
  finding = query;
  $.ui.invalidate("ui.render");
  const results = await searchSongs($, query);
  if (results.length === 0) {
    finding = "";
    $.ui.invalidate("ui.render");
    return `No songs found for "${query}"`;
  }
  mode = "song";
  queue = results;
  return playQueued($, 0);
}

async function playQueued($, index) {
  const song = queue[index];
  if (!song) {
    await ask($, "stop");
    stop();
    $.ui.invalidate("ui.render");
    return "Queue finished";
  }
  queueIndex = index;
  finding = song.title;
  $.ui.invalidate("ui.render");
  let url = await streamUrl($, song.id);
  if (!url) {
    await updateYtdlp($);
    url = await streamUrl($, song.id);
  }
  finding = "";
  if (!url) {
    $.ui.invalidate("ui.render");
    return `Could not play "${song.title}". Try another song.`;
  }
  await ask($, `vol ${status.volume}`);
  await ask($, "resume");
  const reply = await ask($, `play ${url} ${song.title}`);
  if (reply) {
    adopt(reply);
  }
  failures = 0;
  watch($);
  cue($);
  $.ui.invalidate("ui.render");
  return `Playing ${song.title}${song.channel ? ` by ${song.channel}` : ""}`;
}

// ---------- commands ----------

async function runCommand($, args) {
  const [first = "", ...rest] = args.split(/\s+/).filter(Boolean);
  const word = first.toLowerCase();
  const arg = rest[0];
  if (word === "") {
    return isActive() ? toggle($) : startStation($, stationIndex);
  }
  const station = STATIONS.findIndex((s) => s.id === word);
  if (station >= 0 && rest.length === 0) {
    return startStation($, station);
  }
  if (word === "next") {
    return mode === "song" ? playQueued($, queueIndex + 1) : startStation($, stationIndex + 1);
  }
  if (word === "prev" || word === "previous") {
    return mode === "song" ? playQueued($, Math.max(0, queueIndex - 1)) : startStation($, stationIndex - 1);
  }
  if (word === "stop" || word === "off") {
    await ask($, "stop");
    stop();
    $.ui.invalidate("ui.render");
    return "Music stopped";
  }
  if (word === "vol" || word === "volume") {
    const n = Number.parseInt(arg ?? "", 10);
    if (Number.isNaN(n)) {
      return `Volume is ${status.volume}. Use /music vol 0-100`;
    }
    await setVolume($, n);
    return `Volume ${status.volume}`;
  }
  if (word === "clawd") {
    clawdOn = !clawdOn;
    await $.store.set("clawd", clawdOn).catch(() => undefined);
    $.ui.invalidate("ui.render");
    return clawdOn ? "DJ Clawd is back" : "DJ Clawd is off";
  }
  if ((word === "pause" || word === "play") && rest.length === 0) {
    return isActive() ? toggle($) : startStation($, stationIndex);
  }
  const query = (word === "play" || word === "song" ? rest : [first, ...rest]).join(" ");
  return playQuery($, query);
}

async function toggle($) {
  await togglePause($);
  return status.state === "paused" ? "Paused" : "Playing";
}

async function startStation($, index) {
  mode = "radio";
  queue = [];
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
  const clamped = Math.max(0, Math.min(100, value));
  status = { ...status, volume: clamped };
  await ask($, `vol ${clamped}`);
  await $.store.set("volume", clamped).catch(() => undefined);
  $.ui.invalidate("ui.render");
}

async function duck($, isDucked) {
  if (!isActive() || status.ducked === isDucked) {
    return;
  }
  status = { ...status, ducked: isDucked };
  $.ui.invalidate("ui.render");
  await ask($, `${isDucked ? "duck" : "unduck"} ${SESSION}`);
}

// ---------- state ----------

function isActive() {
  return finding !== "" || status.state === "playing" || status.state === "loading" || status.state === "paused";
}

function adopt(reply) {
  const index = STATIONS.findIndex((s) => s.name === reply.station);
  if (index >= 0) {
    stationIndex = index;
    mode = "radio";
  } else if (reply.dur > 0) {
    mode = "song";
  }
  status = { ...status, ...reply };
}

function watch($) {
  if (timer) {
    return;
  }
  timer = $.clock.every(POLL_MS, () => {
    void poll($);
  });
}

function stop() {
  if (timer) {
    timer.cancel();
    timer = null;
  }
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
  if (reply.state === "ended" && mode === "song") {
    await playQueued($, queueIndex + 1);
    return;
  }
  if (reply.state === "failed") {
    failures += 1;
    if (mode === "song") {
      await playQueued($, queueIndex + 1);
      return;
    }
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

function fit(text, cells) {
  if (cells <= 0) {
    return "";
  }
  return text.length <= cells ? text : `${text.slice(0, Math.max(0, cells - 1))}…`;
}

// A hotkey makes the engine draw a "h:" prefix, so only the focused band carries them.
function keyed(letter) {
  return isLit ? { hotkey: letter } : {};
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// DJ Clawd: the banner mascot's head with headphones. One cup lifts when you are being asked something.
function clawdFace() {
  if (status.ducked) {
    return "(▐▛█▜▌ '";
  }
  return nod ? "(▐▙█▟▌)" : "(▐▛█▜▌)";
}

// One line: note, title, a tag, a bar, buttons, DJ Clawd. Narrower terminals drop the
// bar first, then the tag, then DJ Clawd, then the buttons.
function band($, ui, columns) {
  const { Box, Text, Button } = ui;
  const isSong = mode === "song";
  const station = STATIONS[stationIndex];
  const accent = isSong ? SONG_COLOR : station.color;
  const quiet = status.ducked || status.state === "paused";
  const loading = finding !== "" || status.state === "loading";
  let title = status.title || `${station.name} radio`;
  if (finding) {
    title = `finding ${finding}…`;
  } else if (status.state === "loading") {
    title = "tuning…";
  } else if (isSong) {
    title = status.station;
  }
  const tag = isSong ? (status.dur > 0 ? `${clock(status.pos)} / ${clock(status.dur)}` : "") : `${station.name} · live`;
  const showBar = columns >= 70;
  const showTag = columns >= 56 && tag !== "";
  const showButtons = columns >= 44;
  const showClawd = clawdOn && columns >= 84 && status.state === "playing" && !finding;
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

  const parts = [
    Text({ color: accent, dimColor: quiet, children: "♪ " }),
    Text({ dimColor: quiet || loading, children: fit(title, titleCells).padEnd(titleCells) }),
  ];
  if (showTag) {
    parts.push(Text({ dimColor: true, children: `  ${tag}` }));
  }
  if (showBar) {
    let filled;
    if (isSong) {
      filled = status.dur > 0 ? Math.round((status.pos / status.dur) * BAR_CELLS) : 0;
    } else {
      const effective = status.ducked ? Math.round(status.volume * 0.35) : status.volume;
      filled = status.state === "paused" ? 0 : Math.round((effective / 100) * BAR_CELLS);
    }
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
        label: status.state === "paused" ? "play" : "pause",
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
      parts.push(Text({ dimColor: true, children: ` vol ${status.volume} ` }));
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
      ? " p pause · h l station · j k volume · esc back to the prompt"
      : " p pause · h l station · esc back to the prompt",
  });
  return Box({ flexDirection: "column", children: [row, hint] });
}

async function press($, what) {
  if (what === "pause") {
    await togglePause($);
  } else if (what === "next") {
    await runCommand($, "next");
  } else if (what === "prev") {
    await runCommand($, "prev");
  } else if (what === "up") {
    await setVolume($, status.volume + VOLUME_STEP);
  } else if (what === "down") {
    await setVolume($, status.volume - VOLUME_STEP);
  }
}
