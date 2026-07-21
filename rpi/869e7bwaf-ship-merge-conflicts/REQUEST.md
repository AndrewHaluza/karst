# [FEAT] Ship stage should track merge conflicts

Ticket: `869e7bwaf`

Ship stage currently gives no visibility into merge conflicts. Add merge conflict tracking to the ship stage so conflict state is detected, persisted, and exposed.

Goal: when work moves through the ship stage, the system must determine whether the change can merge cleanly into its target branch, record that result, and make it readable by consumers of ship-stage state.

## Requirements

- Detect merge conflict status for a change against its target branch during the ship stage.
- Persist conflict state alongside existing ship-stage state, including which files conflict when a conflict exists.
- Expose the conflict state through the same read paths that already surface ship-stage status.
- Refresh conflict state when it can go stale (target branch moves, change updates); do not leave a stale 'clean' result presented as current.
- Handle detection failures explicitly (unavailable branch, missing ref, timeout) — distinguish 'no conflict' from 'unknown/failed to check' rather than defaulting to clean.

## Acceptance criteria

- A change with a real conflict against its target is reported as conflicted, with conflicting files listed.
- A cleanly-mergeable change is reported as conflict-free.
- A failed/indeterminate check is reported distinctly, not as clean.
- Conflict state updates rather than persisting stale results.
- Tests cover conflicted, clean, and check-failure paths.
- No breaking change to existing ship-stage consumers.
