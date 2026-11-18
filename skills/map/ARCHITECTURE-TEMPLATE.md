# Architecture

How the source is laid out: which directory owns what, and what it may import.
`python3 tools/layercheck.py` checks every import in `src/` against the tables
on this page, so the page and the code cannot disagree: a change to what a
directory may import is a change to its row here.

<!-- layercheck: root=src -->

## The module map

A directory may import itself and what its row names: whole directories, single
files of one, or only the types of a file. A file at the top of `src/` is a row
of its own.

| Directory | What it owns | May import |
| --- | --- | --- |
| `core/` | the rules, with no screen and no network attached | nothing else |
| `store/` | what is kept between runs, and the only code that knows how | `core/` |
| `api/` | the boundary: what a client may ask and be told | `core/`, `store/` |
| `ui/` | the screen | `api/`, the types of `core/model.ts` |
| `main.ts` | the entry: reads the settings and starts the rest | `api/`, `ui/` |
| `tools/` | scripts for people, not shipped | anything: not mapped |

### Where one directory takes a file from another

Where two directories would otherwise import each other, one of them takes
only named files back, and its row says which. Say here why each is so:

- `ui/` takes only the types of the model (`core/model.ts`), so that the rules
  can be tested with no screen.

## Inside `ui/`

What each folder of `ui/` may import from the others; what any of them takes
from outside `ui/` is `ui/`'s row above. `*` is the files at the top of `ui/`.

<!-- layercheck: within=ui -->

| Folder | May import |
| --- | --- |
| `*` | `widgets/`, `pages/` |
| `pages/` | `*`, `widgets/` |
| `widgets/` | the types of `*` |

## Known exceptions

Imports that break the map today, each until the change that removes it. An
entry nothing matches any more fails the check, so this list only gets shorter.

<!-- layercheck: known -->

| From | To | Why |
| --- | --- | --- |
| `store/cache.ts` | `ui/widgets/format.ts` | the cache formats its own keys with the widget's helper; move the helper to `core/` |

## Where new code goes

- A concept goes in the directory that owns it. If none does, that is a new
  row here, agreed first.
- No layer or interface with one implementation, added for later.
- When a file grows past what one reading holds, split it along the seams of
  the thing it models, not by kind of code.
