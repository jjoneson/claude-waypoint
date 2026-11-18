---
name: questions
description: Go through a plan's open questions with the user, one after another in a question dialog with a "Skip for now" choice, and write each answer into the plan in the project's plans folder (docs/plans/ unless set otherwise). Use when the user says /questions, "answer the open questions", "what is this plan waiting on me for", or wants to see a plan's open questions.
argument-hint: [project-name]
---

# Answer a plan's open questions

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
   working on, else the only plan in the plans folder that is not `done` and has
   open questions. With several and no name, ask which.
2. **Read the whole plan.** The questions are the bullets under
   `## Open questions`, in the order they stand. Struck-through bullets and a
   bare `None` are not questions. With none, say so and stop. Otherwise say in
   one line how many there are, then start asking: don't print the list first,
   the dialogs show it.
3. **Ask them in order with AskUserQuestion,** up to four to a dialog, which
   shows them one after another. For each:
   - `question`: the question in full, as a sentence that ends in a question
     mark and can be answered by someone who sees nothing else. The dialog may
     be all the user has on screen, so add the line of context from the plan
     that the answer turns on (which phase it holds up, what it costs).
   - `header`: a label of at most 12 characters.
   - `options`: the choices the plan gives for it, the plan's recommendation
     first with "(Recommended)" at the end of its label. Where the plan gives
     none, work out two or three real ones from the plan, reading only as
     much code as that takes. Where the plan recommends none and you would
     pick one, put it first, marked the same way, and say in its description
     that the recommendation is yours and not the plan's. Use at most three,
     each with a description of what choosing it means for the plan.
   - Then always, as the last option: label `Skip for now`, description
     "Leave this question open in the plan." The dialog adds a free-text
     choice by itself, so don't add one.

   A question whose choices depend on the answer to an earlier one goes in a
   later dialog than that one. Never answer a question yourself, and never
   leave one out because it looks settled: if a Decision in the plan already
   answers it, ask it with that answer as the recommended choice.
4. **Write the answers into the plan after each dialog,** before the next one
   is asked, so that nothing is lost if the round stops halfway:
   - **Answered:** take the bullet out of Open questions and add
     `- YYYY-MM-DD: <what was decided> (user)` to Decisions, with today's
     date, in words that stand without the question beside them.
   - **Skipped:** leave the bullet exactly as it is.
   - **A typed answer that is unclear, or is a question back:** talk it
     through first, then ask that one again. Don't record a guess.
   - **Where an answer changes a phase** (what it does, its "Done when" or
     "Proved by", the order, a phase more or fewer): change the phase's text
     and the header's `phases` to match, and say what you changed. Change the
     phase's **Estimate** with it, give a new phase one, and run
     `python3 "${CLAUDE_SKILL_DIR}/../plan/estimate.py" <the plan's file>`,
     which works out afresh what the plan still needs.
   - **The header:** `updated` is today's date; `next` only if the answers
     change what the next session does first.
   - When the last question is answered, the section keeps one bullet,
     `- None`.

   If the user dismisses a dialog or says to stop, stop asking: what is
   unanswered stays open.
5. **Change the plan only.** No code, and no start on a phase, whatever the
   answers unblock.
6. **Report:** one line for each decision recorded, the count skipped, any
   phase text that changed, and how to go on: `/next-phase <name>`.
