import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan } from '../types'
import {
  CONFIG_FILE,
  NOT_PLANS,
  PLAN_DIR,
  configuredDir,
  contextText,
  folderText,
  homeFrom,
  isAbsolute,
  isOpen,
  ordered,
  parsePlan,
  planNameOf,
  resolvePath,
  saysPhaseDone,
  statusText,
  tailOf,
  timeLeft,
} from './plans'

const PLUGIN = 'wp'
const PANE = 'plans'
/** The mod's own command: `/next-phase [plan]` clears the context and runs the phase skill. */
const FRESH = 'next-phase'
/** The mod's own command: `/plans-dir [path]` says where the plans folder is, or sets it for the workspace. */
const WHERE = 'plans-dir'
const REFRESH_MS = 5000
/** How long a plans folder that was found is taken as still the one, before it is looked for again. */
const LOOK_AGAIN_MS = 30_000
/** The skills that bind a session to a plan when the person runs them. */
const SKILL_PROMPT = /^\s*\/([\w:-]+)\s*([\w.-]+)?(?:\s+(\d+))?/
/**
 * How long a new conversation's `classic.SessionStart`, and a typed skill's
 * `classic.UserPromptSubmit`, may take to reach the mod before it is taken
 * that a hook ahead of the mod's sent the event on without them.
 */
const START_WAIT_MS = 8000
const PROMPT_WAIT_MS = 3000
/** What the person is told then, once. */
const HOOKS_STOPPED = "waypoint: another hook stopped waypoint's session hooks; plans folder notes and session titles are off"

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const plansAtom = atom({ plugin: 'wp', key: 'plans' } as const, [], { shape: 'plans-2' })
const currentAtom = atom({ plugin: 'wp', key: 'current' } as const, null, { shape: 'current-1' })
const hiddenAtom = atom({ plugin: 'wp', key: 'isHidden' } as const, false)
// The mod's `classic.*` hooks tell Claude the plans folder and title the session. A hook that runs ahead of them
// (a built-in's, an organization's) can send those events on without the mod's hooks, and then nothing else says so.
/** When a conversation's `classic.SessionStart` last reached the mod, by the session's clock; 0 for never. */
const startSeenAtom = atom({ plugin: 'wp', key: 'sessionStartAt' } as const, 0)
/** It did not, in the time it is given. */
const startStoppedAtom = atom({ plugin: 'wp', key: 'isStartStopped' } as const, false)
/** A skill was typed and its `classic.UserPromptSubmit` did not reach the mod. */
const promptStoppedAtom = atom({ plugin: 'wp', key: 'isPromptStopped' } as const, false)
/** What is wrong with reading the plans folder, for the pane to say; null when nothing is. */
const readErrorAtom = atom({ plugin: 'wp', key: 'readError' } as const, null, { shape: 'readError-1' })
/** `$.store`: whether the pane was put away, kept from one session to the next. */
const HIDDEN_KEY = 'isPaneHidden'

type Engine = EngineInterface

// The module's own variables start over when the mod reloads.
/** Parsed plans by file name, kept while the file's mtime holds. */
const cache = new Map<string, Plan>()
let sessionStartedAt = 0
let lastCodeEditAt = 0
let remindedFor = -1
let timer: { cancel: () => void } | undefined  // the refresh tick, replaced on reload
/**
 * The plans folder and what named it: a workspace's config file (`file`), the
 * mod's `plansDir` option where that is one fixed folder (`option`), a folder
 * of the option's name found at or above the session's (`found`), or nothing
 * yet, so the place a first plan would go (`unset`).
 */
type Place = { dir: string; from: 'file' | 'option' | 'found' | 'unset'; file?: string }
let place: Place | undefined
/** The directories the folder was last looked for from, and when. */
let lookedFrom = ''
let lookedAt = 0
/** The folder the plans on show were listed from. */
let listedDir = ''
/** The `plansDir` option: the folder's name where no workspace says otherwise. Set when the mod loads. */
let defaultDir = PLAN_DIR
let knownHome: string | undefined
/** Plan files whose last read failed. */
const unread = new Set<string>()
/**
 * How many times each kind of event has reached the mod since it loaded. `/plans-dir` prints them: on a machine
 * where a hook ahead of the mod's sends events past it, this says which ones.
 */
