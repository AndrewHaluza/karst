# PR Summary Artifact View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "PR summary" (ship-summary) artifact detail readable and honest: short repo names, no dangling separators, commit counts that match the rows shown, and a metric strip that does not collide with the first section.

**Architecture:** Two layers. The model (`src/model/artifacts.ts` `shipSummary`) carries each commit's `origin` and labels counts truthfully. The dashboard webview (`src/ui/dashboard/webview.html`, vanilla — UI-RULES v3.0) renders PR/commit rows from that snapshot. No new host messages, no schema change.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest, vanilla webview HTML/JS/CSS with `--k-*` design tokens.

**Spec:** Ticket REVAMP-ARTIFACTS-UI-fu1 prompt ("improve PR summary artifact view") + screenshot. Defects observed in the screenshot (this is the spec):
1. PR row shows full absolute path `/Users/nd/Work/projects/karst/ · #482` — noise, trailing slash.
2. Commit row reads `6efb55e ·` — separator with an empty message.
3. Summary/metric say `0 commits` while a commit row is listed (metric counts only `created-by-ship`, list shows all origins) — contradicts itself.
4. Summary says "1 PR opened" for a merged PR.
5. Metric strip (`REPOS PRS COMMITS`) sits flush against the `PULL REQUESTS` heading; values are same weight as body text.

## Global Constraints

- Read `docs/ui/UI-RULES.md` and `docs/ui/UI-INVARIANTS.md` before editing the webview. Cite the rule id in the commit when a change satisfies one (UI-R35).
- Tokens only (`--k-*` from `docs/ui/DESIGN-SYSTEM.md`); no raw colours/px.
- PR number and commit SHA stay the open controls (UI-R09c); state never colour-only (UI-R28).
- Edit `src/ui/dashboard/webview.html` (source), never `dist/`.
- `noUncheckedIndexedAccess` on; ESM imports need `.js`.
- Strict TDD: RED → GREEN per task. Conventional commits.

---

### Task 1: Model — commit origin + truthful ship-summary counts

**Files:**
- Modify: `src/model/artifacts.ts` (`ArtifactCommit` ~line 115; `shipSummary` ~line 780)
- Test: `src/model/artifacts.test.ts` (`derives a ship-summary…` ~line 319)
- Modify fixture: `src/ui/dashboard/webview.test.ts` (`artifactFixtures` ship-summary entry ~line 5061)

**Interfaces:**
- Produces: `ArtifactCommit.origin: 'before-ship' | 'created-by-ship'` (import `ShipCommitOrigin` from `../store/shipRuns.js`). Summary format `"<n> PR(s) · <m> new commit(s)"`; metric label `'new commits'`.

- [ ] **Step 1: Write failing test** — in `src/model/artifacts.test.ts`, change the existing test's summary expectation and add a new test:

```ts
// in 'derives a ship-summary…'
      summary: '1 PR · 1 new commit',
// …
    expect(a.commits[0]).toMatchObject({ sha: 'abc123', origin: 'created-by-ship' });
```

```ts
  it('counts only ship-created commits as new, but lists every commit with its origin', () => {
    const t = ticket({ stageCurrent: 'ship' });
    const run = openShipRun(store, { ticketId: t.id, attempt: 0, startedAt: '2026-08-01T11:00:00.000Z' });
    closeShipRun(store, run.id, 'passed', '2026-08-01T11:05:00.000Z');
    recordShipCommit(store, { shipRunId: run.id, repo: 'web', sha: 'aaa111', message: 'wip', origin: 'before-ship' });

    const [a] = buildTicketArtifacts(store, t.id) as [ArtifactSummary];
    expect(a.summary).toBe('0 PRs · 0 new commits');
    expect(a.metrics).toContainEqual({ label: 'new commits', value: '0' });
    expect(a.commits).toEqual([expect.objectContaining({ sha: 'aaa111', origin: 'before-ship' })]);
  });
```

- [ ] **Step 2: Run** `npx vitest run src/model/artifacts.test.ts` — Expected: FAIL (summary text, missing `origin`).

