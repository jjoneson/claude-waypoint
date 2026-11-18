"""Tests for skills/plan/estimate.py: plans written to a temporary folder, and made-up session records.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "plan" / "estimate.py"
sys.path.insert(0, str(SCRIPT.parent))
import estimate  # noqa: E402

PLAN = """
    ---
    project: docs-site
    status: active
    phase: 3
    phases: 5
    next: Start on the search index.
    updated: 2026-01-15
    ---

    # Docs site

    ## Phases

    ### 1. Landing page: done (commit abc1234)

    - **Does:** the first page.
    - **Estimate:** 2h
    - **Took:** 3h

    ### 2. Navigation: done

    - **Estimate:** 1h
    - **Took:** 1h 30m

    ### 3. Search: in progress

    - **Does:** an index and a box to type in.
    - **Estimate:** 3h
    - **Took:** 1h

    ### 4. Dark mode: not started

    - **Estimate:** 2h

    ### 5. Launch: not started

    - **Estimate:** 2h

    ## Next

    Open the search index.
"""


class Folder:
    """A temporary folder holding a plan, and a Claude Code config folder with made-up session records."""

    def __init__(self, plan: str = PLAN):
        self._tmp = tempfile.TemporaryDirectory()
        self.top = Path(self._tmp.name)
        self.plan = self.top / "plans" / "docs-site.md"
        self.plan.parent.mkdir(parents=True)
        self.plan.write_text(textwrap.dedent(plan).lstrip("\n"))
        self.config = self.top / "config"

    def record(self, session: str, steps: list[tuple[int, str]]) -> None:
        """A session's record: each step is the seconds since the one before, and what the entry is."""
        folder = self.config / "projects" / "-work-repo"
        folder.mkdir(parents=True, exist_ok=True)
        at = datetime(2026, 1, 15, 9, 0, tzinfo=timezone.utc)
        rows = []
        for gap, kind in steps:
            at += timedelta(seconds=gap)
            stamp = at.isoformat().replace("+00:00", "Z")
            if kind == "prompt":
                rows.append({"type": "user", "timestamp": stamp, "message": {"role": "user", "content": "go on"}})
            elif kind == "result":
                rows.append({"type": "user", "timestamp": stamp, "message": {"content": [{"type": "tool_result", "content": "ok"}]}})
            elif kind == "meta":
                rows.append({"type": "user", "isMeta": True, "timestamp": stamp, "message": {"content": "a note"}})
            elif kind == "untimed":
                rows.append({"type": "mode", "mode": "auto"})
            else:
                rows.append({"type": "assistant", "timestamp": stamp, "message": {"content": [{"type": "text", "text": "working"}]}})
        (folder / f"{session}.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows) + "not json\n")

    def run(self, *args: str) -> tuple[int, str]:
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.config)}
        done = subprocess.run([sys.executable, str(SCRIPT), str(self.plan), *args], capture_output=True, text=True, env=env)
        return done.returncode, done.stdout + done.stderr

    def header(self) -> dict[str, str]:
        lines = self.plan.read_text().split("\n")
        end = lines.index("---", 1)
        return dict(line.split(": ", 1) for line in lines[1:end])

    def close(self) -> None:
        self._tmp.cleanup()


class Durations(unittest.TestCase):
    def test_durations_are_read_and_written(self) -> None:
        for text, seconds in (("45m", 2700), ("3h", 10800), ("1h 30m", 5400), ("1.5h", 5400), ("about 2h (a guess)", 7200), ("90 min", 5400)):
            self.assertEqual(estimate.parse_duration(text), seconds, text)
        self.assertIsNone(estimate.parse_duration("soon"))
        self.assertIsNone(estimate.parse_duration(""))
        self.assertEqual(estimate.show(2700), "45m")
        self.assertEqual(estimate.show(10800), "3h")
        self.assertEqual(estimate.show(5460), "1h 31m")
        # A forecast is no finer than it deserves.
        self.assertEqual(estimate.rough(5460), "1h 30m")
        self.assertEqual(estimate.rough(9 * 3600 + 400), "9h")
        self.assertEqual(estimate.rough(26 * 3600 + 1500), "26h")


