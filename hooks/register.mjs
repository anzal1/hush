// Hush: free internet radio in one quiet line above the prompt.
//
// Audio comes from bin/hush, a small native helper that streams with the system
// AVPlayer and listens on a unix socket. This file only talks to it.
//
//   /music            start the last station, or pause and resume
//   /music next|prev|pause|stop
//   /music lofi|jazz|chill|classical|nature
//   /music vol 40
//
// When Claude asks a permission question the music steps down, and it comes back
// when the question is answered. The host reads on(...) and $.noun.method(...)
// from source, so they are written out in full.

const STATIONS = [
  { id: "lofi", name: "lofi", color: "#d97757", url: "https://radio.nia.nc/radio/8020/lofi-hq-stream.aac" },
  { id: "jazz", name: "jazz", color: "#e0af68", url: "https://smoothjazz.cdnstream1.com/2585_128.mp3" },
  { id: "chill", name: "chill", color: "#9b87f5", url: "https://0n-chillout.radionetz.de/0n-chillout.aac" },
  { id: "classical", name: "classical", color: "#7fb7a0", url: "https://stream.srg-ssr.ch/m/rsc_de/aacp_96" },
  { id: "nature", name: "nature", color: "#6fa8c7", url: "https://purenature-mynoise.radioca.st/stream" },
];

const RELEASE_URL = "https://github.com/anzal1/hush/releases/latest/download/hush-macos";
const POLL_MS = 2500;
const VOLUME_STEP = 10;
const VOLUME_CELLS = 10;
const COLLAPSE_CELLS = 4;
const MAX_COLUMNS = 100;
const SESSION = Math.random().toString(36).slice(2, 8);

// What the helper last said: { state, station, title, volume, ducked }.
let status = { state: "off", station: "", title: "", volume: 55, ducked: false };
let stationIndex = 0;
let timer = null;
let failures = 0;
let isLit = false;

