# Context: PRs per Sub-task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `karst context <parent> --md|--json` shows each sub-task's PRs (repo, number, base, status, merge check) so an orchestrator needs no `gh` calls.

**Architecture:** `buildTicketContext` reads each sub-task's cached PR rows (`listPrsByTicket`) and merge checks (`listMergeChecksByTicket`) into a new `prs: TicketContextPr[]` on `TicketContextSubtask`. `TicketContextPr` gains optional `baseRef`. A small pure formatter in a new file builds the row suffix; `renderTicketContext` appends it only when `bounded === false` (CLI path). Seed (bounded) output is unchanged.

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest, in-memory SQLite (`openStore(':memory:')`).

**Spec:** ticket CONTEXT-LIST-PRS-PER-SUB-TASK-IN (prompt + context brief, `karst context CONTEXT-LIST-PRS-PER-SUB-TASK-IN`).

## Global Constraints

- Data source: `listPrsByTicket` (src/store/dashboard.ts:193). No live gh call at render.
- Row suffix: ` — <repo>#<n> → <base> · <status> · merge: <summary>`; several PRs comma-joined (`, `); stage `ship` with no PR → ` — no PR yet`; other stages with no PR → no suffix.
- Repo = manifest repository NAME (`prs.repo` column already stores it).
- Suffix only when `bounded === false`. Seed rows byte-identical to today.
- `--json` includes `prs` per sub-task.
- `src/context/ticketContext.ts` is 967 lines: put the new formatter in its own file, keep additions there minimal.
- Mutation gate does not cover `src/context/**`? Check `stryker.config.json` `mutate`; if covered, kill mutants with the tests below.
- Commands: `npx vitest run <file>`; `npm run -s typecheck`. Never `--reporter`.

---

### Task 1: Data — `prs[]` on each sub-task + `baseRef` on PRs

**Files:**
- Modify: `src/context/ticketContext.ts` (`TicketContextPr` ~line 58; `TicketContextSubtask` ~line 219; sub-task map ~line 445; parent PR map ~line 553)
- Test: `src/context/ticketContext.test.ts` (inside `describe('sub-tasks (design NDL-70 §7)')`)

**Interfaces:**
- Produces: `TicketContextPr.baseRef?: string` (spread in only when non-null, so old JSON is unchanged); `TicketContextSubtask.prs: TicketContextPr[]`; internal helper `toContextPr(p: PrView, checks: Map<string, MergeCheckRow>): TicketContextPr`.

- [ ] **Step 1: Write failing test**

```ts
it('lists each sub-task\'s cached PRs with base and merge check', () => {
  const parent = createTicket(store, { key: 'PROJ-2', title: 'Root' });
  const child = createTicket(store, { key: 'PROJ-2-s1', title: 'Piece', subtaskParentId: parent.id });
  store.db
    .prepare("INSERT INTO prs (ticket_id, repo, number, url, status, base_ref) VALUES (?, 'frontend', 12, 'https://x/pr/12', 'open', 'feat/root')")
    .run(child.id);
  const ctx = buildTicketContext(store, undefined, parent.id);
  expect(ctx.subtasks[0]!.prs).toEqual([
    { repo: 'frontend', number: 12, url: 'https://x/pr/12', status: 'open', baseRef: 'feat/root' },
  ]);
});

it('gives a sub-task with no PR rows an empty prs list', () => {
  const parent = createTicket(store, { key: 'PROJ-3', title: 'Root' });
  createTicket(store, { key: 'PROJ-3-s1', title: 'Piece', subtaskParentId: parent.id });
  expect(buildTicketContext(store, undefined, parent.id).subtasks[0]!.prs).toEqual([]);
});
```

Also update the existing `expect(ctx.subtasks).toEqual([...])` (~line 281) to include `prs: []` on each entry.

- [ ] **Step 2: Run** `npx vitest run src/context/ticketContext.test.ts` — expect FAIL (`prs` undefined).

- [ ] **Step 3: Implement**

```ts
// TicketContextPr
  /** Target branch the PR merges into; omitted when unknown (keeps old JSON). */
  baseRef?: string;

// TicketContextSubtask
  /** Cached PR rows for this sub-task (display cache; gh stays source of truth). */
  prs: TicketContextPr[];
```

Extract the existing parent mapping (line ~553) into a module-level helper and reuse it:

```ts
function toContextPr(
  p: ReturnType<typeof listPrsByTicket>[number],
  checks: ReadonlyMap<string, { state: MergeCheckView['state']; files: MergeCheckView['files']; reason: MergeCheckView['reason'] }>,
): TicketContextPr {
  const check = checks.get(p.repo);
  return {
    repo: p.repo,
    number: p.number,
    url: p.url,
    status: p.status,
    ...(p.baseRef ? { baseRef: p.baseRef } : {}),
    // Spread rather than `mergeCheck: undefined`, so a never-checked PR
    // serializes to the exact JSON the CLI emitted before this existed.
    ...(check ? { mergeCheck: { state: check.state, files: check.files, reason: check.reason } } : {}),
  };
}
```

