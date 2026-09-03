# Execution Plan: Source Control panel diffs (manifest feature flag)

## Goal

Add a manifest boolean `diffsInSourceControl` (default off). When ON, the dashboard worktree "Show Changes" action publishes the ticket's changed-file list into the IDE's native Source Control view as collapsible resource groups (GitLens-like) and focuses that view, instead of opening the "Ticket changes" webview panel. Clicking a file in Source Control opens exactly the same diff editor as today. When OFF, behavior is byte-identical to today.

## Current State

Facts established by reading the repository (do not re-derive them):

- Dashboard button → `show-changes` message → `extension.ts:2573` `() => changes.open(ticketId)`.
- `changes` is a `TicketChangesManager` (`src/ui/diffs/panel.ts`) constructed at `src/extension.ts:2247`. Its `load` callback (lines ~2251–2268) builds the worktree spec list from `listWorktreesByTicket(localStore, ticketId)` and calls `buildTicketChangesSnapshot(...)`.
- `buildTicketChangesSnapshot` (`src/ui/diffs/snapshot.ts`) returns `{ state: TicketChangesState, targets: ReadonlyMap<string, DiffTarget> }`. `state.worktrees` is a `WorktreeChangesView[]` built **in the same order as the `worktrees` spec array passed in** (`settled.map`), each with `label`, `branch`, `baseRef`, `commits[]`, `staged[]`, `unstaged[]`, `untracked[]`, `error`. Every file view is a `ChangedFileView { changeId, status, path, oldPath }` and `targets.get(changeId)` yields its `DiffTarget`.
- `openTicketDiff(target, viewColumn)` is a local const in `activate` (`src/extension.ts:2212`). It prepares virtual documents and runs `vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, viewColumn: viewColumn ?? vscode.ViewColumn.Beside })`. Passing `undefined` for `viewColumn` is already a supported call shape.
- `WorktreeSpec` = `{ label, path, branch, baseRef }`. `FileChangeStatus` comes from `src/ui/diffs/gitParsers.ts`.
- There is **no** SCM provider anywhere in the repo today (`grep -rn "SourceControl\|vscode.scm"` finds nothing in `src/`).
- Boolean manifest flags follow one exact template — `closeDoneTerminalsWithTicket` — touching: `src/manifest/types.ts`, `src/manifest/schema.ts` (validator + call in `validateManifest`), `src/manifest/write.ts` (overlay), `src/ui/settings/sections.ts` (`SECTION_FIELDS.general`), `src/ui/settings/webview.html` (field markup, mirrored `SECTION_FIELDS`, error-routing regex, draft→DOM render, DOM→draft listener), `karst.example.yml` (commented example), plus tests in `src/manifest/load.test.ts`, `src/manifest/writeManifest.test.ts`, `src/ui/settings/webview.test.ts`.
- Architecture invariant: modules under `src/` that hold logic are **vscode-free**; `vscode` is bound only in `src/extension.ts`. Host seams are injected interfaces. ESM: every relative import needs a `.js` suffix. `noUncheckedIndexedAccess` is on.
- Tests: colocated `*.test.ts`, run with `npx vitest run <file>`; typecheck `npm run typecheck`.

## Target State

- `Manifest.diffsInSourceControl?: boolean`, validated, written back by `writeManifest`, editable in Settings → General.
- New vscode-free module `src/ui/diffs/scmModel.ts`: pure function turning a `TicketChangesSnapshot` + the worktree specs into an ordered list of SCM groups/resources.
- New vscode-free module `src/ui/diffs/scmController.ts`: a `TicketScmController` class that owns the injected `ScmHost` seam, renders a snapshot into groups, keeps the `changeId → DiffTarget` map, and exposes `openChange(changeId)`.
- `src/extension.ts` binds `ScmHost` to `vscode.scm.createSourceControl`, registers command `karst.openTicketScmDiff`, and routes the dashboard `show-changes` action through the flag.
- Flag OFF: `changes.open(ticketId)` exactly as today; no SourceControl object is ever created.

## Scope

### In Scope
- The manifest flag and its full field checklist (types/schema/write/settings/example yml + tests).
- The SCM model, controller, host binding, command registration, and dashboard routing.
- Unit tests for the model and the controller with a fake host.

