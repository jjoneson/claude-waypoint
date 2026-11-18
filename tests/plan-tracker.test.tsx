import { expect, mock, test } from 'claude-code/testing'

import { contextText, parsePlan, saysPhaseDone } from '../hooks/plans'

const PLAN = `---
project: docs-site
status: active
phase: 2
phases: 3
next: Start on the index in src/search/index.ts.
updated: 2026-01-15
---

# Docs site

## Phases

### 1. Landing page: done (commit abc1234)

### 2. Search: in progress

### 3. Dark mode: not started

## Open questions

- Should search cover the blog? (recommend yes)
- None
`

const PANE = {
  plugin: 'plan-tracker',
  component: 'Pane',
  requestId: 'plans',
  props: {
    title: 'Plans',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** A slash command as the person types it: what the engine stamps on `command.run`. */
const typed = (command: string, args = '') =>
  ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

test('a plan is read from its header, phase headings and open questions', async () => {
  const plan = parsePlan('docs-site', PLAN, 1)
  expect(plan.title).toBe('Docs site')
  expect(plan.status).toBe('active')
  expect(plan.phase).toBe(2)
  expect(plan.phases).toBe(3)
  expect(plan.list.map(p => p.state)).toEqual(['done', 'in progress', 'not started'])
  expect(plan.questions).toBe(1)
  expect(contextText([plan])).toContain('- docs-site (Docs site): active, phase 2 of 3; 1 open question.')
  expect(contextText([{ ...plan, status: 'done' }])).toBe(null)
  expect(saysPhaseDone('Phase 2 is done. Next: /clear, then /phase docs-site')).toBe(true)
  expect(saysPhaseDone('I finished phase 2.')).toBe(true)
  expect(saysPhaseDone('Still working on the search; the index is next.')).toBe(false)
})

test('the pane lists open plans, and a finished phase with a stale plan is sent back once', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  let mtime = 5_000
  on('fs.list', () => ({
    value: [
      { name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: mtime, isLink: false },
      { name: 'TEMPLATE.md', kind: 'file', size: 10, mtimeMs: 1, isLink: false },
    ],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('command.register', () => ({ value: { command: 'plans' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const titled = await $.classic.UserPromptSubmit({ prompt: '/phase docs-site' })
  expect(titled.sessionTitle).toBe('docs-site · phase 2')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /docs-site/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Next:/ }))?.text).toBe(
      'Next: Start on the index in src/search/index.ts.',
    )
    expect(await ui.find({ type: 'Text', text: /1 open question for you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\. Search/ })).toBeDefined()
    await ui.unmount()
  }

  // The plan (mtime 5 s) is older than the session (10 s): sent back once.
  const done = { stop_hook_active: false, last_assistant_message: 'Phase 2 is done.' }
  expect((await $.classic.Stop(done)).block).toContain('docs/plans/docs-site.md')
  expect((await $.classic.Stop(done)).block).toBe(undefined)

  // Once the plan is written after the work, nothing is said.
  await clock.advance(1_000)
  mtime = 20_000
  expect((await $.classic.Stop(done)).block).toBe(undefined)
  expect((await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Working on it.' })).block).toBe(undefined)
})

test('a session in a worktree finds the plans above it, and an active plan keeps its phases listed with no /phase typed', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const HERE = '/work/repo/.claude/worktrees/x'
  const PLANS = '/work/docs/plans'
  const listed: string[] = []
  on('session.cwd', () => ({ value: HERE }))
  on('session.root', () => ({ value: HERE }))
  on('fs.exists', (_, e) => ({ value: e.path === PLANS }))
  on('fs.list', (_, e) => {
    listed.push(e.path)
    return {
      value: e.path === PLANS ? [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 7, isLink: false }] : [],
    }
  })
  on('fs.read', (_, e) => ({ value: e.path === `${PLANS}/docs-site.md` ? PLAN : '' }))
  on('command.register', () => ({ value: { command: 'plans' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: HERE, surface: 'terminal', isInteractive: true })
  expect(listed).toContain(PLANS)

  // No /phase was typed, so no plan is the session's own: the active plan's phases are listed all the same.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\. Landing page/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\. Search/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3\. Dark mode/ })).toBeDefined()
  await ui.unmount()
})

test("the pane's button and /next-phase clear the context and then run /phase", async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  const ran: string[] = []
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // What the engine would run: the built-in /clear, then the phase skill (by its plain name: no command list here).
  on('command.run', (_, e) => {
    ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  const settled = async (count: number) => {
    for (let i = 0; i < 50 && ran.length < count; i++) await Promise.resolve()
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fresh-docs-site' })
  await settled(2)
  expect(ran).toEqual(['/clear', '/phase docs-site'])
  await ui.unmount()

  // The typed way, with no name: the only active plan. It answers at once and does the two afterwards.
  ran.length = 0
  const said = await $.command.run(typed('next-phase'))
  expect(said.text).toBe('Clearing the context, then /phase docs-site.')
  expect(ran).toEqual([])
  await clock.advance(1)
  await settled(2)
  expect(ran).toEqual(['/clear', '/phase docs-site'])

  // A plan that is not there is asked for, and nothing is cleared.
  ran.length = 0
  expect((await $.command.run(typed('next-phase', 'no-such-plan'))).text).toContain('Which plan?')
  await clock.advance(1)
  await settled(1)
  expect(ran).toEqual([])
})

test('installed as a plugin, the skills go by plan-tracker:<skill>, and the mod runs and reads them under that name', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  const ran: string[] = []
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  // The session's commands as a plugin install lists them, beside someone's own /phase.
  on('command.list', () => ({
    value: [
      { name: 'clear', description: '', source: 'builtin' },
      { name: 'phase', description: '', source: 'user' },
      { name: 'plan-tracker:phase', description: '', source: 'plugin', plugin: 'plan-tracker' },
      { name: 'plan-tracker:plan', description: '', source: 'plugin', plugin: 'plan-tracker' },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('command.run', (_, e) => {
    ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  const settled = async (count: number) => {
    for (let i = 0; i < 50 && ran.length < count; i++) await Promise.resolve()
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // A new conversation is told the name that works in this install.
  const told = await $.classic.SessionStart({ source: 'startup' })
  expect((told.additionalContext ?? []).join('\n')).toContain('Run a phase with /plan-tracker:phase <name>.')

  // Typed under the plugin's name, the skill binds the session to its plan like the plain one.
  const titled = await $.classic.UserPromptSubmit({ prompt: '/plan-tracker:phase docs-site 3' })
  expect(titled.sessionTitle).toBe('docs-site · phase 3')
  expect((await $.classic.UserPromptSubmit({ prompt: '/plan-tracker:plan docs-site' })).sessionTitle).toBe(
    'docs-site · planning',
  )

  const said = await $.command.run(typed('next-phase'))
  expect(said.text).toBe('Clearing the context, then /plan-tracker:phase docs-site.')
  await clock.advance(1)
  await settled(2)
  expect(ran).toEqual(['/clear', '/plan-tracker:phase docs-site'])
})

test("while the commands cannot be listed, the mod's own folder says the skills came with it", async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const asked: string[] = []
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('fs.exists', (_, e) => {
    asked.push(e.path)
    return { value: e.path.endsWith('/skills/phase/SKILL.md') }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(asked.some(path => path.endsWith('/skills/phase/SKILL.md'))).toBe(true)

  const told = await $.classic.SessionStart({ source: 'startup' })
  expect((told.additionalContext ?? []).join('\n')).toContain('Run a phase with /plan-tracker:phase <name>.')
})

const BAND = {
  plugin: 'plan-tracker',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

test('the pane is put away and brought back, and stays away in the next session', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const stored = new Map<string, unknown>()
  const did: string[] = []
  let isUp = false
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => {
    did.push('open')
    isUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    did.push('close')
    isUp = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'plans', title: 'Plans', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const settled = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settled()
  expect(did).toEqual(['open'])

  // While the pane is up the line above the prompt is not the mod's.
  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
  await band.unmount()

  // "hide" in the pane closes it and remembers.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'hide-plans' })
  await settled()
  await pane.unmount()
  expect(did).toEqual(['open', 'close'])
  expect(stored.get('isPaneHidden')).toBe(true)

  // Put away, the line names the plan and has the way back.
  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /^Plans:/ }))?.text).toContain('docs-site · phase 2/3 · active')
  await band.press({ key: 'show-plans' })
  await settled()
  await band.unmount()
  expect(did).toEqual(['open', 'close', 'open'])
  expect(stored.get('isPaneHidden')).toBe(false)

  // /plans is the same switch, typed: away when it is up, back when it is not.
  expect((await $.command.run(typed('plans'))).text).toContain('put away')
  expect(did).toEqual(['open', 'close', 'open', 'close'])
  expect((await $.command.run(typed('plans'))).text).toContain('Plans pane opened')
  expect(did).toEqual(['open', 'close', 'open', 'close', 'open'])

  // Put away again, a new session does not open it unasked.
  await $.command.run(typed('plans'))
  did.length = 0
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settled()
  expect(did).toEqual([])
})
