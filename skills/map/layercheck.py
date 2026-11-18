#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 jjoneson. From waypoint: https://github.com/jjoneson/claude-waypoint
"""Checks every import in a source tree against the module map in docs/architecture.md.

    python3 layercheck.py                  check, from the repository's top folder
    python3 layercheck.py --quiet          print only what fails
    python3 layercheck.py --draft          print the map as the code stands today, to start one from
    --map FILE   the map (default docs/architecture.md)
    --root DIR   the source folder the map's paths are under (default: what the map says; else the base
                 package's folder under src/main/java or src/main/kotlin; else src/; else .)

The map is the document people and agents read, so there is one map and it
cannot drift from the code. In it, every Markdown table with a "May import"
column is read:

    | Directory | What it owns | May import |
    | --- | --- | --- |
    | `orders/` | the order rules | `catalog/`, `billing/rates.ts`, the types of `billing/money.ts` |
    | `tools/` | scripts | anything |
    | `util/` | helpers | nothing else |

The first column names a place under the source folder: a directory (`orders/`,
`packages/api/`) or a single file at the top (`main.ts`). The deepest place a
file sits in is its place. "May import" lists, in backticks, what the place
may import besides itself: a directory, a single file, or "the types of" one
(type-only imports: `import type` in TypeScript, imports under
`if TYPE_CHECKING:` in Python). A cell with no backticks is nothing; one that
starts with "anything" is not checked.

Lines for this script are HTML comments, which a rendered page does not show:

    <!-- layercheck: root=src alias=@/=. ignore=generated/ -->
        root     the source folder
        alias    an import prefix and the folder under root it stands for
        ignore   a folder under root that is not source (repeat for more)
    <!-- layercheck: within=web -->
        the next table maps the folders inside web/ against each other;
        `*` there is the files at the top of web/
    <!-- layercheck: known -->
        the next table (From | To | Why) lists imports that break the map
        today, each until the change that removes it

It fails on an import the map does not allow, a source directory the map
leaves out, a name in the map that is no longer there, and a known exception
that nothing matches any more. Exit status 1 when anything fails.

It reads JavaScript and TypeScript (static and dynamic imports, re-exports,
require, `new URL('…', import.meta.url)`), Python, Java and Kotlin. Imports of
packages and of files outside the source folder are not its business. No
dependencies.

Java and Kotlin. An import names a class by its package, so the source folder
is the base package's folder and the rows are its sub-packages:

    <!-- layercheck: root=src/main/java/com/acme/shop -->

    | Directory | What it owns | May import |
    | --- | --- | --- |
    | `ShopApplication.java` | the entry | nothing else |
    | `web/` | controllers | `service/`, `domain/` |
    | `service/` | use cases | `repository/`, `domain/` |
    | `repository/` | persistence | `domain/` |
    | `domain/` | entities | nothing else |

`import com.acme.shop.domain.Order;` is an import of `domain/Order.java`, and
so are its nested classes and static members. `import com.acme.shop.domain.*;`
is an import of all of `domain/` (shown as `domain/*`), and so is an import of
a name no file is called after: a Kotlin function, a generated class. Classes
of the same package need no import and are one place anyway. A class used by
its full name with no import is not seen. There are no type-only imports. In
a build of several modules, give each module its own map and run this from
the module's folder: between modules the build's own dependencies hold the line.
"""

from __future__ import annotations

import argparse
import ast
import bisect
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

JS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
PY = (".py",)
JVM = (".java", ".kt")
SKIP_DIRS = {"node_modules", "dist", "build", "out", "target", "coverage", "__pycache__", "venv", "site-packages"}


# --- the map -----------------------------------------------------------------------------------------------------

@dataclass
class Allowance:
    path: str            # under root (or under the directory a table is within); "." is the files at its top
    types_only: bool = False


@dataclass
class Row:
    key: str
    allows: list[Allowance]
    anything: bool
    line: int


@dataclass
class Map:
    root: str | None = None
    aliases: list[tuple[str, str]] = field(default_factory=list)
    ignore: list[str] = field(default_factory=list)
    top: dict[str, Row] = field(default_factory=dict)
    within: dict[str, dict[str, Row]] = field(default_factory=dict)
    known: dict[tuple[str, str], str] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)


