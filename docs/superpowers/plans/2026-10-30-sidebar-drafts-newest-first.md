# Sidebar drafts newest-first Implementation Plan

**Goal:** Sidebar planning drafts read newest-first like tickets; pending above accepted.

**Architecture:** Only `listVisibleProposals` (sidebar's source) changes: `ORDER BY p.status = 'accepted', p.id DESC`. Other proposal queries untouched. Nesting is view-side and unaffected; only sibling order changes.

## Task 1: Reverse order in listVisibleProposals
- [x] Test `src/store/planningProposals.test.ts`: pending D1,D3 + accepted D2,D4 -> D3,D1,D4,D2 (RED first)
- [x] Test `src/ui/sidebar/state.test.ts`: session draft rows newest-first; existing expectations swapped
- [x] Change ORDER BY in `src/store/planningProposals.ts`
- [x] Fixtures (`renderFixtures.ts`) are static inputs; no baseline change.