### Out of Scope
- Changing the existing "Ticket changes" webview panel, its HTML, messages, or tests.
- Changing `openTicketDiff`, `prepareDiff`, `git.ts`, `diffResources.ts`, or any git parsing.
- Stage/gate, agent, worktree-creation, or store changes.
- SCM quick-diff (`quickDiffProvider`), staging/unstaging, commit input box, SCM title/context menus, keyboard shortcuts.
- Auto-refresh of the SCM view on file-system changes or on git activity. The view is rebuilt only when the dashboard "Show Changes" action runs.
- Any change to `package.json` other than none (no new contributes are required; `vscode.scm.createSourceControl` is a runtime API).

## Key Decisions

1. **Flag shape**: a flat top-level boolean `diffsInSourceControl`, not a nested `diffs: { openInSourceControl }` object. It follows the existing `closeDoneTerminalsWithTicket` template exactly, so schema/write/settings work is a copy of a known-good path.
2. **Absent means off**: `undefined` and `false` both mean off. Unchecking in Settings deletes the key (same as `closeDoneTerminalsWithTicket`).
3. **One SourceControl object, recreated per ticket show**: the controller keeps at most ONE `vscode.scm` SourceControl alive. Showing changes for a different ticket disposes the previous one and creates a new one. This avoids stale groups from other tickets and avoids multi-ticket grouping design work.
4. **Group layout** (fixed, no executor choice). For each worktree view, in snapshot order:
   - `"<label> — Staged"` if `staged.length > 0`
   - `"<label> — Unstaged"` if `unstaged.length > 0`
   - `"<label> — Untracked"` if `untracked.length > 0`
   - then one group per commit, in snapshot order: `"<label> — <shortHash> <subject>"` if that commit has files.
   Empty groups are never created. A worktree whose `error` is non-null contributes no groups.
5. **Resource identity**: each resource carries the `changeId` from the snapshot. The command argument is the `changeId` string only — never a path, never a `DiffTarget` — so the untrusted-shape surface stays a single opaque token that the controller resolves through its own map.
6. **Resource URI**: `absolutePath = join(worktreeSpec.path, file.path)` (POSIX/`node:path` `join`). Used only for VS Code's label/icon rendering. Worktree spec is matched to the snapshot view **by array index**, which `buildTicketChangesSnapshot` guarantees.
7. **Click behavior**: unchanged — the registered command calls the existing `openTicketDiff(target, undefined)`, so the diff opens beside as it does today.
8. **Focus**: after rendering, run `vscode.commands.executeCommand('workbench.view.scm')`.
9. **Failure behavior**: if the snapshot load throws, the SCM path shows `vscode.window.showWarningMessage` with the error message and logs via `logError`; it does NOT fall back to the webview panel.
10. **Rejected alternative**: adding `path` to `WorktreeChangesView`. It would push absolute host paths into the existing webview protocol for no benefit; the specs are already in hand at the call site.

## Execution Order

### Task 1: Add the `diffsInSourceControl` manifest field

#### Objective
Make `diffsInSourceControl` a first-class, validated, round-tripped manifest boolean.

#### Files
- `src/manifest/types.ts` — declare the field on the `Manifest` interface.
- `src/manifest/schema.ts` — add the validator and call it in `validateManifest`.
- `src/manifest/write.ts` — add the overlay entry so Save does not drop it.
- `src/manifest/load.test.ts` — new load/validation cases.
- `src/manifest/writeManifest.test.ts` — round-trip case.
- `karst.example.yml` — commented example.

#### Implementation
1. In `src/manifest/types.ts`, immediately after the `closeDoneTerminalsWithTicket?: boolean;` declaration, add:
   ```ts
   /**
    * Open a ticket's changed-file list in the IDE's native Source Control view
    * (collapsible groups per worktree and per commit) instead of the "Ticket
    * changes" webview panel. Clicking a file opens the same diff editor either
    * way. Defaults to off: absent and `false` both mean the webview panel.
    */
   diffsInSourceControl?: boolean;
   ```
2. In `src/manifest/schema.ts`, immediately after `validateCloseDoneTerminalsWithTicket`, add:
   ```ts
   /**
    * Parse `diffsInSourceControl` (default undefined → the changes webview
    * panel). Must be a boolean when present, like `debug` — a string `"true"`
    * is a YAML typo and must fail loudly rather than silently rerouting the
    * diffs UI.
    */
   function validateDiffsInSourceControl(raw: unknown): boolean | undefined {
     if (raw === undefined) return undefined;
     if (typeof raw !== 'boolean') {
       throw new ManifestError('diffsInSourceControl must be a boolean');
     }
     return raw;
   }
   ```