class Remaining(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Folder()
        self.addCleanup(self.folder.close)

    def test_what_is_left_follows_how_finished_phases_went(self) -> None:
        code, out = self.folder.run()
        self.assertEqual(code, 0, out)
        # Finished phases took 4h 30m against 3h guessed; with one average phase (2h) of trust in the first guess
        # the factor is (4.5 + 2) / (3 + 2) = 1.3. Phase 3 needs 3h x 1.3 less the 1h taken; 4 and 5 need 2h x 1.3 each.
        self.assertIn("docs-site: 2 of 5 phases done", out)
        self.assertIn("estimated 10h in all; 5h 30m spent", out)
        self.assertIn("1.30x their estimates", out)
        self.assertIn("phase 3 in progress: 1h taken, about 3h left", out)
        self.assertIn("remaining: about 8h", out)
        self.assertEqual(self.folder.header()["estimate"], "10h")
        self.assertEqual(self.folder.header()["spent"], "5h 30m")
        self.assertEqual(self.folder.header()["remaining"], "8h")
        # The three lines sit before `updated`, and the rest of the plan is as it was.
        text = self.folder.plan.read_text()
        self.assertLess(text.index("remaining: 8h"), text.index("updated:"))
        self.assertIn("### 3. Search: in progress\n\n- **Does:** an index and a box to type in.\n- **Estimate:** 3h\n- **Took:** 1h\n", text)

    def test_running_it_again_changes_nothing(self) -> None:
        self.folder.run()
        first = self.folder.plan.read_text()
        self.folder.run()
        self.assertEqual(self.folder.plan.read_text(), first)

    def test_check_prints_and_writes_nothing(self) -> None:
        before = self.folder.plan.read_text()
        code, out = self.folder.run("--check")
        self.assertEqual(code, 0, out)
        self.assertIn("remaining: about 8h", out)
        self.assertEqual(self.folder.plan.read_text(), before)

    def test_a_phase_that_has_run_past_its_estimate_moves_the_factor_and_keeps_a_floor(self) -> None:
        code, out = self.folder.run("--took", "3=6h")
        self.assertEqual(code, 0, out)
        # Phase 3 at 6h is past 3h x 1.3, so it counts: (4.5 + 6 + 2) / (3 + 3 + 2) = 1.5625. It is taken to have a
        # fifth of 3h x 1.5625 left; phases 4 and 5 need 2h x 1.5625 each.
        self.assertIn("1.56x their estimates", out)
        self.assertIn("phase 3 in progress: 6h taken, about 55m left", out)
        self.assertIn("remaining: about 7h 15m", out)

    def test_a_plan_just_written_is_its_guess(self) -> None:
        fresh = Folder(PLAN.replace(": done (commit abc1234)", ": not started").replace("2. Navigation: done", "2. Navigation: not started")
                       .replace("3. Search: in progress", "3. Search: not started").replace("    - **Took:** 3h\n", "")
                       .replace("    - **Took:** 1h 30m\n", "").replace("    - **Took:** 1h\n", ""))
        self.addCleanup(fresh.close)
        code, out = fresh.run()
        self.assertEqual(code, 0, out)
        self.assertIn("0 of 5 phases done", out)
        self.assertIn("1.00x their estimates", out)
        self.assertEqual(fresh.header()["remaining"], "10h")
        self.assertEqual(fresh.header()["spent"], "0m")

    def test_a_phase_with_no_estimate_is_given_the_average_and_said(self) -> None:
        plan = self.folder.plan.read_text().replace("### 5. Launch: not started\n\n- **Estimate:** 2h\n", "### 5. Launch: not started\n\n- **Does:** ship it.\n")
        self.folder.plan.write_text(plan)
        code, out = self.folder.run()
        self.assertEqual(code, 0, out)
        self.assertIn("1 phase(s) have no estimate", out)
        self.assertIn("estimated 10h in all", out)       # 8h known, and their average of 2h for the fifth

    def test_with_no_estimates_at_all_what_is_left_is_unknown(self) -> None:
        plain = Folder("---\nproject: x\nstatus: active\nupdated: 2026-01-15\n---\n\n### 1. One: done\n\n### 2. Two: not started\n")
        self.addCleanup(plain.close)
        code, out = plain.run()
        self.assertEqual(code, 0, out)
        self.assertIn("remaining: unknown", out)
        self.assertEqual(plain.header()["remaining"], "unknown")

    def test_every_phase_done_leaves_nothing(self) -> None:
        text = self.folder.plan.read_text().replace("in progress", "done").replace("not started", "done")
        self.folder.plan.write_text(text)
        code, out = self.folder.run()
        self.assertEqual(code, 0, out)
        self.assertIn("remaining: nothing", out)
        self.assertEqual(self.folder.header()["remaining"], "0m")


class Sessions(unittest.TestCase):
    """A session's working time, read from its record: the time waiting on the person is left out."""

    def setUp(self) -> None:
        self.folder = Folder()
        self.addCleanup(self.folder.close)
        self.session = "0a1b2c3d-1111-2222-3333-444455556666"
        # The person types; 20 minutes of work with a 12-minute job in it; an hour waiting on the person; 10 more.
        self.folder.record(self.session, [
            (0, "prompt"), (60, "assistant"), (0, "untimed"), (720, "result"), (420, "assistant"),
            (3600, "prompt"), (300, "assistant"), (240, "meta"), (60, "assistant"),
        ])

    def test_a_session_is_logged_once_however_often_it_is_asked(self) -> None:
        code, out = self.folder.run("--log", "3", "--session", self.session)
        self.assertEqual(code, 0, out)
        self.assertIn("this session: 30m of work added to phase 3 (it has waited on the person 1h)", out)
        text = self.folder.plan.read_text()
        self.assertIn("- **Estimate:** 3h\n- **Took:** 1h 30m\n", text)
        self.assertTrue(text.rstrip("\n").endswith("<!-- estimate.py: sessions counted 0a1b2c3d=1800 -->"))
        self.assertEqual(self.folder.header()["spent"], "6h")

        # Asked again with nothing new in the record: nothing is added.
        code, out = self.folder.run("--log", "3", "--session", self.session)
        self.assertIn("this session: 0m of work added to phase 3", out)
        self.assertIn("- **Took:** 1h 30m\n", self.folder.plan.read_text())

        # The session goes on for 15 more minutes of work, and only those are added, to the phase it is on now.
        self.folder.record(self.session, [
            (0, "prompt"), (60, "assistant"), (720, "result"), (420, "assistant"),
            (3600, "prompt"), (300, "assistant"), (240, "meta"), (60, "assistant"), (900, "assistant"),
        ])
        code, out = self.folder.run("--log", "4", "--session", self.session)
        self.assertIn("this session: 15m of work added to phase 4", out)
        text = self.folder.plan.read_text()
        self.assertIn("### 4. Dark mode: not started\n\n- **Estimate:** 2h\n- **Took:** 15m\n", text)
        self.assertEqual(text.count("estimate.py: sessions counted"), 1)
        self.assertIn("0a1b2c3d=2700", text)

    def test_a_phase_with_no_bullets_yet_gets_its_time_under_its_heading(self) -> None:
        self.folder.plan.write_text(self.folder.plan.read_text().replace("### 5. Launch: not started\n\n- **Estimate:** 2h\n", "### 5. Launch: not started\n"))
        code, out = self.folder.run("--log", "5", "--session", self.session)
        self.assertEqual(code, 0, out)
        self.assertIn("### 5. Launch: not started\n\n- **Took:** 30m\n", self.folder.plan.read_text())

    def test_with_no_record_nothing_is_added_and_it_says_how_to_set_it(self) -> None:
        before = self.folder.plan.read_text()
        code, out = self.folder.run("--log", "3", "--session", "ffffffff-0000-0000-0000-000000000000")
        self.assertEqual(code, 0, out)
        self.assertIn("nothing added to phase 3: no record of session ffffffff on this machine. Set its time with --took 3=<time>", out)
        self.assertIn("- **Took:** 1h\n", self.folder.plan.read_text())
        self.assertNotIn("sessions counted", self.folder.plan.read_text())
        self.assertNotEqual(self.folder.plan.read_text(), before)      # the header's three lines are still written

    def test_a_time_set_by_hand_and_a_phase_that_is_not_there(self) -> None:
        code, out = self.folder.run("--took", "4=45m")
        self.assertEqual(code, 0, out)
        self.assertIn("phase 4's time set to 45m", out)
        self.assertIn("- **Estimate:** 2h\n- **Took:** 45m\n", self.folder.plan.read_text())
        self.assertEqual(self.folder.run("--log", "9", "--session", self.session)[0], 2)
        self.assertEqual(self.folder.run("--took", "4=soon")[0], 2)


if __name__ == "__main__":
    unittest.main()
