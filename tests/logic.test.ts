import { expect, test } from 'claude-code/testing'
// @ts-expect-error plain JS module, no declarations
import { clamp, duckCommand, humView, livePosition, lyricLine, parseArgs, route } from '../hooks/logic.mjs'

const LYRICS = [
  { t: 0, text: 'first line' },
  { t: 10, text: 'second line' },
  { t: 20, text: '' },
  { t: 24.5, text: 'fourth line' },
]
const STATIONS = ['lofi', 'jazz', 'chill', 'classical', 'nature']

test('the lyric line is the last one that has started', () => {
  expect(lyricLine(LYRICS, 0)).toBe('first line')
  expect(lyricLine(LYRICS, 9)).toBe('first line')
  expect(lyricLine(LYRICS, 15)).toBe('second line')
  expect(lyricLine(LYRICS, 100)).toBe('fourth line')
})

test('the lyric line leads by 0.15 seconds', () => {
  expect(lyricLine(LYRICS, 9.8)).toBe('first line')
  expect(lyricLine(LYRICS, 9.86)).toBe('second line')
  expect(lyricLine(LYRICS, 9.85)).toBe('second line')
})

test('a gap in the lyrics is an empty line, and so is a missing list', () => {
  expect(lyricLine(LYRICS, 22)).toBe('')
  expect(lyricLine([], 5)).toBe('')
  expect(lyricLine(undefined, 5)).toBe('')
  expect(lyricLine([{ t: 30, text: 'late' }], 5)).toBe('')
})

test('lyrics out of order still pick the latest start', () => {
  const shuffled = [LYRICS[3], LYRICS[0], LYRICS[1]]
  expect(lyricLine(shuffled, 15)).toBe('second line')
  expect(lyricLine(shuffled, 30)).toBe('fourth line')
})

test('the position moves on with the time since the report, only while playing', () => {
  const state = { playing: true, position: 12, at: 1000, duration: 200 }
  expect(livePosition(state, 1000)).toBe(12)
  expect(livePosition(state, 3500)).toBe(14.5)
  expect(livePosition({ ...state, playing: false }, 9000)).toBe(12)
  expect(livePosition(state, 500)).toBe(12)
  expect(livePosition({ ...state, position: 199 }, 9000)).toBe(200)
  expect(livePosition(null, 0)).toBe(0)
})

test('the band view joins title and artist and picks the live lyric', () => {
  const state = {
    connected: 1,
    playing: true,
    track: { title: 'Nights', artist: 'Frank Ocean' },
    position: 9,
    at: 0,
    duration: 307,
    volume: 80,
    ducked: false,
    lyrics: LYRICS,
  }
  const view = humView(state, 1000)
  expect(view.name).toBe('Nights · Frank Ocean')
  expect(view.line).toBe('second line')
  expect(view.state).toBe('playing')
  expect(view.hasLyrics).toBe(true)
  expect(humView({ ...state, playing: false }, 60000).line).toBe('first line')
  expect(humView({ ...state, playing: false }, 0).state).toBe('paused')
  expect(humView({ ...state, track: { title: 'Nights' } }, 0).name).toBe('Nights')
})

test('no hum window or no track means no hum view', () => {
  expect(humView(null, 0)).toBeNull()
  expect(humView({ connected: 0, track: { title: 'x' } }, 0)).toBeNull()
  expect(humView({ connected: 1, track: null }, 0)).toBeNull()
})

test('/music words are read as subcommands, stations or a song search', () => {
  expect(parseArgs('', STATIONS)).toEqual({ kind: 'bare' })
  expect(parseArgs('jazz', STATIONS)).toEqual({ kind: 'station', index: 1 })
  expect(parseArgs('Lofi', STATIONS)).toEqual({ kind: 'station', index: 0 })
  expect(parseArgs('radio', STATIONS)).toEqual({ kind: 'radio' })
  expect(parseArgs('next', STATIONS)).toEqual({ kind: 'next' })
  expect(parseArgs('previous', STATIONS)).toEqual({ kind: 'prev' })
  expect(parseArgs('off', STATIONS)).toEqual({ kind: 'stop' })
  expect(parseArgs('vol 40', STATIONS)).toEqual({ kind: 'vol', value: 40 })
  expect(parseArgs('vol', STATIONS)).toEqual({ kind: 'vol', value: null })
  expect(parseArgs('clawd', STATIONS)).toEqual({ kind: 'clawd' })
  expect(parseArgs('pause', STATIONS)).toEqual({ kind: 'pause' })
  expect(parseArgs('frank ocean nights', STATIONS)).toEqual({ kind: 'search', query: 'frank ocean nights' })
  expect(parseArgs('play nights', STATIONS)).toEqual({ kind: 'search', query: 'nights' })
  expect(parseArgs('song', STATIONS)).toEqual({ kind: 'bare' })
})