3. In `validateManifest` (same file, the object literal that already contains `debug: validateDebug(raw.debug),` around line 526), add on the line after the existing `closeDoneTerminalsWithTicket:` entry:
   ```ts
   diffsInSourceControl: validateDiffsInSourceControl(raw.diffsInSourceControl),
   ```
4. In `src/manifest/write.ts`, immediately after the `closeDoneTerminalsWithTicket: manifest.closeDoneTerminalsWithTicket,` line (~159), add:
   ```ts
   // Optional: written when set, dropped when cleared, so it falls back to
   // "diffs open in the changes webview panel".
   diffsInSourceControl: manifest.diffsInSourceControl,
   ```
5. In `karst.example.yml`, after the `# closeDoneTerminalsWithTicket: false` line (~57), add a blank line then:
   ```yaml
   # Show a ticket's changed files in the IDE's Source Control view — collapsible
   # groups per worktree and per commit — instead of the "Ticket changes" panel
   # (Settings → General). Clicking a file opens the same diff either way. Off by
   # default.
   # diffsInSourceControl: false
   ```
6. In `src/manifest/load.test.ts`, copy the existing `closeDoneTerminalsWithTicket` cases and add three tests for `diffsInSourceControl`: (a) absent → `undefined`; (b) `true` → `true`; (c) the string `'true'` → `loadManifest` rejects with a `ManifestError` whose message contains `diffsInSourceControl must be a boolean`.
7. In `src/manifest/writeManifest.test.ts`, extend the existing "round-trips every modeled section" fixture/assertion the same way `closeDoneTerminalsWithTicket` appears there: set `diffsInSourceControl: true` on the input manifest and assert it survives the write/read round trip.

#### Constraints
- Do not rename, reorder, or alter any existing manifest field.
- Do not introduce a nested `diffs:` block.
- Do not add the field to `manifest/fixtures.ts` (it is not a repository/service field).

#### Edge Cases
- `diffsInSourceControl: false` in YAML loads as `false` and is written back as `false` (only Settings clearing removes the key).
- Any non-boolean (`'true'`, `1`, `null`, `{}`) throws `ManifestError('diffsInSourceControl must be a boolean')`. `null` is not `undefined`, so it throws.

#### Verification
```bash
npx vitest run src/manifest/load.test.ts src/manifest/writeManifest.test.ts
npm run typecheck
```

Expected: both test files pass, typecheck clean.

#### Completion Criteria
- [ ] `Manifest.diffsInSourceControl?: boolean` exists in `types.ts`.
- [ ] `validateDiffsInSourceControl` exists and is called in `validateManifest`.
- [ ] `write.ts` overlays the field.
- [ ] `karst.example.yml` documents it as a commented line.
- [ ] The three load tests and the round-trip test pass.

---

### Task 2: Expose the flag in Settings → General

#### Objective
Add a Settings toggle for `diffsInSourceControl` in the General tab, saved through the existing tab-scoped save path.

#### Files
- `src/ui/settings/sections.ts` — add the key to `SECTION_FIELDS.general`.
- `src/ui/settings/webview.html` — field markup, mirrored `SECTION_FIELDS`, error-routing regex, render, change listener.
- `src/ui/settings/sections.test.ts` — assert the key is in the general section.
- `src/ui/settings/webview.test.ts` — mirror + behavior tests.

#### Implementation
1. `src/ui/settings/sections.ts`: append `'diffsInSourceControl',` to the `general` array, directly after `'closeDoneTerminalsWithTicket',` (line ~58).
2. `src/ui/settings/webview.html`, markup: after the closing `</div>` of the "Close done terminals with ticket" field block (the block starting at line ~1210), add an identically structured block:
   ```html
   <div class="field-label" id="scmDiffsLabel">Show changes in Source Control</div>
   <div class="field-control">
     <div class="toggle">
       <input type="checkbox" id="f-diffsInSourceControl" aria-describedby="scmDiffsHint" />
       <label for="f-diffsInSourceControl">Enabled</label>
     </div>
     <div class="field-help" id="scmDiffsHint">
       Show a ticket's changed files in the IDE's Source Control view — collapsible
       groups per worktree and per commit — instead of opening the Ticket changes
       panel. Clicking a file opens the same diff either way.
     </div>
   </div>
   ```
   Match the surrounding block's exact wrapper elements and indentation; if the existing block is wrapped in an outer element (e.g. a `<div class="field">`), wrap this one identically.