const reached = { sessionStart: 0, conversationStart: 0, prompt: 0, toolCall: 0, stop: 0, tick: 0 }
/** Config files already complained about, so each is named once. */
const badConfigs = new Set<string>()
/**
 * What the person types to run the skills that come with the mod. Installed as
 * a plugin they are `wp:phase`, `wp:plan` and
 * `wp:questions`; copied into a skills folder they are plain `phase`,
 * `plan` and `questions`.
 */
const skill = { phase: 'phase', plan: 'plan', questions: 'questions', handoff: 'handoff' }
const SKILLS = ['phase', 'plan', 'questions', 'handoff'] as const
/** When a typed skill's `classic.UserPromptSubmit` last reached the mod. */
let lastSkillPromptAt = -Infinity

/**
 * Which of the mod's skills a command name is, under the name this install
 * gives it. Where the skills go by `wp:plan`, a plain `plan` is not one of
 * them: it is Claude Code's own command for its plan mode.
 */
function skillOf(command: string): (typeof SKILLS)[number] | undefined {
  return SKILLS.find(key => skill[key] === command)
}

/** Whether a hook ahead of the mod's has been found to stop its session hooks. */
async function areHooksStopped($: Engine): Promise<boolean> {
  try {
    return (await read($, startStoppedAtom)) || (await read($, promptStoppedAtom))
  } catch {
    return false
  }
}

/** Notes that one of the two events did not reach the mod, and tells the person the first time. */
async function hooksStopped($: Engine, which: 'start' | 'prompt'): Promise<void> {
  try {
    const wasKnown = await areHooksStopped($)
    if (which === 'start') await update($, startStoppedAtom, () => true)
    else await update($, promptStoppedAtom, () => true)
    if (!wasKnown) void $.ui.toast(HOOKS_STOPPED)
  } catch {
    // Saying so must never get in the way of the session.
  }
}

/**
 * Waits for a conversation's `classic.SessionStart` to reach the mod.
 * `session.start`, and the `session.end` of a `/clear`, run whether or not
 * the `classic.*` hooks do, so they are the places to wait from. The two
 * events come in either order, so one that arrived a little before `since`
 * counts as this conversation's.
 */
function awaitSessionStart($: Engine, since: number): void {
  try {
    $.clock.after(START_WAIT_MS, () => {
      void (async () => {
        try {
          if ((await read($, startSeenAtom)) < since - START_WAIT_MS) await hooksStopped($, 'start')
        } catch {
          // Asked again at the next conversation.
        }
      })()
    })
  } catch {
    // Without a clock there is still the check when a skill is typed.
  }
}

/** Notes that one of the two events reached the mod after all, and takes its warning back. */
async function hookReached($: Engine, which: 'start' | 'prompt'): Promise<void> {
  try {
    const now = await $.clock.now()
    if (which === 'start') {
      await update($, startSeenAtom, () => now)
      if (await read($, startStoppedAtom)) await update($, startStoppedAtom, () => false)
    } else {
      lastSkillPromptAt = now
      if (await read($, promptStoppedAtom)) await update($, promptStoppedAtom, () => false)
    }
  } catch {
    // Keeping count must never get in the way of the event.
  }
}
/** Whether the skills came in the mod's own folder, once that has been looked at. */
let isBundled: boolean | undefined

/**
 * Sets the skills' names. The mod's own folder says how they came (it holds
 * them when the mod was installed as a plugin), and the session's commands,
 * where they can be listed, say which names are there: the mod's own first,
 * then a plain one. The list cannot be had while a session is still starting.
 */
async function findSkills($: Engine): Promise<void> {
  if (isBundled === undefined) {
    try {
      isBundled = await $.fs.exists(`${$.plugin.root}/skills/phase/SKILL.md`)
    } catch {
      // Asked again the next time.
    }
  }
  let names: string[] = []
  try {
    names = (await $.command.list()).map(c => c.name)
  } catch {
    // Not to be had yet: the folder's answer stands.
  }
  for (const key of SKILLS) {
    const own = `${PLUGIN}:${key}`
    skill[key] = [own, key].find(name => names.includes(name)) ?? (isBundled ? own : key)
  }
}

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    return (await $.fs.exists(path)) === true
  } catch {
    return false // A place that cannot be looked at has nothing in it.
  }
}

/** The folder a config file names, as written in it, or `null`: no such file, or it names none. */
async function configAt($: Engine, file: string): Promise<string | null> {
  if (!(await exists($, file))) return null
  try {
    return configuredDir(await $.fs.read(file))
  } catch {
    if (!badConfigs.has(file)) {
      badConfigs.add(file)
      void $.ui.toast(`waypoint: ${file} is not read: it should hold {"plansDir": "<path>"}`)
    }
    return null
  }
}

