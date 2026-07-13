# Settings › Approaches Page — Design Spec

**Date:** 2026-07-13
**Area:** B of todo-4 decomposition (see `docs/todo-4.md`)
**Status:** Approved for planning

## Context

`docs/todo-4.md` is a backlog spanning four UI areas. It was decomposed into
four independent sub-projects (A create-ticket flow, B approaches page, C agents
page, D tickets list). This spec covers **B — Settings › Approaches page**. The
others get their own spec → plan → build cycle.

Sibling item already done and out of scope: services `http`→`port` rename
(commit `1bb815f`).

## Goals

Four workstreams on the approaches surface:

1. **Command namespace swap** — orchestrator command `/rpi:karst` → `/karst:rpi`.
2. **Enable-guard** — a not-installed approach cannot be enabled.
3. **Command-content drawer** — clicking a command chip opens a drawer showing
   the command's markdown body.
4. **UI/UX rework** — redesign the approaches tab (design-gated: `/frontend-designer`
   options presented and approved before any implementation).

Each workstream ships independently; ordering in the plan is 1 → 2 → 3 → 4.

---

## Workstream 1 — Command namespace swap (`/karst:rpi`)

### Current behavior (grounded)

- The launch materializer (`src/agent/claude.ts` `materializeApproach`) builds a
  single plugin dir `sessionDir/.karst-plugin/<id>` whose `plugin.json.name = <id>`.
- The generated orchestrator is written to `commands/karst.md`
  (`KARST_COMMAND_NAME`), so a plugin named `<id>` registers it as `/<id>:karst`
  (e.g. `/rpi:karst`).
- The approach's **native** fetched commands live in the same plugin's
  `commands/` and register as `/<id>:<basename>` (e.g. `/rpi:research`).
- Native phase-command strings (e.g. `/rpi:research`) are **authored in the
  approach definition**, stored verbatim in the package, and verified at install
  by `assertWorkflowCommandsResolvable` (`src/approaches/fetch.ts:464`) against
  `prefix = /<id>:`.
- `buildWorkflowInvocation` / `renderWorkflowCommand` / `KARST_COMMAND_NAME`
  (`src/agent/workflowCommand.ts`) are the single source of truth for the
  orchestrator name; `listApproachCommands` (`src/extension.ts:314`) mirrors it
  for the settings chips.

### Chosen design — Design 2 (two plugins)

Split the single plugin into two sibling plugins under the session's plugin root:

- **`karst` plugin** — holds ONLY karst-generated orchestrator commands, one per
  workflow approach: `commands/<id>.md` → registers `/karst:<id>` (e.g.
  `/karst:rpi`, `/karst:gsd`).
- **`<id>` plugin** (unchanged) — holds the approach's native fetched
  artifacts (`commands/`, `agents/`, `skills/`). Native commands keep registering
  as `/<id>:<basename>` (e.g. `/rpi:research`), so authored phase strings and
  upstream RPI docs stay correct with zero rewrite.

Rationale: swaps exactly what the todo asks (the orchestrator), smallest blast
radius, native commands untouched.

### Changes

- **`workflowCommand.ts`**
  - Add `KARST_PLUGIN_NAME = 'karst'`.
  - The orchestrator file basename becomes `<id>.md` (was `karst.md`); the
    registered name becomes `/karst:<id>`.
  - `buildWorkflowInvocation(id, key)` → `/karst:<id> <key>` (was `/<id>:karst`).
  - `renderWorkflowCommand` title → `# /karst:<id> — <label>`.
- **`claude.ts` `materializeApproach`**
  - When a workflow is present, write the orchestrator into a **separate**
    `sessionDir/.karst-plugin/karst/` plugin dir (its own
    `.claude-plugin/plugin.json` `name: "karst"`), file `commands/<id>.md`.
  - The `<id>` plugin dir keeps native artifacts + solo agent as today; it no
    longer contains the orchestrator.
  - Return `extraArgs` that load **both** plugins.
- **`extension.ts` `listApproachCommands`**
  - Generated orchestrator chip → `/karst:<id>`; native chips stay `/<id>:<name>`.
- **`webview.html`**
  - `renderApproachCommands` "generated" detection: `c.startsWith('/karst:')`
    (was `c.endsWith(':karst')`).

### Open risk — multi-plugin `--plugin-dir` loading — RESOLVED

**RESOLVED (2026-07-13):** `claude --help` documents `--plugin-dir` as
**repeatable** ("(repeatable: --plugin-dir A --plugin-dir B.zip)"). Design 2's
`TWO_FLAGS` mechanism is officially supported: the materializer passes
`--plugin-dir <idDir> --plugin-dir <karstDir>`. No spike required; Design 1
fallback is unnecessary.

### Tests (TDD, RED first)

- `workflowCommand.test.ts` — flip every assertion: `/karst:rpi` title,
  `buildWorkflowInvocation('rpi','PROJ-9') === '/karst:rpi PROJ-9'`, empty-key
  trims to `/karst:rpi`, no-drift test references `KARST_PLUGIN_NAME`.
- `claude.test.ts` — two plugin dirs materialized; orchestrator lands in
  `karst/commands/<id>.md`; native artifacts in `<id>/…`; `extraArgs` load both.
- `extension`-level or unit coverage that `listApproachCommands` emits
  `/karst:<id>` for the generated chip and `/<id>:<name>` for natives.

---

