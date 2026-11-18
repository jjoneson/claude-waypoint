export type PhaseState = 'not started' | 'in progress' | 'done'

/** One "### N. Name: state" heading of a plan. */
export type PhaseInfo = { n: number; name: string; state: PhaseState }

/** A plan file in docs/plans/, as its header and headings say. */
export type Plan = {
  /** The file name without `.md`: what `/phase <name>` takes. */
  name: string
  /** The first `# ` heading, else the name. */
  title: string
  /** planning, active, paused or done; `unknown` when the header has none. */
  status: string
  /** The phase in progress or next to start. */
  phase: number | null
  phases: number | null
  next: string
  updated: string
  list: PhaseInfo[]
  /** Bullets under "## Open questions", placeholders left out. */
  questions: number
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'wp': {
      plans: Shaped<Plan[]>
      current: Shaped<string | null>
      /** The person put the pane away: a line above the prompt stands in for it. */
      isHidden: boolean
      /** When a conversation's `classic.SessionStart` last reached the mod, by the session's clock; 0 for never. */
      sessionStartAt: number
      /** A conversation began and its `classic.SessionStart` did not reach the mod: a hook ahead of it sent it on. */
      isStartStopped: boolean
      /** A skill was typed and its `classic.UserPromptSubmit` did not reach the mod. */
      isPromptStopped: boolean
      /** What is wrong with reading the plans folder, for the pane to say; null when nothing is. */
      readError: Shaped<string | null>
    }
  }
}