/**
 * Where the plans are. First what a workspace says: from the session's
 * directory upward, the nearest `.claude/waypoint.json` that names a plans
 * folder. A folder of several repositories that sessions start from says it
 * once, and it holds in every repository below and in their worktrees, also
 * where one of them has a `docs/plans` of its own. With no such file: the
 * option where it is one fixed folder, else the nearest folder of the option's
 * name (`docs/plans` unless set) at or above the session's directory, so a
 * phase working in a worktree (`<repo>/.claude/worktrees/<name>`) still finds
 * the plans above it. The folder last found is kept when a later place has none.
 */
/**
 * The person's home folder, for a plans folder written with `~`: from the
 * environment, and where that cannot be read (a security mod may keep it from
 * a person's own mods) from where the session and the mod's own files sit.
 * Kept once known, asked again while it is not.
 */
async function homeDir($: Engine, starts: readonly string[]): Promise<string> {
  if (knownHome) return knownHome
  let found = ''
  try {
    found = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  } catch {
    found = ''
  }
  if (!found) {
    let root = ''
    try {
      root = $.plugin.root
    } catch {
      root = ''
    }
    found = homeFrom([...starts, root])
  }
  if (found) knownHome = found
  return found
}

/** Says what is wrong with reading the plans folder, or that nothing is; written only when that changes. */
async function setReadError($: Engine, said: string | null): Promise<void> {
  try {
    if ((await read($, readErrorAtom)) !== said) await update($, readErrorAtom, () => said)
  } catch {
    // Saying so must never get in the way of the read.
  }
}

async function findPlace($: Engine, isForced = false): Promise<Place> {
  let starts: string[]
  try {
    starts = [await $.session.cwd(), await $.session.root()]
  } catch {
    return place ?? { dir: defaultDir, from: 'unset' }
  }
  const key = [...starts, defaultDir].join('\n')
  let now = 0
  try {
    now = await $.clock.now()
  } catch {
    now = 0
  }
  const isFresh = place && place.from !== 'unset' && key === lookedFrom && now - lookedAt < LOOK_AGAIN_MS
  if (place && isFresh && !isForced) return place
  lookedFrom = key
  lookedAt = now
  const home = await homeDir($, starts)
  /** The session's directories and the folders above each, nearest first. */
  const above: string[] = []
  for (const start of starts) {
    let dir = start.replace(/[\\/]+$/, '')
    for (let up = 0; up < 16 && dir; up++) {
      if (!above.includes(dir)) above.push(dir)
      const parent = dir.replace(/[\\/][^\\/]*$/, '')
      if (parent === dir) break
      dir = parent
    }
  }
  for (const dir of above) {
    const file = `${dir}/${CONFIG_FILE}`
    const said = await configAt($, file)
    if (said) return (place = { dir: resolvePath(dir, said, home), from: 'file', file })
  }
  if (isAbsolute(defaultDir)) return (place = { dir: resolvePath('', defaultDir, home), from: 'option' })
  for (const dir of above) {
    if (await exists($, `${dir}/${defaultDir}`)) return (place = { dir: `${dir}/${defaultDir}`, from: 'found' })
  }
  if (place && place.from !== 'unset' && !isForced) return place
  return (place = { dir: resolvePath(starts[0]!, defaultDir, home), from: 'unset' })
}