def clean(name: str) -> str:
    """A place as the map writes it (`orders/`, `*`, `main.ts`) as a path: `orders`, `.`, `main.ts`."""
    name = name.strip().strip("`").strip()
    if name in ("*", "."):
        return "."
    return name.strip("/").replace("\\", "/")


def cells(line: str) -> list[str]:
    parts = re.split(r"(?<!\\)\|", line.strip())
    return [p.strip() for p in parts[1:-1]] if len(parts) >= 3 else []


def parse_map(text: str) -> Map:
    m = Map()
    lines = text.splitlines()
    within: str | None = None
    known_next = False
    i = 0
    while i < len(lines):
        line = lines[i]
        said = re.search(r"<!--\s*layercheck:\s*(.*?)\s*-->", line)
        if said:
            for token in said.group(1).split():
                key, _, value = token.partition("=")
                if key == "root":
                    m.root = value.strip("/") or "."
                elif key == "alias" and "=" in value:
                    prefix, _, to = value.rpartition("=")
                    m.aliases.append((prefix, clean(to)))
                elif key == "ignore":
                    m.ignore.append(clean(value))
                elif key == "within":
                    within = clean(value)
                elif key == "known":
                    known_next = True
                else:
                    m.problems.append(f"line {i + 1}: layercheck does not know `{token}`")
        is_table = line.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1])
        if not is_table:
            i += 1
            continue
        head = [c.lower() for c in cells(line)]
        j = i + 2
        rows = []
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            rows.append((j + 1, cells(lines[j])))
            j += 1
        if known_next and "from" in head and "to" in head:
            a, b = head.index("from"), head.index("to")
            why = head.index("why") if "why" in head else None
            for n, row in rows:
                if len(row) > max(a, b):
                    m.known[(clean(row[a]), clean(row[b]))] = row[why] if why is not None and len(row) > why else ""
            known_next = False
        elif "may import" in head:
            col = head.index("may import")
            table = m.within.setdefault(within, {}) if within else m.top
            for n, row in rows:
                if len(row) <= col:
                    continue
                name = re.search(r"`([^`]+)`", row[0])
                if not name:
                    continue
                allows = [Allowance(clean(p), bool(t)) for t, p in re.findall(r"(the types of\s+)?`([^`]+)`", row[col])]
                key = clean(name.group(1))
                if key in table:
                    m.problems.append(f"line {n}: `{name.group(1)}` has a row already")
                table[key] = Row(key, allows, row[col].lower().lstrip("*_ ").startswith("anything"), n)
            within = None
        i = j
    return m


# --- the code ----------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Edge:
    src: str             # the importing file, under root
    to: str              # the imported file, under root
    line: int
    types_only: bool


def sources(root: Path, ignore: list[str]) -> list[str]:
    out = []
    for folder, dirs, files in os.walk(root):
        rel = Path(folder).relative_to(root).as_posix()
        rel = "" if rel == "." else rel
        dirs[:] = sorted(
            d for d in dirs
            if not d.startswith(".") and d not in SKIP_DIRS and (f"{rel}/{d}" if rel else d) not in ignore
        )
        for name in sorted(files):
            if name.endswith(JS + PY + JVM) and not name.endswith((".d.ts", ".d.mts", ".d.cts")):
                out.append(f"{rel}/{name}" if rel else name)
    return out


def blank_comments(text: str) -> tuple[str, list[tuple[int, int]]]:
    """JavaScript with its comments blanked out and every line where it was, and where its strings are."""
    out = []
    strings: list[tuple[int, int]] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        two = text[i:i + 2]
        if two == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif two == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", text[i:j]))
            i = j
        elif c in "'\"`":
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\\":
                    j += 1
                elif text[j] == "\n" and c != "`":
                    break            # an unclosed quote: a regular expression or an apostrophe in JSX text
                j += 1
            out.append(text[i:j + 1])
            strings.append((i, j))
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out), strings


