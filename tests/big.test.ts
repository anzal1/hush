import { expect, mock, test } from 'claude-code/testing'
// @ts-expect-error plain JS module, no declarations
import { toBase64 } from '../hooks/panel.mjs'

const PORT = 3953
const HOME = '/home/test'
const BAND = (columns: number, surface: 'terminal' | 'desktop' = 'terminal', maxRows = 30) =>
  ({
    plugin: 'hush',
    component: 'AbovePrompt',
    surface,
    requestId: 'band',
    viewport: { columns, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: columns, scroll: { offset: 0, bodyRows: maxRows }, view: {} },
  }) as const

const LYRICS = [
  { t: 0, text: 'first line' },
  { t: 10, text: 'second line' },
  { t: 20, text: 'third line' },
]

// A 32x32 BMP of a warm gradient, the way sips writes it (24 bits, rows top down).
function thumbBase64() {
  const size = 32
  const bytes = new Uint8Array(54 + size * size * 3)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, size, true)
  view.setInt32(22, -size, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = 54 + (y * size + x) * 3
      bytes[at] = 60 + x * 4
      bytes[at + 1] = 40 + y * 3
      bytes[at + 2] = 200 - y * 5
    }
  }
  return toBase64(bytes)
}

// A fake hum, a fake cover maker (the sips script), and a recorder for what is painted.
async function boot($: any, on: any, options: { env?: Record<string, string>; saved?: Map<string, unknown>; coverFails?: boolean } = {}) {
  const saved = options.saved ?? new Map<string, unknown>()
  const env = options.env ?? {}
  const rig = {
    posted: [] as any[],
    scripts: [] as string[][],
    reads: [] as string[],
    blits: [] as any[],
    renders: 0,
    blitDeny: '' as string,
    imageDeny: '' as string,
    hum: {
      connected: 1,
      playing: false,
      track: null as null | Record<string, string>,
      position: 12,
      duration: 200,
      volume: 80,
      ducked: false,
      lyrics: LYRICS,
    },
    saved,
  }
  on('store.get', (_$: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', (_$: any, e: any) => ({ value: e.name in env ? env[e.name] : e.name === 'HUM_PORT' ? String(PORT) : e.name === 'HOME' ? HOME : undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PostToolUse', () => ({}))
  on('ui.render', () => {
    rig.renders += 1
    return { type: 'Text', props: {}, children: ['drawn by Claude Code'] }
  })
  on('ui.blit', (_$: any, e: any) => {
    rig.blits.push(e)
    if (e.key === 'cover') return { value: rig.imageDeny ? { deny: rig.imageDeny } : {} }
    return { value: rig.blitDeny ? { deny: rig.blitDeny } : {} }
  })
  on('http.fetch', (_$: any, e: any) => {
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    const url = new URL(e.url)
    if (url.port !== String(PORT)) throw new Error(`unexpected host ${e.url}`)
    if (url.pathname === '/api/remote/state') return reply({ ...rig.hum, line: '', at: Date.now() })
    const body = JSON.parse(e.init.body)
    rig.posted.push(body)
    if (body.cmd === 'play') {
      rig.hum.playing = true
      rig.hum.track = { title: 'Amazing Grace', artist: 'Judy Collins', id: 'dQw4w9WgXcQ', art: 'https://art.test/grace.jpg' }
    } else if (body.cmd === 'pause') rig.hum.playing = false
    else if (body.cmd === 'resume') rig.hum.playing = true
    else if (body.cmd === 'toggle') rig.hum.playing = !rig.hum.playing
    else if (body.cmd === 'duck') rig.hum.ducked = true
    else if (body.cmd === 'unduck') rig.hum.ducked = false
    return reply({ id: 1, ok: true, text: 'ok' })
  })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === '/bin/test') return ok()
    if (argv[0] === '/bin/sh' && argv[2]?.includes('sips')) {
      rig.scripts.push(argv)
      return { value: { exitCode: options.coverFails ? 3 : 0, stdout: '', stderr: '' } }
    }
    return ok(JSON.stringify({ state: 'playing', station: 'lofi', title: '', volume: 55, ducked: false }))
  })
  on('fs.read', (_$: any, e: any) => {
    rig.reads.push(e.path)
    if (e.path.endsWith('thumb.bmp')) return { value: { base64: thumbBase64() } }
    if (e.path.endsWith('cover.jpg')) return { value: { base64: 'JPEGJPEG' } }
    if (e.path.endsWith('cover.png')) return { value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } }
    throw new Error('ENOENT')
  })
  const clock = mock.clock(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return { ...rig, rig, clock }
}