async function refresh($: Engine): Promise<Plan[]> {
  const { dir } = await findPlace($)
  let entries: { name: string; kind: string; mtimeMs: number }[] = []
  try {
    entries = await $.fs.list(dir)
  } catch (err) {
    // The folder is not there. Where it is the one the plans on show came from (the session has moved), they
    // stay on show; where it is another (the workspace now names a folder not made yet), there are none.
    if (listedDir && dir !== listedDir) {
      listedDir = dir
      cache.clear()
      await update($, plansAtom, () => [])
    }
    // A folder not made yet is no fault. One that is there and cannot be read is, and so is one whose `~`
    // could not be made into a path: the pane says which, where it would otherwise only stay empty.
    const why = err instanceof Error ? err.message : String(err)
    const said = dir.startsWith('~')
      ? 'starts with ~, and your home folder could not be worked out here: give the folder in full'
      : (await exists($, dir))
        ? `is there and could not be read: ${why}`
        : null
    await setReadError($, said)
    await showStatus($)
    return read($, plansAtom)
  }
  const hasMoved = dir !== listedDir
  if (hasMoved) {
    listedDir = dir
    cache.clear()
  }
  const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.md') && !NOT_PLANS.has(f.name))
  let changed = hasMoved || files.length !== cache.size || files.some(f => !cache.has(f.name))
  const plans: Plan[] = []
  let stuck = ''
  for (const file of files) {
    const known = cache.get(file.name)
    if (known && known.mtimeMs === file.mtimeMs) {
      plans.push(known)
      continue
    }
    try {
      const text = await $.fs.read(`${dir}/${file.name}`)
      const plan = parsePlan(file.name.slice(0, -3), text, file.mtimeMs)
      cache.set(file.name, plan)
      plans.push(plan)
      changed = true
      unread.delete(file.name)
    } catch (err) {
      // A file being rewritten right now is read on the next tick. One that fails twice running is not that.
      if (unread.has(file.name)) stuck ||= `${file.name}: ${err instanceof Error ? err.message : String(err)}`
      unread.add(file.name)
    }
  }
  for (const name of [...cache.keys()]) if (!files.some(f => f.name === name)) cache.delete(name)
  await setReadError($, stuck ? `holds a plan that could not be read (${stuck})` : null)
  if (changed) await update($, plansAtom, () => plans)
  await showStatus($)
  return changed ? plans : await read($, plansAtom)
}

async function showStatus($: Engine): Promise<void> {
  const current = await read($, currentAtom)
  const plan = current ? (await read($, plansAtom)).find(p => p.name === current) : undefined
  $.ui.status(plan ? statusText(plan) : undefined)
}

async function follow($: Engine, name: string): Promise<void> {
  if ((await read($, currentAtom)) === name) return
  await update($, currentAtom, () => name)
  await showStatus($)
}

/**
 * Puts the pane away, or brings it back. A docked pane sits beside the
 * transcript, and a selection dragged over several lines takes the pane's text
 * with it; put away, a line above the prompt stands in for it, with a button
 * to bring it back. The choice is kept across sessions.
 */
async function setHidden($: Engine, hidden: boolean): Promise<void> {
  await update($, hiddenAtom, () => hidden)
  void $.store.set(HIDDEN_KEY, hidden).catch(() => undefined)
  if (hidden) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: 'Plans' })
}

/**
 * Clears the conversation and runs the plan's next phase, as if the person had
 * typed `/clear` and then the phase skill with the plan's name. A skill cannot
 * clear the context it runs in; a mod can run the command for it. Each of the
 * two is queued and runs once the session is idle, so a press while Claude is
 * working waits for the turn to end.
 */
async function startFresh($: Engine, name: string): Promise<void> {
  await findSkills($)
  try {
    await $.command.run({ command: 'clear' })
    await follow($, name) // the /clear made the session forget its plan
    await $.command.run({ command: skill.phase, args: name })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    void $.ui.toast(`waypoint: /${skill.phase} ${name} was not started in a fresh context: ${why}`)
  }
}

/**
 * Runs the questions skill for a plan, as if the person had typed it: Claude
 * asks the plan's open questions one after another and writes the answers
 * into the plan. The conversation is kept. The command is queued and runs
 * once the session is idle.
 */
async function askQuestions($: Engine, name: string): Promise<void> {
  await findSkills($)
  try {
    await follow($, name)
    await $.command.run({ command: skill.questions, args: name })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    void $.ui.toast(`waypoint: /${skill.questions} ${name} was not started: ${why}`)
  }
}

/** What `/plans-dir` answers: the folder, what named it, and how to change that. */
function whereText(found: Place, count: number | null): string {
  const why =
    found.from === 'file'
      ? `set in ${found.file}`
      : found.from === 'option'
        ? "the mod's plansDir option"
        : found.from === 'found'
          ? `the nearest ${defaultDir}/ at or above the session's folder`
          : `no plans folder found yet: this is where a first plan would go`
  const holds = count === null ? 'It is not there yet: the first plan written makes it.' : `${count} plan${count === 1 ? '' : 's'} in it.`
  return (
    `Plans folder: ${found.dir}/ (${why}). ${holds}\n` +
    `/${WHERE} <path> sets it for this workspace (a path relative to the workspace's folder, or absolute); /${WHERE} reset takes that back.`
  )
}

