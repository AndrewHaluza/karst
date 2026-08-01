# Merge-check panel presentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a merge conflict readable on the dashboard PR panel — verdict, file count, base ref and age on one bounded line, with the full path list (or git's error prose) in a collapsible body.

**Architecture:** A new pure host-side module, `src/model/mergeCheckPanel.ts`, turns each stored `MergeCheckRow` into a fully-worded panel row. `ui/dashboard/state.ts` calls it and ships the rows; `ui/dashboard/webview.html` places the strings and formats nothing. `model/mergeCheckView.ts` (`summarizeMergeCheck`) is NOT touched — the ship strip and the `karst context` CLI keep their shared one-liner.

**Tech Stack:** TypeScript (ESM, `type: module`), vitest, standalone HTML webview (no framework, no bundler).

Spec: `docs/superpowers/specs/2026-08-01-merge-check-panel-design.md`

## Global Constraints

- ESM: every relative import needs an explicit `.js` suffix, even from a `.ts` file.
- `noUncheckedIndexedAccess` is on: array indexing needs `!` or a guard.
- No mutation. Build new objects; never write into an input.
- The webview is standalone HTML and cannot import a module. **Every display string is rendered host-side.** The webview may only place strings, `esc()` them, and branch on a host-supplied flag.
- Every value interpolated into webview HTML goes through `esc()`. File paths and git prose both originate outside karst.
- A repo with no merge check must render nothing. "Never asked" is not "clean".
- A `conflicted` verdict is never softened by a parsing surprise: zero parsed files still reads `conflicted`.
- `src/model/mergeCheckView.ts` must not be modified by this plan.
- Edit `src/ui/dashboard/webview.html`, never the `dist/` copy — `scripts/copy-assets.mjs` mirrors it at build time.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`).
- Run tests with `npx vitest run <path>`; typecheck with `npm run typecheck`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/model/mergeCheckPanel.ts` | create | Pure. Turns `MergeCheckRow[]` + `now` into fully-worded `MergeCheckPanelRow[]`. Owns all dashboard merge-check copy. |
| `src/model/mergeCheckPanel.test.ts` | create | Unit tests for the above. |
| `src/ui/dashboard/state.ts` | modify | Drop the local `MergeCheckPanelView`; call the new builder; re-export `MergeCheckPanelRow`. |
| `src/ui/dashboard/state.test.ts` | modify | Update the one merge-check assertion to the new row shape. |
| `src/ui/dashboard/webview.html` | modify | `mergeLine()` renders headline + optional `<details>`; new CSS for the disclosure. |
| `src/ui/dashboard/webview.test.ts` | modify | Text-level guards on the new markup. |
| `CLAUDE.md` | modify | One line recording where dashboard merge-check copy lives. |

Untouched on purpose: `src/model/mergeCheckView.ts`, `src/model/inside/index.ts`, `src/context/ticketContext.ts`, `src/store/mergeChecks.ts`, `src/workflow/mergeCheck.ts`.

---

### Task 1: The panel-row builder

**Files:**
- Create: `src/model/mergeCheckPanel.ts`
- Test: `src/model/mergeCheckPanel.test.ts`

**Interfaces:**
- Consumes: `MergeCheckRow` from `../store/mergeChecks.js` (fields: `ticketId`, `repo`, `state`, `files`, `reason`, `headSha`, `baseSha`, `baseRef`, `checkedAt`); `MergeState` from `../workflow/mergeCheck.js` (`'clean' | 'conflicted' | 'unknown'`); `formatPrStamp` from `./prPanelView.js` (`(at: string | null | undefined) => string`, returns `''` for absent/unparseable).
- Produces: `export interface MergeCheckPanelRow` and `export function buildMergeCheckPanelRows(checks: readonly MergeCheckRow[], now: string): MergeCheckPanelRow[]`. Task 2 imports both.

`formatPrStamp` is reused rather than reimplemented: it is the formatter the PR rows beside this one already use, and it already returns `''` for garbage instead of the string `"Invalid Date"`.

- [ ] **Step 1: Write the failing test**

