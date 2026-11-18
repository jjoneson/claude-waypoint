---
name: plan
description: Start or revise a multi-phase project plan, <name>.md in the project's plans folder (docs/plans/ unless set otherwise). Use when the user wants to plan work that will take more than one session, or to change an existing plan.
argument-hint: <project-name> [what it is about]
---

# Plan a multi-phase project

Arguments: $ARGUMENTS

**The plans folder.** Plans are `<name>.md` files in one folder. It is the
folder the waypoint mod names in this conversation: in its note at the
start, or beside this command. If nothing in the conversation names it, the
mod's note did not arrive: find the folder yourself before you read or write
a plan, and say in one line which folder you took and what named it. Take
the first of these that gives one:

- **A workspace's own word:** the nearest `.claude/waypoint.json` at or above
  the working directory. Its `plansDir` is the folder, as a path from the
  folder that holds `.claude`.
- **This plugin's `plansDir` setting,** which the person set when installing
  it or in `/config`. Read `~/.claude/settings.json`: under `pluginConfigs`,
  the entry named `wp@claude-waypoint` (or another whose name starts with
  `wp`), at `options.plansDir`. The project's `.claude/settings.local.json`
  and `.claude/settings.json` can hold the same entry, and theirs comes
  first. A path that is absolute or starts with `~` is the folder. Any other
  is the folder's name, to look for in place of `docs/plans` below.
- **The usual place:** the nearest `docs/plans/` folder at or above the
  working directory.

With none of the three, a new plan goes in `docs/plans/` (or the name the
setting gives) under the working directory, which you make.

1. **Name the plan.** Use the first argument as the file name, in kebab-case:
   `<name>.md` in the plans folder. If that file exists, this is a revision: read it
   and change only what the user wants changed.
2. **Learn just enough.** Start from the project's maps where it has them:
   the area table in CLAUDE.md, and the rows of `docs/architecture.md` the
   work touches (this plugin's `map` skill writes both). If you need more of
   a map of the code, send one `scout` agent rather than reading broadly
   yourself.
3. **Agree the plan with the user.** Ask only the questions whose answers
   change the plan, with real options and a recommendation (AskUserQuestion
   for real choices). Cover the goal, the phases, and how each phase is proved.
   - Size each phase to one session: one deliverable, one round of checks, and
     a natural point for the user to look at it (a screenshot, a try-out, a
     diff). If a phase would need several review rounds, split it.
   - Put risky or uncertain work early, so later phases build on what's proven.
4. **Write the plan** from the template: the project's own, `TEMPLATE.md` in
   the plans folder, where there is one, else
   `${CLAUDE_SKILL_DIR}/TEMPLATE.md`. Fill in the header: `project` is the
   name, `status: planning` until the user approves the plan (then `active`),
   `phase: 1`, `phases` is the count, `next` is one line, and `updated` is
   today's date. Record each decision with who made it. Remove the template's
   comment.
5. **Guess the time.** Give every phase an `- **Estimate:**` of working time
   (`45m`, `2h`, `1h 30m`): what a session will spend on it, your work and the
   checks and jobs it waits on, not the time it waits for the user. It is a
   rough guess and is meant to be: go by the size of the change and how long
   the phase's proof takes to run, and by this plan's finished phases when
   you are revising one. Don't pad it; what is left is corrected from how
   the phases really go. Then run
   `python3 "${CLAUDE_SKILL_DIR}/estimate.py" <the plan's file>`: it adds the
   guesses up and writes `estimate`, `spent` and `remaining` into the header.
   Run it again after any change to the phases or their estimates.
6. **Stop there.** Don't start phase 1. End with the plan's path, one line per
   phase with its estimate, the time in all, how many questions are still open (this plugin's `questions` skill
   goes through them with the user one by one), and how to start:
   `/next-phase <name>`, which clears the conversation and runs the phase
   skill (by hand: `/clear`, then this plugin's `phase` skill with the plan's
   name).
