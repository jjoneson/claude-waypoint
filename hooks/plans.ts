import type { PhaseInfo, PhaseState, Plan } from '../types'

/** Where plans are kept when neither a workspace nor the mod's option says otherwise, relative to the session's directory. */
export const PLAN_DIR = 'docs/plans'

/**
 * A workspace's own word on where its plans are: `{ "plansDir": "<path>" }`,
 * the path relative to the folder that holds `.claude`. It is for a folder of
 * several repositories that sessions start from, where the plans live in one
 * of the repositories or beside them.
 */
export const CONFIG_FILE = '.claude/waypoint.json'

/** Whether a path names one place wherever it is read from: `/x`, `~/x`, `C:\x`. */
export function isAbsolute(path: string): boolean {
  return /^(?:[\\/]|~(?:[\\/]|$)|[A-Za-z]:[\\/])/.test(path)
}

/**
 * `path` as one absolute path with forward slashes: under `base` when it is
 * relative, under `home` when it starts with `~`, with `.` and `..` worked out
 * and no slash at the end.
 */
export function resolvePath(base: string, path: string, home = ''): string {
  let full = path.replace(/\\/g, '/')
  if (/^~(?:\/|$)/.test(full) && home) full = `${home.replace(/\\/g, '/')}${full.slice(1)}`
  else if (!isAbsolute(full)) full = `${base.replace(/\\/g, '/')}/${full}`
  const lead = /^(?:[A-Za-z]:)?\//.exec(full)?.[0] ?? ''
  const parts: string[] = []
  for (const part of full.slice(lead.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return lead + parts.join('/')
}

/**
 * The person's home folder, worked out from paths that sit under it, for where
 * the environment cannot be read: `/home/<name>`, `/Users/<name>` or
 * `C:/Users/<name>` at the head of one, else what a path has before
 * `/.claude/plugins/`. Empty when none says.
 */
export function homeFrom(paths: readonly string[]): string {
  const all = paths.map(path => path.replace(/\\/g, '/'))
  for (const path of all) {
    const named = /^((?:[A-Za-z]:)?\/(?:home|Users)\/[^/]+)(?:\/|$)/.exec(path)
    if (named) return named[1]!
  }
  for (const path of all) {
    const before = /^(.+?)\/\.claude\/plugins\//.exec(path)
    if (before) return before[1]!
  }
  return ''
}

/**
 * The folder a workspace's config file names, as written there; `null` when
 * the file names none. Throws when the file is not JSON or the value is not text.
 */
export function configuredDir(text: string): string | null {
  const said: unknown = JSON.parse(text)
  const dir = said && typeof said === 'object' ? (said as { plansDir?: unknown }).plansDir : undefined
  if (dir === undefined || dir === null || dir === '') return null
  if (typeof dir !== 'string') throw new Error('plansDir is not text')
  return dir.trim() || null
}

/** The last two folders of a path, for a line with little room: `platform-docs/plans`. */
export function tailOf(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').slice(-2).join('/')
}

/** Files in the plan folder that are not plans. */
export const NOT_PLANS = new Set(['TEMPLATE.md', 'README.md'])

const STATES: readonly PhaseState[] = ['not started', 'in progress', 'done']
const PHASE_HEADING = /^###\s+(\d+)\.\s+(.+?):\s*(not started|in progress|done)\b/i
const PLACEHOLDER = /^(none|nothing|questions waiting on the user)\b/i

/** Reads a plan file: its header, phase headings and open questions. */
export function parsePlan(name: string, text: string, mtimeMs: number): Plan {
  const header: Record<string, string> = {}
  let body = text
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (front) {
    body = text.slice(front[0].length)
    for (const line of front[1]!.split(/\r?\n/)) {
      const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
      if (pair) header[pair[1]!.toLowerCase()] = unquote(pair[2]!.trim())
    }
  }

  const list: PhaseInfo[] = []
  for (const line of body.split(/\r?\n/)) {
    const m = PHASE_HEADING.exec(line)
    if (!m) continue
    const state = m[3]!.toLowerCase() as PhaseState
    list.push({ n: Number(m[1]), name: m[2]!.trim(), state: STATES.includes(state) ? state : 'not started' })
  }

  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? name
  const phases = toNumber(header.phases) ?? (list.length || null)
  const inProgress = list.find(p => p.state === 'in progress')?.n
  const firstOpen = list.find(p => p.state !== 'done')?.n

  return {
    name,
    title,
    status: header.status || 'unknown',
    phase: toNumber(header.phase) ?? inProgress ?? firstOpen ?? null,
    phases,
    next: header.next ?? '',
    updated: header.updated ?? '',
    remaining: header.remaining ?? '',
    spent: header.spent ?? '',
    list,
    questions: countQuestions(body),
    mtimeMs,
  }
}

/**
 * The plan name in a path such as `/repo/docs/plans/docs-site.md`, when the
 * file sits right in the plans folder `dir`. An absolute `dir` is that one
 * folder; a relative one is a folder of that name anywhere.
 */
export function planNameOf(path: string, dir: string = PLAN_DIR): string | null {
  const m = /^(.*?)\/?([^/]+)\.md$/.exec(path.replace(/\\/g, '/'))
  if (!m || NOT_PLANS.has(`${m[2]}.md`)) return null
  const folder = m[1]!
  const wanted = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const isIn = folder === wanted || (!isAbsolute(wanted) && folder.endsWith(`/${wanted}`))
  return isIn ? m[2]! : null
}

/** Open plans first (the session's own at the top), finished ones last. */
export function ordered(plans: readonly Plan[], current: string | null): Plan[] {
  const rank = (p: Plan) =>
    p.name === current ? 0 : p.status === 'active' ? 1 : p.status === 'planning' ? 2 : p.status === 'done' ? 4 : 3
  return [...plans].sort((a, b) => rank(a) - rank(b) || b.mtimeMs - a.mtimeMs)
}

export function isOpen(plan: Plan): boolean {
  return plan.status !== 'done'
}

/** `docs-site · phase 3/5 · active · 2 questions` */
export function statusText(plan: Plan): string {
  const parts = [plan.name]
  if (plan.phase !== null) parts.push(`phase ${plan.phase}${plan.phases ? `/${plan.phases}` : ''}`)
  parts.push(plan.status)
  const left = timeLeft(plan)
  if (left) parts.push(`~${left} left`)
  if (plan.questions > 0) parts.push(`${plan.questions} question${plan.questions === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/**
 * The working time a plan still needs, as its header's `remaining` says
 * (`skills/plan/estimate.py` keeps it): `8h`, or '' where the plan is done, has
 * no figure, or has one that says nothing (`unknown`, `0m`).
 */
export function timeLeft(plan: Plan): string {
  const left = plan.remaining.trim()
  return isOpen(plan) && /^\d/.test(left) && !/^0+\s*m?$/.test(left) ? left : ''
}

/** What the person types to run the phase skill and the questions skill, without the slash. */
export type SkillNames = { phase: string; questions: string }

/**
 * What a new session is told about the plans that are still open, with the
 * skills' names as this install has them and the folder the plans are in.
 */
export function contextText(
  plans: readonly Plan[],
  skills: SkillNames = { phase: 'phase', questions: 'questions' },
  dir: string = PLAN_DIR,
): string | null {
  const open = plans.filter(isOpen)
  if (!open.length) return null
  const lines = open.map(p => {
    const where = p.phase !== null ? `phase ${p.phase}${p.phases ? ` of ${p.phases}` : ''}` : 'no phase yet'
    const asks = p.questions ? `; ${p.questions} open question${p.questions === 1 ? '' : 's'}` : ''
    const left = timeLeft(p) ? `; about ${timeLeft(p)} of work left` : ''
    return `- ${p.name} (${p.title}): ${p.status}, ${where}${asks}${left}. Next: ${p.next || 'see the plan'}`
  })
  return [
    `Open project plans in ${dir}/ (from the waypoint mod; that is this project's plans folder):`,
    ...lines,
    `Run a phase with /${skills.phase} <name>. The plan file is the hand-off between sessions.`,
    ...(open.some(p => p.questions > 0)
      ? [`Go through a plan's open questions with the user, and record the answers, with /${skills.questions} <name>.`]
      : []),
  ].join('\n')
}

/** What Claude is told where the plans folder is not the usual one and there is nothing else to say about it. */
export function folderText(dir: string): string {
  return `waypoint: this project's plans folder is ${dir}/. Plans are read from there and new ones are written there.`
}

/** Whether a message says a phase is finished. */
export function saysPhaseDone(message: string): boolean {
  return /\bphase\b[^.\n]{0,80}?\b(?:is |now )?(?:done|complete|completed|finished)\b/i.test(message)
    || /\b(?:finished|completed)\s+phase\b/i.test(message)
}

function countQuestions(body: string): number {
  const section = /^##\s+Open questions\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body)
  if (!section) return 0
  return section[1]!
    .split(/\r?\n/)
    .map(line => /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim())
    .filter((item): item is string => !!item && !PLACEHOLDER.test(item.replace(/^~~|\*\*/g, '')))
    .filter(item => !/^~~.*~~$/.test(item)).length
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : null
}

function unquote(value: string): string {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value
}
