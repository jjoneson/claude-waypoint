import type { SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  configuredDir,
  contextText,
  homeFrom,
  isAbsolute,
  parsePlan,
  planNameOf,
  resolvePath,
  saysPhaseDone,
  tailOf,
} from '../hooks/plans'

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
  plugin: 'wp',
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
  expect(contextText([plan])).toContain('with /questions <name>.')
  expect(contextText([{ ...plan, questions: 0 }])).not.toContain('/questions')
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

test('a plan with open questions has a button that runs the questions skill for it, and the conversation is kept', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const ran: string[] = []
  const SETTLED = PLAN.replace('- Should search cover the blog? (recommend yes)\n', '')
  on('fs.list', () => ({
    value: [
      { name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false },
      { name: 'settled.md', kind: 'file', size: SETTLED.length, mtimeMs: 4_000, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('settled.md') ? SETTLED : PLAN }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.UserPromptSubmit', () => ({}))
  on('command.run', (_, e) => {
    ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  const settled = async (count: number) => {
    for (let i = 0; i < 50 && ran.length < count; i++) await Promise.resolve()
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /or \/questions docs-site/ })).toBeDefined()
    // The plan with nothing to ask has no such button.
    expect(await ui.find({ type: 'Text', text: /settled/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /or \/questions settled/ })).toBeUndefined()
    await ui.press({ key: 'ask-docs-site' })
    await settled(1)
    expect(ran).toEqual(['/questions docs-site'])
    await ui.unmount()
  }

  // Typed, the skill binds the session to its plan and leaves the session's title alone.
  const typedIt = await $.classic.UserPromptSubmit({ prompt: '/questions docs-site' })
  expect(typedIt.sessionTitle).toBe(undefined)
})

test('installed as a plugin, the skills go by wp:<skill>, and the mod runs and reads them under that name', async ($, on) => {
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
      { name: 'wp:phase', description: '', source: 'plugin', plugin: 'wp' },
      { name: 'wp:plan', description: '', source: 'plugin', plugin: 'wp' },
      { name: 'wp:questions', description: '', source: 'plugin', plugin: 'wp' },
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
  expect((told.additionalContext ?? []).join('\n')).toContain('Run a phase with /wp:phase <name>.')

  // Typed under the plugin's name, the skill binds the session to its plan like the plain one.
  const titled = await $.classic.UserPromptSubmit({ prompt: '/wp:phase docs-site 3' })
  expect(titled.sessionTitle).toBe('docs-site · phase 3')
  expect((await $.classic.UserPromptSubmit({ prompt: '/wp:plan docs-site' })).sessionTitle).toBe(
    'docs-site · planning',
  )

  const said = await $.command.run(typed('next-phase'))
  expect(said.text).toBe('Clearing the context, then /wp:phase docs-site.')
  await clock.advance(1)
  await settled(2)
  expect(ran).toEqual(['/clear', '/wp:phase docs-site'])

  // The questions skill too: in what a new conversation is told, and behind the pane's button.
  expect((told.additionalContext ?? []).join('\n')).toContain('with /wp:questions <name>.')
  ran.length = 0
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ask-docs-site' })
  await settled(1)
  expect(ran).toEqual(['/wp:questions docs-site'])
  await ui.unmount()
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
  expect((told.additionalContext ?? []).join('\n')).toContain('Run a phase with /wp:phase <name>.')
})

test('a plans folder is worked out from a base, a home and what a config file says', async () => {
  expect(resolvePath('/work', 'platform-docs/plans')).toBe('/work/platform-docs/plans')
  expect(resolvePath('/work/api', '../platform-docs/./plans/')).toBe('/work/platform-docs/plans')
  expect(resolvePath('/work', '/shared/plans')).toBe('/shared/plans')
  expect(resolvePath('/work', '~/notes/plans', '/home/u')).toBe('/home/u/notes/plans')
  expect(resolvePath('C:\\work', 'docs\\plans')).toBe('C:/work/docs/plans')
  expect(isAbsolute('docs/plans')).toBe(false)
  expect(isAbsolute('~/plans')).toBe(true)
  expect(tailOf('/work/platform-docs/plans/')).toBe('platform-docs/plans')

  expect(configuredDir('{ "plansDir": " platform-docs/plans " }')).toBe('platform-docs/plans')
  expect(configuredDir('{}')).toBe(null)
  expect(() => configuredDir('{ "plansDir": 3 }')).toThrow()
  expect(() => configuredDir('not json')).toThrow()

  // A plan is a file right in the plans folder, wherever that folder is.
  expect(planNameOf('/repo/docs/plans/docs-site.md')).toBe('docs-site')
  expect(planNameOf('/repo/docs/plans/TEMPLATE.md')).toBe(null)
  expect(planNameOf('/work/platform-docs/plans/docs-site.md', '/work/platform-docs/plans')).toBe('docs-site')
  expect(planNameOf('/work/platform-docs/plans/old/docs-site.md', '/work/platform-docs/plans')).toBe(null)
  expect(planNameOf('/work/api/docs/plans/docs-site.md', '/work/platform-docs/plans')).toBe(null)
  expect(contextText([parsePlan('docs-site', PLAN, 1)], undefined, '/work/platform-docs/plans')).toContain(
    'Open project plans in /work/platform-docs/plans/ ',
  )
})

/** A folder of several repositories that sessions start from: its config file names the plans folder. */
const WORK = '/work'
const CONFIG = `${WORK}/.claude/waypoint.json`
const DOCS_PLANS = `${WORK}/platform-docs/plans`

test('a folder of several repositories names its plans folder, and a session there or in a worktree below reads it', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  let here = WORK
  const listed: string[] = []
  on('session.cwd', () => ({ value: here }))
  on('session.root', () => ({ value: here }))
  // One of the repositories has a docs/plans of its own, in its checkout and in its worktrees: what the
  // workspace says still holds there.
  on('fs.exists', (_, e) => ({ value: e.path === CONFIG || e.path.endsWith('/docs/plans') }))
  on('fs.read', (_, e) => ({ value: e.path === CONFIG ? '{ "plansDir": "platform-docs/plans" }' : PLAN }))
  on('fs.list', (_, e) => {
    listed.push(e.path)
    return {
      value:
        e.path === DOCS_PLANS ? [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }] : [],
    }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: WORK, surface: 'terminal', isInteractive: true })
  expect(listed).toContain(DOCS_PLANS)

  // A new conversation is told the folder, and so is a skill when it is run.
  const told = await $.classic.SessionStart({ source: 'startup' })
  expect((told.additionalContext ?? []).join('\n')).toContain(`Open project plans in ${DOCS_PLANS}/ `)
  const ran = await $.classic.UserPromptSubmit({ prompt: '/phase docs-site' })
  expect((ran.additionalContext ?? []).join('\n')).toContain(`plans folder is ${DOCS_PLANS}/`)
  expect(ran.sessionTitle).toBe('docs-site · phase 2')

  // The reminder about a stale plan names the file where it is.
  const done = { stop_hook_active: false, last_assistant_message: 'Phase 2 is done.' }
  expect((await $.classic.Stop(done)).block).toContain(`${DOCS_PLANS}/docs-site.md`)

  // The pane says which folder it reads.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /In platform-docs\/plans\/ \(\/plans-dir\)/ })).toBeDefined()
  await ui.unmount()

  // In a worktree of one of the repositories the same folder is found from above.
  here = `${WORK}/api/.claude/worktrees/x`
  listed.length = 0
  const again = await $.classic.SessionStart({ source: 'clear' })
  expect((again.additionalContext ?? []).join('\n')).toContain(`Open project plans in ${DOCS_PLANS}/ `)
  expect(listed).toContain(DOCS_PLANS)
})

