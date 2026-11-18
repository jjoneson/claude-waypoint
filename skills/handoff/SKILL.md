---
name: handoff
description: Save where the current phase stands into its plan in the project's plans folder (docs/plans/ unless set otherwise), so a fresh session can continue it. Use when the user says /handoff, or before /clear in the middle of a phase.
argument-hint: [project-name]
---

# Hand off a phase in progress

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

1. **Find the plan:** the name given, else the plan this session has been
   working on, else ask.
2. **Under the phase in progress,** add a `- **Handoff (YYYY-MM-DD):**` bullet,
   replacing an earlier one if there is one. It says:
   - what's done, and what's half-done (the files and the state they're in);
   - what's left, and the exact next step;
   - the checks run and their results;
   - which uncommitted files in the working tree belong to this phase
     (`git status --short` on the files you touched; other changes there may
     belong to someone else).
3. **Update** Decisions, Open questions and the header (`next` is the resume
   step; `updated` is today's date). Then log the time, with N the phase in
   progress:
   `python3 "${CLAUDE_SKILL_DIR}/../plan/estimate.py" <the plan's file> --log N --session ${CLAUDE_SESSION_ID}`.
   It adds what this session has spent working to the phase's **Took** and
   writes what the plan still needs into the header; don't write those
   yourself. If the rest of the phase now looks bigger or smaller than its
   **Estimate** allows, change the estimate and run it again.
4. **Don't change code.** End with one line on where things stand, then how to
   continue: `/next-phase <name>`, which clears the conversation and runs the
   phase skill (by hand: `/clear`, then this plugin's `phase` skill with the
   plan's name).
