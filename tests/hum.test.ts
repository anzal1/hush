import { expect, mock, test } from 'claude-code/testing'

const PORT = 3952
const BAND = (columns: number) =>
  ({
    plugin: 'hush',
    component: 'AbovePrompt',
    surface: 'terminal',
    requestId: 'band',
    viewport: { columns, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: columns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  }) as const

const LYRICS = [
  { t: 0, text: 'first line' },
  { t: 10, text: 'second line' },
  { t: 20, text: 'third line' },
]

// A fake hum: answers the loopback remote the mod talks to, keeps its own state, and logs
// every POSTed command. `events` records the order of hum commands and helper commands.
function fakeHum(on: any, events: string[]) {
  const hum = {
    up: true,
    connected: 1,
    playing: false,
    track: null as null | { title: string; artist: string },
    position: 0,
    duration: 307,
    volume: 80,
    ducked: false,
    lyrics: LYRICS as { t: number; text: string }[],
    posted: [] as any[],
    gets: 0,
    spawned: [] as string[][],
    opened: [] as string[][],
    opensWindow: true,
    startable: true,
  }
  on('http.fetch', (_$: any, e: any) => {
    if (!hum.up) throw new Error('ECONNREFUSED')
    const url = new URL(e.url)
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (url.hostname !== '127.0.0.1' || url.port !== String(PORT)) throw new Error(`unexpected host ${e.url}`)
    if (url.pathname === '/api/remote/state') {
      hum.gets += 1
      const { up, posted, gets, spawned, opened, opensWindow, startable, ...state } = hum
      return reply({ ...state, line: '', at: Date.now() })
    }
    const body = JSON.parse(e.init.body)
    hum.posted.push(body)
    events.push(`hum:${body.cmd}`)
    if (hum.connected === 0) return reply({ id: 1, ok: false, text: 'No hum window is open.' })
    if (body.cmd === 'play') {
      hum.playing = true
      hum.position = 12
      hum.track = { title: 'Nights', artist: 'Frank Ocean' }
    } else if (body.cmd === 'pause') hum.playing = false
    else if (body.cmd === 'resume') hum.playing = true
    else if (body.cmd === 'toggle') hum.playing = !hum.playing
    else if (body.cmd === 'volume') hum.volume = body.level
    else if (body.cmd === 'duck') hum.ducked = true
    else if (body.cmd === 'unduck') hum.ducked = false
    return reply({ id: 1, ok: true, text: body.cmd === 'play' ? 'Playing Nights by Frank Ocean' : 'ok' })
  })
  return hum
}

// A fake radio helper plus the two commands the mod runs to start and show hum.
function fakeProcesses(on: any, hum: any, events: string[]) {
  const helper = { state: 'idle', station: '', volume: 55, ducked: false, sent: [] as string[] }
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv[0] === '/bin/test') return ok()
    if (argv[0] === '/bin/sh' && argv.join(' ').includes('npx')) {
      hum.spawned.push(argv)
      if (hum.startable) {
        hum.up = true
        hum.connected = 0
      }
      return ok()
    }
    if (argv[0] === '/usr/bin/open') {
      hum.opened.push(argv)
      if (hum.opensWindow) hum.connected = 1
      return ok()
    }
    if (argv[1] !== 'ctl') return ok()
    const cmd = argv[3] ?? ''
    helper.sent.push(cmd)
    events.push(`radio:${cmd.split(' ')[0]}`)
    const [word, ...rest] = cmd.split(' ')
    if (word === 'play') {
      helper.state = 'playing'
      helper.station = rest.slice(1).join(' ')
    } else if (word === 'pause') helper.state = 'paused'
    else if (word === 'resume') helper.state = 'playing'
    else if (word === 'stop') helper.state = 'idle'
    else if (word === 'duck') helper.ducked = true
    else if (word === 'unduck') helper.ducked = false
    else if (word === 'vol') helper.volume = Number(rest[0])
    const { sent, ...reply } = helper
    return ok(JSON.stringify({ ...reply, title: '' }))
  })
  return helper
}