const music = ($: any, args: string) => $.command.run({ command: 'music', args })

// A song playing in the big panel, with the cover already made.
async function playBig($: any, on: any, clock: any) {
  await music($, 'big')
  await music($, 'amazing grace judy collins')
  await clock.advance(200)
}

test('/music big toggles the panel, says so, and remembers the choice', async ($, on) => {
  const { saved } = await boot($, on)
  expect((await music($, 'big')).text).toMatch(/^Big panel on/)
  expect(saved.get('big')).toBe(true)
  expect((await music($, 'big')).text).toMatch(/^Big panel off/)
  expect(saved.get('big')).toBe(false)
})

test('a new session starts with the choice it had', async ($, on) => {
  const saved = new Map<string, unknown>([['big', true]])
  const { clock } = await boot($, on, { saved })
  await music($, 'amazing grace')
  await clock.advance(200)
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Raster', key: 'aurora' })).toBeDefined()
})

test('without big the band is what it was, and nothing is fetched for a cover', async ($, on) => {
  const { scripts, clock } = await boot($, on)
  await music($, 'amazing grace')
  await clock.advance(2000)
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: /Amazing Grace/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(scripts).toHaveLength(0)
})

test('the radio keeps its band when big is on', async ($, on) => {
  const { clock } = await boot($, on)
  await music($, 'big')
  await music($, 'lofi')
  await clock.advance(3000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(100, surface))
    expect(await ui.find({ type: 'Text', text: /lofi · live/ })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  }
})

test('terminal: cell art cover, aurora strip, text, progress and real buttons', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  const cover = await ui.find({ type: 'Raster', key: 'cover' })
  const aurora = await ui.find({ type: 'Raster', key: 'aurora' })
  expect(cover?.props).toMatchObject({ columns: 16, rows: 8 })
  expect(aurora?.props).toMatchObject({ rows: 2 })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Amazing Grace' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Judy Collins' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /second line/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0:12 \/ 3:20/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /━+/ })).toBeDefined()
  for (const key of ['prev', 'play', 'next']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
  // the one-line band is gone
  expect(await ui.find({ type: 'Text', text: /Amazing Grace ·/ })).toBeUndefined()
})

test('terminal: a kitty or Ghostty terminal gets the Image for the cover', async ($, on) => {
  const { clock, reads } = await boot($, on, { env: { TERM: 'xterm-kitty' } })
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  const image = await ui.find({ type: 'Image', key: 'cover' })
  expect(image?.props).toMatchObject({ columns: 16, rows: 8, source: { png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } })
  expect(await ui.find({ type: 'Raster', key: 'cover' })).toBeUndefined()
  expect(await ui.find({ type: 'Raster', key: 'aurora' })).toBeDefined()
  expect(reads.some((p: string) => p.endsWith('cover.png'))).toBe(true)
})

test('terminal: when the terminal says it draws pictures but the engine draws the alt, the cover becomes cell art', async ($, on) => {
  const { clock, rig } = await boot($, on, { env: { TERM_PROGRAM: 'ghostty' } })
  rig.imageDeny = 'the Image draws its alt here: the terminal draws no placeholder images (not asked yet, no answer)'
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Image', key: 'cover' })).toBeDefined()
  // the first look waits for the terminal to answer, the second confirms
  await clock.advance(1700)
  expect(await ui.find({ type: 'Image', key: 'cover' })).toBeDefined()
  await clock.advance(3200)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Raster', key: 'cover' })).toBeDefined()
})

test('terminal: a terminal that does draw pictures keeps the Image', async ($, on) => {
  const { clock, blits } = await boot($, on, { env: { TERM_PROGRAM: 'ghostty' } })
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  await clock.advance(5000)
  expect(blits.some((b: any) => b.key === 'cover')).toBe(true)
  expect(await ui.find({ type: 'Image', key: 'cover' })).toBeDefined()
})

test('terminal: below 60 columns, or with no room, the one-line band is drawn', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const narrow = await $.ui.mount(BAND(58))
  expect(await narrow.find({ type: 'Text', text: /Amazing Grace/ })).toBeDefined()
  expect(await narrow.find({ type: 'Raster' })).toBeUndefined()
  await narrow.unmount()
  const short = await $.ui.mount(BAND(100, 'terminal', 6))
  expect(await short.find({ type: 'Raster' })).toBeUndefined()
  expect(await short.find({ type: 'Text', text: /Amazing Grace/ })).toBeDefined()
  await short.unmount()
  const just = await $.ui.mount(BAND(60))
  expect(await just.find({ type: 'Raster', key: 'aurora' })).toBeDefined()
})

