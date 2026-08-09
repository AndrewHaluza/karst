# Inside Block — Manual Verification Matrix

> **PENDING MANUAL EXECUTION — NOTHING IN THIS DOCUMENT HAS BEEN VERIFIED YET.**
>
> This file is a checklist, not evidence. Every row below starts unchecked
> because the Extension Development Host run has not been performed: the
> automated suite covers fixture identity, selection, and rendering (executed
> in a VM), but layout, overflow, focus, reduced motion, live updates and the
> production-vs-fixture distinction are Dev Host observations that only a
> human can record. The development preview harness was deleted, so every
> observation below is made on a REAL ticket dashboard — resize the panel,
> not a width frame. **Do not treat any row as passed until it is actually
> observed and ticked**, and record every defect where it happened.

## Metadata

| Field | Value |
|---|---|
| VS Code version | 1.126 (Electron 39 / ABI 140) |
| Platform | darwin (macOS) |
| Date | 2026-08-09 |
| Tester | pending — requires human Dev Host run |
| Surface | Real ticket dashboard (the development preview harness was deleted) |

## How to run

1. Run `npm run build`.
2. Launch the **Extension Development Host** (F5 / `npm run dev:extension`).
3. Open a real ticket dashboard and step the ticket through each stage state available — the matrix rows below name the states a real ticket can show.
4. Use VS Code's panel resizing (drag the panel / editor group boundary) for 300 / 360 / 430 / normal widths.
5. Compare the Implementation completed state to the attached screenshot and `docs/ui/inside-redesign-designer-handoff.html`.
6. Record screenshots for: **Implementation completed**, **UAT failed + Fix**, **Ship waiting/conflicted**, and **Done receipt**.

## Matrix

Stage states × widths. One real ticket per row; a width is verified by
resizing the panel until the Inside block's container measures the target
width (or crosses its breakpoint) and confirming the block still reads.

| Stage state | 300 | 360 | 430 | normal |
|---|---|---|---|---|
| Implementation completed | - [ ] | - [ ] | - [ ] | - [ ] |
| Implementation running | - [ ] | - [ ] | - [ ] | - [ ] |
| UAT failed + Fix | - [ ] | - [ ] | - [ ] | - [ ] |
| Review failed | - [ ] | - [ ] | - [ ] | - [ ] |
| Ship waiting | - [ ] | - [ ] | - [ ] | - [ ] |
| Ship conflicted | - [ ] | - [ ] | - [ ] | - [ ] |
| Done receipt | - [ ] | - [ ] | - [ ] | - [ ] |

## Cross-cutting checklist

Each item applies to the whole matrix run, not one cell.

| Check | Verified |
|---|---|
| No whole-Inside horizontal overflow — at any stage state / width | - [ ] |
| Disclosure keyboard activation — Tab to a chevron, Enter/Space toggles it, focus ring visible on the focused chevron | - [ ] |
| Nested action focus — Tab from a disclosure into a row action button does not toggle the disclosure | - [ ] |
| Reduced-motion spinner — prefers-reduced-motion: the spinner ring stays visible but does not animate | - [ ] |
| Long repo/branch/path wrapping — long untrusted labels and deep paths wrap or ellipsise — no horizontal scroll | - [ ] |
| Active → completed → cleared live updates — inside-progress overlays render on a REAL running ticket (gate run, ship) and retire on the next snapshot, observed in the dashboard | - [ ] |
| One real ticket — open the production dashboard on a real ticket and confirm its state is not fixture-backed | - [ ] |
| Prototype traits — the real dashboard matches the handoff anatomy: "Inside impl" header on the selected stage | - [ ] |
| Prototype traits — Session row with terminal status and execution identity | - [ ] |
| Prototype traits — timeline visible without clicking (session disclosure open on first render) | - [ ] |
| Prototype traits — phase checks and switch branches on the timeline | - [ ] |
| Prototype traits — right-aligned timestamps | - [ ] |
| Prototype traits — token pills | - [ ] |
| Prototype traits — session footer under the expanded session | - [ ] |
| Prototype traits — no debug controls (no preview toolbar, no width frame, no scenario picker) | - [ ] |

## Defects observed

| Row / area | Observed defect | Severity |
|---|---|---|
| (none yet) | | |
