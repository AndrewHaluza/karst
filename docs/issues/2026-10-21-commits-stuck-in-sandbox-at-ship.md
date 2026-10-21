<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-10-21-commits-stuck-in-sandbox-at-ship.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:STUCK-01'):
   awk "/^## \[@issue:STUCK-01\]/,/END_DOC_BLOCK: \[@issue:STUCK-01\]/" docs/issues/2026-10-21-commits-stuck-in-sandbox-at-ship.md
-->
# Fix commits stayed in the sandbox at ship (2026-10-21)

After CI failed at ship, the operator started a fix session by hand. The
sandboxed agent committed inside its clone; the PR kept the failing head.

## [@issue:STUCK-01] Root cause: a manual session at ship has no marker at all

The #662 fix commits (`3ea192bf0d`, `374c9dc98c`) were made after the ship CI
failed ("The ship CI failed the extension.ts ratchet", `374c9dc98c`). Ship has
no done marker for a hand-started session: the sync-to-host and the push both
hang off a stage done marker (`impl`/`fix`), and the ship saga's push runs only
from `runShipTicket`.

Two paths exist, and only one of them is a marker problem:

| path | what moves the commits | what went wrong |
| --- | --- | --- |
| fix stage via the driver | the done marker syncs the clone, ship pushes | a queued or gave-up marker (#665 `markerFlow` `status()` shows reason, attempt and next retry; `retryNow()` recovers it) |
| manual session at ship | nothing | no marker is ever fired, so there is no queued or gave-up state to show |

Recorded: this case is the second row, **no marker, not a queued or gave-up
one**. The #665 status line cannot show it. Not verified from run records: the
marker rows of the original session were not re-read; the conclusion rests on
the commit messages and on the flow having no marker by construction.

END_DOC_BLOCK: [@issue:STUCK-01]

## [@issue:STUCK-02] The fix: count what is missing, deliver on demand

- The PR refresh counts, per open PR, host commits not on the PR head and
  sandbox-clone commits not on the host branch (`extension/ops/deliverToPrOps.ts`).
  Never per render; the snapshot reads an in-memory tracker.
- The ship stage shows "N commits not on the PR (M still in the sandbox)" and a
  **Deliver to PR** button; both are hidden at 0/0.
- Deliver: refuse while an agent turn runs or a ship run is in flight; sync the
  sandbox (fast-forward only); on a diverged clone stop and offer Open sync diff
  (nothing pushed); then ship's delivery push (`deliverToOpenPr`, saga-recorded);
  then re-probe the PR.
- Rejected: a raw `git push`, auto-deliver on every sync, GitHub egress for the
  sandbox (arch:AC-31).

END_DOC_BLOCK: [@issue:STUCK-02]
