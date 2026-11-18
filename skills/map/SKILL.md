---
name: map
description: Write or refresh a project's maps for coding agents, so they read the map first and only the code they need. The index in CLAUDE.md (an area table, search rules, big files, which check to run), the module map in docs/architecture.md, and the import check that holds the code to that map. Use when the user says /map, "map this repo", "set up the index", "why are agents slow here", or after directories were added or moved.
argument-hint: [what to map, or "refresh"]
---

# Map a project for agents

Arguments: $ARGUMENTS

Agents are slow in a large codebase because they find their way from scratch
each session. This sets up three hand-kept things that end that, and one check
that keeps the largest of them true:

- **CLAUDE.md is the index.** It loads into every session: what the areas are,
  which doc to read first for each, where never to search, which check to run.
- **`docs/architecture.md` is the module map.** What each directory owns and
  what it may import.
- **The import check** (`layercheck.py`, beside this file) reads the tables in
  that page and checks every import against them, so the page cannot drift
  from the code.

Nothing here is generated and left: you write the maps with the user, from the
code as it is. Keep them short. A map that tries to say everything is not read.

1. **See what is there.** Read CLAUDE.md (or AGENTS.md) and
   `docs/architecture.md` if they exist: this is then a refresh, and you
   change what is wrong or missing, not the user's wording. Measure before
   writing, from the repository's top folder:
   - size: `git ls-files | wc -l`, and the lines of source by top directory;
   - bulk that floods a search: `du -sh -- */ | sort -h | tail`, and which
     of those are assets, data, build output or vendored code;
   - the biggest source files:
     `git ls-files -z -- '*.ts' '*.py' '*.java' | xargs -0 wc -l | sort -n | tail`,
     with the project's own extensions;
   - the checks: what the package scripts, the Makefile, Maven or Gradle
     (`./mvnw verify`, `./gradlew check`) or CI run, and how long the ones
     run on every change take (time them once, through the `checker` agent if
     the output is long).
2. **Draft the module map.**
   `python3 "${CLAUDE_SKILL_DIR}/layercheck.py" --draft` prints a table of
   what each directory imports today, and which pairs import each other. It
   takes `src/` as the source folder, or in a Java or Kotlin project the base
   package's folder (`src/main/java/com/acme/shop`), where the rows are the
   sub-packages; `--root <dir>` names another. That is the code's map, not
   yet the intended one. With the user:
   - fill "What it owns" for each row, one clause, from reading the
     directory's entry points (a `scout` agent for a directory you don't know);
   - for each pair that import each other, decide which way it should go; the
     other side keeps only named files (`billing/rates.ts`), or only their
     types (the types of `billing/money.ts`);
   - an import that should not be there and is not fixed today goes in the
     known-exceptions table with what it is for, not into a looser row;
   - a directory large enough to be lost in gets a table of its own folders
     (`<!-- layercheck: within=<dir> -->`);
   - in a build of several modules (Maven modules, Gradle subprojects), each
     module gets its own `docs/architecture.md` for the packages inside it,
     drafted and checked from the module's folder. Which module may use which
     is the build's to say, and it already holds that line: put it in the top
     CLAUDE.md as a table of the modules, not in a map.

   Write it to `docs/architecture.md` from
   `${CLAUDE_SKILL_DIR}/ARCHITECTURE-TEMPLATE.md`. The top of `layercheck.py`
   says exactly how the tables and the `<!-- layercheck: ... -->` lines read.
3. **Make the check the project's own.** Copy `layercheck.py` into the
   repository (`tools/layercheck.py`, or where its scripts live) so it runs
   without this plugin and in CI, and give it a name the project uses: a
   package script (`"layercheck": "python3 tools/layercheck.py"`), a Makefile
   target, a Gradle `Exec` task that `check` depends on, a step in the CI
   file. Run it until it passes. It reads JavaScript, TypeScript, Python,
   Java and Kotlin; for another language keep the page in the same form and
   say in the report that its imports are not checked yet. Where a Java
   project already holds its layers with ArchUnit tests, don't add a second
   check: write the page to say what those tests enforce, and name them as
   the check.
4. **Write the index** in CLAUDE.md from
   `${CLAUDE_SKILL_DIR}/CLAUDE-TEMPLATE.md`, keeping whatever the file already
   says that is still true. Take only the sections the project needs:
   - **Finding your way:** the module map and its check; the search rule, with
     the folders never to search from and their sizes; the big files by name
     and length, with the rule to find the function with `grep -n` and read
     that range; and the area table.
   - **The area table** (Area, Start with, Key files) is the part that saves
     the most. A row is something a task would be about, in the user's words,
     not a directory listing. "Start with" is one doc or one section; "Key
     files" are the three to six files where work in that area begins. Ask the
     user which areas they work in, and aim for eight to fifteen rows.
   - **Checking your work:** the smallest check for each kind of change, with
     its measured time, and any rule about a shared resource.
   - **House rules, multi-phase work, sub-agents:** only what is true here.
5. **Other agents.** If the user also runs agents that read `AGENTS.md`, and
   there is none, offer `ln -s CLAUDE.md AGENTS.md`, so that there is one file
   to keep.
6. **A folder of several repositories.** Each repository gets its own
   CLAUDE.md and module map, done as above from inside it. The folder that
   holds them gets a short CLAUDE.md of its own: a table of the repositories
   (Repository, What it owns, Start with), what holds across them, and where
   the plans are kept. Imports between repositories are not the import
   check's business.
7. **Prove it and stop.** Run the import check, and check that every path the
   area table names exists (`ls` them). Report what you wrote, what the user
   still has to decide (each pair that import each other, each known
   exception), and the commands to run. Commit only if the user asked.

**Refreshing.** Run the import check first: it names the directories the map
leaves out and the names that are gone. Then the area table: paths that no
longer exist, areas with no row, big files that have grown or been split.
Change those lines and leave the rest.
