# Enforce Visual Variant Distinctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every registered visual variant record a distinct picture, and pin the fixture clock so that dashboard baselines do not drift.

**Architecture:** A vitest test in `tests/visual/variants.test.ts` hashes each registry baseline PNG in each theme folder. It fails on a hash collision between two different variants unless an allow-list entry with a reason covers the pair. A stale allow-list entry also fails. The source fixes remove the collisions that the ticket names (clock leak, ticketForm populated, five dashboard variants). One Docker re-record then updates the baselines.

**Tech Stack:** TypeScript (ESM), vitest 4, Playwright 1.63 in the pinned Docker image, React webviews.

**Spec:** Ticket ENFORCE-VISUAL-VARIANT (T1357, planned as D773 in P74). Design constraints: `@ui:UI-R57`, `@ui:UI-R46`, `@ui:VISUAL-VARIANTS`, `@ui:UPDATE-BASELINE`, `@arch:BASELINE-REVIEW`.

## Global Constraints

- Re-record baselines only in Docker: `npm run -s test:visual:docker:update` (`@ui:UPDATE-BASELINE`). Never use a host `--update-snapshots`.
- The baseline commit cites UI-R35 and says what changed and why.
- `src/` never imports from `tests/`.
- Do not change `src/ui/dashboard/insideCases.ts` cases for a screenshot step. Put interactions in `tests/visual/variants.ts`.
- Use the `click` field (screenshot-only, no layout key change), not `clicks`, for the new dashboard interactions.
- Do not hand-edit `tests/visual/layout-known-failures.json` to get a pass.
- In a karst ticket, do not run the full vitest suite. Run the changed files and `npm run -s typecheck`.

## Findings at plan time (develop `fec97f833`)

- The prompt line numbers are stale. Develop moved 60 commits after the planner read it.
- Item 3 (settings loading) is already satisfied: `AppShell.tsx:503-509` renders `Loading settings…` in `.content` when `!state.hydrated`, and it does not render `{children}`. So `AppSections` never mounts while unhydrated. The `dark/settings--loading.png` baseline shows the real loading state with the chrome intact. A `hydrated` branch in `AppSections` would be dead code. `AppShell.test.tsx:647` already pins the placeholder. No code change.
- Item 4 `approach-picker` already has `click: '#approachBtn'` (SET-65), and it does not collide. No change.
- Same-theme hash collisions today (sha1 of the PNG files):
  - dashboard: `agent-popover-no-effort-model-wide`=`agent-popover-opencode-wide`; `inside-done-closed`=`inside-done-passed`; `inside-impl-interrupted`=`inside-impl-running`; `inside-ship-running`=`dashboard-waiting`; `inside-uat-gates-revalidation`=`inside-uat-passed-round-2`; `panel-srv-running-wide`=`panel-wt-normal-wide`; `subtask-blocked`=`dashboard-running` (dark, light).
  - serverLogs: `empty`=`no-services`.
  - settings: `populated`=`route-general` (dark, light, hc); `nav-agents-narrow`=`roles-narrow-collapsed`; `nav-agents-tight`=`roles-graph-tight`=`roles-tight-collapsed`.
  - sidebar: `activity-300`=`activity-populated`; `empty`=`queue-empty`; `planning-deps`=`stage-chip-300`; `queue-chips-300`=`queue-populated`.
  - ticketForm: `empty`=`ticketForm` (populated).
- Cross-theme equalities (for example `dark/usage--quota-near.png` = `dark-grayscale/usage--quota-near.png`) are one variant in two projects. The check ignores them.

## File Structure

- Create `tests/visual/baselineDistinct.ts`: pure collision finder and the allow-list type.
- Create `tests/visual/baselineDistinct.test.ts`: unit tests of the finder on synthetic input.
- Create `tests/visual/realisticTicketForm.ts`: `REALISTIC_TICKET_FORM` and `ROUTED_MODEL_CATALOG`, moved from `variants.ts`.
- Modify `tests/visual/variants.test.ts`: the registry-wide distinctness test and the allow-list.
- Modify `src/ui/dashboard/renderFixtures.ts`: export `FIXTURE_NOW`, pin `hoursAgo()`.
- Modify `src/ui/dashboard/renderFixtures.test.ts`: clock-independence test.
- Modify `tests/visual/fixtures.ts`: use `FIXTURE_NOW`.
- Modify `tests/visual/corpora.ts`, `tests/visual/corpora.visual.ts`, `tests/visual/a11y.visual.ts`, `tests/visual/focus.visual.ts`, `tests/visual/variants.ts`, `tests/visual/panelVariants.ts`, `tests/visual/sweepBudget.ts`, `docs/ui/VISUAL-COVERAGE.md`.
- Modify `tests/visual/__baselines__/**`: the re-recorded and deleted PNGs.

