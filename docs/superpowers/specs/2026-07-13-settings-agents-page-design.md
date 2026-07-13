# Settings › Agents Page — Design Spec

**Date:** 2026-07-13
**Area:** C of todo-4 decomposition (see `docs/todo-4.md`)
**Status:** ✅ Approved (layout: Option 1 · Provenance roster)
**Mockup:** scratchpad `agents-mockup.html` (Options 1–3; Option 1 chosen)

## Context

`docs/todo-4.md` is a backlog spanning four UI areas, decomposed into four
independent sub-projects (A create-ticket flow, B approaches page, C agents page,
D tickets list). This spec covers **C — Settings › Agents page**. Sibling B
(approaches) chose **Roster**; this tab shares that visual grammar for a coherent
settings surface.

## Grounded data model (do not re-derive)

- The Agents tab renders from the **agent pool**, NOT the manifest `agents:` map
  (that map is the obsolete role/command shape — see `webview.html` renderAgents
  comment and `karst.example.yml:119`).
- `buildAgentPool` (`src/agents/pool.ts`) = local `file` agents (under
  `agentsDir`, editable) ∪ `agent`-kind artifacts of installed+enabled approaches
  (read-only). Deduped by name (local wins), sorted by name.
- `PoolAgent` **already carries `approachId`** when `source==='approach'`
  (`pool.ts:13`). `SettingsAgentRow` (`src/ui/settings/state.ts:9`) currently
  **drops it** — the "which approach owns it" data exists; it just isn't threaded
  to the webview. This is the cheap fix behind P2.
- Onboarding create-dropdown calls `buildAgentPool` **with** `agentsMeta` → drops
  disabled agents. Settings tab (`listAgentRows`, `extension.ts:291`) calls it
  **without** `agentsMeta` → keeps disabled ones visible with `enabled:false`, so
  the tab is the single place to re-enable them.

## Goals (todo-4 § agents page)

1. **P1 — surface every agent.** Pre-installed / approach-owned agents appear in
   the create subagents dropdown but aren't manageable in Settings. The tab must
   show every pooled agent (yours + approach-owned) with an explicit
   enable/disable control — parity with the create flow it feeds.
2. **P2 — owner attribution.** Approach-owned agents must show which approach owns
   them (today a bare name). Structural in this tab; suffixed `name (approachId)`
   in the flat create dropdown.
3. **P3 — UI/UX rework** (design-gated: `/frontend-design` options presented and
   approved before implementation — this spec).

---

## Chosen layout — Option 1 · Provenance roster

Design thesis: an agent = a subagent you delegate a ticket to. The tab's one job
is to curate which subagents surface in the **"Direct implementation with a
subagent"** create flow, and to show where each came from. Two facts per agent
carry all the weight: **origin** (yours/editable vs approach-owned/read-only) and
**enabled?** (does it appear in the create dropdown). So the organizing spine is
**provenance**, and the signature device is the tab **mirroring the create
dropdown it feeds**.

### Structure

- **Single column, grouped by provenance** (no inner sidebar — the settings page
  already has a left nav; a second vertical list would compete, same reasoning
  that rejected it for approaches).
  - **`Yours`** — local file agents. Editable body (inline editor), Delete, New.
  - **`From approaches`** — approach-owned agents, **bracketed on a left spine
    under their owning approach `id`** (e.g. `rpi`, `tdd`). Read-only, with a
    `manage in approach ↗` link. The bracket header IS the owner attribution.
- **Enable/disable per agent** via a switch. Enabled = green rail on the agent
  row = appears in the create dropdown.
- **Header stat mirrors the create flow:** `N / M enabled` with the caption that
  these are the agents enabled in the "Direct implementation with a subagent"
  create flow. This is the tab's signature — the direct causal link between the
  toggle here and the dropdown there.

### Wording (locked)

Use **enable / disable** vocabulary throughout — the row pill reads
`enabled` / `disabled` and the header reads `N / M enabled` (NOT "live/off").
Approved correction over the first mockup pass.

### Typography / structure devices

- Agent names in the **mono utility face** (agents are code-ish identifiers, like
  commands). Group headers are the existing uppercase eyebrow (`h2`) treatment.
- Provenance is a **left spine + bracket**, not a badge — structural, not
  decorative. This is the one place boldness is spent; everything else stays quiet.

### Theming constraint (hard — same as approaches)

VS Code webview: **all** color/type flows through `--vscode-*` tokens — the
mockup's hex values are dark-theme stand-ins only. No custom palette; must render
under any VS Code theme, light or dark. Green rail = `--vscode-charts-green`
(fallback), accent/owner id = `--vscode-textLink-foreground`, muted via opacity.

---

## Data / plumbing changes the redesign needs

- **Thread `approachId` through** `SettingsAgentRow` (add `approachId?: string`)
  and populate it in `listAgentRows` (`extension.ts:299`) from the pool entry.
  Immutable map, no new fetch. (P2 in this tab.)
- **Group + sort for render:** webview groups rows by `source` then, within
  `approach`, by `approachId`; `file` agents first. Grouping logic can live in a
  small vscode-free helper (unit-testable) rather than inline in `webview.html`.
- **Create dropdown suffix (P2, flat context):** where the onboarding dropdown
  renders an approach-owned agent, label it `name (approachId)`. Localized to the
  onboarding render; the pool already carries `approachId`.
- **Enable/disable action** reuses the existing `set-agent-enabled` message
  (`webview.html` already posts it) → writes `agents[name].enabled`. No new
  message needed for the toggle. New/Delete/Save reuse existing
  `create-agent` / `delete-agent` / `save-agent-file`.

## Functional requirements the redesign preserves

- File agents: inline body editor + Save + Delete (existing messages).
- Approach agents: read-only, `manage in approach ↗` (deep-link to the Approaches
  tab / that approach's card), enable/disable honored.
- Disabled agents stay visible here (that's the point) but drop out of the create
  dropdown.

## Cross-cutting

- **Immutability:** row/state updates return new objects.
- **Error handling:** body reads / actions degrade to a surfaced error, never a
  silent swallow or throw across the message boundary (`listAgentRows` already
  degrades to `[]`).
- **File size:** extract grouping/label helpers into a focused vscode-free module
  (testable under vitest); `webview.html` is already large — add render, not
  logic, there.
- **Architecture invariants (CLAUDE.md):** no `vscode` import in testable logic;
  keep the pool agent-agnostic; no plugin concept leaks in.

## Tests (TDD, RED first)

- `state.ts` / pool-row mapping — `approachId` present for approach rows, absent
  for file rows.
- Grouping helper — file agents first; approach agents grouped by `approachId`,
  stable order; disabled agents retained.
- Onboarding label — approach-owned agent renders `name (approachId)`; file agent
  renders bare `name`.
- Existing `panel.test.ts` / `actions.test.ts` continue to pass (enable/disable,
  create, delete, save-agent-file unchanged). New render lives in `webview.html`
  (no vscode-free seam) — covered indirectly via the helper + action tests.

## Out of scope

- Areas A, B, D of todo-4 (separate specs).
- Approach install/fetch/classify/sanitize changes.
- Any change to how agents are launched/materialized.

## Plan ordering

1. Thread `approachId` (state + `listAgentRows`) — RED first.
2. Grouping/label helper (vscode-free) — RED first.
3. Onboarding dropdown owner suffix.
4. Webview render: provenance roster (groups, spine, enable/disable switch,
   header stat, inline editor for file agents, `manage in approach ↗`).
