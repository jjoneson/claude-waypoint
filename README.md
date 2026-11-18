# plan-tracker

A mod for Claude Code that runs long work as a plan of phases, one phase per
session. The plan is a Markdown file in your project, `docs/plans/<name>.md`,
and it is the hand-off between sessions: each phase starts in a cleared
conversation, reads the plan, does one phase, and writes back what it did and
what comes next.

The repository holds two things that work together:

- **Five skills** that write and run the plans: `plan`, `phase`, `questions`,
  `handoff` and `cleanup`.
- **A mod** that shows the plans in a pane beside the chat, starts the next
  phase in a cleared conversation, and keeps Claude honest about updating the
  plan.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install plan-tracker --marketplace jjoneson/claude-plan-mod
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes it
available in every project).

From a shell:

```
claude plugin install plan-tracker --marketplace jjoneson/claude-plan-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `jjoneson/claude-plan-mod`, then Add
plugin.

It needs a Claude Code build that loads mods (hooks modules written in
TypeScript); it was made and tested on 2.1.327. To try it for one session
without installing, clone the repository and run
`claude --plugin-dir <the clone>`.

## Use

| Type | What it does |
| --- | --- |
| `/plan-tracker:plan <name> [what it is about]` | Agrees a plan with you and writes `docs/plans/<name>.md`. Run it again to revise the plan. It does not start the work. |
| `/next-phase [name]` | Clears the conversation, then runs the plan's next phase. With no name: the session's own plan, else the only active one. |
| `/plan-tracker:phase <name> [number]` | Runs a phase in the conversation as it is. `/next-phase` is this after a `/clear`. |
| `/plan-tracker:questions [name]` | Asks you the plan's open questions one after another, each with its choices and a "Skip for now", and writes your answers into the plan. |
| `/plan-tracker:handoff [name]` | Mid-phase: writes where things stand into the plan, so a fresh session can pick it up. |
| `/plan-tracker:cleanup [worktree names]` | After a phase done in a worktree: merges its branch into the base branch, stops the servers it left running, removes the worktree. |
| `/plans` | Shows or hides the Plans pane. |

A usual round:

1. `/plan-tracker:plan checkout-flow a new checkout in three steps`. Claude
   asks what it needs to, sizes each phase to one session, and writes the
   plan. You approve it.
2. `/next-phase checkout-flow`. Claude reads the plan, marks phase 1 in
   progress, does it, runs what the plan says proves it, and writes the
   result into the plan. Where the proof is your own eyes, it stops and asks
   for your verdict.
3. `/next-phase` again for phase 2, in a cleared conversation, and so on. The
   Plans pane has a button that does the same.

Plans gather open questions as the work goes on. `/plan-tracker:questions
checkout-flow` (or the pane's "answer them" button) puts them to you in the
same kind of dialog Claude uses for its own questions, up to four at a time.
Each has the plan's choices with the recommended one first, a free-text
choice, and "Skip for now". An answer becomes a dated decision in the plan
and the question leaves the list; a skipped one stays as it is. Nothing but
the plan is changed.

## What the mod does

- **Plans pane.** Lists the open plans: status, phase, a bar of phases done,
  the plan's `next` line, and how many open questions wait for you. The plan
  the session works on, and every active plan, has its phases listed and a
  "Clear context, start phase N" button. A plan with open questions has an
  "answer them" button, which runs the questions skill for it in the
  conversation as it is. `hide` puts the pane away to one line above the
  prompt; the choice is kept across sessions.
- **Start of a conversation.** Claude is told which plans are open and where
  each stands, so "continue checkout-flow" is enough.
- **Session title and status line.** Running the plan or phase skill names
  the session after the plan and phase.
- **A plan left stale.** When Claude says a phase is done and the plan file
  has not changed since the work, it is sent back once to update the plan.
- **Where plans are looked for.** `docs/plans/` under the session's
  directory, or under the nearest folder above it, so a session working in a
  worktree still sees the project's plans.

## The plan file

`skills/plan/TEMPLATE.md` is the starting point (a `docs/plans/TEMPLATE.md`
of your own in the project is used instead where there is one). The mod reads
the header and the phase headings, so keep their form:

```markdown
---
project: checkout-flow
status: active
phase: 2
phases: 3
next: One line saying what the next session does first.
updated: 2026-01-15
---

# Checkout flow

## Phases

### 1. Cart page: done (commit abc1234)
### 2. Payment form: in progress
### 3. Receipts: not started

## Open questions

- Questions waiting on you, each with options and a recommendation.
```

`status` is one of `planning`, `active`, `paused` and `done`; `phase` is the
phase in progress, or the next one to start. Each header key has one value on
its own line, with nothing after it. Files named `TEMPLATE.md` and `README.md`
in `docs/plans/` are not plans.

## Cleaning up after a phase

`/plan-tracker:cleanup` is for phases done in a git worktree under
`<repo>/.claude/worktrees/<name>` on a branch `worktree-<name>`, which is
where Claude Code's own worktrees go. It checks the phase is finished, pushes
the phase's branch and the base branch (where the repo has a remote), merges
fast-forward only, pushes again, then runs `skills/cleanup/cleanup.py`: a dry
run first, then for real. The script stops what listens on a port from the
main checkout or a named worktree, removes the named worktrees that are
merged and have nothing uncommitted, and deletes their merged branches. It
never forces a removal and never touches a worktree it was not given by name.

The script needs Python 3 and reads `/proc`, so it runs on Linux only.
Everything else here works wherever Claude Code does.

The phase skill does this clean-up by itself at the end of a phase only when
you have said so, for example with a line in the project's `CLAUDE.md`:
"clean up at the end of every phase". Otherwise it tells you the command.

## Working on the mod

```
claude plugin validate .     # the manifests and the hooks module, as the engine reads them
claude plugin test .         # the tests in tests/
claude --plugin-dir .        # a session with this folder's copy loaded
```

- `hooks/register.tsx`: the hooks, the pane and the two commands.
- `hooks/plans.ts`: reading a plan file; no engine calls, so it is easy to test.
- `types/index.d.ts`: what the mod keeps in the session's state.
- `skills/`: the five skills, plain Markdown.
