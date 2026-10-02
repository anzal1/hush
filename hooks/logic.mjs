// Pure logic for Hush: no host calls, so tests can run it directly.
//
// Hush plays two kinds of audio. Radio goes through the native helper. Songs go through
// hum (https://github.com/anzal1/hum), which plays through YouTube's own embed in a visible
// window. This file decides what a /music command means for each, and how hum's state is
// turned into the line (or the big panel) shown above the prompt.

export const LYRIC_LEAD = 0.15;
export const VOLUME_STEP = 10;

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

// Where the song is right now: hum's report plus the time since it was made, while it plays.
export function livePosition(state, now) {
  if (!state || typeof state.position !== "number") {
    return 0;
  }
  let seconds = state.position;
  if (state.playing && typeof state.at === "number") {
    seconds += Math.max(0, now - state.at) / 1000;
  }
  if (state.duration > 0) {
    seconds = Math.min(seconds, state.duration);
  }
  return Math.max(0, seconds);
}

// The last synced line that has started by `seconds`, a little early so the eye is not behind the voice.
export function lyricLine(lyrics, seconds) {
  if (!Array.isArray(lyrics)) {
    return "";
  }
  const cutoff = seconds + LYRIC_LEAD;
  let best = null;
  for (const entry of lyrics) {
    if (entry && typeof entry.t === "number" && entry.t <= cutoff && (best === null || entry.t >= best.t)) {
      best = entry;
    }
  }
  return best && typeof best.text === "string" ? best.text.trim() : "";
}

// What the band draws for hum, or null when no hum window has a track.
export function humView(state, now) {
  if (!state || !(state.connected > 0) || !state.track) {
    return null;
  }
  const pos = livePosition(state, now);
  const artist = state.track.artist || "";
  const title = state.track.title || artist || "hum";
  const lyrics = Array.isArray(state.lyrics) ? state.lyrics : [];
  return {
    state: state.playing ? "playing" : "paused",
    title,
    artist,
    name: artist && artist !== title ? `${title} · ${artist}` : title,
    id: typeof state.track.id === "string" ? state.track.id : "",
    art: typeof state.track.art === "string" ? state.track.art : "",
    line: lyricLine(lyrics, pos),
    hasLyrics: lyrics.length > 0,
    pos,
    dur: state.duration > 0 ? state.duration : 0,
    volume: Number.isFinite(state.volume) ? state.volume : 0,
    ducked: Boolean(state.ducked),
  };
}

// What the person typed after /music, as an intent. Stations are matched by id.
export function parseArgs(args, stations) {
  const [first = "", ...rest] = args.split(/\s+/).filter(Boolean);
  const word = first.toLowerCase();
  if (word === "") {
    return { kind: "bare" };
  }
  const index = stations.findIndex((id) => id === word);
  if (index >= 0 && rest.length === 0) {
    return { kind: "station", index };
  }
  if (word === "radio" && rest.length === 0) {
    return { kind: "radio" };
  }
  // Only a bare word is a command, so "next level" and "stop making sense" are song searches.
  if (word === "next" && rest.length === 0) {
    return { kind: "next" };
  }
  if ((word === "prev" || word === "previous") && rest.length === 0) {
    return { kind: "prev" };
  }
  if ((word === "stop" || word === "off") && rest.length === 0) {
    return { kind: "stop" };
  }
  if (word === "vol" || word === "volume") {
    const n = Number.parseInt(rest[0] ?? "", 10);
    return { kind: "vol", value: Number.isNaN(n) ? null : n };
  }
  if (word === "clawd" && rest.length === 0) {
    return { kind: "clawd" };
  }
  if (word === "big" && rest.length === 0) {
    return { kind: "big" };
  }
  if ((word === "pause" || word === "play") && rest.length === 0) {
    return { kind: word };
  }
  const query = (word === "play" || word === "song" ? rest : [first, ...rest]).join(" ");
  return query === "" ? { kind: "bare" } : { kind: "search", query };
}

// What an intent does, given where the sound comes from now. ctx is
// { source: "radio" | "hum", humLive, radioActive, radioVolume, humVolume, stationIndex }.
// Returns { target, action, ... }. A hum plan carries `cmd`, the body to POST to hum.
// `source` is the source to switch to once the plan has worked, when it changes.
export function route(intent, ctx) {
  const onHum = ctx.source === "hum" && ctx.humLive;
  const hum = (action, cmd, extra = {}) => ({ target: "hum", action, cmd, ...extra });
  const radio = (action, extra = {}) => ({ target: "radio", action, ...extra });
  switch (intent.kind) {
    case "search":
      return hum("play", { cmd: "play", query: intent.query }, { source: "hum" });
    case "station":
      return radio("station", { index: intent.index, source: "radio" });
    case "radio":
      return radio("station", { index: ctx.stationIndex, source: "radio" });
    case "bare":
    case "pause":
    case "play":
      if (onHum) {
        const cmd = intent.kind === "pause" ? "pause" : intent.kind === "play" ? "resume" : "toggle";
        return hum(intent.kind, { cmd });
      }
      return ctx.radioActive ? radio("toggle") : radio("station", { index: ctx.stationIndex, source: "radio" });
    case "toggle":
      return onHum ? hum("toggle", { cmd: "toggle" }) : radio("toggle");
    case "next":
      return onHum ? hum("next", { cmd: "next" }) : radio("next");
    case "prev":
      return onHum ? hum("prev", { cmd: "prev" }) : radio("prev");
    case "stop":
      return onHum ? hum("stop", { cmd: "pause" }, { source: "radio" }) : radio("stop");
    case "vol": {
      const current = onHum ? ctx.humVolume : ctx.radioVolume;
      let level = null;
      if (typeof intent.value === "number") {
        level = clamp(intent.value, 0, 100);
      } else if (typeof intent.delta === "number") {
        level = clamp(current + intent.delta, 0, 100);
      }
      return onHum ? hum("volume", level === null ? null : { cmd: "volume", level }, { level }) : radio("volume", { level });
    }
    default:
      return { target: "local", action: intent.kind };
  }
}

// The hum command that ducks or restores, or null when nothing needs sending.
export function duckCommand(wantDucked, alreadyDucked) {
  if (wantDucked === alreadyDucked) {
    return null;
  }
  return { cmd: wantDucked ? "duck" : "unduck" };
}
