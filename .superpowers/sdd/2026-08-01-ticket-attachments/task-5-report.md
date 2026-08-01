# Task 5 — Attachments in ticket context

## Implementation

- Added `TicketContextAttachment` and the required `attachments` field to the shared ticket-context model.
- `buildTicketContext` now accepts an optional `storageDir`; when supplied, it maps `listAttachments` rows to absolute `attachmentPath` values. Without it, the field is an empty array so no unusable relative path is emitted.
- The sole markdown renderer emits `## Attachments` immediately after the context brief. Image rows are directly readable; video rows are explicitly suffixed with `(not agent-readable)`.
- The extension supplies `context.globalStorageUri.fsPath`. The CLI derives the storage root from `dirname(dbPath)`, and `main.ts` passes its required `--db` value through.
- Added the empty `attachments` property to the existing direct-launch `TicketContext` fixture after the model became required.

## Files changed

- `src/context/ticketContext.ts`
- `src/context/ticketContext.test.ts`
- `src/cli/context.ts`
- `src/cli/context.test.ts`
- `src/cli/main.ts`
- `src/extension.ts`
- `src/agent/direct-launch.test.ts` (required typed fixture update)

## RED → GREEN evidence

1. RED: `npx vitest run src/context/ticketContext.test.ts`
   - 4 attachment tests failed as expected because `ctx.attachments` was `undefined` and no attachment section rendered.
2. GREEN: `npx vitest run src/context/ticketContext.test.ts src/cli/context.test.ts src/agent/direct-launch.test.ts && npm run typecheck`
   - 3 files passed, 34 tests passed; typecheck passed.
3. Full verification: `npm test && npm run typecheck && git diff --check`
   - 210 files passed, 2,856 tests passed; typecheck and diff check passed.

## Self-review

- Both live consumers use `buildTicketContext` then `renderTicketContext`; no second attachment renderer was introduced.
- Absolute paths are only formed via `attachmentPath` when a real storage root is available.
- CLI storage root is exactly the directory beside the registry database.
- Videos remain visible while explicitly stating that agents cannot read them; images do not get that marker.
- Context and store modules remain VS Code-free and use driver-agnostic store helpers.

## Concerns

None. The full suite emitted its existing Node SQLite experimental warnings and legacy-manifest migration warnings, but all tests passed.
