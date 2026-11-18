#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 jjoneson. From waypoint: https://github.com/jjoneson/claude-waypoint
"""Keeps a plan's time estimate: what is spent, and what is left, from how its phases have gone so far.

    python3 estimate.py <plan.md>                          work it out again and write it into the plan
    python3 estimate.py <plan.md> --log 3 --session <id>   first add this session's working time to phase 3
    python3 estimate.py <plan.md> --took 3=1h30m           set phase 3's time by hand
    --check    print the figures and change nothing

Time is working time: what sessions spend on a phase, Claude's work and the
checks and jobs it waits on, and not the time a session sits waiting for the
person. In the plan it stands on each phase:

    ### 2. Payment form: in progress

    - **Estimate:** 3h
    - **Took:** 1h 40m

`Estimate` is a guess made when the plan is written (and changed when the phase
changes); `Took` is kept by this script. From them it writes three lines into
the plan's header, which the Plans pane shows:

    estimate: 14h         every phase's estimate, added up
    spent: 5h 20m         every phase's Took, added up
    remaining: 11h        what the phases still open are now taken to need

What is left. A phase not started is taken to need its estimate times a
factor: the time finished phases took over what was guessed for them. The
first guess is trusted for one average phase's worth, so one slow phase moves
the factor only part of the way and the figure settles as phases finish. A
phase in progress needs its scaled estimate less what it has taken, and never
less than a fifth of it. A phase that has already run past its scaled
estimate counts towards the factor too. A phase with no estimate is given the
average of the others.

Measuring a session. `--log` reads Claude Code's own record of the session
(`<config>/projects/*/<session id>.jsonl`), adds up the time between its
entries, and leaves out every stretch that ended with the person typing: that
was the session waiting. What this session has been counted for is kept in a
comment at the end of the plan, so logging twice adds only what is new. Where
there is no record (a session that keeps none, another machine), nothing is
added and it says so: use `--took`.

Durations are written `45m`, `3h`, `1h 30m` or `1.5h`. No dependencies.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

HEADING = re.compile(r"^###\s+(\d+)\.\s+(.+?):\s*(not started|in progress|done)\b", re.I)
BULLET = re.compile(r"^(\s*[-*]\s+\*\*(Estimate|Took):\*\*\s*)(.*)$", re.I)
MARK = re.compile(r"^<!-- estimate\.py: sessions counted (.*?) -->\s*$")
#: While a phase is in progress, at least this share of its scaled estimate is taken to be left.
FLOOR = 0.2


# --- durations ---------------------------------------------------------------------------------------------------

def parse_duration(text: str) -> int | None:
    """Seconds in `45m`, `3h`, `1h 30m`, `1.5h` at the start of the text; None when it starts with none."""
    m = re.match(
        r"\s*(?:about|around|roughly|~)?\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?", text, re.I
    )
    if not m or (m.group(1) is None and m.group(2) is None):
        return None
    return round(float(m.group(1) or 0) * 3600) + int(m.group(2) or 0) * 60


def show(seconds: float, step: int = 60) -> str:
    """A duration to the nearest `step` seconds: `45m`, `3h`, `1h 30m`."""
    minutes = max(0, int(round(seconds / step) * step // 60))
    hours, rest = divmod(minutes, 60)
    if hours and rest:
        return f"{hours}h {rest:02d}m"
    return f"{hours}h" if hours else f"{rest}m"


def rough(seconds: float) -> str:
    """A forecast, no finer than it deserves: to 5 minutes under two hours, to 15 above, to the hour past a day's work."""
    return show(seconds, 300 if seconds < 7200 else 900 if seconds < 36000 else 3600)


# --- the plan ----------------------------------------------------------------------------------------------------

@dataclass
class Phase:
    n: int
    name: str
    state: str
    start: int                      # the heading's line
    end: int                        # the line after its last
    estimate: int | None = None
    took: int | None = None
    estimate_line: int | None = None
    took_line: int | None = None


def phases_of(lines: list[str]) -> list[Phase]:
    out: list[Phase] = []
    for i, line in enumerate(lines):
        head = HEADING.match(line)
        if head:
            if out:
                out[-1].end = i
            out.append(Phase(int(head.group(1)), head.group(2).strip(), head.group(3).lower(), i, len(lines)))
        elif out and re.match(r"^##\s", line):
            out[-1].end = min(out[-1].end, i)
    for phase in out:
        for i in range(phase.start + 1, phase.end):
            bullet = BULLET.match(lines[i])
            if not bullet:
                continue
            seconds = parse_duration(bullet.group(3))
            if bullet.group(2).lower() == "estimate" and phase.estimate_line is None:
                phase.estimate, phase.estimate_line = seconds, i
            elif bullet.group(2).lower() == "took" and phase.took_line is None:
                phase.took, phase.took_line = seconds, i
    return out


