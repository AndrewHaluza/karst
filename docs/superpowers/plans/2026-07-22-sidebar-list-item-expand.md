# Sidebar List-Item Expand (Pipeline Triage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the low-value Stage/Ports/Worktrees expanded body with a pipeline-triage peek: a 5-segment stage rail, a next-action line (with real failure reason + attempt), and a collapsed meta line.

**Architecture:** Two layers. (1) Pure row-model additions in `items.ts`/`state.ts` — a fixed 5-cell `rail`, plus `reason`/`attempt`/`model` pulled from the current stage — all unit-tested vscode-free. (2) The standalone `webview.html` renders those fields into three compact lines. No schema change, no new host↔webview messages: every field already lives in `TicketWithStages.stages[]` and the ticket row.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `noUncheckedIndexedAccess`), vitest, standalone HTML+vanilla-JS webview.

## Global Constraints

- ESM: all relative imports need the `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` is on: array/index access needs `!` or a guard.
- Immutability: build new objects, never mutate inputs (`stages[]` is read-only here).
- Row model stays **vscode-free** and serializable (crosses `postMessage`): data only, no class instances.
- The glyph/stage color is single-sourced: rail cells reuse `stageColorClass` (the `stg-<stage>` token) and `STAGE_TITLE` — never a per-view hex or hand-written label.
- `webview.html` is the SOURCE; `scripts/copy-assets.mjs` mirrors it into `dist/`. Never edit the `dist/` copy.
- Keep the three CSP/palette injection markers intact: `<!--KARST_CSP-->`, `/*KARST_PALETTE*/`.
- Run `npm test` (vitest) and `npm run typecheck` before each commit.

---

### Task 1: Row-model additions — rail, reason, attempt, model

**Files:**
- Modify: `src/ui/sidebar/items.ts` (extend `TicketNode`, add `RailCell`, extend `buildTicketNodes`)
- Test: `src/ui/sidebar/items.test.ts` (add cases; shared `ticket()` builder already present)

