---
name: plan
description: Start or revise a multi-phase project plan in docs/plans/<name>.md. Use when the user wants to plan work that will take more than one session, or to change an existing plan.
argument-hint: <project-name> [what it is about]
---

# Plan a multi-phase project

Arguments: $ARGUMENTS

1. **Name the plan.** Use the first argument as the file name, in kebab-case:
   `docs/plans/<name>.md`. If that file exists, this is a revision: read it
   and change only what the user wants changed.
2. **Learn just enough.** Start from the project's CLAUDE.md and README. If
   you need a map of the code, send one Explore agent rather than reading
   broadly yourself.
3. **Agree the plan with the user.** Ask only the questions whose answers
   change the plan, with real options and a recommendation (AskUserQuestion
   for real choices). Cover the goal, the phases, and how each phase is proved.
   - Size each phase to one session: one deliverable, one round of checks, and
     a natural point for the user to look at it (a screenshot, a try-out, a
     diff). If a phase would need several review rounds, split it.
   - Put risky or uncertain work early, so later phases build on what's proven.
4. **Write the plan** from the template: the project's own
   `docs/plans/TEMPLATE.md` where there is one, else
   `${CLAUDE_SKILL_DIR}/TEMPLATE.md`. Fill in the header: `project` is the
   name, `status: planning` until the user approves the plan (then `active`),
   `phase: 1`, `phases` is the count, `next` is one line, and `updated` is
   today's date. Record each decision with who made it. Remove the template's
   comment.
5. **Stop there.** Don't start phase 1. End with the plan's path, one line per
   phase, how many questions are still open (this plugin's `questions` skill
   goes through them with the user one by one), and how to start:
   `/next-phase <name>`, which clears the conversation and runs the phase
   skill (by hand: `/clear`, then this plugin's `phase` skill with the plan's
   name).
