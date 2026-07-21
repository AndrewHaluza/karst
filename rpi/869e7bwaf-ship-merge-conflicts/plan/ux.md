# UX — Ship stage merge-conflict surface

Karst has two consumer surfaces for ship state, plus one machine surface. All three get the same three-valued signal; none of them gains a new screen.

---

## Surface 1 — Stage "inside" strip (dashboard webview)

`src/model/inside/index.ts` → `shipInside(cell, prs, now)` renders one `StageOp` row per PR:

```
  ✓  pr        Karst-extention #128
```

**Change**: append one merge-check row per repo, immediately after that repo's PR row. `StageOp.status` is already `'pass' | 'fail' | ...` — map the three states onto it:

| State | status | name | detail |
|---|---|---|---|
| `clean` | `pass` | `merge` | `Karst-extention · no conflicts with main` |
| `conflicted` | `fail` | `merge` | `Karst-extention · 3 files conflict with main: src/a.ts, src/b.ts, src/c.ts` |
| `unknown` | `warn` (else `fail`) | `merge` | `Karst-extention · could not check: <git reason>` |

After change:

```
  ✓  pr        Karst-extention #128
  ✗  merge     Karst-extention · 3 files conflict with main: src/store/db.ts, …
```

Notes:
- A `fail` row inside a **passed** stage is deliberate — the stage did pass (a PR exists); the merge did not. The strip already models per-op status independently of cell status.
- File list truncates at 5 paths + `(+N more)`; the full list stays in the DB.
- Failed ship (`cell.status === 'failed'`) keeps its existing single-row rendering untouched — no PRs opened means no merge check to show.
- If a repo has no `merge_checks` row at all (pre-feature ticket, never re-shipped), **emit nothing**. Absence is evidence of nothing — same rule the codebase already applies to `phase_marks`.

## Surface 2 — `## Pull requests` in rendered ticket context

`renderTicketContext` (`src/context/ticketContext.ts:174`) currently emits:

```
## Pull requests
- Karst-extention #128 [open] — https://github.com/…
```

**Change**: suffix the merge state on the same line, so no consumer has to learn a new section:

```
## Pull requests
- Karst-extention #128 [open] — https://…  · merge: conflicted (3 files: src/a.ts, src/b.ts, src/c.ts)
- Karst-extention #129 [open] — https://…  · merge: clean
- Karst-extention #130 [open] — https://…  · merge: unknown (fatal: couldn't find remote ref main)
```

Omitted entirely when there is no check for that repo — existing rendering is byte-identical for pre-feature tickets, which is what keeps the seed/context snapshot tests honest.

## Surface 3 — `karst context` CLI (machine)

Inherits Surface 2 verbatim: the CLI renders through `renderTicketContext`. No separate work, no separate format for the agent to learn.

---

## States & edge cases

| Situation | Presentation |
|---|---|
| Never checked | nothing rendered (not "clean", not "unknown") |
| Check ran, clean | `merge: clean` |
| Check ran, conflicts | `merge: conflicted` + file list |
| git failed / timed out / ref missing / git too old | `merge: unknown (<git's own reason>)` |
| Stored SHAs no longer match HEAD/base | `merge: <state> (stale)` — see eng.md staleness rule |
| Zero conflicting files but exit 1 | treat as `conflicted` with an empty list; never silently downgrade to clean |

## Accessibility / copy rules

- Never use colour alone — every state carries a word (`clean` / `conflicted` / `unknown`).
- Reasons are quoted from git verbatim, not paraphrased. A user must be able to search for the message.
- `unknown` is never phrased as reassurance ("probably fine"). It reads as an unanswered question.