async function boot($: any, on: any) {
  const events: string[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HUM_PORT' ? String(PORT) : '/home/test' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PostToolUse', () => ({}))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  const clock = mock.clock(on)
  const hum = fakeHum(on, events)
  const helper = fakeProcesses(on, hum, events)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return { clock, hum, helper, events }
}

const music = ($: any, args: string) => $.command.run({ command: 'music', args })
const sent = (hum: any) => hum.posted.map((p: any) => p.cmd)

test('a song goes to hum, and the band shows title, artist and the lyric being sung', async ($, on) => {
  const { hum } = await boot($, on)
  const answer = await music($, 'frank ocean nights')
  expect(answer.text).toBe('Playing Nights by Frank Ocean')
  expect(hum.posted[0]).toEqual({ cmd: 'play', query: 'frank ocean nights' })
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: /Nights · Frank Ocean/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /second line/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /first line/ })).toBeUndefined()
})

test('the lyric line moves with the song, and without lyrics the title takes the room', async ($, on) => {
  const { hum, clock } = await boot($, on)
  await music($, 'nights')
  const ui = await $.ui.mount(BAND(100))
  hum.position = 21
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /third line/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /second line/ })).toBeUndefined()
  hum.lyrics = []
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /third line/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nights · Frank Ocean/ })).toBeDefined()
})

test('the radio is stopped before the song is sent to hum', async ($, on) => {
  const { helper, events } = await boot($, on)
  await music($, 'lofi')
  expect(helper.state).toBe('playing')
  await music($, 'frank ocean nights')
  expect(helper.state).toBe('idle')
  expect(events.indexOf('radio:stop')).toBeGreaterThan(-1)
  expect(events.indexOf('radio:stop')).toBeLessThan(events.indexOf('hum:play'))
})

test('hum is started and opened when it is not running, then the song is sent', async ($, on) => {
  const { hum, clock } = await boot($, on)
  hum.up = false
  hum.connected = 0
  const pending = music($, 'frank ocean nights')
  await clock.advance(3000)
  const answer = await pending
  expect(answer.text).toBe('Playing Nights by Frank Ocean')
  expect(hum.spawned.length).toBe(1)
  const script = hum.spawned[0].join(' ')
  expect(script).toContain('npx -y -p "$2" hum')
  expect(hum.spawned[0]).toContain('github:anzal1/hum')
  expect(hum.spawned[0]).toContain(String(PORT))
  expect(script).toContain('HUM_NO_OPEN=1')
  expect(hum.opened).toEqual([['/usr/bin/open', `http://localhost:${PORT}`]])
  expect(sent(hum)).toEqual(['play'])
})

test('a running hum with no window gets its player opened, not restarted', async ($, on) => {
  const { hum, clock } = await boot($, on)
  hum.connected = 0
  const pending = music($, 'nights')
  await clock.advance(2000)
  await pending
  expect(hum.spawned.length).toBe(0)
  expect(hum.opened.length).toBe(1)
  expect(sent(hum)).toEqual(['play'])
})

test('when hum never opens, the answer says hum needs to be open and the radio is left alone', async ($, on) => {
  const { hum, helper, clock } = await boot($, on)
  await music($, 'lofi')
  hum.up = false
  hum.connected = 0
  hum.startable = false
  const pending = music($, 'nights')
  await clock.advance(25000)
  const answer = await pending
  expect(answer.text).toMatch(/^hum needs to be open to play songs\. Start it with: npx -y -p github:anzal1\/hum hum/)
  expect(answer.text).not.toContain('\u2014')
  expect(hum.posted.length).toBe(0)
  expect(helper.state).toBe('playing')
})

test('when hum starts but no window ever connects, the answer says so', async ($, on) => {
  const { hum, clock } = await boot($, on)
  hum.up = false
  hum.connected = 0
  hum.opensWindow = false
  const pending = music($, 'nights')
  await clock.advance(25000)
  const answer = await pending
  expect(answer.text).toMatch(/^hum is running but its player window is not open/)
  expect(hum.posted.length).toBe(0)
})

