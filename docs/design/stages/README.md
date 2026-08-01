# Stage graph — design variants

Three variants were built to answer one question: how should the dashboard show
what stages exist, which is active, what completed, what is next, and what is
happening *inside* the active stage.

All three were driven by the same finding — there is no `design` stage in the
codebase. The real defect behind the ticket was that `buildStepper` projects
stage rows onto the flat `STAGE_KEYS` array, so `fix` rendered as a linear step
between `review` and `ship`. `STAGE_GRAPH` reaches `fix` only on a failed
verdict and returns it to `review` on a pass.

| File | Idea | Outcome |
|---|---|---|
| `variant-a-circuit.html` | Main rail + fix as a return channel below it; click a stage to re-point an activity strip | **Shipped** |
| `variant-b-ledger.html` | Vertical CI-style run log, fix nested under the gate that failed | Not taken |
| `variant-c-inspector.html` | Graph map + inspector pane, verdict-labelled edges | Not taken |

Variant A shipped in `src/ui/dashboard/webview.html`. The mockup is kept as the
record of what was approved and why each detail is the way it is — the comments
in it explain choices the production file inherits (derived column geometry,
`display:contents` on the approach disclosure, the spinner over a glyph, and
why a not-yet-run stage shows a blurb rather than empty rows).

The mockup renders standalone in a browser with no build step. It is a design
record, not a live surface: it is not wired to the extension and will not track
later changes to the shipped view.

## Second round — 869ecpmwe

Variant A had shipped and been lived with. The complaints against it were that
`fix` read wrong, the collapsed fix toggle floated unattached, impl's approach
chip looked weak beside it, and a stage parked on a human (`ship`, `merge`, both
added after A was designed) was invisible on the rail — `needsUser` existed and
the rail never asked.

Both new variants are built on one finding: **`fix` is not a place on the map.**
`STAGE_GRAPH` reaches it only by a failed verdict and its only outgoing edge
returns to `uat`, so nothing can ever be *after* fix and the ticket never leaves
the gate's neighbourhood. It is a **retry cycle on the gate that failed**.
Variant A drew it as a seventh station under a bracket, which bought permanent
layout for a stage most tickets never enter and left a control on screen reading
`fix idle` — a control announcing that nothing is happening.

| File | Idea | fix | needs-you |
|---|---|---|---|
| `variant-d-orbit.html` | The shipped rail, corrected. Nodes and connectors kept. | A segmented **orbit** around the retried gate: one arc per allowed attempt, filled per attempt spent. Absent when the loop has not run. | Amber ring + corner badge + reason in the meta line + a dead forward connector, plus a call-to-action strip |
| `variant-e-track.html` | One chevron-segmented **track**; the current segment is wide, the rest compact. | A **retry meter** inside the retried gate's segment — ticks, not a bar, because spending attempts is not progress. | The segment fills amber and carries the action **inside itself** |

Both correct a topology error the shipped rail still has: the CSS comment at
`src/ui/dashboard/webview.html` claims `fix ─pass→ review`; `graph.ts` says
`uat`, and the geometry follows the comment. Both also make the attempt cap
(`FIX_ATTEMPT_CAP`) visible as geometry rather than as a caption, so "one retry
left before this parks" can be seen. Nothing in karst shows that today.

**Variant E was chosen.** The design it is taken into is
`docs/superpowers/specs/2026-08-02-stage-flow-nodes-design.md`; where the two
disagree, the spec wins (the mockup draws the needs-you segment's button as an
actor; the spec narrows it to a navigational control).

E additionally removes the rail's 560px floor. It degrades in three measured
steps — drop annotations, then drop names, then reduce the passed-by segments to
position markers while the current segment sheds its own annotation and shortens
its name to the stage key. Two steps was the first attempt and it was wrong: at a
397px lane five of the eight cases were still over, and because the lane was
`overflow:hidden` that showed up as the current segment's action button being
clipped away with nothing to indicate it. The lane is `overflow-x:auto` now and
the three steps clear every case down to **300px**. The measurement loop that
produced that number is in the file; re-run it if a segment gains content.