Create `src/model/mergeCheckPanel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { MergeCheckRow } from '../store/mergeChecks.js';
import { formatPrStamp } from './prPanelView.js';
import { buildMergeCheckPanelRows } from './mergeCheckPanel.js';

const NOW = '2026-08-01T12:00:00.000Z';

/** A row with every field present; each test overrides only what it is about. */
function row(over: Partial<MergeCheckRow> = {}): MergeCheckRow {
  return {
    ticketId: 1,
    repo: '/repos/api',
    state: 'clean',
    files: [],
    reason: null,
    headSha: 'h',
    baseSha: 'b',
    baseRef: 'develop',
    checkedAt: '2026-08-01T11:56:00.000Z', // 4 minutes before NOW
    ...over,
  };
}

describe('buildMergeCheckPanelRows', () => {
  it('words a clean check as state, base ref and age', () => {
    const [out] = buildMergeCheckPanelRows([row()], NOW);
    expect(out!.headline).toBe('clean · vs develop · 4m ago');
    // Nothing to open: a clean check has no body.
    expect(out!.detailsLabel).toBe('');
    expect(out!.files).toEqual([]);
    expect(out!.reason).toBe('');
  });

  it('puts the conflict count on the line and the paths in the body', () => {
    const [out] = buildMergeCheckPanelRows(
      [row({ state: 'conflicted', files: ['CLAUDE.md', 'src/a.ts', 'src/b.ts', 'src/c.ts'] })],
      NOW,
    );
    expect(out!.headline).toBe('conflicted · 4 files · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('4 conflicting files');
    // Uncapped: the disclosure is collapsed and scroll-capped, so the panel
    // lists every path rather than the five the one-line summarizer allows.
    expect(out!.files).toEqual(['CLAUDE.md', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('says file, not files, for a single conflict', () => {
    const [out] = buildMergeCheckPanelRows([row({ state: 'conflicted', files: ['a.ts'] })], NOW);
    expect(out!.headline).toBe('conflicted · 1 file · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('1 conflicting file');
  });

  it('keeps the conflicted verdict when the file list came back empty', () => {
    // The verdict came from an exit code; only the list came from parsing output.
    // A parsing surprise drops the count and the body — never the verdict.
    const [out] = buildMergeCheckPanelRows([row({ state: 'conflicted', files: [] })], NOW);
    expect(out!.headline).toBe('conflicted · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('');
  });

  it('routes git’s own words to the body and never to the headline', () => {
    // Unbounded prose in a one-line slot is the defect this replaces.
    const prose = 'fatal: not a valid object name develop';
    const [out] = buildMergeCheckPanelRows([row({ state: 'unknown', reason: prose })], NOW);
    expect(out!.headline).toBe('unknown · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('why karst could not tell');
    expect(out!.reason).toBe(prose);
  });

  it('opens no disclosure for an unknown check that carries no reason', () => {
    const [out] = buildMergeCheckPanelRows([row({ state: 'unknown', reason: null })], NOW);
    expect(out!.headline).toBe('unknown · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('');
    expect(out!.reason).toBe('');
  });

  it('drops the base ref from the line when none was recorded', () => {
    const [out] = buildMergeCheckPanelRows([row({ baseRef: null })], NOW);
    expect(out!.headline).toBe('clean · 4m ago');
  });

  it('reports age in coarse buckets', () => {
    const at = (iso: string) => buildMergeCheckPanelRows([row({ checkedAt: iso })], NOW)[0]!.headline;
    expect(at('2026-08-01T11:59:30.000Z')).toBe('clean · vs develop · just now');
    expect(at('2026-08-01T11:20:00.000Z')).toBe('clean · vs develop · 40m ago');
    expect(at('2026-08-01T09:00:00.000Z')).toBe('clean · vs develop · 3h ago');
    expect(at('2026-07-29T12:00:00.000Z')).toBe('clean · vs develop · 3d ago');
  });

  it('states no age at all rather than a wrong one', () => {
    // Unparseable, and a stamp in the future (clock skew): both are facts karst
    // does not have, and an absent part renders as nothing.
    expect(buildMergeCheckPanelRows([row({ checkedAt: 'nonsense' })], NOW)[0]!.headline)
      .toBe('clean · vs develop');
    expect(buildMergeCheckPanelRows([row({ checkedAt: '2026-08-02T12:00:00.000Z' })], NOW)[0]!.headline)
      .toBe('clean · vs develop');
  });

  it('carries the absolute stamp for the tooltip, and none for a bad one', () => {
    const iso = '2026-08-01T11:56:00.000Z';
    // Computed the same way the PR rows compute theirs, so the assertion holds
    // in any locale the suite runs under.
    expect(buildMergeCheckPanelRows([row({ checkedAt: iso })], NOW)[0]!.checkedTitle)
      .toBe(formatPrStamp(iso));
    expect(buildMergeCheckPanelRows([row({ checkedAt: 'nonsense' })], NOW)[0]!.checkedTitle).toBe('');
  });

  it('carries the repo path and state through untouched, one row per check', () => {
    // `repo` is the row's identity — the value a Resolve click sends back — and
    // `state` drives the dot and whether that button is offered at all.
    const out = buildMergeCheckPanelRows([row({ repo: '/repos/api' }), row({ repo: '/repos/web', state: 'conflicted', files: ['x'] })], NOW);
    expect(out.map((r) => r.repo)).toEqual(['/repos/api', '/repos/web']);
    expect(out.map((r) => r.state)).toEqual(['clean', 'conflicted']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/model/mergeCheckPanel.test.ts`