/** How many plans the folder holds, or `null` when it is not there. */
async function countPlans($: Engine, dir: string): Promise<number | null> {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter(f => f.kind === 'file' && f.name.endsWith('.md') && !NOT_PLANS.has(f.name)).length
  } catch {
    return null
  }
}

export const register: Register = (on, options) => {
  // The option is the folder's name where no workspace says otherwise; a change to it loads the mod again.
  const wanted = typeof options?.plansDir === 'string' ? options.plansDir.trim().replace(/[\\/]+$/, '') : ''
  defaultDir = wanted || PLAN_DIR

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    reached.sessionStart++
    sessionStartedAt = await $.clock.now()
    // Each command is registered on its own: a name someone else's mod already holds costs that command only,
    // and the pane, its buttons and the rest still come up.
    try {
      await $.command.register({ name: 'plans', description: 'Show or hide the pane of project plans' })
    } catch {
      // Without the command the pane still opens by itself where there are open plans.
    }
    try {
      await $.command.register({
        name: WHERE,
        description: 'Say where the plans folder is, or set it for this workspace',
        argumentHint: '[path | reset]',
      })
    } catch {
      // Without the command the config file can still be written by hand.
    }
    let hidden = false
    try {
      hidden = (await $.store.get(HIDDEN_KEY)) === true
      await update($, hiddenAtom, () => hidden)
    } catch {
      hidden = false
    }
    try {
      await $.command.register({
        name: FRESH,
        description: 'Clear the context, then run the next phase of a plan (/clear and /phase in one)',
        argumentHint: '[plan]',
      })
    } catch {
      // Without the command there is still the pane's button.
    }
    await findSkills($)
    const plans = await refresh($)
    timer?.cancel()
    try {
      timer = $.clock.every(REFRESH_MS, () => {
        reached.tick++
        void refresh($).catch(() => undefined)
      })
    } catch {
      timer = undefined
    }
    if (e.isInteractive && plans.some(isOpen) && !hidden) void $.ui.open({ id: PANE, title: 'Plans' })
    // A conversation already under way (the mod was installed or loaded again in it, or it was resumed) has had
    // its SessionStart: only a new one is waited for.
    let isNew = true
    try {
      const said = await $.session.messages({ last: 1 })
      isNew = !(Array.isArray(said) && said.length > 0)
    } catch {
      isNew = true
    }
    if (isNew) awaitSessionStart($, sessionStartedAt)
    return started
  })

  // The person's own close mark or key puts the pane away like the hide button does.
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    try {
      if (e.id === PANE && e.origin.kind === 'person') {
        await update($, hiddenAtom, () => true)
        void $.store.set(HIDDEN_KEY, true).catch(() => undefined)
      }
    } catch {
      // Remembering the choice must never get in the way of the close.
    }
    return closed
  })

  // A /clear ends the conversation without a new session.start: forget its plan.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      await update($, currentAtom, () => null)
      sessionStartedAt = await $.clock.now()
      lastCodeEditAt = 0
      $.ui.status(undefined)
      awaitSessionStart($, sessionStartedAt) // the cleared conversation's SessionStart
    }
    return ended
  })

  // `/plans` puts the pane away when it is up and brings it back when it is not.
  on('command.run', { command: 'plans' }, async $ => {
    const plans = await refresh($)
    let isUp = false
    try {
      isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    } catch {
      isUp = false
    }
    if (isUp) {
      await setHidden($, true)
      return { text: 'Plans pane put away. /plans brings it back, and so does "show" on the line above the prompt.' }
    }
    await update($, hiddenAtom, () => false)
    void $.store.set(HIDDEN_KEY, false).catch(() => undefined)
    // Without `focus`: the keyboard stays in the prompt, where the person is typing.
    await $.ui.open({ id: PANE, title: 'Plans' })
    const open = plans.filter(isOpen)
    return {
      text: open.length
        ? `Plans pane opened: ${open.map(p => p.name).join(', ')}.`
        : `Plans pane opened. No open plans yet: start one with /${skill.plan} <name>.`,
    }
  })

  // `/plans-dir`: where the plans folder is and what named it. With a path, the workspace's config file is
  // written: the one already in force, else a new one in the session's folder. `reset` takes the entry out.
  on('command.run', { command: WHERE }, async ($, e) => {
    const asked = (e.args ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
    let file: string | undefined
    if (asked) {
      const before = await findPlace($, true)
      file = before.from === 'file' ? before.file : undefined
      if (!file && asked === 'reset') {
        return { text: `No workspace setting to take back.\n${whereText(before, await countPlans($, before.dir))}` }
      }
      try {
        file ??= `${(await $.session.root()).replace(/[\\/]+$/, '')}/${CONFIG_FILE}`
        let config: Record<string, unknown> = {}
        try {
          const old: unknown = JSON.parse(await $.fs.read(file))
          if (old && typeof old === 'object' && !Array.isArray(old)) config = { ...(old as Record<string, unknown>) }
        } catch {
          config = {} // No file yet, or one that could not be read: it is written anew.
        }
        if (asked === 'reset') delete config.plansDir
        else config.plansDir = asked
        await $.fs.write(file, `${JSON.stringify(config, null, 2)}\n`)
        badConfigs.delete(file)
      } catch (err) {
        return { text: `The plans folder was not set: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    const found = await findPlace($, true)
    await refresh($)
    const wrote = asked ? `${asked === 'reset' ? 'Taken out of' : 'Written to'} ${file}. ` : ''
    const warning = (await areHooksStopped($))
      ? `\nAnother hook is stopping waypoint's session hooks, so Claude is not told this folder: say it when you run a skill.`
      : ''
    let unreadable = ''
    try {
      const said = await read($, readErrorAtom)
      unreadable = said ? `\nThe plans folder ${said}.` : ''
    } catch {
      unreadable = ''
    }
    // Which events have reached the mod: where a hook ahead of it sends some past it, these are the facts to
    // work from. A zero beside prompts that were typed, or tool calls that were made, is an event stopped.
    const events =
      `\nReached the mod since it loaded: session start ${reached.sessionStart}, conversation start ${reached.conversationStart}, ` +
      `prompts ${reached.prompt}, tool calls ${reached.toolCall}, stops ${reached.stop}, refresh ticks ${reached.tick}.`
    return { text: wrote + whereText(found, await countPlans($, found.dir)) + unreadable + warning + events }
  })

  // A skill of the mod's typed by the person: its `classic.UserPromptSubmit` should reach the mod as well. Where
  // it does not, a hook ahead of the mod's is sending that event on without it. Every command passes through
  // here untouched, and a run the mod started itself has no prompt to wait for.
  on('command.run', async ($, e, next) => {
    try {
      if (e.origin.kind === 'composer' && skillOf(e.command)) {
        const typedAt = await $.clock.now()
        $.clock.after(PROMPT_WAIT_MS, () => {
          if (lastSkillPromptAt < typedAt - PROMPT_WAIT_MS) void hooksStopped($, 'prompt')
        })
        // The pane follows the plan the person named, whether or not the prompt's own hook gets to say so.
        const name = /^[\w.-]+/.exec((e.args ?? '').trim())?.[0]
        if (name) await follow($, name)
      }
    } catch {
      // Keeping watch must never get in the way of a command.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // `/next-phase [plan]`: with no name, the session's own plan, else the only active one.
  on('command.run', { command: FRESH }, async ($, e) => {
    const plans = await refresh($)
    const active = plans.filter(p => p.status === 'active')
    const asked = (e.args ?? '').trim().split(/\s+/)[0]
    const name = asked || (await read($, currentAtom)) || (active.length === 1 ? active[0]!.name : '')
    const plan = plans.find(p => p.name === name)
    if (!plan || !isOpen(plan)) {
      const open = plans.filter(isOpen).map(p => p.name)
      return { text: `Which plan? /${FRESH} <name>${open.length ? `, one of: ${open.join(', ')}` : ''}.` }
    }
    // After this command's own run has ended: the two it queues wait for the session to be idle.
    $.clock.after(0, () => {
      void startFresh($, plan.name)
    })
    await findSkills($)
    return { text: `Clearing the context, then /${skill.phase} ${plan.name}.` }
  })

  // Every new conversation (startup, /clear, resume, compaction) is told
  // which plans are open and which folder they are in, once, so "continue
  // <plan>" is enough. With none open it is told the folder alone, where a
  // workspace or the option has set one: the skills cannot work that out.
  on('classic.SessionStart', async ($, e, next) => {
    reached.conversationStart++
    await hookReached($, 'start')
    const result = await next(e)
    await findSkills($)
    const plans = await refresh($)
    const found = await findPlace($)
    const isSet = found.from === 'file' || found.from === 'option' || defaultDir !== PLAN_DIR
    const text = contextText(plans, skill, found.dir) ?? (isSet ? folderText(found.dir) : null)
    if (!text) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), text] }
  })

  // One of the mod's skills, typed (`/wp:phase <name>`, or `/phase <name>`
  // where the skills go by plain names), binds the session to a plan, and
  // the plan and phase skills title it after the plan and phase. The skill is
  // told the plans folder with it. Claude Code's own `/plan` is none of this.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    reached.prompt++
    const m = SKILL_PROMPT.exec(e.prompt)
    if (m) await findSkills($)
    const kind = m ? skillOf(m[1]!) : undefined
    if (kind) await hookReached($, 'prompt')
    const answered = await next(e)
    if (!m || !kind) return answered
    const plans = await refresh($)
    const found = await findPlace($)
    const result = isAbsolute(found.dir)
      ? { ...answered, additionalContext: [...(answered.additionalContext ?? []), folderText(found.dir)] }
      : answered
    let name = m[2] ?? null
    if (!name) {
      const open = plans.filter(p => p.status === 'active')
      name = open.length === 1 ? open[0]!.name : await read($, currentAtom)
    }
    if (!name) return result
    await follow($, name)
    if (kind === 'handoff' || kind === 'questions') return result
    const plan = plans.find(p => p.name === name)
    const phase = m[3] ? Number(m[3]) : plan?.phase
    const title = kind === 'plan' ? `${name} · planning` : `${name} · phase ${phase ?? '?'}`
    return { ...result, sessionTitle: title }
  })

  // Note code edits, and follow the plan a session writes to.
  on('tool.call', async ($, e, next) => {
    reached.toolCall++
    const ran = await next(e)
    try {
      const path =
        e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : undefined
      if (path && ran.deny === undefined && !ran.isError) {
        const plan = planNameOf(path, place?.dir ?? defaultDir)
        if (plan) {
          if (!(await read($, currentAtom))) await follow($, plan)
          await refresh($)
        } else {
          lastCodeEditAt = await $.clock.now()
        }
      } else if (e.tool === 'Bash' && e.command.includes(`${tailOf(place?.dir ?? defaultDir)}/`)) {
        await refresh($)
      }
    } catch {
      // Tracking must never get in the way of a tool call.
    }
    return ran
  })

  // When Claude says a phase is done but its plan is older than the work,
  // send it back once to update the plan.
  on('classic.Stop', async ($, e, next) => {
    reached.stop++
    const result = await next(e)
    if (e.stop_hook_active || result.block) return result
    const current = await read($, currentAtom)
    if (!current || !saysPhaseDone(e.last_assistant_message ?? '')) return result
    const plan = (await refresh($)).find(p => p.name === current)
    if (!plan) return result
    const work = Math.max(sessionStartedAt, lastCodeEditAt)
    if (plan.mtimeMs >= work || remindedFor === work) return result
    remindedFor = work
    return {
      ...result,
      block:
        `waypoint: you said a phase is done, but ${place?.dir ?? defaultDir}/${current}.md hasn't changed since the work. ` +
        "Update it as the phase skill's step 7 says (the phase heading, Notes, Decisions, Next, Open questions and the header), then finish. " +
        "If the phase isn't finished, just say so and stop.",
    }
  })

  // While the pane is put away, one line above the prompt: the plan in hand, and the way back.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, hiddenAtom))) return next(e)
    const current = await read($, currentAtom)
    const open = ordered(await read($, plansAtom), current).filter(isOpen)
    if (!open.length) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          Plans: {statusText(open[0]!)}
          {open.length > 1 ? ` (+${open.length - 1})` : ''}{' '}
        </Text>
        <Button key="show-plans" label="show" onPress={() => void setHidden($, false)} />
        <Text dimColor> or /plans</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, currentAtom)
    const plans = ordered(await read($, plansAtom), current)
    const open = plans.filter(isOpen)
    const done = plans.filter(p => !isOpen(p))
    // Where a hook ahead of the mod's stops its session hooks, Claude is not told the plans folder: the person is
    // shown it in full, to say it themselves. An empty pane needs this most, since the plan may be elsewhere.
    const warning =
      (await read($, startStoppedAtom)) || (await read($, promptStoppedAtom)) ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="yellow" wrap="wrap">
            Another hook stopped waypoint's session hooks: Claude is not told the plans folder, and sessions are not
            named after their plan.
          </Text>
          <Text wrap="wrap">Plans folder: {place?.dir ?? defaultDir}/</Text>
          <Text dimColor wrap="wrap">Say that folder to Claude when you run a skill.</Text>
        </Box>
      ) : null
    // A folder that cannot be read leaves the pane as it was, or empty: say that it is so, and why.
    const readError = await read($, readErrorAtom)
    const unreadable = readError ? (
      <Box marginBottom={1}>
        <Text color="red" wrap="wrap">
          The plans folder {place?.dir ?? defaultDir}/ {readError}. /{WHERE} says more.
        </Text>
      </Box>
    ) : null

    if (!plans.length) {
      return (
        <Box flexDirection="column">
          {warning}
          {unreadable}
          <Text dimColor wrap="wrap">No plans in {tailOf(place?.dir ?? defaultDir)}/ yet.</Text>
          <Text dimColor>Start one with /{skill.plan} &lt;name&gt;.</Text>
        </Box>
      )
    }

    // No button has a key of its own: a pane that holds the keyboard would take the first letter of whatever the
    // person types next. A press is a click, or ctrl+x tab, Tab and Enter; the commands /plans and /next-phase do
    // the same from the prompt.
    return (
      <Box flexDirection="column">
        {warning}
        {unreadable}
        <Box>
          <Button key="hide-plans" label="hide" onPress={() => void setHidden($, true)} />
          <Text dimColor> or /plans</Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor wrap="wrap">
            No mouse? Type /plans and /next-phase, or ctrl+x tab, Tab, Enter; Esc goes back.
          </Text>
        </Box>
        {open.map(plan => {
          const isCurrent = plan.name === current
          // Its phases are listed for the session's own plan and for every active one: a /clear forgets which
          // plan the session was on, and the list of what is done and what is left should not go with it.
          const isListed = isCurrent || plan.status === 'active'
          const finished = plan.list.filter(p => p.state === 'done').length
          const total = plan.phases ?? plan.list.length
          const bar = total ? '■'.repeat(Math.min(finished, total)) + '□'.repeat(Math.max(0, total - finished)) : ''
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color={isCurrent ? 'green' : undefined} wrap="truncate-end">
                {isCurrent ? '▶ ' : ''}
                {plan.name}
              </Text>
              <Text dimColor wrap="truncate-end">
                {plan.status}
                {plan.phase !== null ? ` · phase ${plan.phase}${total ? `/${total}` : ''}` : ''} {bar}
              </Text>
              {timeLeft(plan) ? (
                <Text wrap="truncate-end">
                  about {timeLeft(plan)} left{plan.spent ? ` · ${plan.spent} spent` : ''}
                </Text>
              ) : null}
              {isListed &&
                plan.list.map(p => (
                  <Text dimColor={p.state === 'not started'} wrap="truncate-end">
                    {p.state === 'done' ? '  ✓ ' : p.state === 'in progress' ? '  ▸ ' : '  · '}
                    {p.n}. {p.name}
                  </Text>
                ))}
              {plan.next ? <Text wrap="wrap">Next: {plan.next}</Text> : null}
              {plan.questions > 0 ? (
                <Text color="yellow">
                  {plan.questions} open question{plan.questions === 1 ? '' : 's'} for you
                </Text>
              ) : null}
              {plan.questions > 0 ? (
                <Box>
                  <Button key={`ask-${plan.name}`} label="answer them" onPress={() => void askQuestions($, plan.name)} />
                  <Text dimColor wrap="truncate-end">
                    {' '}
                    or /{skill.questions} {plan.name}
                  </Text>
                </Box>
              ) : null}
              {isListed && plan.phase !== null ? (
                <Button key={`fresh-${plan.name}`} onPress={() => void startFresh($, plan.name)}>
                  Clear context, start phase {plan.phase}
                </Button>
              ) : null}
              <Text dimColor wrap="truncate-end">
                {isListed ? `or type /${FRESH} ${plan.name}` : `Continue: /${skill.phase} ${plan.name}`}
              </Text>
            </Box>
          )
        })}
        {done.length ? <Text dimColor wrap="wrap">Done: {done.map(p => p.name).join(', ')}</Text> : null}
        <Text dimColor wrap="truncate-end">
          In {tailOf(place?.dir ?? defaultDir)}/ (/{WHERE})
        </Text>
      </Box>
    )
  })
}
