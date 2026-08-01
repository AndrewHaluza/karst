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

## Fix round 1/5

### Change

- Resolved the CLI registry directory with `resolve(dirname(dbPath))` before passing it to the shared ticket-context builder. A relative `--db karst.db` therefore produces absolute attachment paths rooted at the current working directory, preserving the `TicketContextAttachment.path` contract.
- Added the CLI regression test for a relative database path.

### Covering test

- `src/cli/context.test.ts` — `resolves attachment paths when the registry file path is relative`.

### Evidence

1. RED: `npx vitest run src/cli/context.test.ts`
   - The new test failed: rendered path was `attachments/1/aaaa1111bbbb2222.png` instead of an absolute path.
2. GREEN: `npx vitest run src/cli/context.test.ts src/context/ticketContext.test.ts && npm run typecheck`
   - 2 files passed, 34 tests passed; typecheck passed.
3. Full verification: `npm test && npm run typecheck && git diff --check`
   - 210 files passed, 2,857 tests passed; typecheck and diff check passed.

### Self-review

- `resolve` is applied only to the storage root at the CLI boundary. The builder and renderer remain shared by CLI and extension, and absolute database paths retain their existing output.

### Concerns

None. The full suite emitted its existing Node SQLite experimental warnings and legacy-manifest migration warnings, but all tests passed.