---

### Task 1: Collision finder (pure)

**Files:**
- Create: `tests/visual/baselineDistinct.ts`
- Test: `tests/visual/baselineDistinct.test.ts`

**Interfaces:**
- Produces:
  - `interface BaselineShot { readonly theme: string; readonly baseline: string; readonly hash: string }`
  - `interface AllowedCollision { readonly baselines: readonly string[]; readonly reason: string }`
  - `function baselineCollisions(shots: readonly BaselineShot[], allow: readonly AllowedCollision[]): { readonly unexpected: readonly string[]; readonly stale: readonly string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { baselineCollisions, type BaselineShot } from './baselineDistinct.js';

const shot = (theme: string, baseline: string, hash: string): BaselineShot => ({ theme, baseline, hash });

describe('baselineCollisions', () => {
  it('reports two baselines in one theme with the same hash', () => {
    const r = baselineCollisions([shot('dark', 'a', 'h1'), shot('dark', 'b', 'h1'), shot('dark', 'c', 'h2')], []);
    expect(r.unexpected).toEqual(['dark: a = b']);
    expect(r.stale).toEqual([]);
  });

  it('ignores the same hash in two themes', () => {
    expect(baselineCollisions([shot('dark', 'a', 'h1'), shot('light', 'b', 'h1')], []).unexpected).toEqual([]);
  });

  it('accepts a collision that one allow-list entry covers, in every theme', () => {
    const shots = [shot('dark', 'a', 'h1'), shot('dark', 'b', 'h1'), shot('light', 'a', 'h3'), shot('light', 'b', 'h3')];
    const r = baselineCollisions(shots, [{ baselines: ['b', 'a'], reason: 'r' }]);
    expect(r).toEqual({ unexpected: [], stale: [] });
  });

  it('needs every member of a three-way group in one entry', () => {
    const shots = [shot('dark', 'a', 'h'), shot('dark', 'b', 'h'), shot('dark', 'c', 'h')];
    expect(baselineCollisions(shots, [{ baselines: ['a', 'b'], reason: 'r' }]).unexpected).toEqual(['dark: a = b = c']);
    expect(baselineCollisions(shots, [{ baselines: ['a', 'b', 'c'], reason: 'r' }]).unexpected).toEqual([]);
  });

  it('reports an allow-list entry that no longer collides as stale', () => {
    const r = baselineCollisions([shot('dark', 'a', 'h1'), shot('dark', 'b', 'h2')], [{ baselines: ['a', 'b'], reason: 'r' }]);
    expect(r.stale).toEqual(['a = b']);
  });
});
```

- [ ] **Step 2: Run the test to make sure that it fails**

Run: `npx vitest run tests/visual/baselineDistinct.test.ts`
Expected: FAIL, the module `./baselineDistinct.js` does not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
/**
 * Variant distinctness (@ui:VISUAL-VARIANTS, @ui:UI-R57): two registry variants that record the same PNG in one theme
 * project prove nothing the other does not. A collision passes only when one allow-list entry names every member of
 * the group, with a reason. An entry whose members no longer share a hash in any theme is stale and also fails, so
 * the list only shrinks.
 */
export interface BaselineShot {
  readonly theme: string;
  readonly baseline: string;
  readonly hash: string;
}

export interface AllowedCollision {
  /** Baseline stems (file name without `.png`) that may record the same picture. */
  readonly baselines: readonly string[];
  readonly reason: string;
}

