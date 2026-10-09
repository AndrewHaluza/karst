# Debug logging

Binding reference for `logger.debug()` and the injected `debug` callbacks. `CLAUDE.md` carries the rule; this file carries the inventory.

## Injected callbacks

Host-agnostic modules receive `debug` as an INJECTED callback, never by importing the logger. `extension.ts` binds every one of these to `logger.debug`:

- `StageDriverDeps.debug`
- `DriveTicketDeps.debug`
- `RunUatOpts.debug` / `RunReviewOpts.debug`
- `RunGatesOptions.onDebug` / `RunCommandOptions.onDebug` (gate processes)
- `RunHeadlessOpts.debug` (adapters) — injected ONCE by `instrumentAdapter`'s `InstrumentOptions.debug`, so a fifth core gets debug logging by construction
- `HeadlessSpawnOptions.onDebug`
- `SpinOptions.debug`
- `StartHotOpts.debug`
- `ReapOptions.debug`

A new debug call site must stay behind the injected callback — never call a global logger from a vscode-free module.

## Gate and retention

`logger.debug()` (`src/logging/logger.ts`) is a NO-OP unless `setDebugEnabled(true)` was called. The manifest's `debug: true` drives it, toggleable from Settings → General and re-applied on every manifest (re)load by `extension.ts`'s `applyManifestDebug`. When off, a `debug()` call is a boolean check and a return. When on, entries go to the Karst output channel AND the diagnostic buffer, through the same sanitize/redaction pipeline as info/warn/error, so reports capture them. Debug mode also raises the buffer's retention to 2000 entries / 1 MB via `setDebugRetention`.