3. `src/ui/settings/webview.html`, mirrored `SECTION_FIELDS` (~line 2220): append `'diffsInSourceControl',` to the `general` array.
4. `src/ui/settings/webview.html`, error-routing regex (~line 2276): add `|diffsInSourceControl` inside the alternation, immediately after `closeDoneTerminalsWithTicket`.
5. `src/ui/settings/webview.html`, render (~line 2588), after the `f-closeDoneTerminalsWithTicket` line:
   ```js
   // Absent (undefined) renders unchecked — diffs open in the changes panel by default.
   el('f-diffsInSourceControl').checked = draft.diffsInSourceControl === true;
   ```
6. `src/ui/settings/webview.html`, listener (~line 2741), after the `f-closeDoneTerminalsWithTicket` listener:
   ```js
   el('f-diffsInSourceControl').addEventListener('change', () => {
     // Unchecking deletes the field entirely — absent IS the off default.
     if (el('f-diffsInSourceControl').checked) draft.diffsInSourceControl = true;
     else delete draft.diffsInSourceControl;
     markDirty();
   });
   ```
7. Tests: in `src/ui/settings/sections.test.ts` extend the existing general-section assertion to include `'diffsInSourceControl'`. In `src/ui/settings/webview.test.ts`, find every existing test that names `closeDoneTerminalsWithTicket` (there are six occurrences) and add the parallel assertion for `diffsInSourceControl` in the same test bodies — specifically: the mirror test that compares the webview's `SECTION_FIELDS` to the host's, the render test, and the change-listener/draft test (checked → `true`, unchecked → key absent).

#### Constraints
- Do not change `SECTION_FIELDS` for any other section.
- Do not add a new settings tab or a new save message type.
- Do not import TypeScript into `webview.html` — the field list stays a mirror.

#### Edge Cases
- Manifest has `diffsInSourceControl: false` on disk: the checkbox renders unchecked; toggling on then off deletes the key, so the saved manifest no longer carries `false`. That is the same behavior the existing toggles have and is accepted.
- Saving the General tab must not touch any other section (already guaranteed by `mergeSection`).

#### Verification
```bash
npx vitest run src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts
npm run typecheck
```

Expected: both pass; the mirror test proves webview and host field lists agree.

#### Completion Criteria
- [ ] Key present in `SECTION_FIELDS.general` in both `sections.ts` and `webview.html`.
- [ ] Checkbox `f-diffsInSourceControl` renders, reads, and writes the draft.
- [ ] Error routing sends a `diffsInSourceControl` ManifestError to the General tab.
- [ ] Both test files pass.

---

### Task 3: Create the pure SCM model (`scmModel.ts`)

#### Objective
Add a vscode-free, fully tested function that turns a ticket changes snapshot plus its worktree specs into the exact ordered group/resource structure the SCM view will render.

#### Files
- `src/ui/diffs/scmModel.ts` — new.
- `src/ui/diffs/scmModel.test.ts` — new.

#### Implementation
Create `src/ui/diffs/scmModel.ts` with exactly this public surface:

```ts
import { join } from 'node:path';
import type { FileChangeStatus, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot } from './snapshot.js';

/** One file row inside an SCM group. */
export interface ScmResourceModel {
  /** Opaque token resolved back to a DiffTarget by the controller. */
  changeId: string;
  /** Repo-relative path, as git reported it. */
  path: string;
  /** Absolute path on disk, for the host's label/icon rendering only. */
  absolutePath: string;
  status: FileChangeStatus;
  /** Rename source, or null. */
  oldPath: string | null;
}

/** One collapsible group in the Source Control view. */
export interface ScmGroupModel {
  /** Stable id, unique within one render. */
  id: string;
  label: string;
  resources: ScmResourceModel[];
}

export function buildScmGroups(
  snapshot: TicketChangesSnapshot,
  worktrees: readonly WorktreeSpec[],
): ScmGroupModel[];
```

`buildScmGroups` rules (implement exactly):
1. Iterate `snapshot.state.worktrees` by index `i`. The matching spec is `worktrees[i]`. If `worktrees[i]` is `undefined`, skip that view entirely (guard required by `noUncheckedIndexedAccess`).
2. If the view's `error` is non-null, contribute no groups for it.
3. Group ids are `` `w${i}-staged` ``, `` `w${i}-unstaged` ``, `` `w${i}-untracked` ``, and `` `w${i}-c${j}` `` for the j-th commit.
4. Group labels are `` `${view.label} — Staged` ``, `` — Unstaged``, `` — Untracked``, and `` `${view.label} — ${commit.shortHash} ${commit.subject}` ``.
5. Emission order per worktree: staged, unstaged, untracked, then commits in snapshot order.
6. A group whose file array is empty is not emitted.
7. `absolutePath` is `join(spec.path, file.path)`.
8. Resource order inside a group is the snapshot's order; do not sort.
9. The function is pure: it must not mutate `snapshot`, and must return freshly constructed arrays/objects.