function groups(shots: readonly BaselineShot[]): { readonly theme: string; readonly members: readonly string[] }[] {
  const byKey = new Map<string, { theme: string; members: string[] }>();
  for (const s of shots) {
    const key = `${s.theme}\0${s.hash}`;
    const g = byKey.get(key) ?? { theme: s.theme, members: [] };
    byKey.set(key, { theme: g.theme, members: [...g.members, s.baseline] });
  }
  return [...byKey.values()]
    .filter((g) => new Set(g.members).size > 1)
    .map((g) => ({ theme: g.theme, members: [...new Set(g.members)].sort() }));
}

export function baselineCollisions(
  shots: readonly BaselineShot[],
  allow: readonly AllowedCollision[],
): { readonly unexpected: readonly string[]; readonly stale: readonly string[] } {
  const found = groups(shots);
  const covers = (entry: AllowedCollision, members: readonly string[]): boolean => members.every((m) => entry.baselines.includes(m));
  const unexpected = found
    .filter((g) => !allow.some((entry) => covers(entry, g.members)))
    .map((g) => `${g.theme}: ${g.members.join(' = ')}`)
    .sort();
  const stale = allow
    .filter((entry) => !found.some((g) => entry.baselines.every((b) => g.members.includes(b))))
    .map((entry) => [...entry.baselines].sort().join(' = '));
  return { unexpected, stale };
}
```

- [ ] **Step 4: Run the test to make sure that it passes**

Run: `npx vitest run tests/visual/baselineDistinct.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/visual/baselineDistinct.ts tests/visual/baselineDistinct.test.ts
git commit -m "test: add the visual baseline collision finder"
```

### Task 2: Registry distinctness test (RED until Task 7)

**Files:**
- Modify: `tests/visual/variants.test.ts`

**Interfaces:**
- Consumes: `baselineCollisions`, `AllowedCollision` from Task 1; `VARIANTS`, `NON_VIEW_BASELINES`, `allVariants`, `BASELINES` already in the file.
- Produces: `const ALLOWED_BASELINE_COLLISIONS: readonly AllowedCollision[]` (filled in Task 7).

- [ ] **Step 1: Add the test with an empty allow-list**

Add the imports `createHash` from `node:crypto` and `readFileSync` from `node:fs`. Add this block after `NON_VIEW_BASELINES` and the test inside the `describe`:

```ts
/**
 * Pairs of variants that may record the same picture, each with the reason (@ui:VISUAL-VARIANTS). Filled from the
 * final PNGs only. An entry that stops colliding fails the test, so remove it when its fix lands.
 */
const ALLOWED_BASELINE_COLLISIONS: readonly AllowedCollision[] = [];

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
```

```ts
  it('records a distinct picture for every variant in each theme project, unless allow-listed (@ui:VISUAL-VARIANTS)', () => {
    const shots = allVariants.flatMap(({ variant }) =>
      variant.themes
        .map((theme) => ({ theme, file: join(BASELINES, theme, `${variant.baseline}.png`) }))
        .filter(({ file }) => existsSync(file))
        .map(({ theme, file }) => ({ theme, baseline: variant.baseline, hash: sha256(file) })),
    );
    const { unexpected, stale } = baselineCollisions(shots, ALLOWED_BASELINE_COLLISIONS);
    expect(unexpected, 'variants that record the same picture').toEqual([]);
    expect(stale, 'allow-list entries that no longer collide').toEqual([]);
  });
