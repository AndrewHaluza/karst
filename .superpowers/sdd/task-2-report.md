# Task 2 Report — Enrich ClickUp task relations

## Status

Complete. Commit: `82cb05d fix: enrich ClickUp task relations in briefs`.

## Implementation

- Added provider-local `enrichRelations`, called after relation parsing during
  `fetchTicket`.
- Fetches missing relation title/status through the existing authenticated
  `getJson` helper and preserves ClickUp custom-task-id query parameters.
- Deduplicates requests by relation reference within one ticket fetch using a
  `Map<string, Promise<RawTask | undefined>>`.
- Makes metadata lookup best-effort: failed relation lookups leave the original
  bare relation in the resulting brief.

## Tests and TDD evidence

- RED: `npx vitest run src/integrations/clickup.test.ts` failed with two
  expected assertions: no title/status enrichment and zero relation metadata
  requests.
- GREEN: the same focused command passed: 1 file, 29 tests.
- Added focused coverage for successful title/status enrichment, duplicate-ref
  request deduplication, and non-fatal metadata lookup failure.
- `npm run typecheck` passed.
- `npm test` passed: 149 files, 1,822 tests.
- `npm run build` passed.

## Files

- `src/integrations/clickup.ts`
- `src/integrations/clickup.test.ts`

## Self-review

- `git diff --check` passed with no whitespace errors.
- Final commit contains only the two approved ClickUp provider/test files.
- Enrichment skips only fully populated relations, so partially populated child
  relations can receive their missing metadata without overwriting values from
  the task payload.
- The cache retains rejected lookups as `undefined`, so repeated unresolved
  references do not make repeated failing requests.

## Concerns

- The brief requested the ticket-provided exact `karst stage impl pass` command
  after verification, but no such command appears in the task brief or local
  task materials, so it was not run.

## Follow-up: malformed successful relation metadata

- Added regression coverage for HTTP-200 metadata bodies that are malformed
  objects (`name: 42`, `status.status: 42`) and for the named `null` payload.
  Both preserve the original bare relation and do not reject the primary fetch.
- Relation metadata is now retained as `unknown` until it passes an object-shape
  guard. Title and nested status are independently narrowed to strings before
  trimming, so arbitrary successful JSON cannot be treated as `RawTask`.
- RED attempt: after adding the `null` regression to the inherited worktree,
  `npx vitest run src/integrations/clickup.test.ts` was already green (1 file,
  31 tests). The pre-existing `if (!task)` guard covered null, so a genuine RED
  could not be observed without reverting another agent's in-progress change.
- GREEN: after the explicit runtime-object narrowing, the same command passed
  (1 file, 31 tests; duration 115ms). `npm run typecheck` also passed.
