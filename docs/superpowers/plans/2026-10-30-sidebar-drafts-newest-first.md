# Sidebar drafts newest-first Implementation Plan

**Goal:** Sidebar planning drafts read newest-first like tickets; pending above accepted.

**Architecture:** Only `listVisibleProposals` (sidebar's source) changes: `ORDER BY p.status = 'accepted', p.id DESC`. Other proposal queries untouched. Nesting is view-side and unaffected; only sibling order changes.

## Task 1: Reverse order in listVisibleProposals
- [x] Test `src/store/planningProposals.test.ts`: pending D1,D3 + accepted D2,D4 -> D3,D1,D4,D2 (RED first)
- [x] Test `src/ui/sidebar/state.test.ts`: session draft rows newest-first; existing expectations swapped
- [x] Change ORDER BY in `src/store/planningProposals.ts`
- [x] Fixtures (`renderFixtures.ts`) are static inputs; no baseline change.

## Spec coverage (intent scenarios -> evidence)
- D1,D3 pending + D2,D4 accepted -> D3,D1,D4,D2: `planningProposals.test.ts` (listVisibleProposals).
- Many pending, newest on top; pending above accepted whatever the ids: same test (id DESC inside each status group).
- Session draft rows newest-first in sidebar state: `state.test.ts` "lists a session's drafts newest-first".
- Accepting moves a draft to the accepted group, newest-first there: same ORDER BY, status is the first key.
- Nested draft stays nested: nesting is built view-side from `dependsOn`; no code touched. Only sibling order changes. Scope note (children order in the dependency view) is unchanged behavior, not covered by a new test.
- Single draft, ticket order, session order: untouched (`listTickets`, `listPlanningSessions` not modified).
- Out of scope, untouched: announce loop, planning index, auto-archive, single-row lookups (other queries in `planningProposals.ts`).
