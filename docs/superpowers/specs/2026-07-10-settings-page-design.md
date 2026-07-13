# Karst Settings Page — Design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation plan

## Goal

Give users a UI to edit `.karst/karst.yml` (the manifest) instead of hand-editing YAML. The
page exposes the full manifest config surface across four sections and writes changes back to
disk safely, using the same validator the loader uses so the UI can never persist a manifest
the loader would reject.

## Scope

All four manifest sections are editable, and the page is **schema-driven / section-based** so
future manifest keys extend it without a rewrite:

- **General** — `host`, `portRange [min,max]`, `baselineBranch`, `worktreePathDisplay` (`relative` | `absolute`)
- **Services** (map) — per service: `repoPath`, `start`, `health?`, `hasMigrations`, `ports[]`
  (name/env/default), `dependsOn[]` (target/port/bind[]), `signals[]`
- **Approaches** (list) — `id`, `label`, `recommended?` (at most one)
- **Agents** (role map) — role → `command?`

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Writeback | Merge-over-raw re-serialize | Read raw YAML tree → overlay only the sections the UI edited → `validateManifest` → `yaml.dump` merged tree → write. **Preserves unknown top-level keys and unmodeled service fields** (serves the extensibility goal). Comments still drop (documented tradeoff, same as current `writeServiceSignals`). |
| Open on invalid manifest | Load raw, show errors inline | Settings reads the file **directly, not via the `resolveManifest` gate** (which returns undefined on invalid and would block open). If the file fails validation, open anyway with raw values + the validation error shown — fixing a broken manifest is exactly the point. |
| Entry | `karst.openSettings` command + gear icon in sidebar view title | Discoverable, matches VS Code convention. Needs a `menus > view/title` contribution in `package.json`. |
| Save | Explicit **Save** button; webview holds draft; dirty indicator + Discard | Nothing writes until Save — safe with graph edits. |
| Validation | Live `validateManifest` on draft; inline errors; **Save disabled while invalid** | Same validator as loader → zero drift; user never hits a failed write. |
| Services layout | **Accordion cards** (Option A) | Matches existing dashboard/onboarding webviews; tables map 1:1 to `ports[]` / `dependsOn[]`; least new pattern to build & test. Graph view deferred as possible read-only preview later. |

## Architecture

Mirrors the existing `src/ui/dashboard` and `src/ui/onboarding` pattern: host-agnostic modules,
unit-testable with fakes, `vscode` supplied only by the activation adapter.

```
src/ui/settings/
  panel.ts      SettingsManager: single panel, open/reveal, message pump, pushState
  state.ts      buildSettingsState(manifest) -> webview-shaped snapshot
  messages.ts   WebviewMessage union + parseWebviewMessage (trust boundary) + routeAction
  actions.ts    host logic: draft validate + save
  webview.html  nav + accordion service cards, dirty dot, Save (Option A)
  *.test.ts     RED-first per module
```

New manifest writer (generalizes the existing single-field `writeServiceSignals`):

```
src/manifest/write.ts
  writeManifest(path, manifest): read raw YAML tree -> overlay ONLY the edited sections
                                 (general/services/approaches/agents) onto the raw tree,
                                 preserving unknown top-level keys + unmodeled service fields
                                 -> validateManifest(merged) -> yaml.dump(merged) -> writeFileSync
```

`writeServiceSignals` stays (onboarding classify-gate uses it) — `writeManifest` is the general
form for the settings page. Both re-validate before write; neither writes on failure.

## Data Flow

**Open:**
```
karst.openSettings:
  read manifest file directly (raw), NOT via resolveManifest gate
  try validateManifest -> ok:  open with typed values
                       -> throw: open with raw values + error banner (broken manifest is fixable here)
```

**Save:**
```
webview draft --> post {type:'save', manifest: draft}
  actions.save:
    validateManifest(draft)
      throw -> post {type:'error', message}   (banner; panel stays open; NO write)
      ok    -> writeManifest(path, draft)      (merge-over-raw; preserves unknown keys)
               reloadManifest(); onChange(); pushState()
```

**Shared-manifest refresh after Save:** the activation layer holds the live manifest in
`currentManifest` (module var) and hands it to dashboard/onboarding via getters
(`() => currentManifest`). `reloadManifest()` re-reads the file into `currentManifest` so those
getters — and the next `pushState` anywhere — see the saved values; `onChange()` then refreshes
the sidebar + open dashboard. Without this refresh, other panels would keep the stale manifest.

**Live validation (drives Save-enabled):**
```
webview edit --> post {type:'validate', manifest: draft}
  host: run validateManifest(draft)
        --> post {type:'validation', ok, error?}
  webview: Save button disabled while !ok; show inline/section error
```

## Trust Boundary

The webview is untrusted. `parseWebviewMessage` validates every inbound message shape before it
reaches `save`/`validate` — no message drives a disk write with unvalidated input. The manifest
draft itself is fully re-validated by `validateManifest` (including cross-service `validateGraph`)
before any write.

## Error Handling

- Invalid draft on Save → error banner with the `ManifestError` message; panel stays open; no file touched.
- YAML read/parse failure in `writeManifest` → `ManifestError`; surfaced as error banner.
- Message pump wraps `routeAction` in try/catch (same as dashboard) so one bad message never kills the panel.

## Testing (TDD, RED first)

- `messages.test.ts` — `parseWebviewMessage` rejects malformed shapes; routes valid ones.
- `state.test.ts` — `buildSettingsState` maps a manifest to the webview state shape (all 4 sections).
- `actions.test.ts` — save writes on valid draft; rejects + does **not** write on invalid; verifies `reloadManifest -> onChange -> pushState` order; live-validate returns ok/error.
- `write.test.ts` — `writeManifest` round-trips a manifest; **preserves an unknown top-level key + an unmodeled service field** across a write (merge-over-raw); rejects a manifest failing graph validation (never writes).
- `panel.test.ts` — opens with typed values on a valid file; opens with raw values + error on an invalid file (open-on-invalid).

Fakes for panel and filesystem, consistent with existing UI tests. Target 80%+ coverage.

## Out of Scope

- Dependency-graph visual editor (Option C) — possible future read-only preview.
- Editing anything outside `karst.yml`.
- Comment preservation in YAML (documented tradeoff).