def set_took(lines: list[str], phase: Phase, seconds: int) -> None:
    """Writes a phase's Took line, under its Estimate where it has none yet."""
    text = f"- **Took:** {show(seconds)}"
    if phase.took_line is not None:
        lines[phase.took_line] = BULLET.match(lines[phase.took_line]).group(1) + show(seconds)
        return
    if phase.estimate_line is not None:
        at = phase.estimate_line + 1
    else:
        at = phase.start + 1
        while at < phase.end and not lines[at].strip():
            at += 1                  # under the heading's blank line, at the head of its bullets
        if at == phase.end or not re.match(r"^\s*[-*]\s", lines[at]):
            lines.insert(phase.start + 1, "")
            at = phase.start + 2
    lines.insert(at, text)


@dataclass
class Figures:
    estimate: int
    spent: int
    remaining: int
    factor: float
    done: int
    total: int
    unestimated: int
    current: Phase | None
    current_left: int

    @property
    def is_unknown(self) -> bool:
        """Phases are still open and none of the plan's phases has an estimate to go by."""
        return self.done < self.total and self.estimate == 0


def figures(phases: list[Phase]) -> Figures:
    known = [p.estimate for p in phases if p.estimate]
    average = sum(known) / len(known) if known else 0
    guess = {p.n: (p.estimate or average) for p in phases}
    done = [p for p in phases if p.state == "done" and p.took is not None]
    took = sum(p.took or 0 for p in done)
    guessed = sum(guess[p.n] for p in done)

    def factor_of(took: float, guessed: float) -> float:
        # The first guess is trusted for one average phase's worth of evidence.
        return (took + average) / (guessed + average) if guessed + average else 1.0

    factor = factor_of(took, guessed)
    current = next((p for p in phases if p.state == "in progress"), None)
    if current and (current.took or 0) > guess[current.n] * factor:
        factor = factor_of(took + (current.took or 0), guessed + guess[current.n])
    left = 0.0
    current_left = 0.0
    for p in phases:
        need = guess[p.n] * factor
        if p.state == "not started":
            left += need
        elif p.state == "in progress":
            current_left = max(need - (p.took or 0), FLOOR * need)
            left += current_left
    return Figures(
        estimate=int(sum(guess.values())),
        spent=sum(p.took or 0 for p in phases),
        remaining=int(left),
        factor=factor,
        done=sum(1 for p in phases if p.state == "done"),
        total=len(phases),
        unestimated=sum(1 for p in phases if not p.estimate),
        current=current,
        current_left=int(current_left),
    )


def set_header(lines: list[str], values: dict[str, str]) -> bool:
    """Writes the header's lines for the keys given, before `updated` where they are new. False with no header."""
    if not lines or lines[0].strip() != "---":
        return False
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return False
    for key, value in values.items():
        at = next((i for i in range(1, end) if re.match(rf"^{key}:\s", lines[i] + " ")), None)
        if at is not None:
            lines[at] = f"{key}: {value}"
            continue
        before = next((i for i in range(1, end) if lines[i].startswith("updated:")), end)
        lines.insert(before, f"{key}: {value}")
        end += 1
    return True


# --- a session's working time ------------------------------------------------------------------------------------

def record_of(session: str) -> Path | None:
    base = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
    found = sorted(glob.glob(str(base / "*" / f"{glob.escape(session)}.jsonl")), key=os.path.getmtime)
    return Path(found[-1]) if found else None