```

`NON_VIEW_BASELINES` stay out because the shots come from the registry only.

- [ ] **Step 2: Run it to see the full collision list**

Run: `npx vitest run tests/visual/variants.test.ts -t 'distinct picture'`
Expected: FAIL. The list matches "Findings at plan time".

- [ ] **Step 3: Commit (test stays RED, the ticket branch is not shipped before Task 7)**

```bash
git add tests/visual/variants.test.ts
git commit -m "test: fail when two visual variants record the same baseline picture"
```

### Task 3: Pin the dashboard fixture clock

**Files:**
- Modify: `src/ui/dashboard/renderFixtures.ts:1349-1352`
- Modify: `tests/visual/fixtures.ts:60-65`
- Test: `src/ui/dashboard/renderFixtures.test.ts`

**Interfaces:**
- Produces: `export const FIXTURE_NOW_MS: number` in `src/ui/dashboard/renderFixtures.ts` (`Date.parse('2026-10-27T22:00:00.000Z')`).

- [ ] **Step 1: Write the failing test** (append to `renderFixtures.test.ts`, add `vi` to the vitest import, and import `FIXTURE_NOW_MS`)

```ts
describe('fixture clock (T1357)', () => {
  it('builds the same stage ages at any wall-clock time', () => {
    const at = (ms: number): string => {
      vi.useFakeTimers({ now: ms, toFake: ['Date'] });
      try {
        return JSON.stringify(populatedStateFor('impl').subtasks);
      } finally {
        vi.useRealTimers();
      }
    };
    expect(at(Date.UTC(2030, 0, 1))).toBe(at(Date.UTC(2026, 0, 1)));
  });

  it('ages the sub-task stamps from FIXTURE_NOW_MS, the instant the visual sweep pins', () => {
    const since = populatedStateFor('impl').subtasks.map((s) => s.stageSince).filter((s): s is string => s !== null);
    expect(since).toContain(new Date(FIXTURE_NOW_MS - 5.5 * 3_600_000).toISOString());
  });
});
```

- [ ] **Step 2: Run the test to make sure that it fails**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts -t 'fixture clock'`
Expected: FAIL (`FIXTURE_NOW_MS` is not exported; after the export only, the first test fails on different JSON).

- [ ] **Step 3: Write the minimal implementation**

In `renderFixtures.ts`, replace `hoursAgo`:

```ts
/**
 * The instant the visual sweep pins the dashboard clock to (`tests/visual/fixtures.ts`). Fixture stamps are offsets
 * from it, never from `Date.now()`, so a baseline built at any time shows the same relative ages (T1357).
 */
export const FIXTURE_NOW_MS = Date.parse('2026-10-27T22:00:00.000Z');

/** Fixed offset from the pinned fixture clock (mid-hour, so the `Xh` text is stable). */
function hoursAgo(hours: number): string {
  return new Date(FIXTURE_NOW_MS - hours * 3_600_000).toISOString();
}
```

In `tests/visual/fixtures.ts`, import `FIXTURE_NOW_MS` from `../../src/ui/dashboard/renderFixtures.js` and replace the constant:

```ts
const DASHBOARD_NOW = new Date(FIXTURE_NOW_MS);
```

Keep the comment above it, and add: "The fixture stamps age from the same instant (`FIXTURE_NOW_MS`)."

- [ ] **Step 4: Run the related tests**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts` then `npx vitest related src/ui/dashboard/renderFixtures.ts --run`
Expected: PASS. If a snapshot changes because a jsdom real clock now reads the stamps as about 29 days old, check that the test normalizes the duration. Fix the test only when it pins a real-clock value; otherwise stop and report.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/renderFixtures.ts src/ui/dashboard/renderFixtures.test.ts tests/visual/fixtures.ts
git commit -m "fix: age dashboard fixture stamps from the pinned visual clock"
```

### Task 4: ticketForm populated uses the realistic state

**Files:**
- Create: `tests/visual/realisticTicketForm.ts`
- Modify: `tests/visual/variants.ts` (ticketForm block, `ROUTED_MODEL_CATALOG`, `REALISTIC_TICKET_FORM`)
- Modify: `tests/visual/corpora.ts:265`, `:288-291` and the `MINIMAL_RATCHET` comment
- Modify: `tests/visual/corpora.visual.ts:42-58`
- Modify: `tests/visual/a11y.visual.ts:3` (drop the unused `MINIMAL_RATCHET` import)
- Modify: `tests/visual/sweepBudget.ts:99-101`
- Modify: `docs/ui/VISUAL-COVERAGE.md:200`

**Interfaces:**
- Produces: `export const ROUTED_MODEL_CATALOG`, `export const REALISTIC_TICKET_FORM` in `tests/visual/realisticTicketForm.ts`.

- [ ] **Step 1: Move the two constants**

Cut `ROUTED_MODEL_CATALOG` and `REALISTIC_TICKET_FORM` (with their doc comments) out of `variants.ts` into `tests/visual/realisticTicketForm.ts` as exports. Add a file comment: "The realistic ticket form state (Layout B′, ui:UI-R57). `corpora.ts` seeds the populated ticketForm page from it, and `variants.ts` builds the named states from it." Import both in `variants.ts`.