Create `src/ui/diffs/scmModel.test.ts` with these cases (build fixtures inline as plain object literals typed as `TicketChangesSnapshot`; `targets` may be an empty `Map` because the model never reads it):
- Two worktrees, first with staged+untracked and one commit, second with only unstaged → asserts exact group ids, labels, and order.
- A worktree with `error: 'boom'` and non-empty arrays → emits no groups for it, and a later healthy worktree still emits with its own index-based ids.
- Empty categories are omitted (a worktree with only commits emits only commit groups).
- `absolutePath` equals `join(spec.path, file.path)` for a nested path like `src/a/b.ts`.
- A commit with zero files emits no group.
- Snapshot with more views than specs (specs array shorter) → the unmatched views are skipped and the function does not throw.

#### Constraints
- No `vscode` import. No I/O. No git calls.
- Do not modify `snapshot.ts`, `git.ts`, or any existing type.
- Use `node:path` `join`; do not hand-roll path concatenation.

#### Edge Cases
- Duplicate worktree labels: ids stay unique because they are index-based; labels may repeat and that is accepted.
- A commit subject containing `—` or newlines is used verbatim in the label; no escaping or truncation.

#### Verification
```bash
npx vitest run src/ui/diffs/scmModel.test.ts
npm run typecheck
```

Expected: all new tests pass; typecheck clean.

#### Completion Criteria
- [ ] `scmModel.ts` exports `ScmResourceModel`, `ScmGroupModel`, `buildScmGroups` with the signature above.
- [ ] All six test cases exist and pass.
- [ ] `grep -n "vscode" src/ui/diffs/scmModel.ts` returns nothing.

---

### Task 4: Create the host-agnostic controller (`scmController.ts`)

#### Objective
Add a vscode-free `TicketScmController` that owns the injected SCM host seam, renders a snapshot, resolves clicks back to `DiffTarget`s, and disposes cleanly.

#### Files
- `src/ui/diffs/scmController.ts` — new.
- `src/ui/diffs/scmController.test.ts` — new.

#### Implementation
Create `src/ui/diffs/scmController.ts`:

```ts
import type { DiffTarget, WorktreeSpec } from './git.js';
import type { TicketChangesSnapshot } from './snapshot.js';
import { buildScmGroups, type ScmGroupModel } from './scmModel.js';

/** A group of file rows the host has materialized. */
export interface ScmGroupHandle {
  setResources(resources: readonly ScmResourceHandleInput[]): void;
  dispose(): void;
}

/** What the host needs to render one row. */
export interface ScmResourceHandleInput {
  changeId: string;
  absolutePath: string;
  path: string;
  status: string;
  oldPath: string | null;
}

/** One materialized Source Control object. */
export interface ScmViewHandle {
  setTitle(title: string): void;
  createGroup(id: string, label: string): ScmGroupHandle;
  dispose(): void;
}

/** The seam the extension binds to `vscode.scm.createSourceControl`. */
export interface ScmHost {
  createView(id: string, title: string): ScmViewHandle;
  /** Bring the Source Control view forward. */
  focus(): void | Promise<void>;
  warn(message: string): void;
}

export interface TicketScmControllerDeps {
  host: ScmHost;
  load: (ticketId: number, signal?: AbortSignal) => Promise<{
    snapshot: TicketChangesSnapshot;
    worktrees: readonly WorktreeSpec[];
  }>;
  openDiff: (target: DiffTarget) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  titleFor: (ticketId: number) => string;
  debug?: (message: string) => void;
}

export class TicketScmController {
  constructor(private readonly deps: TicketScmControllerDeps) {}
  async show(ticketId: number): Promise<void>;
  async openChange(changeId: string): Promise<void>;
  dispose(): void;
}
```

Behavior (implement exactly):