Q = r"""(['"])([^'"\n]+)\{}"""
JS_PATTERNS = [
    # import a, { b } from 'x' / import type { T } from 'x'
    ("import", re.compile(r"\bimport\s+(type\s+)?((?:[\w$*{}\s,]|\bas\b)+?)\s*\bfrom\s*" + Q.format(3))),
    # import 'x'
    ("side", re.compile(r"\bimport\s*" + Q.format(1))),
    # export { a } from 'x' / export * from 'x' / export type { T } from 'x'
    ("export", re.compile(r"\bexport\s+(type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*" + Q.format(3))),
    # import('x'), as a call or as a type
    ("dynamic", re.compile(r"\bimport\s*\(\s*" + Q.format(1) + r"\s*\)")),
    ("require", re.compile(r"\brequire\s*\(\s*" + Q.format(1) + r"\s*\)")),
    ("url", re.compile(r"\bnew\s+URL\s*\(\s*" + Q.format(1) + r"\s*,\s*import\.meta\.url")),
]


def all_types(clause: str) -> bool:
    """Whether an import or export clause names only types: `{ type A, type B }`."""
    clause = clause.strip()
    if not clause.startswith("{") or not clause.endswith("}"):
        return False
    names = [p.strip() for p in clause[1:-1].split(",") if p.strip()]
    return bool(names) and all(re.match(r"type\s+[\w$]", p) for p in names)


def js_imports(text: str) -> list[tuple[str, int, bool]]:
    """Each import in a JavaScript or TypeScript file: what it names, its line, and whether it takes only types."""
    code, strings = blank_comments(text)
    starts = [s for s, _ in strings]
    found: dict[int, tuple[str, int, bool]] = {}
    for kind, pattern in JS_PATTERNS:
        for hit in pattern.finditer(code):
            at = hit.start()
            before_it = bisect.bisect_right(starts, at) - 1
            if before_it >= 0 and at <= strings[before_it][1]:
                continue                     # the words of an import inside a string are not one
            if kind in ("import", "export"):
                spec, types = hit.group(4), bool(hit.group(1)) or all_types(hit.group(2))
            else:
                spec, types = hit.group(2), False
            if kind == "dynamic":
                # `typeof import('x')` and `import('x').Name` are types; a call is awaited, chained or passed on.
                before, after = code[max(0, at - 12):at].rstrip(), code[hit.end():hit.end() + 8]
                chained = re.match(r"\s*\.\s*(then|catch|finally)\b", after)
                types = before.endswith("typeof") or (bool(re.match(r"\s*\.\s*[A-Za-z_$]", after)) and not chained)
            if kind == "side" and at in found:
                continue
            found.setdefault(at, (spec, code.count("\n", 0, at) + 1, types))
    return [found[at] for at in sorted(found)]


def js_target(root: Path, file: str, spec: str, aliases: list[tuple[str, str]], tops: set[str]) -> str | None:
    """The file a JavaScript import names, under root; None for a package or a file outside root."""
    spec = spec.split("?")[0]
    if spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(file), spec))
    else:
        base = next((os.path.normpath(os.path.join(to, spec[len(p):])) for p, to in aliases if spec.startswith(p)), None)
        if base is None:
            # A path from the source folder itself (`baseUrl`), when it is one: its first part is a folder there.
            if spec.split("/")[0] not in tops:
                return None
            base = os.path.normpath(spec)
            if not any((root / c).is_file() for c in js_candidates(base)):
                return None
    base = base.replace(os.sep, "/")
    if base.startswith(".."):
        return None
    return next((c for c in js_candidates(base) if (root / c).is_file()), base)


def js_candidates(base: str) -> list[str]:
    out = [base]
    stem, ext = os.path.splitext(base)
    if ext in (".js", ".jsx", ".mjs", ".cjs"):      # `./x.js` written for the `x.ts` it is built from
        out += [stem + e for e in (".ts", ".tsx", ".mts", ".cts")]
    out += [base + e for e in JS]
    out += [f"{base}/index{e}" for e in JS]
    return out


def py_imports(text: str, file: str) -> list[tuple[list[str], int, bool, int, list[str]]]:
    """Each import in a Python file: the module's parts, its line, types only, the dots before it, the names taken."""
    tree = ast.parse(text, filename=file)
    out = []

    def visit(node: ast.AST, typing_only: bool) -> None:
        if isinstance(node, ast.If):
            test = ast.unparse(node.test) if hasattr(ast, "unparse") else ""
            is_typing = test in ("TYPE_CHECKING", "typing.TYPE_CHECKING")
            for child in node.body:
                visit(child, typing_only or is_typing)
            for child in node.orelse:
                visit(child, typing_only)
            return
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((alias.name.split("."), node.lineno, typing_only, 0, []))
        elif isinstance(node, ast.ImportFrom):
            parts = node.module.split(".") if node.module else []
            out.append((parts, node.lineno, typing_only, node.level, [a.name for a in node.names]))
        for child in ast.iter_child_nodes(node):
            visit(child, typing_only)

    visit(tree, False)
    return out