## Workstream 2 — Enable-guard (not-installed cannot be enabled)

### Current behavior

`approachInstallAffordance` (`webview.html`) already gates Install/Uninstall on
the disk-state `installedIds` set. The enable/disable toggle is a separate
control (approach enable/disable action landed in commit `2a7a6b2`).

### Change

- **Render (webview):** when `!installedIds.includes(a.id)`, the enable toggle is
  rendered disabled (and visually muted), with a hint ("Install to enable").
- **Action guard (`src/ui/settings/actions.ts`):** the enable-approach action
  rejects (no-op + surfaced error) when the target id is not installed — so a
  crafted/stale message can't enable an uninstalled approach. Never trust the
  webview alone (input validation at the boundary).

### Tests

- `actions.test.ts` — enabling a not-installed approach id is rejected and does
  not mutate manifest state; enabling an installed one still works.

---

## Workstream 3 — Command-content drawer

### Behavior

Clicking a command chip in an approach's Commands row opens a drawer showing that
command's markdown body (read-only).

### Design

- **New message** (`src/ui/settings/messages.ts`): request
  `getApproachCommandBody { approachId, command }` → response
  `approachCommandBody { command, body }`.
- **New action** (`src/ui/settings/actions.ts`):
  - Native command (`/<id>:<name>`) → read `commands/<name>.md` from the
    installed package on disk.
  - Generated orchestrator (`/karst:<id>`) → render on demand via
    `renderWorkflowCommand` from the package's stored `workflow` (no file needed).
  - Missing/unreadable → return a clear error string, never throw.
- **UI (`webview.html`):** chips become clickable; a drawer panel renders the
  returned markdown. Reuse the existing drawer/panel styling if one exists;
  otherwise a minimal slide-over consistent with the current settings CSS.

### Tests

- `actions.test.ts` / `messages.test.ts` — native command body read from disk;
  orchestrator body rendered from workflow; unknown command → error, no throw.

---

## Workstream 4 — UI/UX rework (design decided: Option A · Roster)

The approaches tab redesign. Design explored via `/frontend-design` (mockup:
scratchpad `approaches-mockup.html`, options A–D). **Chosen: Option A · Roster.**

### Chosen layout — Roster

- Single-column list of approach **cards** (no inner sidebar — the settings page
  already has the left nav; a second vertical list would compete with it).
- Cards **grouped by install-state**: `Installed` / `Available` / `Built-in`
  section headers. Kills the current "can't tell what's installed" problem.
- Each card: a 4px left **status rail** (green = installed, muted = not), the
  approach `id` in mono + label, and a right-aligned action cluster.
- Installed cards show two command lines: `entry` → the orchestrator
  `/karst:<id>` (accent-outlined) and `runs` → native commands (grey chips).
  Commands are rendered in the **mono utility face** (commands are code).
- GitHub source link (git approaches) in the card footer.

### Theming constraint (hard)

VS Code webview: **all** color/type flows through `--vscode-*` tokens — the
mockup's hex values are standalone fallbacks only. No custom palette. The design
must render correctly under any VS Code theme, light or dark. (This also nods to
the broader todo.md item "theme of extension should inherit VS Code theme".)

### Functional requirements the redesign preserves/exposes

- Install / uninstall affordance (git immediate, npm confirm-run) — unchanged
  behavior, restyled into the card action cluster.
- Enable/disable toggle honoring Workstream 2's guard (muted + non-interactive
  on not-installed cards, "Install to enable" title).
- Command tokens are clickable (Workstream 3) → drawer with the `.md` body;
  orchestrator visually distinguished (accent) from native commands (grey).
- GitHub source link for git-sourced approaches.

### Tests

- Existing `panel.test.ts` / `state.test.ts` continue to pass (state shape
  unchanged). New rendering is in `webview.html` (not unit-tested directly — it
  has no vscode-free seam); logic changes it depends on (grouping order,
  installed/enabled flags) are already covered by state/actions tests.

---

## Cross-cutting

- **Architecture invariants (CLAUDE.md):** the plugin format stays confined to
  `ClaudeAdapter.materializeApproach` — Workstream 1's two-plugin split lives
  entirely there. No new plugin concept leaks into install/manifest. Approach
  packages stay agent-agnostic.
- **Immutability:** all state updates return new objects (settings draft, pool).
- **Error handling:** every new read/action degrades to a surfaced error, never a
  silent swallow or throw across the message boundary.
- **File size:** keep new logic in focused modules; `webview.html` is already
  large — extract drawer logic to a small helper block rather than growing it
  unboundedly.

## Out of scope

- Areas A, C, D of todo-4 (separate specs).
- Agents-page naming/visibility (area C), even though it shares the settings
  surface.
- Any change to how approaches are fetched/classified/sanitized.

## Testing strategy

TDD throughout (RED → GREEN). Unit coverage per workstream as listed. No new
`vscode`-importing logic — all testable logic stays in vscode-free modules
(`workflowCommand.ts`, `actions.ts`, `messages.ts`, `claude.ts`) exercised under
vitest with fakes. Target ≥80% on changed modules.

## Plan ordering

1. Verify multi-plugin `--plugin-dir` (gates Design 2 vs Design 1 fallback).
2. Workstream 1 — namespace swap.
3. Workstream 2 — enable-guard.
4. Workstream 3 — command drawer.
5. Workstream 4 — UI/UX rework (design checkpoint → implement).