**Interfaces:**
- Consumes: `TicketWithStages` (`stageCurrent`, `model`, `stages: Stage[]` where `Stage = {stageKey, status, attempt, verdict, …}`), `StageKey`/`StageStatus` from `../../model/types.js`, `STAGE_TITLE` from `../../model/stageBadge.js`, `stageColorClass` from `../../model/stagePalette.js` (already imported).
- Produces (relied on by Task 2 via `TicketRow`):
  - `RailCell = { key: StageKey; title: string; status: StageStatus; current: boolean; colorClass: string }`
  - `TicketNode.rail: RailCell[]` — exactly 5 cells, order `['scope','impl','uat','review','ship']`.
  - `TicketNode.reason: string | null`
  - `TicketNode.attempt: number`
  - `TicketNode.model: string | null`

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/sidebar/items.test.ts` inside the `describe('buildTicketNodes', …)` block:

```typescript
  const RAIL_ORDER = ['scope', 'impl', 'uat', 'review', 'ship'] as const;

  it('builds a fixed 5-cell rail in milestone order', () => {
    const n = buildTicketNodes([ticket()])[0]!;
    expect(n.rail.map((c) => c.key)).toEqual([...RAIL_ORDER]);
  });

  it('mirrors each rail cell status from the matching stage row', () => {
    // scope passed, impl running (from the shared builder); the rest default pending.
    const n = buildTicketNodes([ticket()])[0]!;
    const byKey = Object.fromEntries(n.rail.map((c) => [c.key, c.status]));
    expect(byKey.scope).toBe('passed');
    expect(byKey.impl).toBe('running');
    expect(byKey.uat).toBe('pending');
    expect(byKey.review).toBe('pending');
    expect(byKey.ship).toBe('pending');
  });

  it('marks current true only on the current stage cell', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: 'impl' })])[0]!;
    expect(n.rail.filter((c) => c.current).map((c) => c.key)).toEqual(['impl']);
  });

  it('has no current cell when the ticket has no stage', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.rail.some((c) => c.current)).toBe(false);
    expect(n.rail.every((c) => c.status === 'pending')).toBe(true);
  });

  it('paints each rail cell with the shared stg-* color token', () => {
    const n = buildTicketNodes([ticket()])[0]!;
    expect(n.rail.find((c) => c.key === 'scope')!.colorClass).toBe('stg-scope');
  });

  it('exposes the current stage failure reason and attempt', () => {
    const n = buildTicketNodes([
      ticket({
        stageCurrent: 'uat',
        stages: [
          { ticketId: 1, stageKey: 'uat', status: 'failed', attempt: 2, verdict: '2 tests red', artifactPath: null, startedAt: null, endedAt: null },
        ],
      }),
    ])[0]!;
    expect(n.reason).toBe('2 tests red');
    expect(n.attempt).toBe(2);
  });

  it('reason is null and attempt 0 when the current stage is missing', () => {
    const n = buildTicketNodes([ticket({ stageCurrent: null, stages: [] })])[0]!;
    expect(n.reason).toBeNull();
    expect(n.attempt).toBe(0);
  });

  it('passes the ticket model through', () => {
    const n = buildTicketNodes([ticket({ model: 'claude-opus-4-8' })])[0]!;
    expect(n.model).toBe('claude-opus-4-8');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/items.test.ts`
Expected: FAIL — `rail`/`reason`/`attempt`/`model` do not exist on the node (type error / undefined).

- [ ] **Step 3: Implement the additions in `items.ts`**

Add the import near the top (STAGE_TITLE lives in stageBadge, StageKey/StageStatus in types):

```typescript
import { ticketGlyph, currentStageStatus } from '../../model/ticketGlyph.js';
import { stageBadge, STAGE_TITLE } from '../../model/stageBadge.js';
import { stageColorClass } from '../../model/stagePalette.js';
import type { StageKey, StageStatus } from '../../model/types.js';
```

Add the constant + cell type above `TicketNode`:

```typescript
/** The five linear milestones the expanded rail always renders, in order. */
const RAIL_STAGES: readonly StageKey[] = ['scope', 'impl', 'uat', 'review', 'ship'];

/** One segment of the expanded-body stage rail. */
export interface RailCell {
  key: StageKey;
  /** Human milestone name (STAGE_TITLE) — the same words the dashboard uses. */
  title: string;
  /** Status from the matching stage row; `pending` when the row is absent. */
  status: StageStatus;
  /** True only for the ticket's current stage. */
  current: boolean;
  /** Shared `stg-<stage>` color token (single palette source). */
  colorClass: string;
}
```

Add these fields to the `TicketNode` interface (after `stageChip`, before `archived`):

```typescript
  /**
   * Fixed 5-segment pipeline rail for the expanded body — scope→impl→uat→review
   * →ship, each colored by its own status. `fix`/`done` are not linear segments
   * (they surface in the next-action line), so the rail stays a stable width.
   */
  rail: RailCell[];
  /** Current stage's failure reason (`verdict`), or null. Drives the "… failed: <reason>" line. */
  reason: string | null;
  /** Current stage's attempt count (0 when no current stage). */
  attempt: number;
  /** Per-ticket launch model (`ticket.model`); null = inherit the manifest default. */
  model: string | null;
```

In `buildTicketNodes`, inside the `.map`, before the `return`, build the rail and pull the current stage:

```typescript
  return tickets.map((t) => {
    const badge = stageBadge(t);
    const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
    const rail: RailCell[] = RAIL_STAGES.map((key) => {
      const s = t.stages.find((st) => st.stageKey === key);
      return {
        key,
        title: STAGE_TITLE[key],
        status: s?.status ?? 'pending',
        current: t.stageCurrent === key,
        colorClass: stageColorClass(key),
      };
    });
    return {
      kind: 'ticket',
      ticketId: t.id,
      label: ticketLabel(t, labelTemplate),
      glyph: badge.glyph,
      description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
      stageLabel: badge.label,
      stageClass: stageColorClass(badge.stage),
      stageChip: badge.stage ?? 'none',
      rail,
      reason: current?.verdict ?? null,
      attempt: current?.attempt ?? 0,
      model: t.model,
      archived: t.archivedAt !== null,
      collapsible: true,
    };
  });
```

Note: `stageBadge` is already imported in `items.ts` via `import { stageBadge }` — merge the `STAGE_TITLE` import into that existing line rather than duplicating it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/sidebar/items.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/items.ts src/ui/sidebar/items.test.ts
git commit -m "feat(sidebar): add rail/reason/attempt/model to ticket row model"
```

---

### Task 2: Webview render — rail, next-action line, meta line

**Files:**
- Modify: `src/ui/sidebar/webview.html` (styles + the expanded-body markup in `renderList`)
- Test: `src/ui/sidebar/webview.test.ts` (replace the old body-structure assertions with rail/next-action/meta assertions)

**Interfaces:**
- Consumes: `TicketRow` fields `rail` (`RailCell[]`), `reason`, `attempt`, `model` (Task 1) plus existing `servers`, `worktrees`, `stageLabel`, `description`, `archived`.
- Produces: rendered HTML only. No new message types, no field renames.

- [ ] **Step 1: Write the failing tests**

In `src/ui/sidebar/webview.test.ts`, DELETE the existing test `it('states the stage in the expanded body, above ports and worktrees', …)` (the Stage/Ports ordering is gone). Add in its place:

```typescript
  it('renders a 5-segment stage rail in the expanded body', () => {
    // One cell per rail entry, colored by the shared stg-* token, current marked.
    expect(HTML).toContain('class="rail"');
    expect(HTML).toContain('(row.rail || []).map');
    expect(HTML).toContain('cell.current');
    expect(HTML).toContain('cell.colorClass');
  });

  it('renders a next-action line carrying the failure reason and attempt', () => {
    expect(HTML).toContain('class="nextact"');
    expect(HTML).toContain('nextActionText(row)');
    // The reason + attempt are surfaced when the current stage failed.
    expect(HTML).toContain('row.reason');
    expect(HTML).toContain('row.attempt');
  });

  it('renders a meta line that omits empty tokens instead of dashes', () => {
    expect(HTML).toContain('class="meta"');
    expect(HTML).toContain('metaLine(row)');
    // No more fixed "—" Ports/Worktrees rows.
    expect(HTML).not.toContain('<span class="k">Ports</span>');
    expect(HTML).not.toContain('<span class="k">Worktrees</span>');
  });

  it('keeps the labeled body actions (dashboard + session)', () => {
    expect(HTML).toContain("data-act=\"open-dashboard\"");
    expect(HTML).toContain('Session');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/webview.test.ts`
Expected: FAIL — `class="rail"`, `nextActionText`, `metaLine`, `class="meta"` not found; and the deleted-assertion test no longer exists.

- [ ] **Step 3: Add the styles**

In `webview.html`, replace the `.tags`/`.tag` block and the old `.mline` rules (the "expanded body" style group starting at `.body{…}`) so the group reads:

```css
  /* expanded body */
  .body{display:none;padding:4px 8px 10px 28px}
  .ticket.open .body{display:block}

  /* stage rail — five milestone dots joined by connectors */
  .rail{display:flex;align-items:center;gap:0;margin:2px 0 6px}
  .rail .seg{display:flex;align-items:center;flex:1 1 0;min-width:0}
  .rail .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;
    border:1.5px solid currentColor;background:transparent;color:var(--g-gray)}
  .rail .seg.passed .dot{background:currentColor}
  .rail .seg.failed .dot{background:var(--g-failed);border-color:var(--g-failed);color:var(--g-failed)}
  .rail .seg.running .dot{background:currentColor;opacity:.85;animation:railpulse 1.4s ease-in-out infinite}
  .rail .seg.skipped .dot{border-style:dashed;opacity:.5}
  .rail .seg.current .dot{box-shadow:0 0 0 3px var(--vscode-list-hoverBackground)}
  .rail .bar{flex:1 1 auto;height:1.5px;background:currentColor;opacity:.35;margin:0 3px;color:var(--g-gray)}
  .rail .seg:last-child{flex:0 0 auto}
  @keyframes railpulse{0%,100%{opacity:.5}50%{opacity:1}}

  .nextact{font-size:11.5px;margin:2px 0;color:var(--vscode-foreground)}
  .nextact.warn{color:var(--g-failed)}
  .nextact .att{color:var(--g-gray);font-family:var(--mono);font-size:10.5px;margin-left:4px}

  .meta{font-size:10.5px;color:var(--vscode-descriptionForeground);
    font-family:var(--mono);margin:4px 0 2px;word-break:break-word}

  .actions{display:flex;gap:6px;margin-top:8px}
```

Keep the existing `.btn`/`.btn.pri` rules exactly as they are (they follow this group).

- [ ] **Step 4: Add the render helpers**

In the `<script>`, replace the existing `portsText` and `worktreeTags` functions with the three helpers below (rail is rendered inline in `renderList`, so no helper for it):

```javascript
  function railHtml(row) {
    const cells = row.rail || [];
    return cells.map((cell, i) => {
      const cls = ['seg', cell.status, cell.current ? 'current' : ''].filter(Boolean).join(' ');
      const bar = i < cells.length - 1 ? '<span class="bar"></span>' : '';
      return `<span class="${cls} ${esc(cell.colorClass)}" title="${esc(cell.title)}"><span class="dot"></span></span>${bar}`;
    }).join('');
  }

  // The one actionable sentence: needs-you / failure+reason / activity / else the badge.
  function nextActionText(row) {
    const label = row.stageLabel || row.description || '—';
    if (/failed$/i.test(label) && row.reason) {
      return { text: `${label}: ${row.reason}`, warn: true, attempt: row.attempt };
    }
    const warn = label === 'Needs you' || /failed$/i.test(label);
    return { text: label, warn, attempt: 0 };
  }

  function metaLine(row) {
    const ports = (row.servers || []).map((s) => s.port).filter(Boolean);
    const repos = (row.worktrees || []).map((w) => w.repoDisplay || w.repo).filter(Boolean);
    const tokens = [];
    if (row.model) tokens.push(esc(row.model));
    if (repos.length) tokens.push(esc(repos.join('+')));
    if (ports.length) tokens.push(esc(ports.map((p) => ':' + p).join(', ')));
    return tokens.join(' · ');
  }
```

- [ ] **Step 5: Replace the expanded-body markup**

In `renderList`, replace the body block (currently the three `.mline` rows + `.actions`) — the string that starts `+ \`<div class="body">\`` through `+ \`<div class="actions">${bodyActs}</div>\`` — with:

```javascript
        + `<div class="body">`
        + `<div class="rail">${railHtml(row)}</div>`
        + (() => { const na = nextActionText(row);
            const att = na.attempt ? `<span class="att">attempt ${na.attempt}</span>` : '';
            return `<div class="nextact${na.warn ? ' warn' : ''}">${esc(na.text)}${att}</div>`; })()
        + (() => { const m = metaLine(row); return m ? `<div class="meta">${m}</div>` : ''; })()
        + `<div class="actions">${bodyActs}</div>`
```

Leave the rest of the returned template (the `.row`, chevron, glyph, name, stage chip, `rowacts`, and the closing `</div></div>`) unchanged.

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run src/ui/sidebar/webview.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (all sidebar + unrelated suites green).

- [ ] **Step 8: Commit**

```bash
git add src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts
git commit -m "feat(sidebar): pipeline-triage expanded body (rail + next-action + meta)"
```

---

## Manual verification (after both tasks)

- [ ] F5 the Extension Dev Host; open the karst sidebar.
- [ ] Expand a ticket mid-pipeline: rail shows filled past stages, ringed current, hollow future.
- [ ] Expand a ticket with a failed current stage: next-action line is red and reads `<Stage> failed: <reason> · attempt N`.
- [ ] Expand a ticket with no server/worktree: meta line is absent (no `—` rows), body stays compact.
- [ ] `Open dashboard` + `Session` buttons still work.
