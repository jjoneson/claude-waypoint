# waypoint

A mod for Claude Code that keeps an agent's context small in a large
codebase, in two ways that work together:

- **Maps instead of searching.** A short index in `CLAUDE.md`, a module map
  in `docs/architecture.md`, and a check that holds the code to that map, so
  an agent reads the map first and only the code it needs. Two cheap
  sub-agents keep bulk out of the main conversation: one finds code and
  answers with `path:line`, one runs checks and answers pass or fail.
- **Plans instead of chat history.** Long work is a plan of phases, one phase
  per session. The plan is a Markdown file in your project,
  `docs/plans/<name>.md` unless you [put plans elsewhere](#where-plans-are-kept),
  and it is the hand-off between sessions: each phase starts in a cleared
  conversation, reads the plan, does one phase, and writes back what it did
  and what comes next.

Nothing here builds an index from the code and leaves it to go stale. The
maps are written by hand (with Claude's help) and kept short; the one part a
machine can check, what imports what, is checked.

The repository holds:

- **Six skills:** `map` writes and refreshes the maps; `plan`, `phase`,
  `questions`, `handoff` and `cleanup` write and run the plans.
- **Two agent types:** `scout` and `checker`.
- **A mod** that shows the plans in a pane beside the chat, starts the next
  phase in a cleared conversation, and keeps Claude honest about updating the
  plan.

## Install

At the prompt of a Claude Code session in a terminal:

```
/plugin install wp --marketplace jjoneson/claude-waypoint
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes it
available in every project).

From a shell:

```
claude plugin install wp --marketplace jjoneson/claude-waypoint
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `jjoneson/claude-waypoint`, then Add
plugin.

It needs a Claude Code build that loads mods (hooks modules written in
TypeScript); it was made and tested on 2.1.327. To try it for one session
without installing, clone the repository and run
`claude --plugin-dir <the clone>`.

## Use

The project is called waypoint; the plugin's install name is `wp`, so that
the prefix on its skills is short. The three commands the mod registers
itself have no prefix. Claude Code's own `/plan`, which turns on its plan
mode, is left as it is: this mod's planning is `/wp:plan`.

| Type | What it does |
| --- | --- |
| `/wp:map [what to map \| refresh]` | Writes or refreshes the project's maps with you: the index in `CLAUDE.md`, the module map in `docs/architecture.md`, and the import check. |
| `/wp:plan <name> [what it is about]` | Agrees a plan with you and writes `docs/plans/<name>.md`. Run it again to revise the plan. It does not start the work. |
| `/next-phase [name]` | Clears the conversation, then runs the plan's next phase. With no name: the session's own plan, else the only active one. |
| `/wp:phase <name> [number]` | Runs a phase in the conversation as it is. `/next-phase` is this after a `/clear`. |
| `/wp:questions [name]` | Asks you the plan's open questions one after another, each with its choices and a "Skip for now", and writes your answers into the plan. |
| `/wp:handoff [name]` | Mid-phase: writes where things stand into the plan, so a fresh session can pick it up. |
| `/wp:cleanup [worktree names]` | After a phase done in a worktree: merges its branch into the base branch, stops the servers it left running, removes the worktree. |
| `/plans` | Shows or hides the Plans pane. |
| `/plans-dir [path \| reset]` | Says where the plans folder is and what named it. With a path, sets it for the workspace. |

A usual round:

1. `/wp:plan checkout-flow a new checkout in three steps`. Claude
   asks what it needs to, sizes each phase to one session, and writes the
   plan. You approve it.
2. `/next-phase checkout-flow`. Claude reads the plan, marks phase 1 in
   progress, does it, runs what the plan says proves it, and writes the
   result into the plan. Where the proof is your own eyes, it stops and asks
   for your verdict.
3. `/next-phase` again for phase 2, in a cleared conversation, and so on. The
   Plans pane has a button that does the same.

Plans gather open questions as the work goes on. `/wp:questions
checkout-flow` (or the pane's "answer them" button) puts them to you in the
same kind of dialog Claude uses for its own questions, up to four at a time.
Each has the plan's choices with the recommended one first, a free-text
choice, and "Skip for now". An answer becomes a dated decision in the plan
and the question leaves the list; a skipped one stays as it is. Nothing but
the plan is changed.

## The maps

Run `/wp:map` once in a repository. Claude measures it (how big,
where the bulk is, which files are huge, what the checks cost) and writes
three things with you:

- **The index, in `CLAUDE.md`.** It loads into every session. Its core is an
  area table: for each thing a task might be about, the one doc to read first
  and the few files where work begins. Around it: where never to search from
  (the folder with 50 GB of assets), the big files by name with the rule to
  find the function with `grep -n` and read that range, and which check to
  run for which kind of change. `AGENTS.md` can be a symlink to it, so other
  agents read the same file.
- **The module map, in `docs/architecture.md`.** A table of what each
  directory owns and what it may import.
- **The import check.** `layercheck.py` reads the tables in that page and
  checks every import in the source against them. The page people read is
  the map the check enforces, so the two cannot drift apart. The skill copies
  the script into your repository, so it runs in CI and without this plugin.

```
python3 tools/layercheck.py            # check
python3 tools/layercheck.py --quiet    # only what fails
python3 tools/layercheck.py --draft    # the map as the code stands today, to start from
```

A row of the map:

```markdown
<!-- layercheck: root=src -->

| Directory | What it owns | May import |
| --- | --- | --- |
| `orders/` | the order rules | `catalog/`, `billing/rates.ts`, the types of `billing/money.ts` |
```

`orders/` may import all of `catalog/`, one file of `billing/`, and only the types
of another. The check fails on an import the map does not allow, a source
directory the map leaves out, a name in the map that is gone, and a listed
exception that nothing matches any more. A large directory can have a table
of its own folders. The top of `skills/map/layercheck.py` says how every part
reads, and `skills/map/ARCHITECTURE-TEMPLATE.md` is a whole page to start from.

It reads JavaScript, TypeScript, Python, Java and Kotlin imports and needs
Python 3 and nothing else. It works from the text of the files, not a
compiler; run over a large TypeScript codebase it found the same offending
imports as that project's own compiler-based check.

### Java and Spring Boot

A Java import names a class by its package, so the source folder is the base
package's folder and the rows are its sub-packages. `--draft` finds that
folder by itself under `src/main/java` (or `src/main/kotlin`):

```markdown
<!-- layercheck: root=src/main/java/com/acme/shop -->

| Directory | What it owns | May import |
| --- | --- | --- |
| `ShopApplication.java` | the entry | nothing else |
| `web/` | controllers and what they take and answer | `service/`, `domain/` |
| `service/` | use cases and transactions | `repository/`, `domain/` |
| `repository/` | Spring Data repositories | `domain/` |
| `domain/` | entities and value types | nothing else |
| `config/` | beans and properties | anything |
```

That is a layered application; one laid out by feature has rows such as
`orders/` and `billing/`, and a feature with layers of its own gets a table
of its folders. How Java is read:

- `import com.acme.shop.domain.Order;` is an import of `domain/Order.java`,
  and so are its nested classes and static members.
- `import com.acme.shop.domain.*;` is an import of all of `domain/`. An
  allowance for one file does not cover it.
- Kotlin files are read the same way. An imported function or property has no
  file named after it, so it counts as an import of its whole package.
- Tests under `src/test/` are outside the source folder: not mapped, and free
  to import anything.
- Not seen: a class used by its full name with no import, and what Spring
  wires at run time. The check is about what the source says it depends on.
- **Several modules** (Maven modules, Gradle subprojects): give each module
  its own `docs/architecture.md` and run the check from the module's folder.
  Which module may use which is already held by the build's dependencies.
- If the project already has ArchUnit tests for its layers, keep those as the
  check and let the page say what they enforce.

Nothing else here depends on the language: the agents run whatever checks
`CLAUDE.md` names (`./mvnw verify`, `./gradlew check`), and the clean-up
script stops an application left running by `spring-boot:run` or `bootRun`
like any other server, by the port it listens on and the folder it runs in.

**The agents.** `scout` is read-only and answers "where does this happen"
with `path:line` references and a short explanation, not file contents.
`checker` runs the checks it is given and answers pass or fail with the
failing lines; it never fixes or re-records anything. Both run on a smaller
model, and the plan and phase skills send work to them. Installed with the
plugin they are `wp:scout` and `wp:checker`.

**Several repositories.** Map each repository from inside it. The folder that
holds them gets a short `CLAUDE.md` of its own: a table of the repositories,
what holds across them, and where the plans are kept.

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
- **The plans folder.** Found from the session's directory upward, so a
  session working in a worktree still sees the project's plans, and told to
  Claude so the skills read and write the same folder. See the next section.

### If another hook is in the way

The mod tells Claude the plans folder, and names sessions, through two of
Claude Code's hook events: the start of a conversation, and each prompt. A
hook that runs ahead of the mod's (a built-in one, or one your organization
sets) can pass those events on without the mod's hooks ever running. The
pane and the commands still work, so nothing looks wrong until a plan lands
in the wrong folder.

The mod notices: within a few seconds of a new conversation, or when you
type one of its skills and no prompt event follows. It then says so once in
a toast, "waypoint: another hook stopped waypoint's session hooks; plans
folder notes and session titles are off", and the Plans pane and `/plans-dir`
show the warning with the plans folder in full, so you can say it to Claude.
With no such hook, none of this appears. The skills also
[find the folder themselves](#where-plans-are-kept) when the note is missing.

## Where plans are kept

With nothing set, plans are in `docs/plans/` in the folder the session runs
in, or in the nearest folder above it that has one.

**A folder of several repositories.** If you start sessions from a folder
that holds several repositories, say once where that workspace's plans live,
in a session started there:

```
/plans-dir platform-docs/plans
```

That writes `.claude/waypoint.json` in the folder:

```json
{
  "plansDir": "platform-docs/plans"
}
```

The path is relative to the folder that holds `.claude`, or absolute, or
starts with `~`. You can write the file by hand just as well. From then on
every session started in that folder, in a repository under it, or in a
worktree of one, reads and writes plans there. `/plans-dir` with no path
says which folder is in use and what named it; `/plans-dir reset` takes the
setting back. The folder need not exist yet: the first plan written makes it.

**A different folder name everywhere.** The mod's `plansDir` option (in
`/config`, or asked for at install) is the folder looked for where no
workspace says otherwise. `plans` makes it `plans/` in place of `docs/plans/`
in every project. An absolute path, or one that starts with `~`, is one
folder for all your projects.

**When the mod's note does not arrive.** The skills are told the folder by
the mod, in a note at the start of the conversation and beside each skill's
command. Where that note is missing ([another hook in the way](#if-another-hook-is-in-the-way),
or the hooks module not loaded), each skill finds the folder itself in the
same order: the workspace's `.claude/waypoint.json`, then the `plansDir`
setting as it is saved in `settings.json`, then the nearest `docs/plans/`. It
says in one line which folder it took and what named it.

**Which wins.** A workspace's file comes first: the nearest
`.claude/waypoint.json` at or above the session's directory that names a
plans folder. So what a folder of repositories says holds in every repository
under it, also in one that has a `docs/plans/` of its own; such a repository
can carry a file of its own to keep its plans to itself. With no file, the
option where it is one fixed folder; else the nearest folder of the option's
name at or above the session's directory.

## The plan file

`skills/plan/TEMPLATE.md` is the starting point (a `TEMPLATE.md` of your own
in the plans folder is used instead where there is one). The mod reads
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
in the plans folder are not plans.

## Cleaning up after a phase

`/wp:cleanup` is for phases done in a git worktree under
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
claude plugin test .         # the mod's tests in tests/
python3 -m unittest discover -s tests -p 'test_*.py'    # the import check's tests
claude --plugin-dir .        # a session with this folder's copy loaded
```

- `hooks/register.tsx`: the hooks, the pane and the three commands.
- `hooks/plans.ts`: reading a plan file; no engine calls, so it is easy to test.
- `types/index.d.ts`: what the mod keeps in the session's state.
- `skills/`: the six skills, plain Markdown; `skills/map/layercheck.py` is the import check.
- `agents/`: the two agent types.

## Licence

MIT: see [LICENSE](LICENSE). The copy of `layercheck.py` that the map skill
puts in your repository carries the same licence in its first lines.