test('desktop: one Svg with the cover and a glow that animates, native lyric, progress and buttons', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100, 'desktop'))
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.isInteractive).toBe(true)
  const source = String(svg?.props.source)
  expect(source.length).toBeLessThanOrEqual(131072)
  expect(source).toContain('data:image/jpeg;base64,JPEGJPEG')
  expect(source).toContain('<animate ')
  expect(source).toContain('Amazing Grace')
  expect(source).toContain('Judy Collins')
  expect(svg?.props.alt).toBe('Amazing Grace by Judy Collins')
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /second line/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0:12 \/ 3:20/ })).toBeDefined()
  for (const key of ['prev', 'play', 'next']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
})

test('desktop: the Svg source stays the same while the song plays, so its animation is not restarted', async ($, on) => {
  const { clock, hum } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100, 'desktop'))
  const before = String((await ui.find({ type: 'Svg' }))?.props.source)
  hum.position = 25
  await clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: /third line/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toBe(before)
})

test('desktop: pausing swaps in a still glow', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100, 'desktop'))
  await ui.press({ key: 'play' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).not.toContain('<animate ')
  await ui.press({ key: 'play' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('<animate ')
})

test('the buttons call hum on both surfaces', async ($, on) => {
  const { clock, posted } = await boot($, on)
  await playBig($, on, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    posted.length = 0
    const ui = await $.ui.mount(BAND(100, surface))
    await ui.press({ key: 'prev' })
    await ui.press({ key: 'play' })
    await ui.press({ key: 'next' })
    expect(posted.map((p: any) => p.cmd)).toEqual(['prev', 'toggle', 'next'])
    await ui.press({ key: 'play' })
    await ui.unmount()
  }
})

test('the cover is made in the background from hum\'s art, then YouTube\'s thumbnail, into hush\'s folder', async ($, on) => {
  const { clock, scripts, reads } = await boot($, on)
  await playBig($, on, clock)
  expect(scripts).toHaveLength(1)
  const argv = scripts[0]
  expect(argv[0]).toBe('/bin/sh')
  expect(argv.slice(3, 6)).toEqual(['sh', `${HOME}/.claude/hush/art/dQw4w9WgXcQ`, `${HOME}/.claude/hush/art`].slice(0, 3))
  expect(argv).toContain('40')
  expect(argv.slice(-2)).toEqual(['https://art.test/grace.jpg', 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'])
  expect(argv[2]).toContain('/usr/bin/sips')
  expect(argv[2]).toContain('-s format bmp')
  expect(argv[2]).toContain('-s format jpeg')
  expect(argv[2]).toContain('-s format png')
  expect(reads.some((p: string) => p.endsWith('thumb.bmp'))).toBe(true)
  // the same song again does not fetch again
  await clock.advance(5000)
  expect(scripts).toHaveLength(1)
})

test('a cover that cannot be made still gets a panel, with hum\'s warm colours', async ($, on) => {
  const { clock } = await boot($, on, { coverFails: true })
  await playBig($, on, clock)
  const term = await $.ui.mount(BAND(100))
  expect(await term.find({ type: 'Raster', key: 'cover' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: 'Amazing Grace' })).toBeDefined()
  const desk = await $.ui.mount(BAND(100, 'desktop'))
  const source = String((await desk.find({ type: 'Svg' }))?.props.source)
  expect(source).not.toContain('data:image')
  expect(source).toContain('Amazing Grace')
})

test('the aurora is blitted about eight times a second, and the tree is not redrawn for it', async ($, on) => {
  const { clock, blits, rig } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  await clock.advance(100)
  blits.length = 0
  rig.renders = 0
  await clock.advance(2000)
  expect(blits.length).toBeGreaterThanOrEqual(14)
  expect(blits.length).toBeLessThanOrEqual(17)
  expect(blits.every((b: any) => b.key === 'aurora' && b.requestId === 'band' && b.rows === 2)).toBe(true)
  expect(blits[0].columns).toBe(panelTextColumns(100))
  // the tree is drawn when the clock or lyric moves, about once a second, never per frame
  expect(rig.renders).toBeLessThanOrEqual(6)
  expect(blits[0].cells).not.toBe(blits[5].cells)
  await ui.unmount()
})

function panelTextColumns(width: number) {
  return Math.min(width - 4, 100) - 2 - 16 - 2
}

test('the aurora stops when the song is paused, and when the music steps down, and comes back', async ($, on) => {
  const { clock, blits } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  await clock.advance(500)
  expect(blits.length).toBeGreaterThan(0)
  await music($, '')
  await clock.advance(1500)
  blits.length = 0
  await clock.advance(2000)
  expect(blits).toHaveLength(0)
  blits.length = 0
  await music($, '')
  await clock.advance(1500)
  expect(blits.length).toBeGreaterThan(8)
  await $.tool.check({ tool: 'Bash', command: 'npm publish' })
  await clock.advance(1500)
  blits.length = 0
  await clock.advance(2000)
  expect(blits).toHaveLength(0)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} })
  await clock.advance(1500)
  expect(blits.length).toBeGreaterThan(8)
  await ui.unmount()
})