- [ ] **Step 3: Implement** in `src/model/artifacts.ts`:

```ts
import type { ShipCommitOrigin, ShipEvidence } from '../store/shipRuns.js';

export interface ArtifactCommit {
  repo: string;
  sha: string;
  message: string;
  /** Whether ship made this commit or found it on the branch. */
  origin: ShipCommitOrigin;
  action?: TypedInsideAction;
}
```

In `shipSummary`:

```ts
    summary: running
      ? `Shipping across ${repoCount} repo${repoCount === 1 ? '' : 's'}…`
      : `${prCount} PR${prCount === 1 ? '' : 's'} · ${created.length} new commit${created.length === 1 ? '' : 's'}`,
// metrics:
      { label: 'new commits', value: String(created.length) },
// commits map: add
        origin: c.origin,
```

(Keep the existing `ShipEvidence` import merged into that one line.)

- [ ] **Step 4: Update webview fixture** in `src/ui/dashboard/webview.test.ts` ship-summary entry: `summary: '1 PR · 1 new commit'`, metric `{ label: 'new commits', value: '1' }`, commit gets `origin: 'created-by-ship'`. Then `grep -rn "PR opened" src` and update any other hit.

- [ ] **Step 5: Run** `npx vitest run src/model/artifacts.test.ts src/ui/dashboard/webview.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/artifacts.ts src/model/artifacts.test.ts src/ui/dashboard/webview.test.ts
git commit -m "fix(artifacts): ship summary counts new commits and carries commit origin"
```

---

### Task 2: Webview — PR/commit rows and metric strip

**Files:**
- Modify: `src/ui/dashboard/webview.html` — `artifactPrsHtml`, `artifactCommitsHtml` (~line 4515–4545), CSS `.artmetrics`/`.artmetric` (~line 1711) and `.artfiles` block (~line 1774–1797)
- Test: `src/ui/dashboard/webview.test.ts` (`artifacts render round trip` describe, next to `renders the ship detail…` ~line 5244)

**Interfaces:**
- Consumes: `ArtifactCommit.origin` from Task 1; `ArtifactPr.repo` (may be an absolute path with trailing `/`).
- Produces: webview helper `repoName(path)` (local function, webview only).

- [ ] **Step 1: Write failing tests** (add inside the `artifacts render round trip` describe):

```ts
  it('names the repo by basename on PR and commit rows, full path in the title', () => {
    const h = bootPreviewHarness();
    const state = stateWithArtifacts();
    const ship = state.artifacts!.find((a) => a.id === 'ship-summary')!;
    const patched = {
      ...state,
      artifacts: state.artifacts!.map((a) => (a.id === 'ship-summary'
        ? { ...ship, prs: [{ ...ship.prs[0]!, repo: '/Users/x/karst/' }],
            commits: [{ ...ship.commits[0]!, repo: '/Users/x/karst/' }] }
        : a)),
    };
    h.receive({ type: 'state', state: patched });
    h.click('[data-art]', { art: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    const detail = h.htmlOf('artView');
    expect(detail).toMatch(/<span class="af-repo" title="\/Users\/x\/karst\/">karst<\/span>/);
    expect(detail).not.toContain('>/Users/x/karst/');
  });

  it('drops the separator when a commit has no message and tags pre-existing commits', () => {
    const h = bootPreviewHarness();
    const state = stateWithArtifacts();
    const ship = state.artifacts!.find((a) => a.id === 'ship-summary')!;
    const patched = {
      ...state,
      artifacts: state.artifacts!.map((a) => (a.id === 'ship-summary'
        ? { ...ship, commits: [{ ...ship.commits[0]!, message: '', origin: 'before-ship' as const }] }
        : a)),
    };
    h.receive({ type: 'state', state: patched });
    h.click('[data-art]', { art: 'index' });
    h.click('[data-art-open]', { artOpen: 'ship-summary' });
    const detail = h.htmlOf('artView');
    expect(detail).not.toMatch(/abc123<\/a>\s*·/);
    expect(detail).toContain('<span class="af-msg af-msg--empty">No message</span>');
    expect(detail).toContain('<span class="commit-origin" title="Already on the branch before ship ran">existing</span>');
  });
```

