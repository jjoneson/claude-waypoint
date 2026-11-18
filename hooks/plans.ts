import type { PhaseInfo, PhaseState, Plan } from '../types'

/** Where the plans live, relative to the session's directory. */
export const PLAN_DIR = 'docs/plans'

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
    list,
    questions: countQuestions(body),
    mtimeMs,
  }
}

/** The plan name in a path such as `/repo/docs/plans/docs-site.md`. */
export function planNameOf(path: string): string | null {
  const m = /(?:^|[\\/])docs[\\/]plans[\\/]([^\\/]+)\.md$/.exec(path)
  if (!m || NOT_PLANS.has(`${m[1]}.md`)) return null
  return m[1]!
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
  if (plan.questions > 0) parts.push(`${plan.questions} question${plan.questions === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** What the person types to run the phase skill and the questions skill, without the slash. */
export type SkillNames = { phase: string; questions: string }

/** What a new session is told about the plans that are still open, with the skills' names as this install has them. */
export function contextText(
  plans: readonly Plan[],
  skills: SkillNames = { phase: 'phase', questions: 'questions' },
): string | null {
  const open = plans.filter(isOpen)
  if (!open.length) return null
  const lines = open.map(p => {
    const where = p.phase !== null ? `phase ${p.phase}${p.phases ? ` of ${p.phases}` : ''}` : 'no phase yet'
    const asks = p.questions ? `; ${p.questions} open question${p.questions === 1 ? '' : 's'}` : ''
    return `- ${p.name} (${p.title}): ${p.status}, ${where}${asks}. Next: ${p.next || 'see the plan'}`
  })
  return [
    'Open project plans in docs/plans/ (from the plan-tracker mod):',
    ...lines,
    `Run a phase with /${skills.phase} <name>. The plan file is the hand-off between sessions.`,
    ...(open.some(p => p.questions > 0)
      ? [`Go through a plan's open questions with the user, and record the answers, with /${skills.questions} <name>.`]
      : []),
  ].join('\n')
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