test('the music ducks hum, not the radio, and restores it after the answer', async ($, on) => {
  const { hum, helper } = await boot($, on)
  await music($, 'nights')
  await $.tool.check({ tool: 'Bash', command: 'npm publish' })
  expect(sent(hum)).toEqual(['play', 'duck'])
  expect(hum.ducked).toBe(true)
  expect(helper.sent.some((c: string) => c.startsWith('duck'))).toBe(false)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} })
  expect(sent(hum)).toEqual(['play', 'duck', 'unduck'])
  expect(hum.ducked).toBe(false)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} })
  expect(sent(hum)).toEqual(['play', 'duck', 'unduck'])
})

test('/music, next, prev, vol and stop are hum commands while hum is the source', async ($, on) => {
  const { hum, helper } = await boot($, on)
  await music($, 'nights')
  expect((await music($, '')).text).toBe('Paused')
  expect((await music($, '')).text).toBe('Playing')
  await music($, 'next')
  await music($, 'prev')
  expect((await music($, 'vol 40')).text).toBe('Volume 40')
  expect(hum.volume).toBe(40)
  expect((await music($, 'stop')).text).toBe('Music stopped')
  expect(sent(hum)).toEqual(['play', 'toggle', 'toggle', 'next', 'prev', 'volume', 'pause'])
  expect(helper.sent.some((c: string) => c.startsWith('play '))).toBe(false)
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: /Nights/ })).toBeUndefined()
})

test('the band buttons drive hum', async ($, on) => {
  const { hum, clock } = await boot($, on)
  await music($, 'nights')
  const ui = await $.ui.mount(BAND(100))
  // The engine stamps these fields when the person tabs onto the band; the test sends them itself.
  await $.ui.focus({ requestId: 'band', key: 'play', component: 'AbovePrompt', plugin: 'hush', element: 'play' } as any)
  await clock.settle()
  await ui.press({ key: 'play' })
  expect(hum.playing).toBe(false)
  await ui.press({ key: 'next' })
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'down' })
  await ui.press({ key: 'up' })
  await ui.press({ key: 'up' })
  expect(sent(hum)).toEqual(['play', 'toggle', 'next', 'prev', 'volume', 'volume', 'volume'])
  expect(hum.posted.filter((p: any) => p.cmd === 'volume').map((p: any) => p.level)).toEqual([70, 80, 90])
})

test('a station key pauses hum and goes back to the radio', async ($, on) => {
  const { hum, helper } = await boot($, on)
  await music($, 'nights')
  const answer = await music($, 'jazz')
  expect(answer.text).toMatch(/^Playing jazz/)
  expect(sent(hum)).toEqual(['play', 'pause'])
  expect(helper.sent.some((c: string) => c.startsWith('play https://smoothjazz'))).toBe(true)
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: /jazz · live/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Nights/ })).toBeUndefined()
})

test('/music radio returns to the radio from hum', async ($, on) => {
  const { hum, helper } = await boot($, on)
  await music($, 'nights')
  await music($, 'radio')
  expect(sent(hum)).toEqual(['play', 'pause'])
  expect(helper.state).toBe('playing')
})

test('hum is polled only while it is the source', async ($, on) => {
  const { hum, clock } = await boot($, on)
  await music($, 'lofi')
  await clock.advance(6000)
  expect(hum.gets).toBe(0)
  await music($, 'nights')
  const before = hum.gets
  await clock.advance(3000)
  expect(hum.gets - before).toBeGreaterThanOrEqual(3)
  await music($, 'stop')
  const after = hum.gets
  await clock.advance(5000)
  expect(hum.gets).toBe(after)
})

test('the band goes away when the hum window is closed', async ($, on) => {
  const { hum, clock } = await boot($, on)
  await music($, 'nights')
  const ui = await $.ui.mount(BAND(100))
  expect(await ui.find({ type: 'Text', text: /Nights/ })).toBeDefined()
  hum.connected = 0
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /Nights/ })).toBeUndefined()
  const before = hum.gets
  await clock.advance(12000)
  expect(hum.gets - before).toBeLessThanOrEqual(10)
})
