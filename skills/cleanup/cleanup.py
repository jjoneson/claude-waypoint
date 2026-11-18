#!/usr/bin/env python3
"""Clears up after a phase: stops the servers it left running and removes its worktree once that is merged.

    python3 cleanup.py [--apply] [--keep-servers] <worktree name> [more names ...]

Run it from the repo's main checkout. Without --apply it only says what it
would do. The names are folders under <repo>/.claude/worktrees/: the phase's
own, and any earlier phase's that is still standing. A worktree that is not
named is never touched, and neither is anything that runs in it: other work
lives in worktrees too.

Servers. A process that listens on a TCP port is stopped (SIGTERM, then
SIGKILL after five seconds) when its working directory is in the main
checkout or in a named worktree: a review page, a dev server, an app left
running after a try-out. `--keep-servers` leaves them. This command's own
ancestors are never touched.

Worktrees. A named one is removed, with whatever still runs in it stopped
first and its branch deleted (`git branch -d`: merged only), when

  - its HEAD is in the base branch (the branch the main checkout is on, else
    main or master);
  - it has nothing uncommitted. Untracked symbolic links do not count: a
    worktree may be given links to the main checkout's ignored folders (data,
    a virtual environment), and they are taken away first, the links only;
  - it is not locked, and this command does not run inside it.

Otherwise it is kept and the reason is said. `git worktree remove` is never
forced. Linux only (/proc).
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def git(cwd: Path, *args: str, check: bool = True) -> str:
    done = subprocess.run(["git", "--no-optional-locks", "-C", str(cwd), *args], capture_output=True, text=True)
    if check and done.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {done.stderr.strip().splitlines()[0] if done.stderr.strip() else done.returncode}")
    return done.stdout.strip() if done.returncode == 0 else ""


def git_ok(cwd: Path, *args: str) -> bool:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True).returncode == 0


def inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def processes() -> dict[int, dict]:
    """Every process this user can see: its parent, command line and working directory."""
    out = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cwd = Path(os.readlink(entry / "cwd"))
            cmd = [c for c in (entry / "cmdline").read_text().split("\0") if c]
            ppid = int(next(line.split()[1] for line in (entry / "status").read_text().splitlines() if line.startswith("PPid:")))
        except (OSError, StopIteration, ValueError):
            continue
        out[int(entry.name)] = {"pid": int(entry.name), "ppid": ppid, "cmd": cmd, "cwd": cwd}
    return out


def listening() -> dict[int, list[str]]:
    """The processes that listen on a TCP port, and the addresses they listen on."""
    out: dict[int, list[str]] = {}
    done = subprocess.run(["ss", "-ltnpH"], capture_output=True, text=True)
    for line in done.stdout.splitlines():
        parts = line.split()
        for chunk in line.split("pid=")[1:]:
            pid = int(chunk.split(",")[0].split(")")[0])
            out.setdefault(pid, []).append(parts[3] if len(parts) > 3 else "?")
    return out


def stop(pids: list[int]) -> list[int]:
    """Stops the processes, politely first. Returns the ones that would not go."""
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass

    def alive() -> list[int]:
        return [p for p in pids if Path(f"/proc/{p}").exists()]
    for _ in range(20):
        if not alive():
            break
        time.sleep(0.25)
    for pid in alive():
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    time.sleep(0.2)
    return alive()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("names", nargs="*", help="the worktrees to clear, by folder name under .claude/worktrees/")
    ap.add_argument("--apply", action="store_true", help="do it; without this, only say what would be done")
    ap.add_argument("--keep-servers", action="store_true", help="leave what listens on a port alone")
    args = ap.parse_args()

    here = Path.cwd().resolve()
    common = Path(git(here, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    repo = common.parent
    base = git(repo, "symbolic-ref", "--short", "HEAD", check=False) or next((b for b in ("main", "master") if git_ok(repo, "rev-parse", "--verify", b)), "")
    if not base:
        print("the main checkout is on no branch, and the repo has neither main nor master: nothing done", file=sys.stderr)
        return 2
    wt_dir = repo / ".claude" / "worktrees"
    trees = {}
    for block in git(repo, "worktree", "list", "--porcelain").split("\n\n"):
        info = dict((line.split(" ", 1) + [""])[:2] for line in block.splitlines() if line)
        path = Path(info.get("worktree", ""))
        if info.get("worktree") and inside(path, wt_dir) and path != wt_dir:
            trees[path.name] = (path, info)
    unknown = [n for n in args.names if n not in trees]
    if unknown:
        print(f"no such worktree under {wt_dir}: {', '.join(unknown)} (there: {', '.join(sorted(trees)) or 'none'})", file=sys.stderr)
        return 2
    named = [trees[n][0] for n in args.names]

    all_procs = processes()
    mine, pid = set(), os.getpid()
    while pid in all_procs:          # this command and whoever started it
        mine.add(pid)
        pid = all_procs[pid]["ppid"]
    lines = []

    def describe(pids: list[int]) -> str:
        return ", ".join(f"pid {p} ({' '.join(all_procs[p]['cmd'])[:70]})" for p in pids if p in all_procs)

    # --- servers: in the main checkout or a named worktree; in any other worktree they are someone else's ---
    for pid, where in sorted(listening().items()):
        proc = all_procs.get(pid)
        if not proc or pid in mine or not inside(proc["cwd"], repo):
            continue
        what = f"the server on {', '.join(sorted(set(where)))}: pid {pid}, {' '.join(proc['cmd'])[:90]} (in {proc['cwd']})"
        other = next((n for n, (p, _) in trees.items() if inside(proc["cwd"], p) and p not in named), None)
        if other or args.keep_servers:
            lines.append(f"left {what}" + (f": the worktree {other} is not named" if other else ""))
        elif not args.apply:
            lines.append(f"would stop {what}")
        else:
            lines.append(f"{'COULD NOT STOP' if stop([pid]) else 'stopped'} {what}")
    all_procs = processes()

    # --- the named worktrees ---
    for name in args.names:
        path, info = trees[name]
        head, branch = info.get("HEAD", ""), info.get("branch", "").replace("refs/heads/", "")
        if inside(here, path):
            lines.append(f"kept {name}: this command runs inside it (leave the worktree first)")
            continue
        if "locked" in info:
            lines.append(f"kept {name}: locked")
            continue
        if not head or not git_ok(repo, "merge-base", "--is-ancestor", head, base):
            ahead = git(repo, "rev-list", "--count", f"{base}..{head}", check=False) or "?"
            lines.append(f"kept {name}: {ahead} commit(s) not in {base} (merge it first)")
            continue
        changes, links = [], []
        for line in git(path, "status", "--porcelain").splitlines():
            entry = path / line[3:].rstrip("/")
            (links if line.startswith("??") and entry.is_symlink() else changes).append(line[3:])
        if changes:
            lines.append(f"kept {name}: {len(changes)} uncommitted change(s) ({', '.join(changes[:3])}{' ...' if len(changes) > 3 else ''})")
            continue
        running = [p for p, proc in all_procs.items() if inside(proc["cwd"], path) and p not in mine]
        note = f", stopping {describe(running)}" if running else ""
        if not args.apply:
            lines.append(f"would remove {name} ({branch or 'detached'}){note}")
            continue
        left = stop(running) if running else []
        if left:
            lines.append(f"kept {name}: could not stop {describe(left)}")
            continue
        for link in links:           # the links to the main checkout's ignored folders: the links, never what they point at
            (path / link.rstrip("/")).unlink()
        try:
            git(repo, "worktree", "remove", str(path))
        except RuntimeError as e:
            lines.append(f"kept {name}: {e}")
            continue
        gone = ""
        if branch and branch != base:
            gone = ", branch deleted" if git_ok(repo, "branch", "-d", branch) else ", branch kept (git branch -d refused)"
        lines.append(f"removed {name} ({branch or 'detached'}){note.replace('stopping', 'stopped')}{gone}")
    rest = sorted(n for n in trees if n not in args.names)
    if rest:
        lines.append(f"not named, left alone: {', '.join(rest)}")

    print("\n".join(lines) if lines else "nothing to clear up")
    if not args.apply and any(line.startswith("would") for line in lines):
        print("(dry run: pass --apply to do it)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
