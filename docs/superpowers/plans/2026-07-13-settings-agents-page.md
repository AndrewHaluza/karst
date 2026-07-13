# Settings Agents Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Settings › Agents tab into a provenance roster (Option 1): surface every pooled agent with enable/disable, attribute approach-owned agents to their owning approach, and show the same in the create dropdown.

**Architecture:** `approachId` already rides `PoolAgent`; thread it to the webview via `SettingsAgentRow`, sort rows by provenance in a vscode-free helper wired into `buildSettingsState`, and render grouped sections inline in `webview.html`. Onboarding dropdown gains the `name (approachId)` suffix.

**Tech Stack:** TypeScript ESM (`.js` imports, `moduleResolution:Bundler`), vitest, VS Code webview (vanilla JS + `--vscode-*` tokens).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-settings-agents-page-design.md`. Every task implicitly includes it.
- Strict TDD (RED→GREEN). Conventional commits. Files <400 lines typical.
- ESM: relative imports end in `.js`. `noUncheckedIndexedAccess` on (array access needs `!`/guard).
- Immutability: return new objects/arrays; never mutate `draft`, rows, or the pool.
- Webview HTML is a static asset — it CANNOT import TS modules; its render logic is inline vanilla JS. Testable logic therefore lives host-side (state.ts / helpers) and is pushed as data.
- `vscode`-importing modules (`extension.ts`) don't load under vitest — put testable logic in vscode-free modules.
- VS Code webview: all color/type via `--vscode-*` tokens — no literal hex. Green rail = `--vscode-charts-green` (fallback), owner id = `--vscode-textLink-foreground`.
- Enable/disable reuses the existing `set-agent-enabled` message; New/Delete/Save reuse `create-agent`/`delete-agent`/`save-agent-file`. No new messages.

---

### Task 1: Thread `approachId` through the agent row

**Files:**
- Modify: `src/ui/settings/state.ts` (`SettingsAgentRow`)
- Modify: `src/extension.ts` (`listAgentRows`, ~lines 296-305)

**Interfaces:**
- Consumes: `PoolAgent.approachId?: string` (already on `src/agents/pool.ts:13`, set when `source==='approach'`).
- Produces: `SettingsAgentRow` gains `approachId?: string`, populated for approach rows. Task 2 sorts on it; Task 4 renders it.

- [ ] **Step 1: Add the field to the interface**

In `src/ui/settings/state.ts`, extend `SettingsAgentRow`:

```typescript
export interface SettingsAgentRow {
  name: string;
  source: 'file' | 'approach';
  approachId?: string; // set when source==='approach' — the owning approach's id
  enabled: boolean;
  body: string | null;
}
```

- [ ] **Step 2: Populate it in `listAgentRows`**

In `src/extension.ts`, in the `pool.map(...)` inside `listAgentRows`, add `approachId`:

```typescript
      return pool.map((a) => ({
        name: a.name,
        source: a.source,
        ...(a.approachId !== undefined ? { approachId: a.approachId } : {}),
        enabled: agentsMeta[a.name]?.enabled !== false,
        body: a.source === 'file' ? (readAgentFile(agentsDirOrThrow(), a.name)?.body ?? null) : null,
      }));
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. (No unit test here — `extension.ts` is untestable under vitest; the field is exercised by Task 2's tests, which build rows with `approachId`.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/settings/state.ts src/extension.ts
git commit -m "feat: thread approachId through the settings agent row"
```

---

### Task 2: Provenance sort helper, wired into `buildSettingsState`

**Files:**
- Create: `src/ui/settings/agentGrouping.ts`
- Test: `src/ui/settings/agentGrouping.test.ts`
- Modify: `src/ui/settings/state.ts` (`buildSettingsState` applies the sort)
- Test: `src/ui/settings/state.test.ts` (assert pushed agents are provenance-sorted)

**Interfaces:**
- Consumes: `SettingsAgentRow` (Task 1).
- Produces: `sortAgentRowsByProvenance(rows: readonly SettingsAgentRow[]): SettingsAgentRow[]` — file agents first (original order preserved), then approach agents grouped by `approachId` (groups ordered by first appearance, order within a group preserved), disabled rows retained. `buildSettingsState` returns `agents` already in this order, so the webview renders sections by walking the flat list.

- [ ] **Step 1: Write the failing helper test**

Create `src/ui/settings/agentGrouping.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sortAgentRowsByProvenance } from './agentGrouping.js';
import type { SettingsAgentRow } from './state.js';

const row = (name: string, source: 'file' | 'approach', approachId?: string, enabled = true): SettingsAgentRow =>
  ({ name, source, ...(approachId ? { approachId } : {}), enabled, body: source === 'file' ? '' : null });