def is_prompt(entry: dict) -> bool:
    """Whether an entry of the record is the person typing, and not a tool's answer or a note the session wrote."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        return not any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content)
    return True


def worked(record: Path) -> tuple[int, int]:
    """Seconds a session has worked, and seconds it has waited on the person, from its record."""
    work = wait = 0.0
    last = None
    with open(record, encoding="utf-8", errors="replace") as lines:
        for line in lines:
            try:
                entry = json.loads(line)
                at = datetime.fromisoformat(str(entry["timestamp"]).replace("Z", "+00:00"))
            except (ValueError, KeyError, TypeError):
                continue
            if last is not None and at > last:
                if is_prompt(entry):
                    wait += (at - last).total_seconds()
                else:
                    work += (at - last).total_seconds()
            last = at if last is None or at > last else last
    return int(work), int(wait)


def counted(lines: list[str]) -> tuple[dict[str, int], int | None]:
    """What each session has been counted for already, from the comment at the plan's end, and that comment's line."""
    for i in range(len(lines) - 1, -1, -1):
        mark = MARK.match(lines[i])
        if mark:
            pairs = (pair.split("=") for pair in mark.group(1).split())
            return {key: int(value) for key, value in pairs if value.isdigit()}, i
    return {}, None


def set_counted(lines: list[str], sessions: dict[str, int], at: int | None) -> None:
    kept = " ".join(f"{key}={value}" for key, value in list(sessions.items())[-40:])
    text = f"<!-- estimate.py: sessions counted {kept} -->"
    if at is not None:
        lines[at] = text
    else:
        while lines and not lines[-1].strip():
            lines.pop()
        lines += ["", text]


# --- the command -------------------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("plan", help="the plan file")
    ap.add_argument("--log", type=int, metavar="N", help="add this session's working time to phase N")
    ap.add_argument("--session", help="the session's id, for --log")
    ap.add_argument("--took", action="append", default=[], metavar="N=TIME", help="set phase N's time by hand")
    ap.add_argument("--check", action="store_true", help="print the figures and change nothing")
    args = ap.parse_args()

    path = Path(args.plan)
    if not path.is_file():
        print(f"no plan at {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    phases = phases_of(lines)
    if not phases:
        print(f'{path} has no phase headings ("### N. Name: not started | in progress | done")', file=sys.stderr)
        return 2
    notes: list[str] = []

    def phase_numbered(n: int) -> Phase | None:
        return next((p for p in phases_of(lines) if p.n == n), None)

    for pair in args.took:
        n, _, value = pair.partition("=")
        seconds = parse_duration(value)
        phase = phase_numbered(int(n)) if n.strip().isdigit() else None
        if phase is None or seconds is None:
            print(f"--took {pair}: wants a phase's number and a time, as in 3=1h30m", file=sys.stderr)
            return 2
        set_took(lines, phase, seconds)
        notes.append(f"phase {phase.n}'s time set to {show(seconds)}")

    if args.log is not None:
        phase = phase_numbered(args.log)
        if phase is None:
            print(f"--log {args.log}: the plan has no phase {args.log}", file=sys.stderr)
            return 2
        record = record_of(args.session) if args.session else None
        if record is None:
            why = "no --session given" if not args.session else f"no record of session {args.session[:8]} on this machine"
            notes.append(f"nothing added to phase {phase.n}: {why}. Set its time with --took {phase.n}=<time>")
        else:
            work, wait = worked(record)
            sessions, at = counted(lines)
            key = args.session[:8]
            new = max(0, work - sessions.get(key, 0))
            set_took(lines, phase, (phase.took or 0) + new)
            sessions.pop(key, None)
            sessions[key] = work
            _, at = counted(lines)               # the Took line may have moved it
            set_counted(lines, sessions, at)
            notes.append(f"this session: {show(new)} of work added to phase {phase.n} (it has waited on the person {show(wait)})")

    phases = phases_of(lines)
    f = figures(phases)
    name = path.stem
    print(f"{name}: {f.done} of {f.total} phases done")
    print(f"  estimated {show(f.estimate)} in all; {show(f.spent)} spent")
    if f.unestimated:
        print(f"  {f.unestimated} phase(s) have no estimate and are given the average of the others: add `- **Estimate:**` to each")
    if f.estimate:
        print(f"  phases are taken to need {f.factor:.2f}x their estimates, from how they have gone so far")
    if f.current:
        print(f"  phase {f.current.n} in progress: {show(f.current.took or 0)} taken, about {rough(f.current_left)} left")
    if f.is_unknown:
        print("  remaining: unknown: no phase has an estimate yet")
    else:
        print(f"  remaining: about {rough(f.remaining)}" if f.remaining else "  remaining: nothing: every phase is done")
    for note in notes:
        print(f"  {note}")

    left = "unknown" if f.is_unknown else rough(f.remaining) if f.remaining else "0m"
    values = {"estimate": show(f.estimate), "spent": show(f.spent), "remaining": left}
    if not set_header(lines, values):
        print("  the plan has no header (--- ... ---): the figures are not written into it")
    new_text = "\n".join(lines)
    if args.check or new_text == text:
        return 0
    if set_header(lines, {"updated": date.today().isoformat()}):
        new_text = "\n".join(lines)
    path.write_text(new_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