`show(ticketId)`:
1. `debug?.('[diffs] scm show ticket=' + ticketId)`.
2. `await deps.load(ticketId)`. If it throws: `logError('karst: loading ticket changes for Source Control failed', error)`, then `host.warn(message)` where `message` is `error instanceof Error ? error.message : String(error)`, then return. Do not create or dispose the view on this path when a view for the same ticket already exists — leave the previous render standing.
3. Compute `groups = buildScmGroups(snapshot, worktrees)`.
4. If the currently held view is for a different ticket (or none exists), dispose the held view and its groups, then `host.createView('karst', titleFor(ticketId))`. If it is for the same ticket, dispose only its groups and reuse the view, calling `setTitle(titleFor(ticketId))`.
5. For each group model in order: `view.createGroup(model.id, model.label)` then `group.setResources(...)` mapping each `ScmResourceModel` to `{ changeId, absolutePath, path, status, oldPath }`. Keep the handles so they can be disposed on the next render.
6. Replace the held `changeId → DiffTarget` map with a fresh `Map` built from `snapshot.targets` (copy it; do not retain the snapshot).
7. `await deps.host.focus()`.
8. `debug?.('[diffs] scm rendered groups=' + groups.length)`.

`openChange(changeId)`:
1. Look up the target in the held map. If absent: `host.warn('That change is no longer available. Reopen changes for this ticket.')`, `debug?.('[diffs] scm openChange miss')`, return without throwing.
2. Otherwise `await deps.openDiff(target)`. If it throws: `logError('karst: opening diff from Source Control failed', error)` and `host.warn(message)`; do not rethrow.

`dispose()`: dispose every held group then the held view, clear the map, and become a no-op if called twice.

Concurrency: `show` holds a monotonically increasing request counter. After `await deps.load(...)` resolves, if a newer `show` has started, abandon the stale one — perform no host calls and no map replacement. Reuse the same "newest request wins" shape the panel manager uses.

Create `src/ui/diffs/scmController.test.ts` with a hand-written fake `ScmHost` that records `createView` / `createGroup` / `setResources` / `dispose` / `focus` / `warn` calls. Cases:
- Renders groups in model order, with resources carrying `changeId` and `absolutePath`; `focus` called once.
- Second `show` for the SAME ticket reuses the view (one `createView`) and disposes the previous groups before creating new ones.
- `show` for a DIFFERENT ticket disposes the previous view and creates a new one with the new title.
- `load` rejecting → `logError` and `warn` called, no `createView` on a first-ever show, and the method resolves (does not reject).
- `openChange` with a known id calls `openDiff` with the mapped target.
- `openChange` with an unknown id warns and does not call `openDiff`.
- `openDiff` rejecting → `warn` + `logError`, method resolves.
- Two overlapping `show` calls (first `load` resolves last) → only the newer render reaches the host.
- `dispose()` twice → no double-dispose of handles.

#### Constraints
- No `vscode` import in this file.
- Do not reuse or modify `TicketChangesManager`; the SCM path is independent.
- The controller must never receive or store a file path from the webview; its only external input is `changeId` strings and the loader's output.

#### Edge Cases
- A snapshot with zero groups: dispose old groups, create none, still `focus()`.
- `openChange` called before any `show`: the map is empty → warn path.
- A `changeId` from a previous render: absent from the new map → warn path.

#### Verification
```bash
npx vitest run src/ui/diffs/scmController.test.ts
npm run typecheck
```

Expected: all nine cases pass.

#### Completion Criteria
- [ ] `scmController.ts` exports the interfaces and class exactly as specified.
- [ ] All nine test cases exist and pass.
- [ ] `grep -n "vscode" src/ui/diffs/scmController.ts` returns nothing.

---

### Task 5: Bind the controller in `extension.ts` and route the dashboard action

#### Objective
Wire the real `vscode` SCM API to `ScmHost`, register the click command, and make `show-changes` honor the flag.

#### Files
- `src/extension.ts` — the only file changed.

#### Implementation
Depends on Tasks 1, 3, 4.

1. Add imports at the top of `src/extension.ts`, beside the existing `./ui/diffs/...` imports:
   ```ts
   import { TicketScmController, type ScmHost } from './ui/diffs/scmController.js';
   ```
2. **Extract the loader.** The `TicketChangesManager` construction at line ~2247 passes an inline `async (ticketId, signal) => { ... }` load callback. Move that function body verbatim into a named const declared immediately ABOVE the `const changes = new TicketChangesManager(` line:
   ```ts
   const ticketWorktreeSpecs = (ticketId: number) => {
     const pathContext = worktreePathContext(currentManifest(), logger.warn, logger.info);
     return listWorktreesByTicket(localStore, ticketId).map((worktree) => ({
       label: repoDisplayPath(worktree.repo, pathContext),
       path: worktree.path,
       branch: worktree.branch,
       baseRef: worktree.baseRef,
     }));
   };
   const loadTicketChanges = async (ticketId: number, signal?: AbortSignal) => {
     const worktrees = ticketWorktreeSpecs(ticketId);
     const snapshot = await buildTicketChangesSnapshot(
       ticketId,
       worktrees,
       (spec, inspectSignal) => inspectWorktree(defaultGitRunner, spec, inspectSignal),
       undefined,
       signal,
     );
     return { snapshot, worktrees };
   };
   ```
   Then replace the manager's inline load callback with:
   ```ts
   async (ticketId, signal) => (await loadTicketChanges(ticketId, signal)).snapshot,
   ```
   Every other constructor argument stays byte-identical.