test('the plansDir option names the folder to look for', { options: { plansDir: 'plans/' } }, async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const listed: string[] = []
  on('session.cwd', () => ({ value: `${WORK}/api` }))
  on('session.root', () => ({ value: `${WORK}/api` }))
  on('fs.exists', (_, e) => ({ value: e.path === `${WORK}/plans` }))
  on('fs.read', () => ({ value: PLAN.replace('status: active', 'status: done') }))
  on('fs.list', (_, e) => {
    listed.push(e.path)
    return { value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }] }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ cwd: `${WORK}/api`, surface: 'terminal', isInteractive: true })
  expect(listed).toEqual([`${WORK}/plans`])

  // With no plan open, a new conversation is still told a folder that is not the usual one.
  const told = await $.classic.SessionStart({ source: 'startup' })
  expect((told.additionalContext ?? []).join('\n')).toBe(
    `waypoint: this project's plans folder is ${WORK}/plans/. Plans are read from there and new ones are written there.`,
  )
})

test('an option that is one fixed folder is used wherever the session is', { options: { plansDir: '/shared/plans' } }, async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const listed: string[] = []
  on('session.cwd', () => ({ value: `${WORK}/api` }))
  on('session.root', () => ({ value: `${WORK}/api` }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: PLAN }))
  on('fs.list', (_, e) => {
    listed.push(e.path)
    return { value: [] }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: `${WORK}/api`, surface: 'terminal', isInteractive: true })
  expect(listed).toEqual(['/shared/plans'])
})