describe('sortAgentRowsByProvenance', () => {
  it('puts file agents first, preserving their order', () => {
    const out = sortAgentRowsByProvenance([
      row('zeta', 'approach', 'rpi'),
      row('beta', 'file'),
      row('alpha', 'file'),
    ]);
    expect(out.map((r) => r.name)).toEqual(['beta', 'alpha', 'zeta']);
  });

  it('groups approach agents by approachId in first-appearance order', () => {
    const out = sortAgentRowsByProvenance([
      row('a1', 'approach', 'rpi'),
      row('b1', 'approach', 'tdd'),
      row('a2', 'approach', 'rpi'),
      row('f', 'file'),
    ]);
    expect(out.map((r) => r.name)).toEqual(['f', 'a1', 'a2', 'b1']);
  });

  it('retains disabled rows', () => {
    const out = sortAgentRowsByProvenance([row('x', 'file', undefined, false)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.enabled).toBe(false);
  });

  it('returns a new array (immutable)', () => {
    const input = [row('f', 'file')];
    expect(sortAgentRowsByProvenance(input)).not.toBe(input);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/ui/settings/agentGrouping.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `src/ui/settings/agentGrouping.ts`:

```typescript
import type { SettingsAgentRow } from './state.js';

/**
 * Order agent rows for the provenance roster: local `file` agents first (in
 * their given order), then `approach` agents grouped by `approachId` — groups
 * appear in first-appearance order, rows within a group keep their order.
 * Disabled rows are retained (the tab is where they get re-enabled). Pure; a new
 * array is returned.
 */
export function sortAgentRowsByProvenance(
  rows: readonly SettingsAgentRow[],
): SettingsAgentRow[] {
  const files = rows.filter((r) => r.source === 'file');
  const approachRows = rows.filter((r) => r.source === 'approach');
  const order: string[] = [];
  const byId = new Map<string, SettingsAgentRow[]>();
  for (const r of approachRows) {
    const id = r.approachId ?? '';
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(r);
  }
  return [...files, ...order.flatMap((id) => byId.get(id)!)];
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run src/ui/settings/agentGrouping.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the sort into `buildSettingsState` (failing test first)**

Add to `src/ui/settings/state.test.ts` a case asserting the pushed `agents` are provenance-sorted (follow the file's existing `buildSettingsState` call convention — it takes `(manifest, error, installedIds, tokenConfigured, implementedProviders, agents, approachCommands)` positionally; pass an unsorted `agents` array and assert the output order):

```typescript
it('orders agents by provenance (file first, then grouped by approach)', () => {
  const agents = [
    { name: 'z', source: 'approach' as const, approachId: 'rpi', enabled: true, body: null },
    { name: 'a', source: 'file' as const, enabled: true, body: '' },
  ];
  const state = buildSettingsState(validManifest, null, [], false, ['claude'], agents, {});
  expect(state.agents.map((r) => r.name)).toEqual(['a', 'z']);
});
```

Match `validManifest` / argument order to the existing tests in the file.

- [ ] **Step 6: Run — verify it fails**

Run: `npx vitest run src/ui/settings/state.test.ts`
Expected: FAIL — agents are passed through unsorted.

- [ ] **Step 7: Apply the sort in `buildSettingsState`**

In `src/ui/settings/state.ts`, import the helper and sort the `agents` before returning:

```typescript
import { sortAgentRowsByProvenance } from './agentGrouping.js';
// ...
// inside buildSettingsState, where the returned object is built:
    agents: sortAgentRowsByProvenance(agents),
```

- [ ] **Step 8: Run — verify both pass**

Run: `npx vitest run src/ui/settings/agentGrouping.test.ts src/ui/settings/state.test.ts`
Expected: PASS. Then `npm run typecheck` (clean).

- [ ] **Step 9: Commit**

```bash
git add src/ui/settings/agentGrouping.ts src/ui/settings/agentGrouping.test.ts src/ui/settings/state.ts src/ui/settings/state.test.ts
git commit -m "feat: sort settings agents by provenance (file first, then by approach)"
```

---

### Task 3: Onboarding dropdown owner suffix

**Files:**
- Modify: `src/ui/onboarding/webview.html` (`renderAgentPicker`, ~line 479-483)

**Interfaces:**
- Consumes: onboarding `state.agents` = `PoolAgent[]` from `listAgents()` — each already carries `source` and (for approach agents) `approachId` (verify it survives serialization; `PoolAgent` includes it and the state pushes the pool whole).

- [ ] **Step 1: Confirm `approachId` reaches the onboarding webview**

Read where onboarding state is built (grep `listAgents` in `src/extension.ts`, ~line 493, and the onboarding state push). Confirm the pushed agent objects include `approachId` for approach agents (they are `PoolAgent`s). If a mapping strips it, add `approachId` to that mapping. If already whole, no change.

- [ ] **Step 2: Change the suffix to the owning approach id**

In `src/ui/onboarding/webview.html` `renderAgentPicker`, replace:

```javascript
      + esc(a.name) + (a.source === 'approach' ? ' (approach)' : '')
```
with:
```javascript
      + esc(a.name)
      + (a.source === 'approach' ? ` (${esc(a.approachId || 'approach')})` : '')
```

- [ ] **Step 3: Build + typecheck**

Run: `npm run build && npm run typecheck`
Expected: build succeeds (copies onboarding webview to dist), typecheck clean. (Inline webview change — no vitest seam; the labeling rule is documented and mirrors the settings provenance grouping.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/onboarding/webview.html src/extension.ts
git commit -m "feat: label approach-owned agents by owning approach in the create dropdown"
```

---

### Task 4: Provenance roster render (settings Agents tab)

**Files:**
- Modify: `src/ui/settings/webview.html` (`renderAgents` / `renderAgentCard` and the Agents section)

**Interfaces:**
- Consumes: pushed `agents` (already provenance-sorted, each with `name`, `source`, `approachId?`, `enabled`, `body`), `installedIds`. Posts existing `set-agent-enabled` / `create-agent` / `delete-agent` / `save-agent-file`.
- Produces: view only — no exported interface. Not unit-tested (no vscode-free seam); verified by build + self-review. Rests on Tasks 1-2 (covered).

> UI integration task; no unit test. Keep it self-contained.

- [ ] **Step 1: Render provenance groups**

Rework `renderAgents` to walk the (already-sorted) `agents` and emit section headers on provenance change:
- A **`Yours`** header before the run of `source==='file'` agents (only if any).
- A **`From approaches`** header, then within it a per-`approachId` sub-group: a left-spine bracket labelled with the approach `id` (mono, `--vscode-textLink-foreground`), the approach's agents bracketed under it. Emit a new sub-group header whenever `approachId` changes.
Use the existing uppercase eyebrow (`h2`/group-header) treatment already used by the approaches roster for the top-level `Yours` / `From approaches` headers, for a coherent surface.

- [ ] **Step 2: Agent row content**

For each agent row:
- Agent `name` in `var(--mono)`.
- Enable/disable **switch** posting `{type:'set-agent-enabled', name, enabled}` (reuse the existing toggle markup/handler). Enabled = a green rail (`--vscode-charts-green`) on the row.
- **File agents (`source==='file'`):** keep the existing inline body editor + Save (`save-agent-file`) + Delete (`delete-agent`), and the New-agent affordance (`create-agent`).
- **Approach agents (`source==='approach'`):** read-only (no body editor), with a `manage in approach ↗` link that switches to the Approaches tab (reuse the existing nav-switch: click the `approaches` nav button / set the section). No Delete.

- [ ] **Step 3: Header stat**

Add a header line for the tab: `N / M enabled`, where `M` = total agents, `N` = enabled count, with the caption that these are the agents offered in the "Direct implementation with a subagent" create flow. Derive both from the pushed `agents`.

- [ ] **Step 4: Theming + a11y**

Every color via `--vscode-*` tokens (no literal hex). Visible keyboard focus on the switch and links. Escape all interpolated values with `esc()`; set the body textarea via value/`textContent`, never innerHTML for agent content.

- [ ] **Step 5: Build + smoke**

Run: `npm run build`
Expected: build succeeds; `scripts/copy-assets.mjs` copies the edited `webview.html` into `dist/`. Edit the SOURCE, never the `dist/` copy.

Manual smoke (F5 → Settings › Agents):
- File agents under `Yours` (editable); approach agents under `From approaches`, bracketed by owning approach id, read-only.
- Toggling an agent off here removes it from the create "single-subagent" dropdown; header stat updates.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/webview.html
git commit -m "feat: provenance-roster agents tab with per-approach grouping and enable switches"
```

---

## Self-Review Notes

- **Spec coverage:** P1 (surface every agent + enable/disable) → Task 4 (render) on Task 1's data; P2 (owner attribution) → Task 1 (`approachId`) + Task 3 (create dropdown suffix) + Task 4 (bracket header); P3 (UI/UX rework, Option 1) → Task 4. Grouping/sort testable helper → Task 2.
- **Deviation from spec test list:** the spec listed a unit test for the onboarding label. The onboarding webview renders inline and cannot import a TS helper, so the label is an inline one-liner mirroring the settings provenance grouping — not separately unit-tested, consistent with the pre-existing inline `(approach)` suffix. The provenance *grouping* is unit-tested via `sortAgentRowsByProvenance` (Task 2).
- **Type consistency:** `approachId?: string` on both `PoolAgent` (existing) and `SettingsAgentRow` (Task 1); `sortAgentRowsByProvenance` consumes the latter, used by `buildSettingsState` (Task 2) and rendered by Task 4.
- **No new messages:** enable/disable/create/delete/save all reuse existing settings messages.