- [ ] **Step 2: Switch the populated corpus**

In `corpora.ts`:

```ts
import { REALISTIC_TICKET_FORM } from './realisticTicketForm.js';
// ...
  // The realistic create page over the MINIMAL base: the merge the named variants use (T1357).
  ticketForm: { messages: [{ type: 'state', state: { ...MINIMAL_TICKET_FORM, ...REALISTIC_TICKET_FORM } }] },
```

Set `MINIMAL_RATCHET` to `['settings']`. Update its doc comment: ticketForm left the ratchet when its populated page took the realistic state (T1357).

- [ ] **Step 3: Remove `realistic-create`**

Delete `variant('ticketForm', 'realistic-create', ...)` and the SET-63 comment line before it. Change the `realistic-create-switches` comment to: "The toggle changes no geometry, so it shares the populated page's covered layout." Then `git rm tests/visual/__baselines__/{dark,light,hc}/ticketForm--realistic-create.png`.

- [ ] **Step 4: Tighten the ratchet test**

In `corpora.visual.ts`, change `toBeLessThanOrEqual(2)` to `toBeLessThanOrEqual(1)`. Change the comment: "The one that remains — settings — has no renderFixtures module. ticketForm left in T1357: its populated page is the realistic create state."

- [ ] **Step 5: Remove the unused import**

In `a11y.visual.ts`, change the import to `import { ALL_VIEWS } from './corpora.js';`.

- [ ] **Step 6: Update the budget and the doc**

Run: `npx vitest run tests/visual/sweepBudget.test.ts`
Expected: FAIL with the new ticketForm counts (3 fewer screenshots, fewer layout runs). Set `ticketForm` to the printed counts and add the line `// T1357: realistic-create removed, the populated page now renders the same realistic state (-3 screenshots and its layout run).` Change the T1301 line text "realistic-create" to "populated". In `VISUAL-COVERAGE.md:200`, state that only `settings` remains on the MINIMAL seed.

- [ ] **Step 7: Run the unit checks**

Run: `npx vitest run tests/visual/sweepBudget.test.ts tests/visual/variants.test.ts tests/visual/defaultVariant.test.ts` and `npm run -s typecheck`
Expected: PASS, except the Task 2 test and the exact-pair baseline test (the new populated picture is not recorded yet).

- [ ] **Step 8: Commit**

```bash
git add -A tests/visual docs/ui/VISUAL-COVERAGE.md
git commit -m "test: seed the ticketForm populated page from the realistic state"
```

The focus count and a11y findings are measured in Task 6.

### Task 5: Dashboard collapsed variants

**Files:**
- Modify: `tests/visual/variants.ts` (`RUNTIME_STATES`, `runtimeStripVariants`, `insideCaseVariants`, `agentPopoverVariants`)
- Modify: `tests/visual/panelVariants.ts:153`
- Modify: `tests/visual/sweepBudget.ts` (dashboard count)

- [ ] **Step 1: runtime-shell-off opens the ⋯ menu**

Give `RUNTIME_STATES` an optional third element and pass it:

```ts
const RUNTIME_STATES: ReadonlyArray<readonly [string, (s: DashboardState) => DashboardState, RuntimeOpen?]> = [
  // ...
  // T1357: the shell's disabled reason is only in the ⋯ menu, so the closed strip equals the docker state.
  ['shell-off', (s) => ({ ...s, sandbox: { ...SBX_VIEW, shell: { available: false, why: 'Sandbox is stopped' } } }), 'more'],
  // ...
];
```

```ts
  ...RUNTIME_STATES.flatMap(([id, patch, open]) =>
    (RUNTIME_MULTI_WIDTH.has(id) ? RUNTIME_TIERS : RUNTIME_TIERS.slice(0, 1)).map(([tier, width]) =>
      variant('dashboard', `runtime-${id}-${tier}`, dashboardScenario('running', 2, patch), {
        skipLayout: true,
        width,
        ...(open === undefined ? {} : { runtimeOpen: open }),
      }),
    ),
  ),
```

- [ ] **Step 2: Inside-case screenshot steps**