test('a station name followed by more words is a song search, not a station', () => {
  expect(parseArgs('jazz hands', STATIONS)).toEqual({ kind: 'search', query: 'jazz hands' })
  expect(parseArgs('next level', STATIONS)).toEqual({ kind: 'search', query: 'next level' })
  expect(parseArgs('stop making sense', STATIONS)).toEqual({ kind: 'search', query: 'stop making sense' })
})

const radioCtx = { source: 'radio', humLive: false, radioActive: true, radioVolume: 55, humVolume: 0, stationIndex: 2 }
const humCtx = { source: 'hum', humLive: true, radioActive: true, radioVolume: 55, humVolume: 80, stationIndex: 2 }

test('a song search goes to hum and makes hum the source', () => {
  const plan = route({ kind: 'search', query: 'nights' }, radioCtx)
  expect(plan).toMatchObject({ target: 'hum', action: 'play', source: 'hum', cmd: { cmd: 'play', query: 'nights' } })
  expect(route({ kind: 'search', query: 'nights' }, humCtx).source).toBe('hum')
})

test('stations and /music radio hand the sound back to the radio', () => {
  expect(route({ kind: 'station', index: 3 }, humCtx)).toMatchObject({ target: 'radio', action: 'station', index: 3, source: 'radio' })
  expect(route({ kind: 'radio' }, humCtx)).toMatchObject({ target: 'radio', action: 'station', index: 2, source: 'radio' })
})

test('controls go to hum while hum is the source', () => {
  expect(route({ kind: 'bare' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'toggle' } })
  expect(route({ kind: 'toggle' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'toggle' } })
  expect(route({ kind: 'pause' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'pause' } })
  expect(route({ kind: 'play' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'resume' } })
  expect(route({ kind: 'next' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'next' } })
  expect(route({ kind: 'prev' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'prev' } })
  expect(route({ kind: 'stop' }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'pause' }, source: 'radio' })
})

test('the same controls go to the radio while the radio is the source', () => {
  expect(route({ kind: 'bare' }, radioCtx)).toMatchObject({ target: 'radio', action: 'toggle' })
  expect(route({ kind: 'bare' }, { ...radioCtx, radioActive: false })).toMatchObject({ target: 'radio', action: 'station', index: 2 })
  expect(route({ kind: 'next' }, radioCtx)).toMatchObject({ target: 'radio', action: 'next' })
  expect(route({ kind: 'prev' }, radioCtx)).toMatchObject({ target: 'radio', action: 'prev' })
  expect(route({ kind: 'stop' }, radioCtx)).toMatchObject({ target: 'radio', action: 'stop' })
})

test('a hum source with no window falls back to the radio', () => {
  const closed = { ...humCtx, humLive: false, radioActive: false }
  expect(route({ kind: 'bare' }, closed)).toMatchObject({ target: 'radio', action: 'station', source: 'radio' })
  expect(route({ kind: 'next' }, closed)).toMatchObject({ target: 'radio', action: 'next' })
})

test('volume is absolute for hum and clamped, from a number or a step', () => {
  expect(route({ kind: 'vol', value: 40 }, humCtx)).toMatchObject({ target: 'hum', cmd: { cmd: 'volume', level: 40 } })
  expect(route({ kind: 'vol', value: 400 }, humCtx)).toMatchObject({ cmd: { cmd: 'volume', level: 100 } })
  expect(route({ kind: 'vol', delta: 10 }, humCtx)).toMatchObject({ cmd: { cmd: 'volume', level: 90 } })
  expect(route({ kind: 'vol', delta: 10 }, { ...humCtx, humVolume: 95 })).toMatchObject({ cmd: { cmd: 'volume', level: 100 } })
  expect(route({ kind: 'vol', delta: -10 }, { ...humCtx, humVolume: 5 })).toMatchObject({ cmd: { cmd: 'volume', level: 0 } })
  expect(route({ kind: 'vol', value: null }, humCtx)).toMatchObject({ target: 'hum', cmd: null })
  expect(route({ kind: 'vol', delta: -10 }, radioCtx)).toMatchObject({ target: 'radio', action: 'volume', level: 45 })
})

test('clawd stays local whatever the source', () => {
  expect(route({ kind: 'clawd' }, humCtx)).toMatchObject({ target: 'local', action: 'clawd' })
})

test('ducking sends one command per change', () => {
  expect(duckCommand(true, false)).toEqual({ cmd: 'duck' })
  expect(duckCommand(false, true)).toEqual({ cmd: 'unduck' })
  expect(duckCommand(true, true)).toBeNull()
  expect(duckCommand(false, false)).toBeNull()
  expect(clamp(120, 0, 100)).toBe(100)
})