export function register(on) {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "music",
      description: "Free radio above the prompt: start, pause, next station, volume",
      argumentHint: "[next | prev | pause | stop | lofi | jazz | chill | classical | nature | vol <0-100>]",
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
    const running = await ask($, "status");
    if (running && (running.state === "playing" || running.state === "loading" || running.state === "paused")) {
      adopt(running);
      watch($);
    }
    return started;
  });

  on("command.run", { command: "music" }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const word = words[0] ?? "";
    const text = await runCommand($, word, words[1]);
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
  return { bin: `${$.plugin.root}/bin/hush`, socket: `${home}/.claude/hush/h.sock` };
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

// Makes sure the helper runs, building it from source when the binary is missing.
async function ensureHelper($) {
  if (await ask($, "status")) {
    return true;
  }
  const { bin, socket } = await paths($);
  const root = $.plugin.root;
  const executable = await $.process.run(["/bin/test", "-x", bin]).catch(() => ({ exitCode: 1 }));
  if (executable.exitCode !== 0) {
    const hasSwift = await $.process.run(["/bin/test", "-x", "/usr/bin/swiftc"]).catch(() => ({ exitCode: 1 }));
    const built =
      hasSwift.exitCode === 0
        ? await $.process
            .run(["/usr/bin/swiftc", "-O", `${root}/native/hush.swift`, "-o", bin], { timeoutMs: 180000 })
            .catch(() => ({ exitCode: 1 }))
        : await $.process
            .run(["/bin/sh", "-c", 'mkdir -p "$(dirname "$2")" && curl -fsSL "$1" -o "$2" && chmod +x "$2"', "sh", RELEASE_URL, bin], {
              timeoutMs: 60000,
            })
            .catch(() => ({ exitCode: 1 }));
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

// ---------- commands ----------

async function runCommand($, word, arg) {
  const station = STATIONS.findIndex((s) => s.id === word);
  if (station >= 0) {
    return startStation($, station);
  }
  if (word === "next") {
    return startStation($, stationIndex + 1);
  }
  if (word === "prev" || word === "previous") {
    return startStation($, stationIndex - 1);
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
  if (word === "pause" || word === "play" || word === "") {
    if (!isActive()) {
      return startStation($, stationIndex);
    }
    await togglePause($);
    return status.state === "paused" ? "Paused" : "Playing";
  }
  return "Try /music, /music next, /music jazz, /music vol 40 or /music stop";
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
  return status.state === "playing" || status.state === "loading" || status.state === "paused";
}

function adopt(reply) {
  const index = STATIONS.findIndex((s) => s.name === reply.station);
  if (index >= 0) {
    stationIndex = index;
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
  status = { ...status, state: "off", title: "", ducked: false };
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
  const changed = reply.state !== status.state || reply.title !== status.title || reply.ducked !== status.ducked;
  adopt(reply);
  if (changed) {
    $.ui.invalidate("ui.render");
  }
}

// ---------- drawing ----------

// A hotkey makes the engine draw a "h:" prefix, so only the focused band carries them.
function keyed(letter) {
  return isLit ? { hotkey: letter } : {};
}

function fit(text, cells) {
  if (cells <= 0) {
    return "";
  }
  return text.length <= cells ? text : `${text.slice(0, Math.max(0, cells - 1))}…`;
}

// One line: note, title, station tag, volume line. Narrower terminals drop the
// volume line first, then the tag.
function band($, ui, columns) {
  const { Box, Text, Button } = ui;
  const station = STATIONS[stationIndex];
  const quiet = status.ducked || status.state === "paused";
  const loading = status.state === "loading";
  const title = loading ? "tuning…" : status.title || `${station.name} radio`;
  const tag = `${station.name} · live`;
  const showVolume = columns >= 70;
  const showTag = columns >= 56;
  const showButtons = columns >= 44;
  const lit = isLit && showButtons;
  const volumeText = showVolume ? VOLUME_CELLS + 1 : 0;
  const tagText = showTag ? tag.length + 2 : 0;
  const showVolButtons = lit && columns >= 70;
  const buttonsText = showButtons ? (showVolButtons ? 40 : lit ? 24 : 12) : 0;
  const titleCells = Math.max(8, columns - 2 - tagText - volumeText - buttonsText - 1);

  const parts = [
    Text({ color: station.color, dimColor: quiet, children: "♪ " }),
    Text({ dimColor: quiet || loading, children: fit(title, titleCells).padEnd(titleCells) }),
  ];
  if (showTag) {
    parts.push(Text({ dimColor: true, children: `  ${tag}` }));
  }
  if (showVolume) {
    const effective = status.ducked ? Math.round(status.volume * 0.35) : status.volume;
    const filled = status.state === "paused" ? 0 : Math.round((effective / 100) * VOLUME_CELLS);
    parts.push(Text({ children: " " }));
    parts.push(Text({ color: station.color, dimColor: quiet, children: "━".repeat(filled) }));
    parts.push(Text({ dimColor: true, children: "─".repeat(VOLUME_CELLS - filled) }));
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
      parts.push(
        Button({ key: "down", label: "-", hotkey: "j", plain: true, onPress: () => void press($, "down") }),
      );
      parts.push(Text({ dimColor: true, children: ` vol ${status.volume} ` }));
      parts.push(Button({ key: "up", label: "+", hotkey: "k", plain: true, onPress: () => void press($, "up") }));
    }
  }
  const row = Box({ flexDirection: "row", paddingX: 1, children: parts });
  if (!lit) {
    return row;
  }
  const hint = Text({
    dimColor: true,
    children: showVolButtons ? " p pause · h l station · j k volume · esc back to the prompt" : " p pause · h l station · esc back to the prompt",
  });
  return Box({ flexDirection: "column", children: [row, hint] });
}

async function press($, what) {
  if (what === "pause") {
    await togglePause($);
  } else if (what === "next") {
    await startStation($, stationIndex + 1);
  } else if (what === "prev") {
    await startStation($, stationIndex - 1);
  } else if (what === "up") {
    await setVolume($, status.volume + VOLUME_STEP);
  } else if (what === "down") {
    await setVolume($, status.volume - VOLUME_STEP);
  }
}