Parent: `prs: listPrsByTicket(store, ticketId).map((p) => toContextPr(p, mergeChecks)),`
Sub-task map: add

```ts
    prs: listPrsByTicket(store, s.id).map((p) =>
      toContextPr(p, new Map(listMergeChecksByTicket(store, s.id).map((c) => [c.repo, c]))),
    ),
```

(hoist the Map out of the inner map: compute `const checks = ...` inside the sub-task arrow, then map.) If `MergeCheckView` field types differ, type `checks` as `ReadonlyMap<string, MergeCheckView>` — the store row is assignable.

Note: adding `baseRef` changes the parent `## Pull requests` JSON for PRs that have a base. Acceptable (additive); fix any `toEqual` test that breaks by adding `baseRef`.

- [ ] **Step 4: Run** `npx vitest run src/context/ticketContext.test.ts src/cli/context.test.ts` and `npm run -s typecheck` — PASS.

- [ ] **Step 5: Commit** `feat(context): carry cached PRs per sub-task in ticket context`

---

### Task 2: Render suffix in unbounded (CLI) markdown only

**Files:**
- Create: `src/context/subtaskPrSuffix.ts`
- Create: `src/context/subtaskPrSuffix.test.ts`
- Modify: `src/context/ticketContext.ts` (sub-task row builder ~line 762)
- Test: `src/context/ticketContext.test.ts` (new `describe('sub-task PRs')` under `renderTicketContext`)

**Interfaces:**
- Consumes: `TicketContextSubtask.prs`, `TicketContextPr.baseRef`, `summarizeMergeCheck` (src/model/mergeCheckView.js).
- Produces: `export function subtaskPrSuffix(stage: string | null, prs: readonly TicketContextPr[]): string` — returns `''`, `' — no PR yet'`, or `' — a, b'`.