3. **Bind the host.** After the `changes` construction block (after `context.subscriptions.push(changes);`), add:
   ```ts
   const scmHost: ScmHost = {
     createView: (id, title) => {
       const sc = vscode.scm.createSourceControl(id, title);
       // Karst's SCM view is read-only: no commit box, no staging.
       sc.inputBox.visible = false;
       return {
         setTitle: (next) => {
           sc.label = next;
         },
         createGroup: (groupId, label) => {
           const group = sc.createResourceGroup(groupId, label);
           group.hideWhenEmpty = true;
           return {
             setResources: (resources) => {
               group.resourceStates = resources.map((resource) => ({
                 resourceUri: vscode.Uri.file(resource.absolutePath),
                 command: {
                   command: 'karst.openTicketScmDiff',
                   title: 'Open Changes',
                   arguments: [resource.changeId],
                 },
                 decorations: {
                   tooltip: resource.oldPath
                     ? `${resource.status} — ${resource.oldPath} → ${resource.path}`
                     : `${resource.status} — ${resource.path}`,
                 },
               }));
             },
             dispose: () => group.dispose(),
           };
         },
         dispose: () => sc.dispose(),
       };
     },
     focus: () => vscode.commands.executeCommand('workbench.view.scm').then(() => undefined),
     warn: (message) => void vscode.window.showWarningMessage(message),
   };
   const ticketScm = new TicketScmController({
     host: scmHost,
     load: loadTicketChanges,
     openDiff: (target) => openTicketDiff(target, undefined),
     logError,
     titleFor: (ticketId) => {
       const t = getTicket(localStore, ticketId);
       return `Karst — ${compactTicketLabel(t, ticketLabel(t))}`;
     },
     debug: logger.debug,
   });
   context.subscriptions.push({ dispose: () => ticketScm.dispose() });
   ```
   If `openTicketDiff` is declared after this point in the file, move this block to just after `openTicketDiff`'s declaration; it must not be referenced before initialization at module-evaluation time.
4. **Register the command.** In the same `vscode.commands.registerCommand(...)` block list that already contains `'karst.archiveTicket'` (~line 6209), add:
   ```ts
   vscode.commands.registerCommand('karst.openTicketScmDiff', async (arg: unknown) => {
     if (typeof arg !== 'string' || arg.length === 0) return;
     await ticketScm.openChange(arg);
   }),
   ```
   If `ticketScm` is not in scope there, hoist the `ticketScm` declaration so it is (both are inside `activate`).
5. **Route the dashboard action.** Replace the `() => changes.open(ticketId)` argument at line ~2573 with:
   ```ts
   () => {
     // Manifest-gated (`diffsInSourceControl`, OFF by default): the ticket's
     // changed files render in the IDE's Source Control view instead of the
     // changes panel. Clicking a file opens the same diff either way.
     if ((currentManifest() ?? emptyManifest()).diffsInSourceControl === true) {
       void ticketScm.show(ticketId);
       return;
     }
     changes.open(ticketId);
   },
   ```
   Use the exact `(currentManifest() ?? emptyManifest()).<flag> === true` shape already used for `closeDoneTerminalsWithTicket` at lines 5228 and 6217.
6. Leave the second `changes.open` call site (`openDiff: (id) => changes.open(id)` at ~line 3060) unchanged — it is a different entry point and is out of scope.

#### Constraints
- Do not modify `openTicketDiff`'s body.
- Do not change `package.json` (no `contributes.commands` entry: `karst.openTicketScmDiff` is invoked only from resource states, never from the command palette).
- Do not add `quickDiffProvider`, `acceptInputCommand`, or any SCM menu contribution.
- Do not create the SourceControl object at activation time — it is created lazily on the first flagged `show`.
- Do not change any other `makeDashboardActions` argument or its parameter order.

