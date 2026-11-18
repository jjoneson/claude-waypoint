---
name: phase
description: Run the next phase of a project plan in the project's plans folder (docs/plans/ unless set otherwise). Use when the user says /phase <name>, "continue <project>", or "do phase N of <project>".
argument-hint: <project-name> [phase number]
---

# Run one phase of a plan

Arguments: $ARGUMENTS

**The plans folder.** Plans are `<name>.md` files in one folder. It is the
folder the plan-tracker mod names in this conversation: in its note at the
start, or beside this command. If nothing names it, find it yourself: the
nearest `.claude/plan-tracker.json` at or above the working directory whose
`plansDir` names it (a path relative to the folder that holds `.claude`);
with no such file, the nearest `docs/plans/` folder at or above it.

1. **Find the plan:** `<name>.md` in the plans folder. With no name, list the plans
   whose header says `status: active` or `planning`. Use the only one, or ask
   which.
2. **Read the whole plan,** Decisions and Open questions included. If an open
   question blocks this phase, ask it before starting.
3. **Clear up after earlier phases.** Where the repo has worktrees under
   `.claude/worktrees/` (`git worktree list`) that earlier phases of this plan
   left standing, run, from the repo's main checkout,
   `python3 "${CLAUDE_SKILL_DIR}/../cleanup/cleanup.py" <their names>`. That
   is a dry run: it says which of the named worktrees it would remove (those
   merged into the base branch, with nothing uncommitted and not locked) and
   what it would stop in them. Read it, then run it again with `--apply`. Say
   in one line what it removed. Leave what it kept; it says why. Never name a
   worktree you cannot account for. With no such worktrees, skip this step.
4. **Pick the phase:** the number given, else the header's `phase`. Mark it
   started right away, so the Plans pane shows it: the heading becomes
   `### N. Name: in progress`, the header gets `status: active` and `updated`
   gets today's date.
5. **Do the phase,** following CLAUDE.md. Find your way from its area table
   and `docs/architecture.md` where the project has them, and send a `scout`
   agent for a map of code you don't know. Work towards the phase's "Done
   when" and run what its "Proved by" names, through a `checker` agent where
   a check's output is long. Stay inside the phase: anything out of scope
   goes under Open questions, or becomes a later phase, rather than being done
   now.
6. **If the user's eyes are the proof** (a screenshot, a try-out), stop and
   ask for their verdict, then record it under Decisions as theirs.
7. **Finish by updating the plan:**
   - the heading becomes `done`, with the commit if there is one:
     `### N. Name: done (commit abc1234)`;
   - **Notes:** what changed, the files touched, the checks run and their
     results, and anything that surprised you;
   - Decisions (with who made each), Next (the files to open and the check to
     run first) and Open questions;
   - the header: `phase` moves to the next phase, `status` stays `active` (or
     becomes `done` after the last phase), and `next` and `updated` are set.

   Commit only if the user asked for commits.
8. **Clear up, where the user has asked for it.** If the user, the project's
   CLAUDE.md or your memory says to clear up at the end of every phase, do
   what the cleanup skill describes once the phase is done (after the user's
   verdict, when their eyes are the proof): merge the phase's branch into the
   base branch, stop the web servers the phase left running, remove its
   worktree. Without that standing word, do none of it: say in the report
   that `/cleanup` (this plugin's `cleanup` skill) does it. A phase that is
   not done is left as it is.
9. **Report and stop.** Say what was done, how it was proved, what's waiting
   on the user, and the next step: `/next-phase <name>`, or the Plans pane's
   "Clear context, start phase N" button (the plan-tracker mod clears the
   conversation and runs this skill; a skill cannot clear it itself).
   `/clear` and then this skill with the plan's name does the same by hand.
   Don't start the next phase.

If the phase turns out bigger than one session, stop at a clean point, save
where things stand as the handoff skill describes, and suggest how to split it.
