---
name: cleanup
description: Close a phase's housekeeping. Merge its branch into the base branch, stop the web servers it left running, remove its worktree. Use when the user says /cleanup or "clean up", and at the end of a phase where the user has asked for that at every phase's end.
argument-hint: [worktree names]
---

# Clear up after a phase

Arguments: $ARGUMENTS

Asking for this skill is asking for all three: the merge, the stopping of
servers and the removal of the worktree. None of them needs asking again, as
long as the steps below hold.

1. **Say what is to be cleared.** The phase's own worktree (the one this
   session made or entered, `<repo>/.claude/worktrees/<name>`, branch
   `worktree-<name>`) and any named in the arguments. `git worktree list`
   shows what stands. Other worktrees are other work: leave them, and what
   runs in them. A phase that was done in the main checkout has no worktree
   and nothing to merge: only its servers are stopped (steps 4 to 6).
2. **Is the phase finished?** Its work is committed, and pushed where the repo
   has a remote for branches; its checks pass; and the plan says `done`. When
   the phase's proof is the user's eyes, their verdict has been given. If any
   of that is missing, stop and say which: a phase that is not done is not
   merged.
3. **Push, merge, push.** Both the phase's branch and the base branch are
   pushed to the repo's remote before the merge and again after it, so that
   the state before the merge exists off this machine whatever happens.
   - Before: `git push <remote> worktree-<name> <base>`, each as it stands.
   - Merge. Git commands aimed at the main checkout are refused from inside
     a worktree session, so leave the worktree first (ExitWorktree with
     `keep`). In the main checkout: `git merge --ff-only worktree-<name>`. If
     it cannot fast-forward, stop and tell the user; do not make a merge
     commit or rebase on your own. Run the repo's tests there (`make test`
     where there is one) and say the result.
   - After: the same push again, so the remote's base branch has the merge.

   Never force a push: one that is refused is a reason to stop and say so. A
   repo with no remote cannot be pushed; say that in the report. Where the
   user or the project's CLAUDE.md keeps pushes to the base branch for
   themselves, push the phase's branch only and say so.
4. **Dry run.** From the main checkout:
   `python3 "${CLAUDE_SKILL_DIR}/cleanup.py" <name> [more names]`.
   It lists the servers it would stop (what listens on a port from the main
   checkout or a named worktree) and the worktrees it would remove (merged,
   nothing uncommitted, not locked). Read the list. A server that is not the
   phase's own (something the user is using, another project's page) is a
   reason to ask first, or to pass `--keep-servers`. The script reads `/proc`
   and so runs on Linux only; elsewhere, stop the phase's servers and remove
   its worktree by hand (`git worktree remove`, never forced, then
   `git branch -d`).
5. **Apply:** the same command with `--apply`. It never forces a removal and
   deletes only merged branches; it says why it kept what it kept.
6. **If a kill is refused** by the permission system (it can refuse kills of
   processes an earlier session started), do not work round it: give the user
   the one command to type, `! kill <pid>`, and carry on with the rest.
7. **Write it down.** In the plan: the merge under Decisions (who asked for
   it; the commit the base branch is at; the tests' result; what was pushed,
   before and after), and Next without the lines about a worktree or a page
   that no longer exist. Report in two or three lines: merged and pushed at
   which commit, what was stopped, what was removed, what was left and why.

Earlier phases' worktrees that are merged and still standing can be named in
the same run. Never name a worktree you cannot account for.