- [ ] **Step 1: Write failing unit tests** (`src/context/subtaskPrSuffix.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { subtaskPrSuffix } from './subtaskPrSuffix.js';

describe('subtaskPrSuffix', () => {
  it('formats one PR with base, status and merge check', () => {
    expect(
      subtaskPrSuffix('ship', [
        { repo: 'frontend', number: 12, url: null, status: 'open', baseRef: 'feat/root',
          mergeCheck: { state: 'clean', files: [], reason: null } },
      ]),
    ).toMatch(/^ — frontend#12 → feat\/root · open · merge: .+$/);
  });
  it('comma-joins several PRs', () => {
    expect(
      subtaskPrSuffix('ship', [
        { repo: 'api', number: 3, url: null, status: 'open', baseRef: 'develop' },
        { repo: 'web', number: 4, url: null, status: 'merged', baseRef: 'develop' },
      ]),
    ).toBe(' — api#3 → develop · open, web#4 → develop · merged');
  });
  it('says no PR yet in ship', () => expect(subtaskPrSuffix('ship', [])).toBe(' — no PR yet'));
  it('says nothing before ship', () => expect(subtaskPrSuffix('impl', [])).toBe(''));
  it('drops missing parts', () => {
    expect(subtaskPrSuffix('ship', [{ repo: 'api', number: null, url: null, status: null }])).toBe(' — api');
  });
});
```

(Adjust the `mergeCheck` literal to `MergeCheckView`'s real field types; read `src/model/mergeCheckView.ts` first.)

- [ ] **Step 2: Run** `npx vitest run src/context/subtaskPrSuffix.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** `src/context/subtaskPrSuffix.ts`

```ts
import { summarizeMergeCheck } from '../model/mergeCheckView.js';
import type { TicketContextPr } from './ticketContext.js';

/**
 * The sub-task row suffix in the pulled `karst context --md` document: the
 * cached PR facts an orchestrator would otherwise fetch with one `gh` call per
 * repo. Never rendered into the bounded seed (arch:RESIDENT).
 */
export function subtaskPrSuffix(stage: string | null, prs: readonly TicketContextPr[]): string {
  if (prs.length === 0) return stage === 'ship' ? ' — no PR yet' : '';
  return ` — ${prs.map(formatPr).join(', ')}`;
}

function formatPr(p: TicketContextPr): string {
  const head = p.number !== null ? `${p.repo}#${p.number}` : p.repo;
  const parts = [p.baseRef ? `${head} → ${p.baseRef}` : head];
  if (p.status) parts.push(p.status);
  if (p.mergeCheck) parts.push(`merge: ${summarizeMergeCheck(p.mergeCheck)}`);
  return parts.join(' · ');
}
```

Use `import type` to avoid a runtime cycle.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Write failing render tests** (`ticketContext.test.ts`)

```ts
describe('sub-task PRs', () => {
  function seedParent() {
    const parent = createTicket(store, { key: 'PROJ-5', title: 'Root' });
    const a = createTicket(store, { key: 'PROJ-5-s1', title: 'A', subtaskParentId: parent.id });
    const b = createTicket(store, { key: 'PROJ-5-s2', title: 'B', subtaskParentId: parent.id });
    setStage(store, a.id, 'ship'); setStage(store, b.id, 'ship');
    const ins = store.db.prepare(
      'INSERT INTO prs (ticket_id, repo, number, url, status, base_ref) VALUES (?, ?, ?, ?, ?, ?)',
    );
    ins.run(a.id, 'frontend', 12, 'https://x/12', 'open', 'feat/root');
    ins.run(a.id, 'backend', 13, 'https://x/13', 'open', 'feat/root');
    return buildTicketContext(store, undefined, parent.id);
  }
  it('suffixes rows when unbounded', () => {
    const md = renderTicketContext(seedParent(), undefined, { bounded: false });
    expect(md).toContain('PROJ-5-s1: A (stage: ship) — backend#13 → feat/root · open, frontend#12 → feat/root · open');
    expect(md).toContain('PROJ-5-s2: B (stage: ship) — no PR yet');
  });
  it('leaves seed (bounded) rows unchanged', () => {
    const md = renderTicketContext(seedParent());
    expect(md).toContain('- PROJ-5-s1: A (stage: ship)\n');
    expect(md).not.toContain('no PR yet');
    expect(md).not.toContain('#12');
  });
});
```

Use the stage-setting helper the file already uses (grep `setStage`/`src/cli/test/setStage.ts`); order of PRs follows `ORDER BY number` → frontend#12 first: fix expected string to `frontend#12 … , backend#13 …`.

- [ ] **Step 6: Run** — FAIL.

- [ ] **Step 7: Implement** in the row builder (~line 762):

```ts
      const prs = bounded ? '' : subtaskPrSuffix(s.stageCurrent, s.prs);
      return `- ${key}${named} (stage: ${s.stageCurrent ?? 'unknown'}${queued}${paused})${flag}${prs}`;
```

Import `subtaskPrSuffix` from `./subtaskPrSuffix.js`.

- [ ] **Step 8: Run** `npx vitest run src/context/ src/cli/context.test.ts` + `npm run -s typecheck` — PASS.

- [ ] **Step 9: Commit** `feat(context): show sub-task PRs in karst context --md`

---

### Task 3: CLI acceptance (`--md` and `--json`)

**Files:**
- Test: `src/cli/context.test.ts` (append in the describe containing `'prints automatic advance instruction…'`)

**Interfaces:** Consumes `runContextCommand(store, MANIFEST, { key, format }, '/db', CLI?)`, `seed(stage)` (existing helper creating PROJ-9 id 1), `setStage`.

- [ ] **Step 1: Write tests**

```ts
it('lists sub-task PRs in --md and --json', () => {
  seed('impl');
  const child = createTicket(store, { key: 'PROJ-9-s1', title: 'Child', subtaskParentId: 1 });
  setStage(store, child.id, 'ship');
  store.db
    .prepare("INSERT INTO prs (ticket_id, repo, number, url, status, base_ref) VALUES (?, 'frontend', 21, 'https://x/21', 'open', 'feat/p')")
    .run(child.id);
  const md = runContextCommand(store, MANIFEST, { key: 'PROJ-9', format: 'md' }, '/db', CLI);
  expect(md).toContain('PROJ-9-s1: Child (stage: ship) — frontend#21 → feat/p · open');
  const json = JSON.parse(runContextCommand(store, MANIFEST, { key: 'PROJ-9', format: 'json' }, '/db'));
  expect(json.subtasks[0].prs).toEqual([
    { repo: 'frontend', number: 21, url: 'https://x/21', status: 'open', baseRef: 'feat/p' },
  ]);
});
```

Check `setStage` signature in `src/store/stages.ts` before use (it is imported already in this file).

- [ ] **Step 2: Run** `npx vitest run src/cli/context.test.ts` — PASS expected (Tasks 1–2 done); if FAIL, fix implementation not test.

- [ ] **Step 3: Gates** — `npm run -s typecheck`; `npx vitest related src/context/ticketContext.ts src/context/subtaskPrSuffix.ts`; if `src/context/**` is in Stryker `mutate`, `npx stryker run --mutate src/context/subtaskPrSuffix.ts` then `node scripts/mutationSummary.mjs` (≥85). Full `npm run -s test:unit` once at end.

- [ ] **Step 4: Commit** `test(cli): context lists sub-task PRs in md and json`