test('/plans-dir says where the plans folder is, sets it for the workspace and takes that back', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const files = new Map<string, string>()
  on('session.cwd', () => ({ value: WORK }))
  on('session.root', () => ({ value: WORK }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('no such file')
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    if (e.path !== DOCS_PLANS) throw new Error('no such folder')
    return { value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }] }
  })
  files.set(`${DOCS_PLANS}/docs-site.md`, PLAN)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: WORK, surface: 'terminal', isInteractive: true })

  // Nothing set and nothing found: the place a first plan would go, and no plans.
  const before = (await $.command.run(typed('plans-dir'))).text ?? ''
  expect(before).toContain(`Plans folder: ${WORK}/docs/plans/ (no plans folder found yet`)
  expect(before).toContain('It is not there yet')
  expect((await $.command.run(typed('plans-dir', 'reset'))).text).toContain('No workspace setting to take back.')

  // Set: written to the folder the session started in, and read from there at once.
  const set = (await $.command.run(typed('plans-dir', 'platform-docs/plans'))).text ?? ''
  expect(JSON.parse(files.get(CONFIG) ?? '{}')).toEqual({ plansDir: 'platform-docs/plans' })
  expect(set).toContain(`Written to ${CONFIG}. Plans folder: ${DOCS_PLANS}/ (set in ${CONFIG}). 1 plan in it.`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /docs-site/ })).toBeDefined()
  await ui.unmount()

  // Taken back: the entry leaves the file, and the plans that were on show go with it.
  const reset = (await $.command.run(typed('plans-dir', 'reset'))).text ?? ''
  expect(JSON.parse(files.get(CONFIG) ?? 'null')).toEqual({})
  expect(reset).toContain(`Taken out of ${CONFIG}. Plans folder: ${WORK}/docs/plans/`)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /No plans in docs\/plans\/ yet/ })).toBeDefined()
  await after.unmount()
})

test('a command name that is already taken costs that command only: the pane still comes up', async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const opened: string[] = []
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN }))
  on('command.register', (_, e) => {
    if (e.name === 'plans') throw new Error('"/plans" refused: another plugin registered it already')
    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(opened).toEqual(['plans'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /docs-site/ })).toBeDefined()
  await ui.unmount()
})

const STOPPED = "waypoint: another hook stopped waypoint's session hooks; plans folder notes and session titles are off"

/**
 * A session as a plugin install has it (the skills came with the mod), started in a folder whose plans folder is
 * set and empty: what a person sees when a plan went somewhere else. Toasts and every command run are noted.
 */
