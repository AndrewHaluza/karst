# Task 3 — ticket changes panel manager

## Result

Implemented the secure two-message changes-panel protocol and a per-ticket,
latest-result-wins panel manager. Diff requests resolve only through the active
snapshot's trusted target map; stale identifiers warn and begin a fresh load.

## RED evidence

`npx vitest run src/ui/diffs/messages.test.ts` before `messages.ts` existed:

```text
FAIL  src/ui/diffs/messages.test.ts [ src/ui/diffs/messages.test.ts ]
Error: Cannot find module './messages.js' imported from /Users/nd/Work/projects/karst/.karst/worktrees/show-wt-diffs-show-wt-diffs/src/ui/diffs/messages.test.ts
 ❯ src/ui/diffs/messages.test.ts:2:1
      1| import { describe, expect, it, vi } from 'vitest';
      2| import { parseChangesMessage, routeChangesMessage } from './messages.j…
       | ^
      3|
      4| describe('parseChangesMessage', () => {

Test Files  1 failed (1)
     Tests  no tests
```

`npx vitest run src/ui/diffs/panel.test.ts src/ui/diffs/messages.test.ts`
before `panel.ts` existed:

```text
FAIL  src/ui/diffs/panel.test.ts [ src/ui/diffs/panel.test.ts ]
Error: Cannot find module './panel.js' imported from /Users/nd/Work/projects/karst/.karst/worktrees/show-wt-diffs-show-wt-diffs/src/ui/diffs/panel.test.ts
 ❯ src/ui/diffs/panel.test.ts:4:1
      2| import type { DiffTarget } from './git.js';
      3| import type { ChangesHostMessage } from './messages.js';
      4| import { TicketChangesManager, type ChangesPanel, type ChangesPanelHos…
       | ^
      5| import type { TicketChangesSnapshot, TicketChangesState } from './snap…

Test Files  1 failed | 1 passed (2)
     Tests  3 passed (3)
```

## GREEN verification

- `npx vitest run src/ui/diffs/messages.test.ts src/ui/diffs/panel.test.ts` — 2 files, 11 tests passed.
- `npm run typecheck` — passed.
- `npm test` — 194 files, 2483 tests passed.
- `git diff --check` — passed.

## Review

Confirmed that each accepted diff id retrieves the original `DiffTarget` object
from the current `ReadonlyMap`, every load checks session liveness plus request
generation before posting, disposal invalidates outstanding loads, and untrusted
path/repo/revision fields never enter the protocol.