Expected: FAIL — `Failed to resolve import "./mergeCheckPanel.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/model/mergeCheckPanel.ts`:

```ts
import type { MergeCheckRow } from '../store/mergeChecks.js';
import type { MergeState } from '../workflow/mergeCheck.js';
import { formatPrStamp } from './prPanelView.js';

/**
 * How one repo's mergeability reads on the dashboard PR panel.
 *
 * Built host-side, like every other piece of dashboard copy: the webview is
 * standalone HTML that cannot import a module, so anything it words for itself
 * is untested and drifts.
 *
 * Separate from `mergeCheckView.ts` on purpose. That module's job is keeping the
 * ship strip and the `karst context` CLI from describing one three-valued fact
 * two different ways, and both of those place their string in a genuinely
 * one-line slot. This panel has room for a second line, so it says more — and
 * dashboard-only copy living in the shared module would undercut the very thing
 * that module exists to protect.
 *
 * Pure: no store, no clock, no vscode. `now` is injected.
 */
export interface MergeCheckPanelRow {
  /** The repository path — the row's IDENTITY, what a Resolve click sends back. */
  repo: string;
  /** Drives the dot's shape and colour, and whether Resolve is offered. */
  state: MergeState;
  /**
   * `conflicted · 4 files · vs develop · 4m ago`. Each part is dropped entirely
   * when its fact is absent — never a placeholder, and never git's own prose,
   * which is unbounded and would truncate in a one-line slot.
   */
  headline: string;
  /**
   * The disclosure's summary, or '' when there is nothing to open. '' renders no
   * disclosure at all rather than an empty one.
   */
  detailsLabel: string;
  /** Conflicting paths, verbatim and uncapped. Empty unless conflicted. */
  files: readonly string[];
  /** git's own words. Non-empty only for an `unknown` check that carried one. */
  reason: string;
  /**
   * The absolute stamp, for the headline's tooltip. The relative age is what a
   * reader scans; this is what stays true once the panel has sat open and that
   * relative label has drifted. '' when the stamp could not be read.
   */
  checkedTitle: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Age in coarse buckets.
 *
 * Deliberately coarser than `formatDuration`: this label only refreshes when the
 * host pushes state, so `4m 12s ago` would claim a precision the value does not
 * have. An unreadable stamp, or one in the future (clock skew), yields '' — the
 * row states no age rather than a wrong one.
 */
function formatAge(checkedAt: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(checkedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

function plural(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

/** The disclosure summary — '' whenever there is no body worth opening. */
function detailsLabelFor(state: MergeState, files: readonly string[], reason: string): string {
  if (state === 'conflicted' && files.length > 0) return plural(files.length, 'conflicting file');
  if (state === 'unknown' && reason !== '') return 'why karst could not tell';
  return '';
}

/** One panel row per check, in the order given. */
export function buildMergeCheckPanelRows(
  checks: readonly MergeCheckRow[],
  now: string,
): MergeCheckPanelRow[] {
  return checks.map((check) => {
    // Both are scoped to the state that can carry them, so a row written by a
    // newer karst — or a state that got rewritten to 'unknown' on read — can
    // never surface a stale file list beside a verdict that has no files.
    const files = check.state === 'conflicted' ? check.files : [];
    const reason = check.state === 'unknown' ? (check.reason ?? '') : '';
    const parts = [
      check.state,
      files.length > 0 ? plural(files.length, 'file') : '',
      check.baseRef ? `vs ${check.baseRef}` : '',
      formatAge(check.checkedAt, now),
    ].filter((part) => part !== '');
    return {
      repo: check.repo,
      state: check.state,
      headline: parts.join(' · '),
      detailsLabel: detailsLabelFor(check.state, files, reason),
      files,
      reason,
      checkedTitle: formatPrStamp(check.checkedAt),
    };
  });
}
```