def py_target(root: Path, file: str, parts: list[str], level: int, name: str | None) -> str | None:
    """The file a Python import names, under root; None for a package from elsewhere."""
    if level:
        base = os.path.dirname(file)
        for _ in range(level - 1):
            base = os.path.dirname(base)
        starts = [[p for p in base.split("/") if p] + parts]
    else:
        starts = [parts] + ([parts[1:]] if parts and parts[0] == root.resolve().name and len(parts) > 1 else [])
    for start in starts:
        for tail in ([name] if name and name != "*" else []) + [None]:
            path = "/".join(start + ([tail] if tail else []))
            if not path:
                continue
            for candidate in (f"{path}.py", f"{path}/__init__.py"):
                if (root / candidate).is_file():
                    return candidate
    return None


JVM_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)", re.M)
JVM_IMPORT = re.compile(r"^[ \t]*import\s+(?:static\s+)?([\w.]+?)(\.\*)?[ \t]*(?:as\s+\w+[ \t]*)?;?[ \t]*$", re.M)
# Imports come before the first declaration; what looks like one further down is inside a text block.
JVM_BODY = re.compile(
    r"^[ \t]*(?:(?:public|private|protected|internal|abstract|final|sealed|non-sealed|static|strictfp|open|data|value"
    r"|inline|annotation|expect|actual)\s+)*(?:class|interface|enum|record|object|fun|val|var|typealias|@interface)\b",
    re.M,
)


def jvm_scan(text: str) -> tuple[str, list[tuple[str, bool, int]]]:
    """A Java or Kotlin file's package, and each import: the name, whether it ends in `.*`, and its line."""
    code, _ = blank_comments(text)
    body = JVM_BODY.search(code)
    head = code[:body.start()] if body else code
    package = JVM_PACKAGE.search(head)
    imports = [(m.group(1), bool(m.group(2)), head.count("\n", 0, m.start(1)) + 1) for m in JVM_IMPORT.finditer(head)]
    return (package.group(1) if package else ""), imports


@dataclass
class JvmIndex:
    """The Java and Kotlin classes in the source folder, by full name, and the folders of each package."""
    classes: dict[str, str] = field(default_factory=dict)
    packages: dict[str, set[str]] = field(default_factory=dict)

    def add(self, file: str, package: str) -> None:
        stem = os.path.splitext(os.path.basename(file))[0]
        self.classes.setdefault(f"{package}.{stem}" if package else stem, file)
        self.packages.setdefault(package, set()).add(os.path.dirname(file))

    def targets(self, name: str, wildcard: bool) -> list[str]:
        """What an import names under root: a class's file, or all of a package's folder as `folder/*`."""
        parts = name.split(".")
        for i in range(len(parts), 0, -1):      # the class itself, or the class a nested class or member is in
            hit = self.classes.get(".".join(parts[:i]))
            if hit:
                return [hit]
        package = name if wildcard else ".".join(parts[:-1])
        return [f"{folder}/*" if folder else "*" for folder in sorted(self.packages.get(package, ()))]


def edges_of(root: Path, files: list[str], aliases: list[tuple[str, str]]) -> tuple[list[Edge], list[str]]:
    tops = {f.split("/")[0] for f in files if "/" in f}
    edges: list[Edge] = []
    unread: list[str] = []
    index = JvmIndex()
    jvm: list[tuple[str, list[tuple[str, bool, int]]]] = []
    for file in files:
        try:
            text = (root / file).read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            unread.append(f"{file}: {e}")
            continue
        if file.endswith(JVM):
            package, imports = jvm_scan(text)
            index.add(file, package)
            jvm.append((file, imports))         # followed below, once every class is known
        elif file.endswith(PY):
            try:
                found = py_imports(text, file)
            except SyntaxError as e:
                unread.append(f"{file}: not read as Python (line {e.lineno})")
                continue
            for parts, line, types, level, names in found:
                targets = {py_target(root, file, parts, level, n) for n in (names or [None])}
                edges += [Edge(file, t, line, types) for t in sorted(t for t in targets if t and t != file)]
        else:
            for spec, line, types in js_imports(text):
                to = js_target(root, file, spec, aliases, tops)
                if to and to != file:
                    edges.append(Edge(file, to, line, types))
    for file, imports in jvm:
        own = f"{os.path.dirname(file)}/*" if "/" in file else "*"
        for name, wildcard, line in imports:
            edges += [Edge(file, to, line, False) for to in index.targets(name, wildcard) if to not in (file, own)]
    return edges, unread


