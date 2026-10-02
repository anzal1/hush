import { expect, mock, test } from 'claude-code/testing'

const PROMPT = (columns: number, surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'hush',
    component: 'AbovePrompt',
    surface,
    requestId: 'band',
    viewport: { columns, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: columns, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  }) as const

// A fake helper: answers the ctl commands the mod sends, keeps its own state.
function fakeHelper(on: any) {
  const helper = { state: 'idle', station: '', title: '', volume: 55, ducked: false, sent: [] as string[] }
  on('process.run', ($: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === '/bin/test') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (argv[1] !== 'ctl') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    const cmd = argv[3] ?? ''
    helper.sent.push(cmd)
    const [word, ...rest] = cmd.split(' ')
    if (word === 'play') {
      helper.state = 'playing'
      helper.station = rest.slice(1).join(' ')
      helper.title = 'Nights - Frank Ocean'
    } else if (word === 'pause') helper.state = 'paused'
    else if (word === 'resume') helper.state = 'playing'
    else if (word === 'stop') helper.state = 'idle'
    else if (word === 'duck') helper.ducked = true
    else if (word === 'unduck') helper.ducked = false
    else if (word === 'vol') helper.volume = Number(rest[0])
    const { sent, ...reply } = helper
    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' } }
  })
  return helper
}

async function boot($: any, on: any) {
  const saved = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/home/test' }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  const clock = mock.clock(on)
  const helper = fakeHelper(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return { clock, helper, saved }
}

test('/music starts the lofi station and remembers it', async ($, on) => {
  const { helper, saved } = await boot($, on)
  const answer = await $.command.run({ command: 'music', args: 'lofi' })
  expect(answer.text).toMatch(/^Playing lofi/)
  expect(helper.sent.some((c: string) => c.startsWith('play https://radio.nia.nc/'))).toBe(true)
  expect(saved.get('station')).toBe(0)
})

test('/music next moves to the following station and wraps', async ($, on) => {
  const { helper } = await boot($, on)
  await $.command.run({ command: 'music', args: 'classical' })
  const answer = await $.command.run({ command: 'music', args: 'next' })
  expect(answer.text).toMatch(/^Playing nature/)
  const wrapped = await $.command.run({ command: 'music', args: 'next' })
  expect(wrapped.text).toMatch(/^Playing lofi/)
  expect(helper.sent.filter((c: string) => c.startsWith('play ')).length).toBe(3)
})

test('the music ducks on a permission question and returns after the answer', async ($, on) => {
  const { helper } = await boot($, on)
  await $.command.run({ command: 'music', args: 'jazz' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm publish' } })
  expect(helper.ducked).toBe(true)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {} })
  expect(helper.ducked).toBe(false)
})

test('nothing is drawn while nothing plays, and no helper call is made for a duck', async ($, on) => {
  const { helper } = await boot($, on)
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(helper.sent.some((c: string) => c.startsWith('duck'))).toBe(false)
  const ui = await $.ui.mount(PROMPT(100))
  expect(await ui.find({ type: 'Text', text: /Nights/ })).toBeUndefined()
})

test('the band shows the title, station tag and a volume line', async ($, on) => {
  await boot($, on)
  await $.command.run({ command: 'music', args: 'lofi' })
  const ui = await $.ui.mount(PROMPT(100))
  expect(await ui.find({ type: 'Text', text: /Nights - Frank Ocean/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /lofi · live/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /━+/ })).toBeDefined()
})

test('the band narrows: volume line goes first, then the tag', async ($, on) => {
  await boot($, on)
  await $.command.run({ command: 'music', args: 'lofi' })
  const mid = await $.ui.mount(PROMPT(62))
  expect(await mid.find({ type: 'Text', text: /━/ })).toBeUndefined()
  expect(await mid.find({ type: 'Text', text: /lofi · live/ })).toBeDefined()
  const tight = await $.ui.mount(PROMPT(34))
  expect(await tight.find({ type: 'Text', text: /lofi · live/ })).toBeUndefined()
  expect(await tight.find({ type: 'Text', text: /Nights/ })).toBeDefined()
})

test('pressing play pauses, and the button then reads play', async ($, on) => {
  const { helper } = await boot($, on)
  await $.command.run({ command: 'music', args: 'lofi' })
  const ui = await $.ui.mount(PROMPT(100))
  await ui.press({ key: 'play' })
  expect(helper.state).toBe('paused')
})

test('a failed station moves on to the next one', async ($, on) => {
  const { helper, clock } = await boot($, on)
  await $.command.run({ command: 'music', args: 'lofi' })
  helper.state = 'failed'
  await clock.advance(2600)
  expect(helper.sent.filter((c: string) => c.startsWith('play ')).length).toBeGreaterThanOrEqual(2)
  expect(helper.station).toBe('jazz')
})

test('/music stop stops the helper', async ($, on) => {
  const { helper } = await boot($, on)
  await $.command.run({ command: 'music', args: 'lofi' })
  const answer = await $.command.run({ command: 'music', args: 'stop' })
  expect(answer.text).toBe('Music stopped')
  expect(helper.state).toBe('idle')
})