(Existing test `renders the ship detail with the PR number and commit SHA as the open controls` must keep passing unchanged.)

- [ ] **Step 2: Run** `npx vitest run src/ui/dashboard/webview.test.ts -t "artifacts render round trip"` — Expected: the 2 new tests FAIL.

- [ ] **Step 3: Implement** — add helper just above `artifactPrsHtml`:

```js
  // A repo's display name: its last path segment (trailing slash ignored). The
  // full path stays available as the hover title — never dropped.
  function repoName(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(path || '');
  }
  function repoHtml(path) {
    return `<span class="af-repo" title="${esc(path)}">${esc(repoName(path))}</span>`;
  }
```

Replace the row bodies:

```js
      // artifactPrsHtml row
      return `<li>${repoHtml(p.repo)}${number ? `<span class="af-ref">${number}</span>` : ''}`
        + (p.status ? `<span class="pr-status ${esc(p.status)}">${esc(p.status)}</span>` : '')
        + `</li>`;
```

```js
      // artifactCommitsHtml row
      const msg = c.message
        ? `<span class="af-msg">${esc(c.message)}</span>`
        : `<span class="af-msg af-msg--empty">No message</span>`;
      const tag = c.origin === 'before-ship'
        ? `<span class="commit-origin" title="Already on the branch before ship ran">existing</span>` : '';
      return `<li>${sha}${msg}${repoHtml(c.repo)}${tag}</li>`;
```

CSS (replace `.artmetrics`/`.artmetric` rules; append to `.artfiles` block):

```css
  .artmetrics{display:flex;gap:var(--k-space-7);flex-wrap:wrap;margin:var(--k-space-5) 0 var(--k-space-7);
    padding:var(--k-space-4) var(--k-space-5);border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-md)}
  .artmetric{font-family:var(--k-font-mono);font-size:var(--k-text-lg);font-weight:var(--k-weight-semibold);color:var(--k-text)}
  .artfiles .af-repo{font-family:var(--k-font-mono);font-size:var(--k-text-sm);color:var(--k-text);flex:none}
  .artfiles .af-ref{flex:1}
  .artfiles .af-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font-size:var(--k-text-sm);color:var(--k-text)}
  .artfiles .af-msg--empty{color:var(--k-text-faint);font-style:italic}
  .artfiles li > .af-repo:not(:first-child){color:var(--k-text-dim)}
  .artfiles .commit-origin{border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-pill);
    padding:var(--k-space-0) var(--k-space-2);font-family:var(--k-font-mono);font-size:var(--k-text-2xs);
    color:var(--k-text-dim);white-space:nowrap}
```

(Keep `.artmetric .am-label` rule as is.)

- [ ] **Step 4: Run** `npx vitest run src/ui/dashboard/webview.test.ts src/ui/runtimeConformance.render.test.ts` — Expected: PASS. If `test:visual` baselines cover the artifact detail, run `npm run test:visual` and update only the ship-summary snapshot.

- [ ] **Step 5: Manual check** — `npm run build`, F5, open a shipped ticket → Artifacts → PR summary. Confirm: `karst · #482 · merged`, commit row `6efb55e  No message  karst  existing`, metric strip boxed with gap above PULL REQUESTS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat(artifacts): readable PR summary rows — repo basename, commit origin, spaced metrics (UI-R09c, UI-R28)"
```

---

## Self-review

- Defect 1 → Task 2 (`repoName`). Defect 2 → Task 2 (`af-msg--empty`). Defect 3 → Task 1 (`new commits`) + Task 2 (`existing` tag). Defect 4 → Task 1 (drops "opened"). Defect 5 → Task 2 CSS.
- Names consistent: `origin`, `repoName`, `repoHtml`, `af-repo`, `af-msg`, `commit-origin`.
