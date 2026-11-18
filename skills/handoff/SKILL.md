---
name: handoff
description: Save where the current phase stands into its plan in the project's plans folder (docs/plans/ unless set otherwise), so a fresh session can continue it. Use when the user says /handoff, or before /clear in the middle of a phase.
argument-hint: [project-name]
---

# Hand off a phase in progress

Arguments: $ARGUMENTS

**The plans folder.** Plans are `<name>.md` files in one folder. It is the
folder the plan-tracker mod names in this conversation: in its note at the
start, or beside this command. If nothing names it, find it yourself: the
nearest `.claude/plan-tracker.json` at or above the working directory whose
`plansDir` names it (a path relative to the folder that holds `.claude`);
with no such file, the nearest `docs/plans/` folder at or above it.

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
   step; `updated` is today's date).
4. **Don't change code.** End with one line on where things stand, then how to
   continue: `/next-phase <name>`, which clears the conversation and runs the
   phase skill (by hand: `/clear`, then this plugin's `phase` skill with the
   plan's name).