Add above `insideCaseVariants`, and spread the click into each variant:

```ts
/**
 * T1357: a screenshot step for an Inside case whose state is only visible after a click. Without it the page equals
 * a sibling case (@ui:VISUAL-VARIANTS). `click` is screenshot-only, so the layout key does not change.
 */
const INSIDE_CASE_CLICK: Readonly<Record<string, string>> = {
  // The revalidation caption is in the Gates evidence body (EvidenceRows.tsx `gates-caption`).
  'uat-gates-revalidation': '[data-proc-id="uat:gates"] > summary',
  // A closed ticket differs from a passed one only in its menu: Reopen instead of Close.
  'done-closed': '#moreBtn',
};

const insideCaseVariants = (): Variant[] =>
  INSIDE_CASES.filter((c) => c.aliasOf === undefined && c.id !== 'live-tokens').map((c) => {
    const click = INSIDE_CASE_CLICK[`${c.stage}-${c.id}`];
    return variant('dashboard', `inside-${c.stage}-${c.id}`, () => stateMessage(c.state()), {
      ...(c.allThemes ? { themes: ALL_THEMES } : {}),
      ...(click === undefined ? {} : { click }),
    });
  });
```

Add a unit assertion in `variants.test.ts` so that a renamed case fails:

```ts
  it('points every Inside screenshot step at a registered case (T1357)', () => {
    const ids = new Set(VARIANTS.dashboard.map((v) => v.id));
    expect(VARIANTS.dashboard.find((v) => v.id === 'inside-uat-gates-revalidation')?.click).toBe('[data-proc-id="uat:gates"] > summary');
    expect(VARIANTS.dashboard.find((v) => v.id === 'inside-done-closed')?.click).toBe('#moreBtn');
    expect(ids.has('inside-done-passed')).toBe(true);
  });
```

- [ ] **Step 3: Remove `panel-wt-normal`**

In `panelVariants.ts`, delete `{ id: 'wt-normal', patch: (s) => s }`. It is the unpatched running page, which `panel-srv-running` (two running servers, the same worktrees) already records. Then `git rm tests/visual/__baselines__/dark/dashboard--panel-wt-normal-wide.png`.

- [ ] **Step 4: agent-popover-no-effort-model picks a model that is not pre-staged**

`recentByCore.opencode` is `['opencode/big-pickle']`, so the core switch already stages Big Pickle and the click changes nothing. Pick the other model with no efforts:

```ts
  // T1357: Kimi K3 Free has no efforts and is not the recent (pre-staged) model, so the pick changes the panel.
  agentPopoverVariant('no-effort-model-wide', { core: 'opencode', model: 'opencode/kimi-k3-free' }, 1100),
```

Task 6 checks the hypothesis on the recorded picture. If the PNG still equals `agent-popover-opencode-wide`, open the fixture page (`tests/visual/serve.mjs`) and inspect the panel after the click before any other change.

- [ ] **Step 5: Budget and unit checks**

Run: `npx vitest run tests/visual/sweepBudget.test.ts tests/visual/variants.test.ts` and `npm run -s typecheck`
Expected: the sweep budget fails with dashboard screenshots one lower. Set the printed count and add `// T1357: panel-wt-normal removed, it recorded the same page as panel-srv-running (-1 screenshot).`

- [ ] **Step 6: Commit**

```bash
git add -A tests/visual
git commit -m "test: give collapsed dashboard variants the step that shows their state"
```

### Task 6: Re-record in Docker and measure the ratchets

- [ ] **Step 1: Build the gitignored webview bundles**

Run: `npm run -s build` (or the bundle script that `tests/visual/serve.mjs` calls). Check that `src/ui/shared/anchoredPopover.webview.js` exists.

- [ ] **Step 2: Re-record dashboard and ticketForm** (background, it takes longer than 10 minutes)

Run: `KARST_UI_GREP='dashboard|ticketForm' npm run -s test:visual:docker:update 2>&1 | tail -n 60`
Expected: exit 0. Snapshots written for the changed pages.

- [ ] **Step 3: Check the pictures**