test('the aurora stops when the music stops, when big is turned off, and when nothing is drawn any more', async ($, on) => {
  const { clock, blits, rig } = await boot($, on)
  await playBig($, on, clock)
  await $.ui.mount(BAND(100))
  await clock.advance(1000)
  await music($, 'big')
  blits.length = 0
  await clock.advance(2000)
  expect(blits).toHaveLength(0)
  await music($, 'big')
  await clock.advance(1500)
  expect(blits.length).toBeGreaterThan(0)
  await music($, 'stop')
  await clock.advance(200)
  blits.length = 0
  await clock.advance(2000)
  expect(blits).toHaveLength(0)
  expect(rig.hum.playing).toBe(false)
})

test('the aurora gives up after the surface keeps refusing its blits', async ($, on) => {
  const { clock, blits, rig } = await boot($, on)
  await playBig($, on, clock)
  await $.ui.mount(BAND(100))
  rig.blitDeny = 'nothing of this plugin is mounted there'
  await clock.advance(3000)
  const seen = blits.length
  expect(seen).toBeGreaterThanOrEqual(20)
  expect(seen).toBeLessThan(25)
  await clock.advance(3000)
  expect(blits).toHaveLength(seen)
})

test('no blits are made on the desktop, which has no Raster', async ($, on) => {
  const { clock, blits } = await boot($, on)
  await playBig($, on, clock)
  await $.ui.mount(BAND(100, 'desktop'))
  await clock.advance(3000)
  expect(blits).toHaveLength(0)
})

test('DJ Clawd stays in big mode, on the controls row, and /music clawd still hides him', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(100, surface))
    expect(await ui.find({ type: 'Text', text: /\(▐[▛▙]█[▜▟]▌\)/ })).toBeDefined()
    await ui.unmount()
  }
  await music($, 'clawd')
  const hidden = await $.ui.mount(BAND(100))
  expect(await hidden.find({ type: 'Text', text: /▐/ })).toBeUndefined()
})

test('when Claude asks a question the panel dims and Clawd lifts a cup', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const ui = await $.ui.mount(BAND(100))
  const title = () => ui.find({ type: 'Text', text: 'Amazing Grace' })
  expect((await title())?.props.dimColor).toBeFalsy()
  await $.tool.check({ tool: 'Bash', command: 'npm publish' })
  await clock.advance(1100)
  expect((await title())?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\(▐▛█▜▌ '/ })).toBeDefined()
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} })
  await clock.advance(1100)
  expect((await title())?.props.dimColor).toBeFalsy()
})

test('a survey takes the band, and the panel stays out of its way', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const props = { ...BAND(100).props, hasSurvey: true }
  const ui = await $.ui.mount({ ...BAND(100), props })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
})

test('the panel follows the song: a new track gets its own cover', async ($, on) => {
  const { clock, hum, scripts } = await boot($, on)
  await playBig($, on, clock)
  hum.track = { title: 'Nights', artist: 'Frank Ocean', id: 'abcdefghijk', art: '' }
  await clock.advance(1500)
  expect(scripts).toHaveLength(2)
  expect(scripts[1].slice(4, 5)).toEqual([`${HOME}/.claude/hush/art/abcdefghijk`])
  expect(scripts[1].slice(-1)).toEqual(['https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg'])
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: 'Frank Ocean' })).toBeDefined()
})

test('each surface is drawn from its own element table', async ($, on) => {
  const { clock } = await boot($, on)
  await playBig($, on, clock)
  const found: Record<string, string[]> = {}
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(100, surface))
    found[surface] = []
    for (const type of ['Raster', 'Image', 'Svg', 'Button', 'Text']) {
      if (await ui.find({ type })) found[surface].push(type)
    }
    await ui.unmount()
  }
  expect(found.terminal).toEqual(['Raster', 'Button', 'Text'])
  expect(found.desktop).toEqual(['Svg', 'Button', 'Text'])
})
