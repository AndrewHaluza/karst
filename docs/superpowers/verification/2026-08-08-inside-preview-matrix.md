# Inside Preview — Manual Verification Matrix

> **PENDING MANUAL EXECUTION — NOTHING IN THIS DOCUMENT HAS BEEN VERIFIED YET.**
>
> This file is a checklist, not evidence. Every row below starts unchecked
> because the Extension Development Host run has not been performed: the
> automated suite covers fixture identity, selection, and rendering (executed
> in a VM), but layout, overflow, focus, reduced motion, live updates and the
> production-vs-fixture distinction are Dev Host observations that only a
> human can record. **Do not treat any row as passed until it is actually
> observed and ticked**, and record every defect where it happened.

## Metadata

| Field | Value |
|---|---|
| VS Code version | 1.126 (Electron 39 / ABI 140) |
| Platform | darwin (macOS) |
| Date | 2026-08-08 |
| Tester | pending — requires human Dev Host run |
| Surface | Karst: Open Inside Preview (Development) |

## How to run

1. Launch **Run Karst Extension** (F5 / `npm run dev:extension`).
2. Open the command palette and execute **Karst: Open Inside Preview (Development)** — it must appear there (context key `karst.insidePreviewAvailable` set by the development activation) and must NOT appear in a production window.
3. For every row: pick the scenario, repository count and width in the preview toolbar, confirm the rendered Inside panel, then tick the box.
4. Any defect is recorded in the row itself and in the defects section below; a defective row is not ticked.

## Matrix

### Scenario: `pending` (stage `scope`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

### Scenario: `running` (stage `impl`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

### Scenario: `passed` (stage `done`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

### Scenario: `failed` (stage `review`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

### Scenario: `waiting` (stage `ship`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

### Scenario: `exhausted` (stage `uat`)

| Repos | Width | Verified |
|---|---|---|
| 2 | 300 | - [ ] |
| 2 | 360 | - [ ] |
| 2 | 430 | - [ ] |
| 2 | normal | - [ ] |
| 5 | 300 | - [ ] |
| 5 | 360 | - [ ] |
| 5 | 430 | - [ ] |
| 5 | normal | - [ ] |
| 10 | 300 | - [ ] |
| 10 | 360 | - [ ] |
| 10 | 430 | - [ ] |
| 10 | normal | - [ ] |
| 15 | 300 | - [ ] |
| 15 | 360 | - [ ] |
| 15 | 430 | - [ ] |
| 15 | normal | - [ ] |
| 20 | 300 | - [ ] |
| 20 | 360 | - [ ] |
| 20 | 430 | - [ ] |
| 20 | normal | - [ ] |

## Cross-cutting checklist

Each item applies to the whole matrix run, not one cell.

| Check | Verified |
|---|---|
| No whole-Inside horizontal overflow — at any scenario / repo count / width | - [ ] |
| Disclosure keyboard activation — Tab to a chevron, Enter/Space toggles it, focus ring visible on the focused chevron | - [ ] |
| Nested action focus — Tab from a disclosure into a row action button does not toggle the disclosure | - [ ] |
| Reduced-motion spinner — prefers-reduced-motion: the spinner ring stays visible but does not animate | - [ ] |
| Long repo/branch/path wrapping — long untrusted labels and deep paths wrap or ellipsise — no horizontal scroll | - [ ] |
| Active → completed → cleared live updates — inside-progress overlays render in the preview host and retire on the next snapshot | - [ ] |
| One real ticket — open the production dashboard on a real ticket and confirm its state is not fixture-backed | - [ ] |

## Defects observed

| Row / area | Observed defect | Severity |
|---|---|---|
| (none yet) | | |
