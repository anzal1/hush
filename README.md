# Hush

![Hush playing lofi above the Claude Code prompt](docs/band.png)

Free internet radio and any song, in one quiet line above the Claude Code prompt, with a small DJ Clawd who listens along. When Claude asks you a
question the music steps down, and it comes back when you answer.

- Free: no account, no key. Streams are public stations from the open Radio Browser directory.
- Nothing to install for radio: a small native helper (source in `native/hush.swift`) plays audio with macOS's own `AVPlayer`. It is built on first use with `swiftc`, or downloaded from the GitHub release if Xcode's command line tools are missing. Songs need Node (for `npx`), see below.
- macOS only for now. Needs Claude Code 2.1.287 or later.

## Use

    /music            start (or pause and resume)
    /music next       next station (lofi, jazz, chill, classical, nature)
    /music vol 40
    /music stop
    /music frank ocean nights     play any song or artist, through hum
    /music jazz                   back to the radio (also /music radio)
    /music clawd                  show or hide DJ Clawd
    /music big                    switch between the player (the default) and the quiet one-line band

Press `ctrl+x tab` to focus the band: `p` pause, `h` `l` station (previous and next song while a song plays),
`j` `k` volume, `esc` back.

![The focused band, with controls](docs/band-focused.png)

## Big mode

Songs through hum get the full player by default; `/music big` switches to the quiet one-line band and back. The ✕ (or `x` while the band has focus) stops the music.

In the Claude app's Code tab the player is one picture: the cover and its light, the title, the lyric being sung over the next line, a progress bar and the time, and DJ Clawd working two decks at his booth. It moves by itself, so it is never redrawn while a song plays (no flicker), with native buttons for prev, play/pause, next, volume and close underneath.
Hush remembers the choice. Radio always keeps its one-line band.

The panel shows the cover, a ribbon of aurora in the cover's colours, the title, the artist (and album), the lyric being
sung over the next line as a karaoke preview, a progress bar with the times, and real prev, play or pause and next
buttons that call hum. A song without synced lyrics never leaves a gap: its album takes the first line and
"up next" (the next track in hum's queue) the second. DJ Clawd stays: he sits at the end of the buttons row, nods on
tool calls and lifts a headphone cup when Claude asks you something. When the music steps down the glow dims and holds
still.

- Terminal: the cover is a picture where the terminal shows them (kitty, Ghostty), and quadrant-block cell art elsewhere
  (`HUSH_COVER=cells` or `image` forces one). Quadrant blocks (▘▝▀▖▌▞▛▗▚▐▜▄▙▟█) carry 2x2 pixels in each cell in two
  colours, so the cover is twice as sharp across as half blocks, and it is given a little contrast, colour and an unsharp
  mask first so it reads crisply at 16 to 20 columns. The panel is as tall as the room allows, 8 to 10 rows (a 20 x 10
  cover on a terminal of about 36 rows or more), and the cover stays square.
- The aurora is a two row ribbon of cells repainted about eight times a second, only while the panel is on screen and the
  song plays. Claude Code paints a Raster in 16 levels a channel, which turns a dark glow into visible bands, so the
  ribbon is rounded to that grid with an ordered (Bayer) dither across the quadrant sub-pixels and fades to nothing at its
  ends and edges. For that reason the panel's background is `#111111`, the grid colour nearest hum's `#08070b`, so the
  dark cells of the glow and the card around them are one colour. Below 60 columns (or without the rows) the one-line band
  is drawn instead.
- Progress is drawn to eighths of a cell (▏▎▍▌▋▊▉█) in a gradient of the cover's two strongest colours over a dim
  track. Play or pause is a pill in a deep shade of the cover's colour; prev and next are plain words. All are real buttons.
- Desktop (the Code tab in the Claude app): one SVG holds the cover with rounded corners on a haze of its own colours,
  the title, artist and album and three bars that dance while it plays (SMIL). The lyric lines, progress and buttons are
  native elements under it, so the SVG does not change each second and its animation is not restarted. Pausing or a
  question swaps in a still glow.

The cover comes from hum's art (or YouTube's thumbnail), is downloaded with `curl` and resized with macOS's `sips`,
and is cached in `~/.claude/hush/art/` (the 40 newest tracks). Nothing new is installed.

## Install

    /plugin marketplace add anzal1/hush
    /plugin install hush@hush

or try it for one session with `claude --plugin-dir /path/to/hush`.

A mod runs with your full permissions. Read `hooks/register.mjs` and `native/hush.swift` first; they are short.

## How it works

`hooks/register.mjs` is the mod. It talks to `bin/hush` over a unix socket (`~/.claude/hush/h.sock`).
`hooks/logic.mjs` holds the pure parts: what a `/music` command means for radio or hum, and which lyric line is being sung and which comes next.
`hooks/panel.mjs` holds the pure parts of the big panel: reading the cover's BMP, the palette, the quadrant-block cover, the dithered aurora, the eighth-block progress, the lyric layout, the SVG and which layout fits.
The helper quits by itself 90 seconds after the last Claude Code session stops talking to it.
If `bin/hush` is missing the mod builds it from `native/hush.swift` with `swiftc`. Rebuild with `./build.sh`.

Ducking listens for `tool.check` (a verdict of "ask") and `AskUserQuestion`, and restores when the tool result
is recorded, the turn ends, or you submit a prompt. Claude Code's built-in guard hides the `classic.*` events from
installed mods, so Hush does not rely on them.

## Stations

Public streams: NIA Radio Lo-Fi, SmoothJazz.com, 0 N Chillout, Radio Swiss Classic, MyNoise Pure Nature.
SomaFM is left out on purpose because its terms prohibit third-party clients.
These are public streams found through the Radio Browser directory. The stations have not agreed to be
in Hush, so use it as you would any radio app, for personal listening. To change the list, edit
`STATIONS` at the top of `hooks/register.mjs`.

## Any song, through hum

`/music <song or artist>` hands the song to [hum](https://github.com/anzal1/hum), a free player that plays
through YouTube's official embed in a window you can see. Hush does not download or re-stream anything: the
song plays in YouTube's own player, so the artist is paid as for any other view, and you can see what is playing.

If hum is not running, Hush starts it (`npx -y -p github:anzal1/hum hum`, so Node is needed) and opens its
player in your browser, then sends the song once the window connects. The first start downloads hum and can
take longer than the 20 seconds Hush waits. If that happens, start it yourself with the same command and run
`/music` again. Hush talks to hum's loopback remote on `127.0.0.1:3737`; set `HUM_PORT` to use another port.

While a song plays the band shows the title and artist and the synced lyric line being sung. Ducking, pause,
next and previous, volume and stop all go to hum. `/music jazz` or `/music radio` pauses hum and returns to
the radio. Keep the hum window open; the sound comes from it.

## DJ Clawd

A tiny headphone-wearing Clawd sits at the right of the row while music plays. He walks in when a song
starts, nods on tool calls, and lifts one headphone cup when Claude asks you a question (the music steps
down at the same moment). He needs about 84 columns, and `/music clawd` turns him off.

## Updating

Plugins from a GitHub marketplace do not auto-update by default. Turn it on in `/plugin`, on the
**Marketplaces** tab, with **Enable auto-update** on `hush`. Or update by hand:

    claude plugin update hush@hush

then run `/reload-plugins` or restart. Mods need Claude Code 2.1.287 or later; update that with
`claude update`.

## Tests

    claude plugin test .

runs everything in `tests/` against fake radio and hum servers, so nothing plays.
