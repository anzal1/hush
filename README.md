# Hush

Free internet radio in one quiet line above the Claude Code prompt. When Claude asks you a
question the music steps down, and it comes back when you answer.

- Free: no account, no key. Streams are public stations from the open Radio Browser directory.
- Nothing to install: a small native helper (source in `native/hush.swift`) plays audio with macOS's own `AVPlayer`. It is built on first use with `swiftc`, or downloaded from the GitHub release if Xcode's command line tools are missing.
- macOS only for now. Needs Claude Code 2.1.287 or later.

## Use

    /music            start (or pause and resume)
    /music next       next station (lofi, jazz, chill, classical, nature)
    /music vol 40
    /music stop

Press `ctrl+x tab` to focus the band: `p` pause, `h` `l` station, `j` `k` volume, `esc` back.

## Install

    /plugin marketplace add anzal1/hush
    /plugin install hush@hush

or try it for one session with `claude --plugin-dir /path/to/hush`.

A mod runs with your full permissions. Read `hooks/register.mjs` and `native/hush.swift` first; they are short.

## How it works

`hooks/register.mjs` is the mod. It talks to `bin/hush` over a unix socket (`~/.claude/hush/h.sock`).
The helper quits by itself 90 seconds after the last Claude Code session stops talking to it.
If `bin/hush` is missing the mod builds it from `native/hush.swift` with `swiftc`. Rebuild with `./build.sh`.

Ducking listens for Claude's permission request and `AskUserQuestion` events, and restores on the
next tool result, denial, stop or prompt.

## Stations

Public streams: NIA Radio Lo-Fi, SmoothJazz.com, 0 N Chillout, Radio Swiss Classic, MyNoise Pure Nature.
SomaFM is left out on purpose because its terms prohibit third-party clients.
These are public streams found through the Radio Browser directory. The stations have not agreed to be
in Hush, so use it as you would any radio app, for personal listening. To change the list, edit
`STATIONS` at the top of `hooks/register.mjs`.