#### Edge Cases
- Flag turned on while a changes panel is already open: the panel stays open; the next "Show Changes" click renders into Source Control. No cleanup of the panel.
- Flag turned off after a SCM render: the SourceControl object stays until the window closes; the next click opens the panel. Acceptable and explicitly in the design.
- Ticket with no worktrees: the loader returns an empty spec list, `buildScmGroups` yields zero groups, the view is created/retitled with no groups, and the SCM view is focused.

#### Verification
```bash
npm run typecheck
npx vitest run src/extensionActivation.test.ts
npm run build
```

Expected: typecheck clean, existing activation tests still pass, build succeeds.

Manual (requires F5 Extension Dev Host):
1. With `diffsInSourceControl` absent from `karst.yml`, click "Show Changes" on a worktree row → the "Ticket changes" panel opens exactly as before.
2. Set `diffsInSourceControl: true` (Settings → General toggle), click "Show Changes" → the Source Control view comes forward showing collapsible groups named `<repo> — Staged/Unstaged/Untracked` and one group per commit.
3. Click a file row → the same diff editor opens beside, identical to the panel's behavior.
4. Click "Show Changes" on a second ticket → the previous ticket's groups are gone and the view title names the new ticket.

#### Completion Criteria
- [ ] `loadTicketChanges` exists and the manager uses it; the manager's behavior is unchanged.
- [ ] `scmHost` + `ticketScm` are constructed inside `activate` and disposed via `context.subscriptions`.
- [ ] `karst.openTicketScmDiff` is registered and validates its argument is a non-empty string.
- [ ] The `show-changes` action branches on `diffsInSourceControl === true`.
- [ ] Typecheck, activation tests, and build all pass.
- [ ] The four manual steps produce the described results.

---

### Task 6: Document the flag in the architecture docs

#### Objective
Record the new invariant where the repo's binding documents already live.

#### Files
- `docs/arch/manifest-and-settings.md` — add a section for the flag.
- `docs/arch/worktrees-and-servers.md` — no change (listed only to state it is deliberately untouched).

#### Implementation
1. In `docs/arch/manifest-and-settings.md`, add a new `##` section immediately before the `## New \`Manifest\` field checklist` section:
   ```markdown
   ## `diffsInSourceControl` reroutes the changes UI, never the diff itself

   `diffsInSourceControl` (boolean, absent → off) decides only WHERE a ticket's changed-file list is listed: the "Ticket changes" webview panel (`TicketChangesManager`) or the IDE's native Source Control view (`TicketScmController`). The diff a click opens is the SAME code path either way — `openTicketDiff` → `vscode.diff` — so the flag can never produce a diff the other mode would not. The SCM path is vscode-free logic behind the `ScmHost` seam (`ui/diffs/scmController.ts`) over a pure group model (`ui/diffs/scmModel.ts`); `extension.ts` binds `vscode.scm.createSourceControl`. At most ONE SourceControl object is alive, and showing a different ticket replaces it — stale groups from another ticket are unrepresentable. The view is read-only (input box hidden, no staging, no quick diff) and is rebuilt only when the dashboard "Show Changes" action runs; it does not track the filesystem.
   ```
2. Add the flag to the checklist section's list of fields only if that section enumerates fields (it does not today) — otherwise leave the checklist text unchanged.

#### Constraints
- Do not restructure or reword any existing section.
- Do not touch `docs/ui/UI-RULES.md` — the SCM view is native VS Code chrome, not a Karst webview, so the webview rules do not apply to it.

#### Edge Cases
- None.

#### Verification
```bash
grep -n "diffsInSourceControl" docs/arch/manifest-and-settings.md
```

Expected: the new section is found.

#### Completion Criteria
- [ ] The new section exists in `docs/arch/manifest-and-settings.md`.
- [ ] No other doc file is modified.

---

## Final Verification

1. Run the full unit suite and the typechecker.
2. Run the build.
3. Perform the manual sequence from Task 5 in the Extension Dev Host (F5).

Commands:

```bash
npm run typecheck
npm run test:unit
npm run build
```

Expected:
- Typecheck clean.
- Full unit suite green, including the pre-existing `src/ui/diffs/*.test.ts`, `src/manifest/*`, and `src/ui/settings/*` suites.
- Build succeeds and emits `dist/`.
- With the flag absent, every existing diffs behavior is unchanged.

Commit convention: conventional commits, e.g. `feat: open ticket diffs in the Source Control view behind diffsInSourceControl`.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them (ESM `.js` import suffixes, colocated `*.test.ts`, vscode-free logic modules).
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report: the task number, the exact blocker, the evidence establishing it, which plan assumption is invalid, and the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