Open these PNGs and confirm the intended change:
- `dark/dashboard--inside-uat-gates-revalidation.png`: the Gates body is open with the revalidation caption.
- `dark/dashboard--inside-done-closed.png`: the ticket menu is open with Reopen.
- `dark/dashboard--runtime-shell-off-wide.png`: the ⋯ menu is open with the disabled shell reason.
- `dark/dashboard--agent-popover-no-effort-model-wide.png`: Kimi K3 Free is checked.
- `dark/dashboard--inside-uat-gates-revalidation.png` Sub-tasks: ages read `5h`/`3h`/`4h`-class values, not `0s`.
- `dark/ticketForm.png`: the realistic create page.

- [ ] **Step 4: Measure the ticketForm focus count and a11y**

Run: `KARST_UI_GREP='ticketForm' node scripts/dockerGate.mjs --local "playwright test tests/visual/focus.visual.ts tests/visual/a11y.visual.ts" run --rm --init -e KARST_UI_GREP -v "$PWD":/work -v /work/node_modules -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test tests/visual/focus.visual.ts tests/visual/a11y.visual.ts --project=dark 2>&1 | tail -n 40`
Expected: the focus test prints `ticketForm has N focusable elements`. If N > 31, set `FOCUS_COUNT_RATCHET.ticketForm` to N with a note: "Updated by T1357: `ticketForm` 31 → N — the populated page is now the realistic create state (provider search, three repos, approach and preset pickers, one attachment). The controls are not new; the old MINIMAL seed did not render them." If N < 31, lower it. Fix any new a11y finding in the source, or stop and report it.

- [ ] **Step 5: Layout ledger**

Run: `npm run -s test:visual:docker:prune` only if the layout run reports entries for removed targets (`ticketForm/realistic-create`). Never hand-edit the ledger.

### Task 7: Fill the allow-list from the final pictures and commit

**Files:**
- Modify: `tests/visual/variants.test.ts` (`ALLOWED_BASELINE_COLLISIONS`)
- Modify: `tests/visual/__baselines__/**`

- [ ] **Step 1: Read the remaining collisions**

Run: `npx vitest run tests/visual/variants.test.ts -t 'distinct picture'`
Expected: FAIL with the out-of-scope groups only. None of `ticketForm`, `runtime-shell-off`, `gates-revalidation`, `done-closed`, `panel-wt-normal`, `no-effort-model` can be in it. If one is, go back to Task 5.

- [ ] **Step 2: Add one entry per remaining group, each with a checked reason**

```ts
const ALLOWED_BASELINE_COLLISIONS: readonly AllowedCollision[] = [
  {
    baselines: ['dashboard--inside-impl-interrupted', 'dashboard--inside-impl-running'],
    reason: 'D772: the Inside view does not yet render agentState interrupted; remove this entry when D772 lands.',
  },
  // One entry per other group that Step 1 prints, for example settings--populated / settings--route-general
  // (the populated page opens on General). Read both variant definitions before you write the reason.
];
```

For each group, write the cause (same page through two registries, a width tier at the view's default width, a route that renders the default section). Do not write a placeholder reason.

- [ ] **Step 3: Run the visual unit tests**

Run: `npx vitest run tests/visual/variants.test.ts tests/visual/baselineDistinct.test.ts tests/visual/sweepBudget.test.ts src/ui/dashboard/renderFixtures.test.ts` and `npm run -s typecheck`
Expected: PASS.

- [ ] **Step 4: Commit the baselines**

```bash
git add -A tests/visual
git commit -m "test: re-record dashboard and ticketForm baselines (UI-R35)

Pinned the fixture clock: Sub-tasks ages read hours from DASHBOARD_NOW, not 0s.
ticketForm populated renders the realistic state; realistic-create is removed.
Collapsed dashboard variants now open the state they name. The distinctness
test allow-lists the remaining identical pictures with a reason."
```

### Task 8: Close-out

- [ ] **Step 1:** Read `.claude/skills/gates-and-ci/SKILL.md` and run the cheap checks it lists.
- [ ] **Step 2:** Run `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs | tail -n 20`. Cite a block with `karst arch cite` if it blocks and the block still holds.
- [ ] **Step 3:** Fire the impl marker. Report item 3 (already satisfied, no change) and item 4 approach-picker (already clicked) in the done report.