Note on `plural(n, 'conflicting file')`: it pluralises the last word, yielding `4 conflicting files` / `1 conflicting file`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/model/mergeCheckPanel.test.ts`

Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/model/mergeCheckPanel.ts src/model/mergeCheckPanel.test.ts
git commit -m "feat: word the dashboard merge check into a headline and a body"
```

---

### Task 2: Ship the new rows in the dashboard state

**Files:**
- Modify: `src/ui/dashboard/state.ts` (the `MergeCheckPanelView` interface at :31-38, the `DashboardState.mergeChecks` field at :79, the imports at :20-22, and the `mergeChecks` mapping at :183-188)
- Test: `src/ui/dashboard/state.test.ts` (the `exposes each repo’s current merge verdict alongside the PRs` test)

**Interfaces:**
- Consumes: `buildMergeCheckPanelRows(checks, now)` and `MergeCheckPanelRow` from Task 1; `nowIso()` from `../../model/time.js` (already imported by this file).
- Produces: `DashboardState.mergeChecks: MergeCheckPanelRow[]`, re-exported as `MergeCheckPanelRow` from `state.ts`. Task 3 renders it.

`buildDashboardState` currently calls `nowIso()` inline at :209 for the stage strip. Hoist it to a single `const now = nowIso();` above the return so the strip and the merge rows date from the same instant — two clock reads in one state push could put a check one bucket apart from the strip describing it.

- [ ] **Step 1: Update the test to the new shape (RED)**

In `src/ui/dashboard/state.test.ts`, replace the body of `exposes each repo’s current merge verdict alongside the PRs` with:

```ts
  it('exposes each repo’s current merge verdict alongside the PRs', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: ['src/a.ts'],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    const state = buildDashboardState(store, t.id);

    // Fully worded host-side: the webview must never phrase a verdict of its own,
    // and the age is relative to the push, so only the fixed parts are pinned.
    expect(state.mergeChecks).toHaveLength(1);
    const row = state.mergeChecks[0]!;
    expect(row.repo).toBe('api');
    expect(row.state).toBe('conflicted');
    expect(row.headline).toMatch(/^conflicted · 1 file · vs main · /);
    expect(row.detailsLabel).toBe('1 conflicting file');
    expect(row.files).toEqual(['src/a.ts']);
    expect(row.reason).toBe('');
    expect(row.checkedTitle).not.toBe('');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/dashboard/state.test.ts -t 'merge verdict'`

Expected: FAIL — `row.headline` is `undefined` (the state still ships `summary`).

- [ ] **Step 3: Rewrite the state's merge-check plumbing**

In `src/ui/dashboard/state.ts`:

Replace the two imports at :20-22 —

```ts
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { summarizeMergeCheck } from '../../model/mergeCheckView.js';
import type { MergeState } from '../../workflow/mergeCheck.js';
```

with:

```ts
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { buildMergeCheckPanelRows, type MergeCheckPanelRow } from '../../model/mergeCheckPanel.js';
```

Delete the local `MergeCheckPanelView` interface (:31-38) entirely and add `MergeCheckPanelRow` to the type re-export on :29:

```ts
export type { PathContext, StepperCell, NowLine, StageRail, StageInside, PrPanelRow, MergeCheckPanelRow };
```

Replace the `mergeChecks` field's doc comment and type (:71-79) with:

```ts
  /**
   * Current mergeability per repo — the same verdicts the ship strip renders,
   * lifted to the top level because the PR panel is where a conflict is acted on
   * and a standalone webview cannot read the store. Fully worded here
   * (`model/mergeCheckPanel.ts`) so the panel cannot phrase a verdict of its own.
   * A repo with no row was never checked; absence renders as nothing, never as
   * clean.
   */
  mergeChecks: MergeCheckPanelRow[];
```

Add a single clock read just above the `return {` at :161:

```ts
  // ONE clock read per push: the merge rows and the stage strip must not date
  // from two different instants.
  const now = nowIso();
```

Replace the `mergeChecks` mapping at :183-188 with:

```ts
    mergeChecks: buildMergeCheckPanelRows(mergeChecks, now),
```

And replace `now: nowIso(),` inside the `buildStageInside({ … })` call at :209 with:

```ts
      now,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/state.test.ts`

Expected: PASS, whole file.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: no output, exit 0. If it reports an unused `MergeState` import in `state.ts`, delete that import line — the type is no longer referenced there.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts
git commit -m "feat: ship worded merge-check rows to the dashboard"
```

---

### Task 3: Render the headline and the disclosure

**Files:**
- Modify: `src/ui/dashboard/webview.html` (the `.mg` CSS block at :411-421, and `mergeLine()` at :1136-1147)
- Modify: `src/ui/dashboard/webview.test.ts` (the `renders each PR’s merge verdict from the host-rendered summary` test at ~:356)
- Modify: `CLAUDE.md`
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `MergeCheckPanelRow` from Task 2, arriving as `state.mergeChecks` and indexed by repo in `renderPrs` (`byRepo[p.repo]`, already in place at :1199-1200 — unchanged).
- Produces: nothing consumed by later tasks. This is the last one.

The webview has no DOM harness — these are text-level guards on the source, which is what every other webview test in this repo is. They catch a lost binding or an unescaped interpolation; they cannot catch a mistyped class or a broken layout. Those need F5.

- [ ] **Step 1: Write the failing tests**

In `src/ui/dashboard/webview.test.ts`, replace the `renders each PR’s merge verdict from the host-rendered summary` test with these four:

```ts
  it('renders each PR’s merge verdict from the host-rendered headline', () => {
    // The wording is `buildMergeCheckPanelRows`', host-side. A verdict phrased in
    // the webview would be a fourth voice describing the same three-valued fact.
    expect(HTML).toMatch(/renderPrs\(state\.prs,\s*state\.mergeChecks/);
    expect(HTML).toContain('esc(m.headline)');
    // The old single-line summary is gone, not merely unused.
    expect(HTML).not.toContain('m.summary');
  });

  it('opens the conflict list only when the host supplied a label for it', () => {
    // '' means "there is nothing to open" — it must render no disclosure at all,
    // not an empty one.
    expect(HTML).toContain('m.detailsLabel');
    expect(HTML).toContain('<details class="mgd">');
  });

  it('escapes the paths and git’s prose, which both come from outside karst', () => {
    expect(HTML).toContain('esc(m.reason)');
    expect(HTML).toContain('esc(f)');
    expect(HTML).not.toContain('${m.reason}');
    expect(HTML).not.toContain('${m.headline}');
  });

  it('hangs the absolute stamp off the headline as its tooltip', () => {
    // The relative age drifts between state pushes; this is the part that stays
    // true when it has.
    expect(HTML).toContain('m.checkedTitle');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/webview.test.ts -t 'merge'`

Expected: FAIL — `esc(m.headline)` is not in the HTML (it still renders `esc(m.summary)`).

- [ ] **Step 3: Rewrite `mergeLine()`**

In `src/ui/dashboard/webview.html`, replace `mergeLine` (:1136-1147) with:

```js
  // Mergeability under a PR row. Every string is the host's
  // (`buildMergeCheckPanelRows`) — the webview only places them. A repo with no
  // check renders NOTHING: never asked is not the same as clean, and the one
  // thing this panel must not do is reassure about a question nobody put.
  //
  // The headline is bounded (verdict, count, base ref, age), so it fits the line
  // it is given. Everything unbounded — the path list, git's own error prose —
  // lives in the disclosure, which is where it can wrap and be selected. A row
  // the host gave no `detailsLabel` renders no disclosure at all.
  function mergeLine(m) {
    if (!m) return '';
    const act = m.state === 'conflicted'
      ? `<button class="mgbtn" data-act="resolve-conflicts" data-repo="${esc(m.repo)}">Resolve conflicts</button>`
      : '';
    // The relative age drifts between state pushes; the absolute stamp does not.
    const title = m.checkedTitle ? ` title="checked ${esc(m.checkedTitle)}"` : '';
    const body = m.reason
      ? `<div class="mgreason">${esc(m.reason)}</div>`
      : (m.files || []).map((f) => `<div class="mgfile">${esc(f)}</div>`).join('');
    const details = m.detailsLabel
      ? `<details class="mgd"><summary>${esc(m.detailsLabel)}</summary>`
        + `<div class="mgdbody">${body}</div></details>`
      : '';
    return `<div class="mgwrap mg-${esc(m.state)}">`
      + `<div class="mg"><span class="mgdot" aria-hidden="true"></span>`
      + `<span class="mgtext"${title}>${esc(m.headline)}</span>${act}</div>`
      + details
      + `</div>`;
  }
```

The state class moves from `.mg` to the new `.mgwrap`. Every existing rule is a descendant selector (`.mg-conflicted .mgdot`, `.mg-conflicted .mgtext`), so they keep matching from the wrapper without edits.

- [ ] **Step 4: Add the disclosure's CSS**

In `src/ui/dashboard/webview.html`, immediately after the `.mg .mgbtn{flex:none}` rule (:421), add:

```css
  /* The conflict list / the reason karst could not tell. Collapsed by default,
     like the PR comments thread further down this same panel — the count is what
     a reader scans, the detail is what they open. Capped and scrollable so a
     forty-file conflict cannot push the rest of the panel off screen. */
  .mgd{margin:-4px 0 6px 30px;font-size:11.5px}
  .mgd summary{cursor:pointer;color:var(--link);width:fit-content}
  .mgdbody{max-height:180px;overflow-y:auto;margin-top:4px}
  .mgfile{font-family:var(--mono);font-size:11px;color:var(--text-dim);word-break:break-all}
  /* git's own words: `pre-wrap` keeps the line breaks a multi-line git error has. */
  .mgreason{white-space:pre-wrap;color:var(--text-dim);word-break:break-word}
```

- [ ] **Step 5: Run the webview tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: PASS, whole file — including the untouched `offers Resolve conflicts only on a repo the host called conflicted`, which still finds `m.state === 'conflicted'`, `data-act="resolve-conflicts"` and `data-repo=` with no `data-path`.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Record where the copy lives**

In `CLAUDE.md`, find the bullet beginning `**PR facts are re-probed state, never assumed.**` and append this sentence to the end of that bullet:

```
The merge verdict beside them is worded in `model/mergeCheckPanel.ts` — bounded facts (verdict, count, base ref, age) on the headline, the unbounded ones (conflicting paths, git's error prose) in a collapsed body — while `model/mergeCheckView.ts` keeps the one-line form the ship strip and `karst context` share; the two must not be merged, because the panel has room to say more and the CLI does not.
```

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts CLAUDE.md
git commit -m "feat: show merge conflicts as a headline plus an openable file list"
```

- [ ] **Step 9: Verify in the real panel**

`npm test` cannot see layout. Press F5 to launch the Extension Dev Host, open a ticket whose ship stage recorded a conflicted merge check, and confirm on the Pull requests panel:
- the headline reads `conflicted · N files · vs <base> · <age>` and does not ellipsize
- hovering it shows `checked <absolute stamp>`
- the disclosure opens to the full path list, scrolls past ~10 files, and long paths wrap rather than overflow
- Resolve conflicts still sits on the headline row and still opens the session
- a clean repo shows a one-line row with no disclosure

---

## Out of scope

- `summarizeMergeCheck` wording, and therefore the ship strip (`model/inside/index.ts`) and `karst context` (`context/ticketContext.ts`).
- Re-checking mergeability from this row — the panel's existing refresh control already re-probes every PR.
- The conflict-resolution session itself (`workflow/conflictSession.ts`).
