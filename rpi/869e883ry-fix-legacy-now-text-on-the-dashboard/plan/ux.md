# ux.md — legacy Now text on the dashboard

**Ticket**: `869e883ry`

## Surface

Single surface: the ticket dashboard webview panel (`src/ui/dashboard/webview.html`), the `#inside` block + the `#now` line beneath the stepper rail. No other surface (tree view, status bar) shows ship progress today.

## States — Ship

### Not started (`stageKey: 'ship'`, `status: 'pending'`)

**Today**: Inside block shows blurb — "Commits, pushes, and opens one PR per hot repo with an agent-written description." Now line: "Now: ready to ship. Confirm to open the PRs." + [Confirm ship] button.

**After fix**:
```
● Inside ship                                    has not run yet
· pr     repo-a                                  pending
· merge  repo-a                                  pending
· pr     repo-b                                  pending
· merge  repo-b                                  pending
```
Now line unchanged — still the confirm prompt, still the button. (Nothing wrong with the pre-run Now text; only ship's IN-FLIGHT Now text is legacy.)

### Running — the moment "Confirm ship" is clicked

**Today**: Now line instantly flips to a spinner + "Shipping…", then streams through "Committing changes…", "Pushing branch…", "Writing PR description…", "Opening pull request…", "Checking mergeability…" — one line at a time, overwritten, never re-readable. Inside block still shows blurb (ops.length === 0 the whole time, since nothing is persisted until a PR row is written).

**After fix**: Inside block goes live immediately (same "click registers before host round trip" guarantee — seeded optimistically, not waiting on the host):
```
● Inside ship                          started 10:34:12 · 12.4s elapsed
✓ commit   repo-a                                 0.3s
✓ push     repo-a                                 1.1s
▶ describe repo-a                       running…
· pr       repo-a                                 pending
· merge    repo-a                                 pending
· commit   repo-b                                 pending
· push     repo-b                                 pending
· describe repo-b                                 pending
· pr       repo-b                                 pending
· merge    repo-b                                 pending
```
Now line: plain sentence, no per-step narration, no button — "Now: shipping — committing, pushing, and opening PRs for each hot repo." A repo whose PR already existed (idempotent re-ship) shows a single `note`-status row ("already shipped — adopting existing PR") instead of re-running commit/push/describe rows for it, so the view never claims work happened that didn't.

### Finished (passed)

**Today and after fix (unchanged)**:
```
● Inside ship                            10:35:59 PM · 1m 23s
✓ pr     repo-a #43
✓ merge  repo-a · clean
```
Now line: "Done." (ticket has advanced to `done`).

### Failed

**Today and after fix (unchanged)**: single `fail` op with the recorded reason; Now line explains + offers [Retry ship].

## States — Review / UAT

### Not started

**Today**: blurb prose ("Runs lint, typecheck and test…").
**After fix**:
```
● Inside review                                  has not run yet
· lint       npm run lint                        pending
· typecheck  npm run typecheck                    pending
· test       npm test                            pending
```

### Running / finished — unchanged (already correct today).

## Interaction notes

- Selecting a stage while ship is running still works exactly as today — `renderInside` reads whichever stage is `selectedStage`; live ship rows only exist in the `ship` strip.
- No new button, no new click target. The only removed affordance is the transient Now-line spinner text — replaced by a static sentence with no interactivity, since the real signal moved into `#inside`.
- Accessibility: identical to existing Inside rows — no new ARIA surface, spinner glyph reuses the existing `.spin` element already announced elsewhere.

## Out of scope

`impl`/`fix` visuals — unchanged, still blurb-before-running.
