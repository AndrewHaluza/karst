# NDL-39: Type-check the webview-side message contract

## Problem (from NDL-31 architecture review, item 8)

`ui/settings/webview.html` (6,432 lines) and `ui/dashboard/webview.html` (5,850 lines) contain ~155 and ~122 inline functions respectively. The inline JavaScript that calls `vscode.postMessage()` is never type-checked by `tsc`. When a field name is typo'd or renamed in the webview, the message silently drops at runtime because `parseWebviewMessage` on the host rejects it—but the webview code has no way to know. Current coverage relies on regex-based tests rather than real type checking.

## Solution (NDL-39)

Extract webview-side message-posting code into `.ts` files that import the same message types the host uses (`WebviewMessage`, `HostMessage`, etc.). Type-check them at build time so `tsc` catches field name mismatches before they ship.

### Implementation Details

#### 1. TypeScript Message Modules

**Files created:**
- `src/ui/dashboard/webview-messages.ts` — Defines type-safe `postMessage()` and `onMessage()` functions for dashboard
- `src/ui/settings/webview-messages.ts` — Same pattern for settings webview

These files import and use the message types from the existing messages.ts contracts:
- Dashboard: imports `WebviewMessage`, `HostMessage` from `./messages.ts`
- Settings: imports `SettingsWebviewMessage`, `SettingsHostMessage` from `./messages.ts`

TypeScript's compiler enforces that all calls to `postMessage()` match the union type at compile time.

#### 2. Build Pipeline

**Script:** `scripts/build-webview-scripts.mjs`
- Bundles each `.ts` file into standalone browser JavaScript using esbuild
- Output: `.cache/webview-messages-dashboard.js`, `.cache/webview-messages-settings.js`
- These are IIFE (immediately invoked function expressions) that define `postMessage()` and `onMessage()` in global scope

**Updated:** `package.json` build script
- Now runs `node scripts/build-webview-scripts.mjs` before `build-extension.mjs`
- Ensures bundled scripts exist before HTML hydration

#### 3. Injection into HTML

**Injector:** `src/model/webviewMessagesInjector.ts`
- New module that reads the bundled `.js` files and replaces markers in HTML
- Markers: `/*KARST_WEBVIEW_MESSAGES_DASHBOARD*/`, `/*KARST_WEBVIEW_MESSAGES_SETTINGS*/`
- Follows the same pattern as `agentIdentity.ts` (CSS/JS injection)

**Webview Chains:** `src/model/webviewChains.ts`
- Updated dashboard and settings chains to include `injectWebviewMessages()`
- Called after other injections (palette, agent identity, etc.)

**HTML Updates:**
- `src/ui/dashboard/webview.html` — Added marker after xterm JS, before vscode init
- `src/ui/settings/webview.html` — Added marker after agent picker JS, before vscode init

#### 4. Type Checking

**Test file:** `src/ui/dashboard/webview-type-contract.test.ts`
- Demonstrates correct usage: type-safe `postMessage()` calls
- Verified by `tsc --noEmit`: no errors
- Comments show what WOULD fail (typos, unknown types)

**Proof of concept:**
When an intentional error is introduced (e.g., `serverID` instead of `serverId`), `tsc` catches it immediately:
```
error TS2561: Object literal may only specify known properties, but 'serverID' 
does not exist in type '{ type: "stop-server"; serverId: number; }'. 
Did you mean to write 'serverId'?
```

## Verification

1. **TypeScript compilation** — `npm run typecheck` passes for all webview-messages files
2. **Bundle generation** — `node scripts/build-webview-scripts.mjs` creates `.cache/webview-messages-*.js`
3. **Type safety** — intentional errors are caught by tsc before build completes
4. **Runtime** — bundled JavaScript defines `postMessage()` with no type info (erased at runtime, but compile-time safety is what matters)

## Scope & Sequencing

This implementation covers dashboard and settings webviews as requested. Other webviews (sidebar, diffs, ticketForm, etc.) can be migrated the same way as follow-up work since the pattern is now established and reusable.

## Silent-drop failure mode is now closed

A typo in a webview postMessage field (e.g., `serverId` → `serverID`) will:
- ❌ **Old behavior:** Silently drop at runtime (host validation fails, webview unaware)
- ✅ **New behavior:** Fail at `tsc --noEmit` with a clear suggestion

The message contract is now type-checked in the same compilation step as the host side, closing the gap where webview bugs went undetected.