const stoppedSession = async (
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  messages: SessionMessage[] = [],
) => {
  const clock = mock.clock(on, { now: 100_000 })
  const toasts: string[] = []
  const ran: string[] = []
  on('session.cwd', () => ({ value: WORK }))
  on('session.root', () => ({ value: WORK }))
  on('session.messages', () => ({ value: messages }))
  on('fs.exists', (_, e) => ({ value: e.path === CONFIG || e.path.endsWith('/skills/phase/SKILL.md') }))
  on('fs.read', (_, e) => ({ value: e.path === CONFIG ? '{ "plansDir": "platform-docs/plans" }' : PLAN }))
  on('fs.list', () => ({ value: [] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'test-session' }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('command.run', (_, e) => {
    ran.push(`/${e.command} ${e.args}`.trim())
    return {}
  })
  await $.session.start({ cwd: WORK, surface: 'terminal', isInteractive: true })
  const wait = async (ms: number) => {
    await clock.advance(ms)
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }
  const paneText = async (text: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found?.text
  }
  return { toasts, ran, wait, paneText }
}

test("a hook ahead of the mod's that stops its session hooks is said: a toast, and the pane with the plans folder", async ($, on) => {
  const { toasts, wait, paneText } = await stoppedSession($, on)

  // Nothing yet: the conversation's SessionStart is given a few seconds to reach the mod.
  await wait(7_000)
  expect(toasts).toEqual([])
  expect(await paneText(/Another hook stopped/)).toBeUndefined()

  // It never came. The person is told once, and the pane, empty as it is, says where the plans folder is.
  await wait(2_000)
  expect(toasts).toEqual([STOPPED])
  expect(await paneText(/Another hook stopped waypoint's session hooks/)).toBeDefined()
  expect(await paneText(/^Plans folder:/)).toBe(`Plans folder: ${DOCS_PLANS}/`)
  expect(await paneText(/No plans in platform-docs\/plans\/ yet/)).toBeDefined()
  expect((await $.command.run(typed('plans-dir'))).text).toContain("Another hook is stopping waypoint's session hooks")

  // A skill typed now gets no prompt hook either: still one toast, not two.
  await $.command.run(typed('wp:plan', 'docs-site'))
  await wait(4_000)
  expect(toasts).toEqual([STOPPED])

  // Once a SessionStart does reach the mod (the hook ahead was taken away, a new conversation), the warning goes.
  await $.classic.SessionStart({ source: 'clear' })
  await $.classic.UserPromptSubmit({ prompt: '/wp:plan docs-site' })
  expect(await paneText(/Another hook stopped/)).toBeUndefined()
  expect((await $.command.run(typed('plans-dir'))).text).not.toContain('Another hook')
})

test('with no hook in the way, nothing is said: the two events may come in either order', async ($, on) => {
  const { toasts, ran, wait, paneText } = await stoppedSession($, on)
  await $.classic.SessionStart({ source: 'startup' })
  await wait(20_000)

  // The person types a skill, and its prompt hook runs just before or just after the command does.
  await $.classic.UserPromptSubmit({ prompt: '/wp:plan docs-site' })
  await $.command.run(typed('wp:plan', 'docs-site'))
  await wait(4_000)
  await $.command.run(typed('wp:phase', 'docs-site'))
  await wait(1_000)
  await $.classic.UserPromptSubmit({ prompt: '/wp:phase docs-site' })
  await wait(4_000)

  // A /clear: the cleared conversation's SessionStart follows, and is waited for the same way.
  await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
  await wait(1_000)
  await $.classic.SessionStart({ source: 'clear' })
  await wait(20_000)

  expect(toasts).toEqual([])
  expect(await paneText(/Another hook stopped/)).toBeUndefined()
  // Every command went on to the engine as typed.
  expect(ran).toEqual(['/wp:plan docs-site', '/wp:phase docs-site'])
})

test("a typed skill whose prompt hook never ran is noticed; Claude Code's own /plan and the mod's own runs are not skills typed", async ($, on) => {
  const { toasts, ran, wait, paneText } = await stoppedSession($, on)
  await $.classic.SessionStart({ source: 'startup' })

  // Claude Code's /plan is not the mod's skill here: nothing is waited for, and its prompt titles nothing.
  await $.command.run(typed('plan', 'docs-site'))
  expect((await $.classic.UserPromptSubmit({ prompt: '/plan docs-site' })).sessionTitle).toBe(undefined)
  // A skill the mod runs itself (a button, /next-phase) has no prompt of the person's behind it.
  await $.command.run({ ...typed('wp:questions', 'docs-site'), origin: { kind: 'plugin', name: 'wp' } })
  await wait(10_000)
  expect(toasts).toEqual([])

  // The person types the plan skill and no prompt hook follows.
  await $.command.run(typed('wp:plan', 'docs-site'))
  await wait(2_000)
  expect(toasts).toEqual([])
  await wait(2_000)
  expect(toasts).toEqual([STOPPED])
  expect(await paneText(/^Plans folder:/)).toBe(`Plans folder: ${DOCS_PLANS}/`)
  expect(ran).toEqual(['/plan docs-site', '/wp:questions docs-site', '/wp:plan docs-site'])
})

test("a plans folder written with ~ is found where the environment cannot be read, from where the session sits", { options: { plansDir: '~/git/acme/platform-docs/plans' } }, async ($, on) => {
  mock.clock(on, { now: 10_000 })
  const listed: string[] = []
  // The home folder is worked out from paths under it, where no HOME can be had.
  expect(homeFrom(['/home/u/git/acme/api'])).toBe('/home/u')
  expect(homeFrom(['/srv/build', 'C:\\Users\\u\\work'])).toBe('C:/Users/u')
  expect(homeFrom(['/srv/build', '/data/people/u/.claude/plugins/cache/x/wp'])).toBe('/data/people/u')
  expect(homeFrom(['/srv/build'])).toBe('')

  on('env.get', () => {
    throw new Error('refused: a mod in the user tier does not read the environment here')
  })
  on('session.cwd', () => ({ value: '/Users/u/git/acme/api' }))
  on('session.root', () => ({ value: '/Users/u/git/acme/api' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: PLAN }))
  on('fs.list', (_, e) => {
    listed.push(e.path)
    return { value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }] }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/Users/u/git/acme/api', surface: 'terminal', isInteractive: true })
  expect(listed).toEqual(['/Users/u/git/acme/platform-docs/plans'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /docs-site/ })).toBeDefined()
  await ui.unmount()
})

test('a plans folder that cannot be read says so in the pane and in /plans-dir, and stops saying so once it can', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  let isRefused = true
  on('session.cwd', () => ({ value: WORK }))
  on('session.root', () => ({ value: WORK }))
  on('fs.exists', (_, e) => ({ value: e.path === `${WORK}/docs/plans` }))
  on('fs.read', () => ({ value: PLAN }))
  on('fs.list', () => {
    if (isRefused) throw new Error('EACCES: permission denied')
    return { value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }] }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const shown = async (text: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return found?.text
  }

  await $.session.start({ cwd: WORK, surface: 'terminal', isInteractive: true })
  // (The test kit puts its own words in place of a test hook's error; a session gives the refusal's.)
  expect(await shown(/^The plans folder/)).toContain(`${WORK}/docs/plans/ is there and could not be read: `)
  const said = (await $.command.run(typed('plans-dir'))).text ?? ''
  expect(said).toContain(`The plans folder is there and could not be read: `)
  // The same answer counts the events that have reached the mod: here the session's start and nothing else yet.
  expect(said).toContain('Reached the mod since it loaded: session start 1, conversation start 0, prompts 0, tool calls 0, stops 0, refresh ticks 0.')

  // The next tick reads it: the plan is listed and the complaint is gone.
  isRefused = false
  await clock.advance(5_000)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  expect(await shown(/docs-site/)).toBeDefined()
  expect(await shown(/^The plans folder/)).toBeUndefined()
  expect((await $.command.run(typed('plans-dir'))).text).toContain('refresh ticks 1.')
})

test("a typed skill's plan becomes the session's in the pane, with no prompt hook to say so", async ($, on) => {
  mock.clock(on, { now: 10_000 })
  on('fs.list', () => ({
    value: [{ name: 'docs-site.md', kind: 'file', size: PLAN.length, mtimeMs: 5_000, isLink: false }],
  }))
  on('fs.read', () => ({ value: PLAN.replace('status: active', 'status: paused') }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/skills/phase/SKILL.md') }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  const phases = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text: /2\. Search/ })
    await ui.unmount()
    return found
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // A paused plan that is nobody's has no phases listed.
  expect(await phases()).toBeUndefined()
  await $.command.run(typed('wp:phase', 'docs-site 2'))
  expect(await phases()).toBeDefined()
})

test('a conversation already under way when the mod loads is not waited on for a SessionStart', async ($, on) => {
  const { toasts, wait } = await stoppedSession($, on, [{ role: 'user', text: 'hello', toolUses: [] }])
  await wait(30_000)
  expect(toasts).toEqual([])
})

const BAND = {
  plugin: 'wp',
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