# --- the check ---------------------------------------------------------------------------------------------------

def place_of(path: str, keys: list[str]) -> str | None:
    """The deepest place in the map a file sits in."""
    return next((k for k in keys if path == k or path.startswith(k + "/")), None)


def folder_of(inner: str) -> str:
    return inner.split("/")[0] if "/" in inner else "."


def allowed(row: Row | None, place: str, path: str, types_only: bool) -> bool:
    if row is None:
        return False
    if row.anything:
        return True
    return any(
        (types_only or not a.types_only) and (a.path == place or path == a.path or path.startswith(a.path + "/"))
        for a in row.allows
    )


def show(name: str, base: str = "") -> str:
    full = (f"{base}/*" if name == "." else f"{base}/{name}") if base else name
    return full if re.search(r"\.\w+$|\*$", full) else f"{full}/"


def listed(row: Row, base: str = "") -> str:
    if row.anything:
        return "anything (not checked)"
    names = [("the types of " if a.types_only else "") + show(a.path, base) for a in row.allows]
    if not names:
        return "nothing else"
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def check(root: Path, m: Map, label: str, quiet: bool) -> int:
    files = sources(root, m.ignore)
    edges, unread = edges_of(root, files, m.aliases)
    keys = sorted(m.top, key=len, reverse=True)
    broken: dict[str, list[Edge]] = {}
    used: set[tuple[str, str]] = set()
    for e in edges:
        a, b = place_of(e.src, keys), place_of(e.to, keys)
        if a is None:
            continue                         # reported below, as a directory the map leaves out
        if a != b or a not in m.within:
            ok = a == b or allowed(m.top[a], b or "", e.to, e.types_only)
            key = a
        else:
            fa, fb = folder_of(e.src[len(a) + 1:]), folder_of(e.to[len(a) + 1:])
            ok = fa == fb or allowed(m.within[a].get(fa), fb, e.to[len(a) + 1:], e.types_only)
            key = f"{a}//{fa}"
        if ok:
            continue
        if (e.src, e.to) in m.known:
            used.add((e.src, e.to))
            continue
        broken.setdefault(key, []).append(e)

    failed = 0
    prefix = "" if label == "." else f"{label}/"

    def report(ok: bool, claim: str, details: list[str]) -> None:
        nonlocal failed
        failed += 0 if ok else 1
        if not ok or not quiet:
            print(f"  {'ok  ' if ok else 'FAIL'}  {claim}")
        for detail in ([] if ok else details):
            print(f"        {detail}")

    def lines(key: str) -> list[str]:
        return [f"{prefix}{e.src}:{e.line} imports {prefix}{e.to}{' (types)' if e.types_only else ''}" for e in broken.get(key, [])]

    if not quiet:
        print("what each directory may import")
    for key, row in m.top.items():
        report(key not in broken, f"{show(key)} may import {listed(row)}", lines(key))
    for base, table in m.within.items():
        if not quiet:
            print(f"what each of {base}'s folders may import from the others")
        for folder, row in table.items():
            report(f"{base}//{folder}" not in broken, f"{show(folder, base)} may import {listed(row, base)}", lines(f"{base}//{folder}"))

    if not quiet:
        print("the map")
    left_out = set()
    for f in files:
        place = place_of(f, keys)
        if place is None:
            left_out.add(f"{prefix}{f.split('/')[0]}{'/' if '/' in f else ''} is not in the map")
        elif place in m.within and folder_of(f[len(place) + 1:]) not in m.within[place]:
            left_out.add(f"{prefix}{show(folder_of(f[len(place) + 1:]), place)} is not in the map of {place}/")
    gone = set()
    for key, row in m.top.items():
        for path in [key] + [a.path for a in row.allows]:
            if not (root / path).exists():
                gone.add(f"{prefix}{path} is named in the map and is not there")
    for base, table in m.within.items():
        if base not in m.top:
            gone.add(f"{prefix}{base}/ has a table of its folders and no row of its own")
        for folder, row in table.items():
            for path in [folder] + [a.path for a in row.allows]:
                if path != "." and not (root / base / path).exists():
                    gone.add(f"{prefix}{base}/{path} is named in the map and is not there")
    report(not left_out and not gone, "the map names every source directory there is, and nothing that is not", sorted(left_out) + sorted(gone))
    unused = [f"{prefix}{a} -> {prefix}{b}" for (a, b) in m.known if (a, b) not in used]
    report(not unused, "every known exception is still there to be removed", unused)
    if m.problems or unread:
        report(not m.problems, "the map reads cleanly", m.problems)
        for note in unread:
            print(f"  note  {prefix}{note}")

    print(f"{failed} failed" if failed else f"ok: {len(edges)} imports in {len(files)} files keep to the map")
    return 1 if failed else 0


