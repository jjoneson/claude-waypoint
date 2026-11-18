# Project name: notes for coding agents

<!--
A starting point for a project's CLAUDE.md, written by the map skill. Take the
sections the project needs, fill them from what you measured, and delete this
comment. Keep the file short and current: it loads into every session, so
every line costs. Point to the docs rather than copying them.
-->

Claude Code reads this file; `AGENTS.md` is a symlink to it for other agents.

What this is, in two or three sentences: the kind of program, its size (lines
and files of source, how many checks), and what is slow about working in it.
Finding your way in is the slowest part of most tasks in a large codebase, so
start from the maps below rather than searching from scratch.

## Finding your way

- **Module map:** `docs/architecture.md` says which directory owns what and what
  it may import (`<the import check's command>` enforces it). Read the rows you
  need.
- **Search with `git grep` or inside `src/`.** Never `grep -R` or `find` from the
  repository's top folder: `assets/` (N GB), `data/` and `dist/` are bulk.
  Narrow to code: `git grep -n <pattern> -- '*.ts'`.
- **Big files:** `src/path/big.ts` (N lines), `src/path/other.ts`. Find the
  function with `grep -n` and read that range.
- **Long documents:** list the headings (`grep -n '^#' README.md`) and read one
  section.

| Area | Start with | Key files |
| --- | --- | --- |
| What a task would be about, in the user's words | `docs/<area>.md` | `src/<dir>/{a,b,c}.ts` |
| An area with no doc of its own | its rows of `docs/architecture.md` | `src/<dir>/` |

## Checking your work

Run the smallest check that covers the change, once.

- `<command>`: the check for every change (what it covers; N s warm, N s cold).
- `<the import check's command>`: after adding an import across directories.
- One area: `<command> <name>`, and how to list the checks there are.
- A check that needs a shared resource (the one GPU, a device, a database)
  runs under its lock: `<command>`. Batch those at the end of a piece of work,
  not after every edit.

## House rules

- What an agent must not assume or touch here: a working tree other sessions
  share, files that are generated and not edited by hand, a config whose save
  restarts something, where large outputs go.

## Multi-phase work

- A project with more than one phase has a plan in the plans folder
  (`docs/plans/<project>.md` unless set otherwise). The plan, not the chat
  history, is the hand-off between sessions. Its header (status, phase,
  phases, next, updated) is read by tools: keep it current.
- One phase per session. Start by reading the plan and do the phase named.
  Finish by updating the phase's status and notes, Decisions, Next and Open
  questions, then say the phase is done and what comes next. Don't start the
  next phase unless asked.
- Record who made each decision (user, or agent and open to change).
- If the plan and the code disagree, the code wins: fix the plan.

## Sub-agents

- Work in one context by default. Two agent types keep bulk out of it:
  - `scout` (read-only): finding where something happens or what a change
    will touch. It answers with `path:line` references, not file contents.
  - `checker`: running named checks and reporting pass or fail with the
    failing lines.
- Design, implementation and review stay on the main model.
- Brief each agent with the exact files, the facts it needs and the check to
  run; it starts without your context. It reads this file too, so the brief can
  skip these basics.
- Say the expected cost before fanning out, and ask before anything wide.
