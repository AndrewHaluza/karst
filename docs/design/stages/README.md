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