def draft(root: Path, m: Map, label: str) -> int:
    """The map as the code stands today: a table to start from, with what each directory imports now."""
    files = sources(root, m.ignore)
    edges, _ = edges_of(root, files, m.aliases)

    def top(path: str) -> str:
        return path.split("/")[0] + "/" if "/" in path else path

    places = sorted({top(f) for f in files}, key=lambda p: (not p.endswith("/"), p))
    takes: dict[str, dict[str, set[str]]] = {p: {} for p in places}
    for e in edges:
        a, b = top(e.src), top(e.to)
        if a != b and e.to != "*":
            takes[a].setdefault(b, set()).add(e.to)
    print(f"<!-- layercheck: root={label} -->\n")
    print("| Directory | What it owns | May import |\n| --- | --- | --- |")
    for place in places:
        names = []
        for other in sorted(takes[place]):
            mutual = place in takes.get(other, {})
            few = sorted(takes[place][other])
            # Where two directories import each other, the one that takes little is given just those files.
            if mutual and len(few) <= 3 and len(few) <= len(takes[other][place]) and not any(f.endswith("*") for f in few):
                names += [f"`{f}`" for f in few]
            else:
                names.append(f"`{other}`")
        print(f"| `{place}` |  | {', '.join(names) if names else 'nothing else'} |")
    cycles = sorted({tuple(sorted((a, b))) for a in takes for b in takes[a] if a in takes.get(b, {})})
    if cycles:
        print("\nThese import each other today; decide which way each should go:")
        for a, b in cycles:
            print(f"- `{a}` and `{b}`: {len(takes[a][b])} file(s) one way, {len(takes[b][a])} the other")
    return 0


def guess_root() -> str:
    """The source folder where nothing names it: a Java or Kotlin base package's folder, else src/, else here."""
    for base in ("src/main/java", "src/main/kotlin"):
        folder = Path(base)
        if not folder.is_dir():
            continue
        while True:                              # down through com/acme/shop, to the first folder that holds more
            entries = [e for e in folder.iterdir() if not e.name.startswith(".")]
            inner = [e for e in entries if e.is_dir()]
            if len(inner) != 1 or len(entries) != 1:
                return folder.as_posix()
            folder = inner[0]
    return "src" if Path("src").is_dir() else "."


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--map", default="docs/architecture.md", help="the map (default docs/architecture.md)")
    ap.add_argument("--root", help="the source folder the map's paths are under")
    ap.add_argument("--quiet", action="store_true", help="print only what fails")
    ap.add_argument("--draft", action="store_true", help="print the map as the code stands today")
    args = ap.parse_args()

    path = Path(args.map)
    if path.is_file():
        m = parse_map(path.read_text(encoding="utf-8"))
    elif args.draft:
        m = Map()
    else:
        print(f"no map at {path}: write one (start from --draft), or name it with --map", file=sys.stderr)
        return 2
    label = (args.root or m.root or guess_root()).strip("/") or "."
    root = Path(label)
    if not root.is_dir():
        print(f"the source folder {label}/ is not there (run this from the repository's top folder)", file=sys.stderr)
        return 2
    m.aliases = [(p, to) for p, to in m.aliases]
    if args.draft:
        return draft(root, m, label)
    if not m.top:
        print(f"{path} has no table with a `May import` column", file=sys.stderr)
        return 2
    return check(root, m, label, args.quiet)


if __name__ == "__main__":
    sys.exit(main())
