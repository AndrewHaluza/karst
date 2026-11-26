# Autopilot base-red CI step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When every failing CI check of a host ticket's PR failed on the same test ids in a develop push run of the same workflow, autopilot rebases on base once when develop is green, or waits without a park while develop is red. It uses no attempt and starts no agent round.

**Architecture:** A pure id extractor (`src/workflow/baseRedCi.ts`) gives a closed, normalized set of failing test ids from a job log. New gh seams (`src/integrations/ciRerun.ts`) list the develop push runs of the workflow, read the failing ids of one develop job (memoized, because a completed run does not change), and ask GitHub whether a commit is in the PR head. A new step (`src/extension/ops/autopilotBaseRed.ts`) decides `none | rebased | waiting`. `autopilotOps.ts` calls it first in the CI step order, before `staleStep`.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest 4, better-sqlite3 via `openStore(':memory:')`, gh CLI through the injected `GhRunner`.

**Spec:** Ticket T1383 (`karst context FEAT-AUTOPILOT-A-CI-CHECK-THAT`; full text in the spilled description attachment `attachments/1383/fb96834f8a64b7b7.txt`). Related arch blocks: `@arch:AP-00`, `@arch:AP-03`, `@arch:AP-04`, `@arch:AP-05`, `@arch:AP-06` in `docs/arch/autopilot.md`.

## Global Constraints

- A check is base red only if every PR failing id is in the failing ids of ONE failed develop push run of the same job.
- A gh error is never read as base red: every throw in the step gives `none`.
- The base-red step uses no attempt, starts no agent round, and re-runs no PR job.
- If ANY failing check is not base red, the step gives `none` (no partial handling).
- Graph tickets and sandboxed tickets skip the step (same eligibility as `staleStep`, `@arch:AP-04`).
- A failing check with no job url gives `none`.
- Rebase event text: `Autopilot: rebased on base: <check> failed on <base> too (<9-char sha>) and <base> is green at <9-char sha>`.
- Wait event text: `Autopilot: waiting for a green <base>: <check> fails there too` — exactly one per (ticket, check, develop run).
- Park suffix for a check rebased on an earlier run: ` (rebased once because <base> was red and it failed again)`.
- A base-red wait ends after 24 hours (`BASE_RED_WAIT_MS = 24 * 60 * 60_000`). Then today's rules apply.
- A rebase marker on the current PR run waits by `STALE_WAIT_MS` (as `staleRebaseStep`).
- A rebase that pushed nothing is tagged `(stopped)`.
- `gh run list` reads at most 20 runs (`BASE_RUN_LIMIT = 20`). The step reads at most 5 failed develop job logs per check (`MAX_BASE_RED_LOGS = 5`).
- No schema change. Markers live in `autopilot_reruns`.
- Do not change the visual gate, `tests/visual/visual-known-failures.json`, any baseline, CI round counts, the budget, or the no-change park.
- No `spawnSync`. No `sed -i`. Logs are bounded text, never evaluated.
- In a karst ticket, do not run the full suite. Run single files, `npm run -s typecheck`, and the cheap checks of the `gates-and-ci` skill.

## Design decisions (gaps the spec leaves open)

1. **Marker keys.** The primary key of `autopilot_reruns` is `(ticket_id, repo, run_id, check_name)`, and markers use `INSERT OR IGNORE`.
   - The rebase marker is keyed by the PR run id. Its pattern is `base-red:<base>` (the base name is needed for the park suffix; the check name is already in `check_name`). A stopped rebase appends ` (stopped)`.
   - The wait row is keyed by the DEVELOP run id (`run_id = <base run id>`). Its pattern is `base-red-wait:<pr run id>`. So a wait row never blocks the later rebase marker on the PR run, and the key gives the one-event-per-(ticket, check, develop run) dedup.
   - The 24h start is `MIN(rerun_at)` over the wait rows of (repo, check, `base-red-wait:<pr run id>`). A new PR run starts a new 24h window.
   - `LIKE 'base-red:%'` does not match `base-red-wait:` rows (char 9 is `-`, not `:`). A test pins this.
2. **Base branch.** `FailedCheck` gets `base?: string | null` from `prs.base_ref` (through `ciFailureState`). Null gives `none`. The gh seam rejects a name that does not match `/^[A-Za-z0-9._\/-]+$/`, starts with `-`, or holds `..`.
3. **Workflow.** Read `.workflow_id` from `repos/<o>/<r>/actions/runs/<runId>`. Pass `--repo <o>/<r>` to every `gh run` call.
4. **"N.headSha is in the PR head".** `gh api repos/<o>/<r>/compare/<N>...<prHead> --jq .status`. `ahead` or `identical` means N is in the PR head. `behind` or `diverged` means it is not. Any other value throws. `prHead` is `readRunHeadSha` of the failing PR run.
5. **N green and already in the PR head.** The check is not handled: the step gives `none`.
6. **Several checks with different N.** If any proof is green and already in the PR head → `none`. Else if any proof is red → `waiting` (a rebase now fails the red one again and spends its one rebase). Else → rebase once per repo.
7. **Already parked.** `autopilotTick` returns `idle` before `runRound` when `holdsPark(stoppedReason)` holds. A wait returns `{ kind: 'nothing' }`, and that path clears no park. The engine test sets an `auto-fix` park block without a stop reason and checks that the block stays.
8. **Id extraction (closed set, three patterns).** Each line is cleaned with the exported `clean()` of `staleGeneratedCi.ts` (ANSI, gh `<job>\t<step>\t` prefix, timestamp, `##[error]`).
   - Visual gate: ``- <project> <file>::<title>`` or ``- `<project>` <file>::<title>``, with the tail `: <n> pixels …` or `: diff size unavailable` cut at the end. Id: `<project> <basename>::<title>`.
   - Playwright failure list: `<n>) [<project>] › <path>:<line>:<col> › … › <leaf>`. Take the last ` › ` segment, drop ` @TAG` tokens and a `(1.1s)` timing. Id: `<project> <basename>::<leaf>`.
   - Vitest: `FAIL <file> > <name>` (an optional `|project|` before the file, a timing like ` 12ms` cut). Id: `vitest <file> > <name>`.
   - The `✘` per-test lines are NOT matched: a flaky test shows `✘` and then passes on retry.
   - The result is sorted and deduplicated.
9. **Cost.** `makeBaseRedSeams` memoizes the ids of each `(owner/repo, runId, jobName)` in its closure (at most 200 entries, oldest dropped). A throw is not memoized. The step stops at the first failed develop run whose ids contain all PR ids.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/workflow/staleGeneratedCi.ts` | Modify | Export `clean` (no behavior change). |
| `src/workflow/baseRedCi.ts` | Create | Pure: `extractFailingTestIds`, `isBaseRed`, prefixes, `isBaseRedPattern`. |
| `src/workflow/baseRedCi.test.ts` | Create | Extractor and subset tests. |
| `src/store/autopilot.ts` | Modify | `baseRedRuns`, `markBaseRedStopped`, `markBaseRedWait`, `baseRedWaitStart`. |
| `src/store/autopilot.test.ts` | Modify | Store tests for the four functions. |
| `src/integrations/ciRerun.ts` | Modify | gh seams and `makeBaseRedSeams`. |
| `src/integrations/ciRerun.test.ts` | Modify or create | gh argument and shape tests. |
| `src/workflow/ciFailure.ts` | Modify | `CiFailurePr.base` from `prs.base_ref`. |
| `src/extension/ops/autopilotRerun.ts` | Modify | `FailedCheck.base`; skip base-red markers. |
| `src/extension/ops/autopilotNoChange.ts` | Modify | Skip base-red markers. |
| `src/extension/ops/autopilotBaseRed.ts` | Create | `baseRedStep`. |
| `src/extension/ops/autopilotBaseRed.test.ts` | Create | Step tests (a)–(f) and more. |
| `src/extension/ops/autopilotOps.ts` | Modify | Dep `baseRed`, `baseRedStepOf`, order, park suffix, `base` in `fails`. |
| `src/extension/ops/autopilotOps.test.ts` | Modify | Engine tests. |
| `src/extension/ops/autopilotWiring.ts` | Modify | Forward `baseRed`. |
| `src/extension/autopilotBinding.ts` | Modify | Wire `makeBaseRedSeams`. |
| `src/extension/autopilotBindingSeams.test.ts` | Modify | Mock and seam test. |
| `docs/arch/autopilot.md` | Modify | New `@arch:AP-12`; pointers in AP-00, AP-03, AP-05. |
| `docs/arch/system-map.md` | Regenerate | `npm run -s docs:graph`. |

---

### Task 1: Pure id extractor and base-red predicate

**Files:**
- Modify: `src/workflow/staleGeneratedCi.ts` (`function clean` → `export function clean`)
- Create: `src/workflow/baseRedCi.ts`
- Test: `src/workflow/baseRedCi.test.ts`

**Interfaces:**
- Consumes: `clean(line: string): string` and `MAX_CI_LOG_CHARS` (from `./transientCi.js`).
- Produces:
  - `export const BASE_RED_PREFIX = 'base-red:'`
  - `export const BASE_RED_WAIT_PREFIX = 'base-red-wait:'`
  - `export function isBaseRedPattern(pattern: string): boolean`
  - `export function extractFailingTestIds(log: string): string[]`
  - `export function isBaseRed(prIds: readonly string[], baseIds: readonly string[]): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/workflow/baseRedCi.test.ts
import { describe, expect, it } from 'vitest';
import { BASE_RED_PREFIX, BASE_RED_WAIT_PREFIX, extractFailingTestIds, isBaseRed, isBaseRedPattern } from './baseRedCi.js';

// Verbatim lines of develop run 45810045962 (gh prefix and timestamps kept).
const P = 'Visual regression (blocks new breaks)\tMerge the shard reports and run the gate\t';
const CROSS = `${P}2026-11-26T11:30:17.2720361Z   ✘   968 [dark] › tests/visual/pages.visual.ts:71:7 › full-page screenshots › dashboard/stage-menu-bottom-edge: full-page screenshot @NOT-LIGHT @NOT-HC @NOT-DARK-GRAYSCALE @NOT-DARK-REDUCED-MOTION @NOT-CATALOG (1.1s)`;
const LIST = `${P}2026-11-26T11:30:17.5736450Z   1) [dark] › tests/visual/pages.visual.ts:71:7 › full-page screenshots › dashboard/stage-menu-bottom-edge: full-page screenshot @NOT-LIGHT @NOT-HC @NOT-DARK-GRAYSCALE @NOT-DARK-REDUCED-MOTION @NOT-CATALOG `;
const GATE = `${P}2026-11-26T11:30:18.1275736Z - dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot: 312 pixels (ratio 0.01 of all image pixels) are different`;
const ID = 'dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot';

describe('extractFailingTestIds', () => {
  it('normalizes the visual gate line and the playwright failure line to the same id', () => {
    expect(extractFailingTestIds(GATE)).toEqual([ID]);
    expect(extractFailingTestIds(LIST)).toEqual([ID]);
    expect(extractFailingTestIds(`${LIST}\n${GATE}\n`)).toEqual([ID]);
  });

  it('does not read the per-test ✘ line (a flaky test passes on retry)', () => {
    expect(extractFailingTestIds(CROSS)).toEqual([]);
  });

  it('reads the backticked project of the gate summary and the diff-size-unavailable tail', () => {
    expect(extractFailingTestIds('- `dark` pages.visual.ts::a/b: full-page screenshot: diff size unavailable')).toEqual(['dark pages.visual.ts::a/b: full-page screenshot']);
  });

  it('keeps a title with no diff tail whole', () => {
    expect(extractFailingTestIds('- light pages.visual.ts::x: y')).toEqual(['light pages.visual.ts::x: y']);
  });

  it('strips ANSI colour from a line', () => {
    expect(extractFailingTestIds(`\u001b[31m${GATE.slice(P.length + 29)}\u001b[0m`)).toEqual([ID]);
  });

  it('does not read an indented "- Expect" line or a line without ::', () => {
    expect(extractFailingTestIds('      - Expect "toHaveScreenshot(a.png)" with timeout 5000ms')).toEqual([]);
    expect(extractFailingTestIds('- dark pages.visual.ts a title')).toEqual([]);
  });

  it('reads a playwright failure line without tags and with a timing', () => {
    expect(extractFailingTestIds('  12) [light] › tests/x/a.spec.ts:3:9 › suite › leaf name (2.3s)')).toEqual(['light a.spec.ts::leaf name']);
  });

  it('extracts a vitest FAIL line, with and without a project and a timing', () => {
    expect(extractFailingTestIds(' FAIL  src/a.test.ts > suite > does a thing')).toEqual(['vitest src/a.test.ts > suite > does a thing']);
    expect(extractFailingTestIds(' FAIL  |unit| src/a.test.ts > b 12ms')).toEqual(['vitest src/a.test.ts > b']);
  });

  it('does not read a vitest file-level FAIL line without a test name', () => {
    expect(extractFailingTestIds(' FAIL  src/a.test.ts [ src/a.test.ts ]')).toEqual([]);
  });

  it('gives [] for a log with no failing-test line', () => {
    expect(extractFailingTestIds('##[error]Process completed with exit code 1.\nnpm error code 1\n')).toEqual([]);
    expect(extractFailingTestIds('')).toEqual([]);
  });

  it('sorts and removes duplicates', () => {
    const log = ' FAIL  src/b.test.ts > z\n FAIL  src/a.test.ts > y\n FAIL  src/b.test.ts > z\n';
    expect(extractFailingTestIds(log)).toEqual(['vitest src/a.test.ts > y', 'vitest src/b.test.ts > z']);
  });

  it('reads only the bounded tail of a long log', () => {
    const log = ` FAIL  src/old.test.ts > gone\n${'x'.repeat(200_001)}\n FAIL  src/new.test.ts > kept\n`;
    expect(extractFailingTestIds(log)).toEqual(['vitest src/new.test.ts > kept']);
  });
});

describe('isBaseRed', () => {
  it('is true only when the base set holds every PR id', () => {
    expect(isBaseRed(['a'], ['a', 'b'])).toBe(true);
    expect(isBaseRed(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isBaseRed(['a', 'c'], ['a', 'b'])).toBe(false);
  });

  it('is false for an empty PR set', () => {
    expect(isBaseRed([], ['a'])).toBe(false);
  });
});

describe('isBaseRedPattern', () => {
  it('names both marker prefixes and nothing else', () => {
    expect(BASE_RED_PREFIX).toBe('base-red:');
    expect(BASE_RED_WAIT_PREFIX).toBe('base-red-wait:');
    expect(isBaseRedPattern('base-red:develop')).toBe(true);
    expect(isBaseRedPattern('base-red-wait:100')).toBe(true);
    expect(isBaseRedPattern('stale-generated:npm run x')).toBe(false);
    expect(isBaseRedPattern('no-change')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/workflow/baseRedCi.test.ts`
Expected: FAIL (`Cannot find module './baseRedCi.js'`).

- [ ] **Step 3: Export `clean` from `staleGeneratedCi.ts`**

Change `function clean(line: string): string {` to:

```ts
/** One log line as plain text: no ANSI, no gh `<job>\t<step>\t` prefix, no timestamp, no `##[error]` annotation. */
export function clean(line: string): string {
```

- [ ] **Step 4: Write the implementation**

```ts
// src/workflow/baseRedCi.ts
import { clean } from './staleGeneratedCi.js';
import { MAX_CI_LOG_CHARS } from './transientCi.js';

/**
 * Base red (T1383, @arch:AP-12): the failing test ids of a CI job log, as a closed, normalized set. A PR check whose ids are
 * all in the ids of a failed develop push run of the same job failed the same way on develop.
 *
 * The log is untrusted data: it is bounded, read as text, and only matched against the three closed patterns below.
 */

/** Prefix of `autopilot_reruns.pattern` for a rebase marker (keyed by the PR run): `base-red:<base>`. */
export const BASE_RED_PREFIX = 'base-red:';
/** Prefix of `autopilot_reruns.pattern` for a wait row (keyed by the develop run): `base-red-wait:<pr run id>`. */
export const BASE_RED_WAIT_PREFIX = 'base-red-wait:';

/** `- <project> <file>::<title>` of `visual-sweep-gate.mjs` (console form, or the backticked comment form). */
const GATE_LINE = /^- `?([\w-]+)`? (\S+?)::(.+)$/;
/** The diff tail of a gate line. The title itself holds `: `, so only these two tails are cut, at the end. */
const GATE_TAIL = /: (?:\d+ pixels\b.*|diff size unavailable)$/;
/** `<n>) [<project>] › <path>:<line>:<col> › … › <leaf>` of the playwright failure list. */
const LIST_LINE = /^\d+\) \[([\w-]+)\] › (\S+?):\d+:\d+ › (.+)$/;
const TAGS = /(?:\s+@\S+)+\s*$/;
const TIMING = /\s+\(\d+(?:\.\d+)?m?s\)\s*$/;
/** `FAIL [|project|] <file> > <name>` of vitest. */
const VITEST_LINE = /^FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function idOf(line: string): string | null {
  const gate = GATE_LINE.exec(line);
  if (gate) return `${gate[1]} ${basename(gate[2]!)}::${gate[3]!.replace(GATE_TAIL, '').trim()}`;
  const list = LIST_LINE.exec(line);
  if (list) {
    const segments = list[3]!.split(' › ');
    const leaf = segments[segments.length - 1]!.replace(TIMING, '').replace(TAGS, '').trim();
    return `${list[1]} ${basename(list[2]!)}::${leaf}`;
  }
  const vitest = VITEST_LINE.exec(line);
  if (vitest) return `vitest ${vitest[1]} > ${vitest[2]!.trim()}`;
  return null;
}

/** The sorted, unique failing test ids of a job log. Empty when no line matches: the check is then not classified. */
export function extractFailingTestIds(log: string): string[] {
  const tail = log.length > MAX_CI_LOG_CHARS ? log.slice(-MAX_CI_LOG_CHARS) : log;
  const ids = new Set<string>();
  for (const raw of tail.split('\n')) {
    const id = idOf(clean(raw));
    if (id !== null) ids.add(id);
  }
  return [...ids].sort();
}

/** True when the PR set is not empty and every PR id is in the base set. */
export function isBaseRed(prIds: readonly string[], baseIds: readonly string[]): boolean {
  if (prIds.length === 0) return false;
  const base = new Set(baseIds);
  return prIds.every((id) => base.has(id));
}

/** A marker of this step (rebase or wait): the transient and no-change steps do not read it. */
export function isBaseRedPattern(pattern: string): boolean {
  return pattern.startsWith(BASE_RED_PREFIX) || pattern.startsWith(BASE_RED_WAIT_PREFIX);
}
```

Note: `clean()` calls `.trim()`, so the leading spaces of `  1) [dark] …` and ` FAIL  …` go away before the match. The indented `- Expect …` line becomes `- Expect "…"`; it has no `::`, so `GATE_LINE` does not match it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/workflow/baseRedCi.test.ts src/workflow/staleGeneratedCi.test.ts`
Expected: PASS. If the ANSI test fails because of the slice offset, compute the slice so that it starts at `- dark` (fix the test input, not the regex).

- [ ] **Step 6: Commit**

```bash
git add src/workflow/baseRedCi.ts src/workflow/baseRedCi.test.ts src/workflow/staleGeneratedCi.ts
git commit -m "feat: extract a closed set of failing test ids from a CI job log (base red)"
```

---

### Task 2: Store markers for the base-red step

**Files:**
- Modify: `src/store/autopilot.ts` (after `markStaleRebaseStopped`, ~line 351)
- Test: `src/store/autopilot.test.ts`

**Interfaces:**
- Consumes: `markAutopilotRerun`, table `autopilot_reruns`.
- Produces:
  - `export interface BaseRedRun { readonly runId: string; readonly base: string; readonly stopped: boolean; readonly rerunAt: number }`
  - `export function baseRedRuns(store: Store, ticketId: number, repo: string, checkName: string): BaseRedRun[]`
  - `export function markBaseRedStopped(store: Store, ticketId: number, repo: string, runId: string, checkName: string): void`
  - `export interface BaseRedWait { readonly repo: string; readonly baseRunId: string; readonly checkName: string; readonly prRunId: string; readonly headSha: string; readonly at: number }`
  - `export function markBaseRedWait(store: Store, ticketId: number, w: BaseRedWait): boolean`
  - `export function baseRedWaitStart(store: Store, ticketId: number, repo: string, checkName: string, prRunId: string): number | null`

The store does not import `src/workflow/` (layer rule). The SQL holds the literals `'base-red:%'` and `'base-red-wait:'`, as `staleRebaseRuns` holds `'stale-generated:%'`.

- [ ] **Step 1: Write the failing test**

Append to `src/store/autopilot.test.ts` (reuse its `store`/`id` setup; add the imports to its import line):

```ts
describe('base-red markers (T1383)', () => {
  const row = (runId: string, pattern: string, at = 1) =>
    markAutopilotRerun(store, id, { repo: 'r', runId, checkName: 'V', headSha: 'h', pattern, rerunAt: at });

  it('reads only base-red rebase markers, with the base and the stopped flag', () => {
    row('100', 'base-red:develop', 5);
    row('101', 'stale-generated:npm run x');
    row('900', 'base-red-wait:100');
    expect(baseRedRuns(store, id, 'r', 'V')).toEqual([{ runId: '100', base: 'develop', stopped: false, rerunAt: 5 }]);
    markBaseRedStopped(store, id, 'r', '100', 'V');
    markBaseRedStopped(store, id, 'r', '100', 'V');
    expect(baseRedRuns(store, id, 'r', 'V')).toEqual([{ runId: '100', base: 'develop', stopped: true, rerunAt: 5 }]);
    expect(getAutopilotRerun(store, id, 'r', '100', 'V')?.pattern).toBe('base-red:develop (stopped)');
  });

  it('does not let staleRebaseRuns read a base-red row or tag it stopped', () => {
    row('100', 'base-red:develop');
    expect(staleRebaseRuns(store, id, 'r', 'V')).toEqual([]);
    markStaleRebaseStopped(store, id, 'r', '100', 'V');
    expect(getAutopilotRerun(store, id, 'r', '100', 'V')?.pattern).toBe('base-red:develop');
  });

  it('writes one wait row per develop run and gives the earliest start of a PR run', () => {
    const w = { repo: 'r', checkName: 'V', prRunId: '100', headSha: 'h' };
    expect(markBaseRedWait(store, id, { ...w, baseRunId: '900', at: 10 })).toBe(true);
    expect(markBaseRedWait(store, id, { ...w, baseRunId: '900', at: 20 })).toBe(false);
    expect(markBaseRedWait(store, id, { ...w, baseRunId: '901', at: 30 })).toBe(true);
    expect(baseRedWaitStart(store, id, 'r', 'V', '100')).toBe(10);
    expect(baseRedWaitStart(store, id, 'r', 'V', '555')).toBeNull();
    expect(baseRedWaitStart(store, id, 'r', 'other', '100')).toBeNull();
    expect(getAutopilotRerun(store, id, 'r', '900', 'V')?.pattern).toBe('base-red-wait:100');
  });

  it('keeps a wait row apart from the rebase marker of the PR run', () => {
    markBaseRedWait(store, id, { repo: 'r', baseRunId: '900', checkName: 'V', prRunId: '100', headSha: 'h', at: 1 });
    expect(row('100', 'base-red:develop')).toBe(true);
    expect(baseRedRuns(store, id, 'r', 'V').map((r) => r.runId)).toEqual(['100']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run -s rebuild:node` (only if the ABI is not built), then `npx vitest run src/store/autopilot.test.ts`
Expected: FAIL (the four functions are not exported).

- [ ] **Step 3: Write the implementation**

Insert after `markStaleRebaseStopped` in `src/store/autopilot.ts`:

```ts
/** A rebase marker of the base-red step (T1383, @arch:AP-12): its PR run id, the base it named, and whether it stopped with no push. */
export interface BaseRedRun { readonly runId: string; readonly base: string; readonly stopped: boolean; readonly rerunAt: number }

const BASE_RED_REBASE = 'base-red:';

/** The PR runs on which the base-red step rebased this check. A wait row (`base-red-wait:`) is not read. */
export function baseRedRuns(store: Store, ticketId: number, repo: string, checkName: string): BaseRedRun[] {
  const rows = store.db
    .prepare("SELECT run_id, pattern, rerun_at FROM autopilot_reruns WHERE ticket_id = ? AND repo = ? AND check_name = ? AND pattern LIKE 'base-red:%'")
    .all(ticketId, repo, checkName) as Array<{ run_id: string; pattern: string; rerun_at: number }>;
  return rows.map((r) => {
    const stopped = r.pattern.endsWith(STALE_STOPPED_SUFFIX);
    const base = r.pattern.slice(BASE_RED_REBASE.length, stopped ? -STALE_STOPPED_SUFFIX.length : undefined);
    return { runId: r.run_id, base, stopped, rerunAt: r.rerun_at };
  });
}

/** Tag the marker of a base-red rebase that stopped with no push, so the next tick does not wait on that run. */
export function markBaseRedStopped(store: Store, ticketId: number, repo: string, runId: string, checkName: string): void {
  store.db
    .prepare("UPDATE autopilot_reruns SET pattern = pattern || ? WHERE ticket_id = ? AND repo = ? AND run_id = ? AND check_name = ? AND pattern LIKE 'base-red:%' AND pattern NOT LIKE '%' || ?")
    .run(STALE_STOPPED_SUFFIX, ticketId, repo, runId, checkName, STALE_STOPPED_SUFFIX);
}

/** One wait of the base-red step: keyed by the DEVELOP run, so it never takes the key of the rebase marker on the PR run. */
export interface BaseRedWait {
  readonly repo: string;
  readonly baseRunId: string;
  readonly checkName: string;
  readonly prRunId: string;
  readonly headSha: string;
  readonly at: number;
}

/** Record a wait for a red base. False when this (check, develop run) already has one: the caller writes no second event. */
export function markBaseRedWait(store: Store, ticketId: number, w: BaseRedWait): boolean {
  return markAutopilotRerun(store, ticketId, {
    repo: w.repo, runId: w.baseRunId, checkName: w.checkName, headSha: w.headSha, pattern: `base-red-wait:${w.prRunId}`, rerunAt: w.at,
  });
}

/** When the first wait for this check on this PR run started, or null. */
export function baseRedWaitStart(store: Store, ticketId: number, repo: string, checkName: string, prRunId: string): number | null {
  const row = store.db
    .prepare('SELECT MIN(rerun_at) AS at FROM autopilot_reruns WHERE ticket_id = ? AND repo = ? AND check_name = ? AND pattern = ?')
    .get(ticketId, repo, checkName, `base-red-wait:${prRunId}`) as { at: number | null };
  return row.at;
}
```

`STALE_STOPPED_SUFFIX` is already defined above `staleRebaseRuns`; reuse it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/autopilot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/autopilot.ts src/store/autopilot.test.ts
git commit -m "feat: store the rebase and wait markers of the base-red step"
```

---

### Task 3: gh seams for develop runs

**Files:**
- Modify: `src/integrations/ciRerun.ts`
- Test: `src/integrations/ciRerun.test.ts` (create it if it does not exist; check with `ls src/integrations/ciRerun*.test.ts`)

**Interfaces:**
- Consumes: `GhRunner` (`./github.js`), `CheckUrl`, `parseCheckUrl`, `MAX_CI_LOG_CHARS` (`../workflow/transientCi.js`), `extractFailingTestIds` (`../workflow/baseRedCi.js`), `readJobLog`, `readRunHeadSha` (same file).
- Produces:
  - `export interface BaseRun { readonly runId: string; readonly headSha: string; readonly conclusion: string }`
  - `export const BASE_RUN_LIMIT = 20`
  - `export async function readRunWorkflowId(gh: GhRunner, cwd: string, c: CheckUrl): Promise<string>`
  - `export async function listBaseRuns(gh: GhRunner, cwd: string, c: CheckUrl, workflowId: string, base: string): Promise<BaseRun[]>` (newest first, completed only)
  - `export async function readRunJobByName(gh: GhRunner, cwd: string, c: CheckUrl, runId: string, jobName: string): Promise<CheckUrl | null>`
  - `export async function commitInHead(gh: GhRunner, cwd: string, c: CheckUrl, commit: string, head: string): Promise<boolean>`
  - `export interface BaseRedSeams` (see code) and `export function makeBaseRedSeams(gh: GhRunner, rebase: (repo: string) => Promise<boolean>): BaseRedSeams`

`BaseRedSeams` lives here (not in the ops file), so the binding and the step share one type without an ops → integrations type cycle. The ops step imports the type.

- [ ] **Step 1: Write the failing test**

```ts
// src/integrations/ciRerun.test.ts (add a describe if the file exists)
import { describe, expect, it, vi } from 'vitest';
import type { GhRunner } from './github.js';
import { BASE_RUN_LIMIT, commitInHead, listBaseRuns, makeBaseRedSeams, readRunJobByName, readRunWorkflowId } from './ciRerun.js';

const C = { owner: 'o', repo: 'r', runId: '100', jobId: '200' };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const ghOf = (...outs: Array<{ exitCode: number; stdout: string; stderr: string }>) => {
  const gh = vi.fn(async () => outs.shift() ?? ok(''));
  return gh as unknown as GhRunner & ReturnType<typeof vi.fn>;
};

describe('readRunWorkflowId', () => {
  it('reads the workflow id of the run', async () => {
    const gh = ghOf(ok('4242\n'));
    await expect(readRunWorkflowId(gh, '/w', C)).resolves.toBe('4242');
    expect(gh).toHaveBeenCalledWith(['api', 'repos/o/r/actions/runs/100', '--jq', '.workflow_id'], '/w');
  });
  it('throws on a gh failure or a value that is not digits', async () => {
    await expect(readRunWorkflowId(ghOf({ exitCode: 1, stdout: '', stderr: 'boom' }), '/w', C)).rejects.toThrow('reading the run workflow failed (gh exit 1: boom)');
    await expect(readRunWorkflowId(ghOf(ok('null')), '/w', C)).rejects.toThrow('gh named no workflow');
  });
});

describe('listBaseRuns', () => {
  it('lists the completed push runs of the workflow on the base, newest first', async () => {
    const json = JSON.stringify([
      { databaseId: 2, headSha: SHA_B, conclusion: 'success' },
      { databaseId: 1, headSha: SHA_A, conclusion: 'failure' },
    ]);
    const gh = ghOf(ok(json));
    await expect(listBaseRuns(gh, '/w', C, '4242', 'develop')).resolves.toEqual([
      { runId: '2', headSha: SHA_B, conclusion: 'success' },
      { runId: '1', headSha: SHA_A, conclusion: 'failure' },
    ]);
    expect(gh).toHaveBeenCalledWith([
      'run', 'list', '--repo', 'o/r', '--branch', 'develop', '--event', 'push', '--workflow', '4242', '--status', 'completed',
      '--limit', String(BASE_RUN_LIMIT), '--json', 'databaseId,headSha,conclusion',
    ], '/w');
  });
  it('refuses an unsafe base name before gh runs', async () => {
    for (const base of ['-x', 'a..b', 'a b', '']) {
      const gh = ghOf();
      await expect(listBaseRuns(gh, '/w', C, '1', base)).rejects.toThrow('unsafe base branch name');
      expect(gh).not.toHaveBeenCalled();
    }
  });
  it('throws on a bad shape', async () => {
    await expect(listBaseRuns(ghOf(ok('{}')), '/w', C, '1', 'develop')).rejects.toThrow('listing the base runs failed (gh gave an unknown shape)');
    await expect(listBaseRuns(ghOf(ok('[{"databaseId":"x","headSha":"a","conclusion":"failure"}]')), '/w', C, '1', 'develop')).rejects.toThrow('unknown shape');
    await expect(listBaseRuns(ghOf(ok('not json')), '/w', C, '1', 'develop')).rejects.toThrow('unknown shape');
  });
});

describe('readRunJobByName', () => {
  it('gives the job url of the job with that name, or null', async () => {
    const jobs = JSON.stringify({ jobs: [{ name: 'Other', url: 'https://github.com/o/r/actions/runs/7/job/1' }, { name: 'Visual', url: 'https://github.com/o/r/actions/runs/7/job/9' }] });
    const gh = ghOf(ok(jobs), ok(jobs));
    await expect(readRunJobByName(gh, '/w', C, '7', 'Visual')).resolves.toEqual({ owner: 'o', repo: 'r', runId: '7', jobId: '9' });
    expect(gh).toHaveBeenCalledWith(['run', 'view', '7', '--repo', 'o/r', '--json', 'jobs'], '/w');
    await expect(readRunJobByName(gh, '/w', C, '7', 'Missing')).resolves.toBeNull();
  });
  it('throws on a run id that is not digits, or a bad shape', async () => {
    await expect(readRunJobByName(ghOf(), '/w', C, '7;x', 'V')).rejects.toThrow('unsafe run id');
    await expect(readRunJobByName(ghOf(ok('[]')), '/w', C, '7', 'V')).rejects.toThrow('reading the base run jobs failed (gh gave an unknown shape)');
  });
});

describe('commitInHead', () => {
  it('is true for ahead and identical, false for behind and diverged', async () => {
    for (const [status, want] of [['ahead', true], ['identical', true], ['behind', false], ['diverged', false]] as const) {
      const gh = ghOf(ok(`${status}\n`));
      await expect(commitInHead(gh, '/w', C, SHA_A, SHA_B)).resolves.toBe(want);
      expect(gh).toHaveBeenCalledWith(['api', `repos/o/r/compare/${SHA_A}...${SHA_B}`, '--jq', '.status'], '/w');
    }
  });
  it('throws on another status or a sha that is not 40 hex', async () => {
    await expect(commitInHead(ghOf(ok('weird')), '/w', C, SHA_A, SHA_B)).rejects.toThrow('comparing the base commit failed (gh named no status)');
    await expect(commitInHead(ghOf(), '/w', C, 'xyz', SHA_B)).rejects.toThrow('unsafe sha');
  });
});

describe('makeBaseRedSeams', () => {
  it('memoizes the ids of a develop job and does not memoize a throw', async () => {
    const jobs = JSON.stringify({ jobs: [{ name: 'V', url: 'https://github.com/o/r/actions/runs/7/job/9' }] });
    const gh = ghOf({ exitCode: 1, stdout: '', stderr: 'net' }, ok(jobs), ok(' FAIL  src/a.test.ts > b\n'));
    const s = makeBaseRedSeams(gh, async () => true);
    await expect(s.baseRunIds('/w', C, '7', 'V')).rejects.toThrow();
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toEqual(['vitest src/a.test.ts > b']);
    expect(gh).toHaveBeenCalledTimes(3);
  });
  it('gives null for a run without that job', async () => {
    const s = makeBaseRedSeams(ghOf(ok(JSON.stringify({ jobs: [] }))), async () => true);
    await expect(s.baseRunIds('/w', C, '7', 'V')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/integrations/ciRerun.test.ts`
Expected: FAIL (the new functions are not exported).

- [ ] **Step 3: Write the implementation**

Append to `src/integrations/ciRerun.ts` (update the imports: add `parseCheckUrl` from `../workflow/transientCi.js` and `extractFailingTestIds` from `../workflow/baseRedCi.js`):

```ts
/** The newest develop runs read per check (T1383, @arch:AP-12). */
export const BASE_RUN_LIMIT = 20;
/** The develop job ids kept in memory: a completed run never changes, so a red develop is not read again on every probe. */
const MAX_MEMO = 200;
const BASE_RE = /^[A-Za-z0-9._/-]+$/;
const RUN_ID_RE = /^\d+$/;

/** One completed push run of a workflow on the base branch. */
export interface BaseRun { readonly runId: string; readonly headSha: string; readonly conclusion: string }

/** The workflow id of a run (digits). */
export async function readRunWorkflowId(gh: GhRunner, cwd: string, c: CheckUrl): Promise<string> {
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/actions/runs/${c.runId}`, '--jq', '.workflow_id'], cwd);
  if (r.exitCode !== 0) fail('reading the run workflow', r.stderr, r.exitCode);
  const id = r.stdout.trim();
  if (!RUN_ID_RE.test(id)) throw new Error('reading the run workflow failed (gh named no workflow)');
  return id;
}

function isBaseRunRow(x: unknown): x is { databaseId: number; headSha: string; conclusion: string } {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return Number.isSafeInteger(o.databaseId) && typeof o.headSha === 'string' && SHA_RE.test(o.headSha) && typeof o.conclusion === 'string';
}

function parseJson(stdout: string, what: string): unknown {
  try { return JSON.parse(stdout); } catch { throw new Error(`${what} failed (gh gave an unknown shape)`); }
}

/** The newest completed push runs of the workflow on `base`, newest first (gh's order). */
export async function listBaseRuns(gh: GhRunner, cwd: string, c: CheckUrl, workflowId: string, base: string): Promise<BaseRun[]> {
  if (!BASE_RE.test(base) || base.startsWith('-') || base.includes('..')) throw new Error('listing the base runs failed (unsafe base branch name)');
  if (!RUN_ID_RE.test(workflowId)) throw new Error('listing the base runs failed (unsafe workflow id)');
  const r = await gh([
    'run', 'list', '--repo', `${c.owner}/${c.repo}`, '--branch', base, '--event', 'push', '--workflow', workflowId, '--status', 'completed',
    '--limit', String(BASE_RUN_LIMIT), '--json', 'databaseId,headSha,conclusion',
  ], cwd);
  if (r.exitCode !== 0) fail('listing the base runs', r.stderr, r.exitCode);
  const rows = parseJson(r.stdout, 'listing the base runs');
  if (!Array.isArray(rows) || !rows.every(isBaseRunRow)) throw new Error('listing the base runs failed (gh gave an unknown shape)');
  return rows.map((x) => ({ runId: String(x.databaseId), headSha: x.headSha, conclusion: x.conclusion }));
}

/** The job of a run that has this name, as a check url, or null when the run has no such job. */
export async function readRunJobByName(gh: GhRunner, cwd: string, c: CheckUrl, runId: string, jobName: string): Promise<CheckUrl | null> {
  if (!RUN_ID_RE.test(runId)) throw new Error('reading the base run jobs failed (unsafe run id)');
  const r = await gh(['run', 'view', runId, '--repo', `${c.owner}/${c.repo}`, '--json', 'jobs'], cwd);
  if (r.exitCode !== 0) fail('reading the base run jobs', r.stderr, r.exitCode);
  const body = parseJson(r.stdout, 'reading the base run jobs') as { jobs?: unknown };
  if (typeof body !== 'object' || body === null || !Array.isArray(body.jobs)) throw new Error('reading the base run jobs failed (gh gave an unknown shape)');
  const job = (body.jobs as Array<{ name?: unknown; url?: unknown }>).find((j) => j?.name === jobName);
  return job !== undefined && typeof job.url === 'string' ? parseCheckUrl(job.url) : null;
}

/** True when `commit` is in the history of `head` (GitHub compare status `ahead` or `identical`). */
export async function commitInHead(gh: GhRunner, cwd: string, c: CheckUrl, commit: string, head: string): Promise<boolean> {
  if (!SHA_RE.test(commit) || !SHA_RE.test(head)) throw new Error('comparing the base commit failed (unsafe sha)');
  const r = await gh(['api', `repos/${c.owner}/${c.repo}/compare/${commit}...${head}`, '--jq', '.status'], cwd);
  if (r.exitCode !== 0) fail('comparing the base commit', r.stderr, r.exitCode);
  const status = r.stdout.trim();
  if (status === 'ahead' || status === 'identical') return true;
  if (status === 'behind' || status === 'diverged') return false;
  throw new Error('comparing the base commit failed (gh named no status)');
}

/** The seams of the base-red step (T1383, @arch:AP-12). Each throws on a gh failure; the step then gives today's rules. */
export interface BaseRedSeams {
  readonly readJobLog: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly readRunHeadSha: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly readRunWorkflowId: (cwd: string, c: CheckUrl) => Promise<string>;
  readonly listBaseRuns: (cwd: string, c: CheckUrl, workflowId: string, base: string) => Promise<readonly BaseRun[]>;
  /** The failing ids of the job named `jobName` in a develop run; null when the run has no such job. */
  readonly baseRunIds: (cwd: string, c: CheckUrl, runId: string, jobName: string) => Promise<readonly string[] | null>;
  readonly commitInHead: (cwd: string, c: CheckUrl, commit: string, head: string) => Promise<boolean>;
  /** Rebase on base for one repo, with no confirm prompt. True only when it pushed. */
  readonly rebase: (repo: string) => Promise<boolean>;
}

export function makeBaseRedSeams(gh: GhRunner, rebase: (repo: string) => Promise<boolean>): BaseRedSeams {
  const memo = new Map<string, readonly string[] | null>();
  const baseRunIds = async (cwd: string, c: CheckUrl, runId: string, jobName: string): Promise<readonly string[] | null> => {
    const key = `${c.owner}/${c.repo}\0${runId}\0${jobName}`;
    if (memo.has(key)) return memo.get(key)!;
    const job = await readRunJobByName(gh, cwd, c, runId, jobName);
    const ids = job === null ? null : extractFailingTestIds(await readJobLog(gh, cwd, job));
    if (memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value!);
    memo.set(key, ids);
    return ids;
  };
  return {
    readJobLog: (cwd, c) => readJobLog(gh, cwd, c),
    readRunHeadSha: (cwd, c) => readRunHeadSha(gh, cwd, c),
    readRunWorkflowId: (cwd, c) => readRunWorkflowId(gh, cwd, c),
    listBaseRuns: (cwd, c, workflowId, base) => listBaseRuns(gh, cwd, c, workflowId, base),
    baseRunIds,
    commitInHead: (cwd, c, commit, head) => commitInHead(gh, cwd, c, commit, head),
    rebase,
  };
}
```

Check the `GhRunner` call shape: the existing `readRunHeadSha` passes only `(args, cwd)`. If the vitest `toHaveBeenCalledWith` fails because `gh` gets a third `undefined` argument, it does not: these calls pass two arguments. Keep it so.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/integrations/ciRerun.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/ciRerun.ts src/integrations/ciRerun.test.ts
git commit -m "feat: gh seams that list develop push runs and read their failing test ids"
```

---

### Task 4: The base branch on each failing check, and the transient and no-change steps skip base-red markers

**Files:**
- Modify: `src/workflow/ciFailure.ts` (`CiFailurePr`, `OpenPrRow`, `openPrRows`, the `prs.push` at ~line 68)
- Modify: `src/extension/ops/autopilotRerun.ts` (`FailedCheck`, the skip at ~line 59)
- Modify: `src/extension/ops/autopilotNoChange.ts` (the skip at ~line 54)
- Test: `src/workflow/ciFailure.test.ts`, `src/extension/ops/autopilotRerun.test.ts`, `src/extension/ops/autopilotNoChange.test.ts`

**Interfaces:**
- Consumes: `isBaseRedPattern` (Task 1).
- Produces: `CiFailurePr.base?: string | null`; `FailedCheck.base?: string | null`.

- [ ] **Step 1: Write the failing tests**

In `src/workflow/ciFailure.test.ts`, add (adapt the seed helper the file already has; the PR row needs `base_ref`):

```ts
it('carries the base branch of the PR (T1383)', () => {
  // seed one open failing PR the way the other tests of this file do, then:
  store.db.prepare("UPDATE prs SET base_ref = 'develop' WHERE ticket_id = ?").run(id);
  const s = ciFailureState(store, id);
  expect(s.available && s.prs[0]!.base).toBe('develop');
});
```

In `src/extension/ops/autopilotRerun.test.ts`, add (reuse its context helper and its check helper; the check url gives run `100`):

```ts
it('does not count a base-red marker as a network re-run (T1383)', async () => {
  markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: 'h', pattern: 'base-red:develop', rerunAt: 1 });
  // A transient log: the step must try a fresh re-run, but the marker key is taken, so it does not re-run and reports no earlier check.
  const step = await transientRerunStep(/* the file's ctx with a transient log */, [/* check('A') on run 100 */]);
  expect(step).not.toEqual(expect.objectContaining({ earlier: new Set(['A']) }));
});
```

Write the call with the real helper names of that file (read its first 40 lines). The assertion: `earlier` does not hold `'A'`, and the step does not return `{ kind: 'rerun' }` from the settle branch.

In `src/extension/ops/autopilotNoChange.test.ts`, add:

```ts
it('skips a check whose run carries a base-red marker (T1383)', async () => {
  // recorded head equals the run head, and the run has a base-red marker: no re-run, kind none
  setCiRoundHeadSha(store, id, 'r', SHA);
  markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'A', headSha: SHA, pattern: 'base-red:develop', rerunAt: 1 });
  expect(await noChangeStep(/* the file's ctx */, [/* check('A') on run 100 */])).toEqual({ kind: 'none' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workflow/ciFailure.test.ts src/extension/ops/autopilotRerun.test.ts src/extension/ops/autopilotNoChange.test.ts`
Expected: FAIL (`base` is undefined; the rerun step counts the marker as earlier; the no-change step re-runs or stops).

- [ ] **Step 3: Implement**

`src/workflow/ciFailure.ts`:
- In `CiFailurePr`, add `/** The PR's base branch (\`prs.base_ref\`), or null when not known. */ base?: string | null;`.
- In `OpenPrRow`, add `base: string | null;`.
- In the `SELECT` of `openPrRows`, change `SELECT p.repo, p.number, p.url, p.checks,` to `SELECT p.repo, p.number, p.url, p.checks, p.base_ref AS base,`.
- In the `prs.push({...})`, add `base: row.base,`.

`src/extension/ops/autopilotRerun.ts`:
- Change `FailedCheck` to:

```ts
/** One failing check of an open PR: where gh runs, which job failed, and the PR's base branch (null when not known). */
export interface FailedCheck { readonly repo: string; readonly cwd: string; readonly name: string; readonly url: string | null; readonly base?: string | null }
```

- Import `isBaseRedPattern` from `../../workflow/baseRedCi.js`. After the line `if (done?.pattern.startsWith(STALE_PATTERN_PREFIX)) continue;` add:

```ts
    // A base-red rebase or wait (T1383, @arch:AP-12) is not a network re-run either.
    if (done && isBaseRedPattern(done.pattern)) continue;
```

`src/extension/ops/autopilotNoChange.ts`:
- Import `isBaseRedPattern`. Change `if (done?.pattern.startsWith(STALE_PATTERN_PREFIX)) continue;` to:

```ts
    if (done && (done.pattern.startsWith(STALE_PATTERN_PREFIX) || isBaseRedPattern(done.pattern))) continue;
```

and update the comment above it: "A stale rebase or a base-red rebase pushed a new head, so its marker belongs to its own step."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workflow/ciFailure.test.ts src/extension/ops/autopilotRerun.test.ts src/extension/ops/autopilotNoChange.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/ciFailure.ts src/workflow/ciFailure.test.ts src/extension/ops/autopilotRerun.ts src/extension/ops/autopilotRerun.test.ts src/extension/ops/autopilotNoChange.ts src/extension/ops/autopilotNoChange.test.ts
git commit -m "feat: failing checks carry the PR base, and the re-run steps skip base-red markers"
```

---

### Task 5: The base-red step

**Files:**
- Create: `src/extension/ops/autopilotBaseRed.ts`
- Test: `src/extension/ops/autopilotBaseRed.test.ts`

**Interfaces:**
- Consumes: `BaseRedSeams`, `BaseRun` (Task 3); `baseRedRuns`, `markBaseRedStopped`, `markBaseRedWait`, `baseRedWaitStart`, `markAutopilotRerun` (Task 2); `extractFailingTestIds`, `isBaseRed`, `BASE_RED_PREFIX` (Task 1); `STALE_WAIT_MS` (`./autopilotStaleRebase.js`); `FailedCheck` (`./autopilotRerun.js`); `parseCheckUrl`, `CheckUrl`.
- Produces:
  - `export const BASE_RED_WAIT_MS = 24 * 60 * 60_000`
  - `export const MAX_BASE_RED_LOGS = 5`
  - `export interface BaseRedContext { store; ticketId; key; seams: BaseRedSeams; now; note; debug }`
  - `export type BaseRedStep = { kind: 'none'; earlier: ReadonlyMap<string, string> } | { kind: 'rebased' } | { kind: 'waiting' }` (`earlier`: check name → base)
  - `export async function baseRedStep(c: BaseRedContext, fails: readonly FailedCheck[]): Promise<BaseRedStep>`

- [ ] **Step 1: Write the failing test**

```ts
// src/extension/ops/autopilotBaseRed.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { baseRedRuns, getAutopilotRerun, markAutopilotRerun } from '../../store/autopilot.js';
import type { BaseRun } from '../../integrations/ciRerun.js';
import type { FailedCheck } from './autopilotRerun.js';
import { STALE_WAIT_MS } from './autopilotStaleRebase.js';
import { BASE_RED_WAIT_MS, baseRedStep, type BaseRedContext } from './autopilotBaseRed.js';

const PR_HEAD = 'a'.repeat(40);
const RED_SHA = '5d7aef5a5'.padEnd(40, '0');
const GREEN_SHA = 'c'.repeat(40);
const ID = 'dark pages.visual.ts::dashboard/stage-menu-bottom-edge: full-page screenshot';
const PR_LOG = `- ${ID}: 312 pixels (ratio 0.01 of all image pixels) are different\n`;
let store: Store;
let id: number;

const check = (name = 'Visual', repo = 'r', run = '100', base: string | null = 'develop'): FailedCheck => ({
  repo, cwd: `/w/${repo}`, name, base, url: `https://github.com/o/${repo}/actions/runs/${run}/job/200`,
});
const run = (runId: string, conclusion: string, headSha = RED_SHA): BaseRun => ({ runId, headSha, conclusion });

interface Opts {
  prLog?: string | Error;
  runs?: readonly BaseRun[] | Error;
  ids?: Record<string, readonly string[] | null>;
  inHead?: boolean | Error;
  rebase?: boolean;
  now?: number;
}
function ctx(o: Opts = {}) {
  const notes: Array<[string, string]> = [];
  const order: string[] = [];
  const seams = {
    readJobLog: vi.fn(async () => { if (o.prLog instanceof Error) throw o.prLog; return o.prLog ?? PR_LOG; }),
    readRunHeadSha: vi.fn(async () => PR_HEAD),
    readRunWorkflowId: vi.fn(async () => '4242'),
    listBaseRuns: vi.fn(async () => { if (o.runs instanceof Error) throw o.runs; return o.runs ?? [run('2', 'success', GREEN_SHA), run('1', 'failure')]; }),
    baseRunIds: vi.fn(async (_cwd: string, _c: unknown, runId: string) => (o.ids ?? { '1': [ID, 'x'] })[runId] ?? []),
    commitInHead: vi.fn(async () => { if (o.inHead instanceof Error) throw o.inHead; return o.inHead ?? false; }),
    rebase: vi.fn(async (repo: string) => { order.push(`rebase:${repo}`); return o.rebase ?? true; }),
  };
  const c: BaseRedContext = { store, ticketId: id, key: 'AP-1', seams, now: () => o.now ?? 5_000, note: (t, b) => void notes.push([t, b]), debug: vi.fn() };
  return { c, notes, seams, order };
}

beforeEach(() => { store = openStore(':memory:'); id = createTicket(store, { key: 'AP-1', title: 't' }).id; });

describe('baseRedStep', () => {
  it('(a) rebases once when develop failed the same way and is green now, with the marker written first', async () => {
    const x = ctx();
    x.seams.rebase.mockImplementationOnce(async () => {
      expect(getAutopilotRerun(store, id, 'r', '100', 'Visual')?.pattern).toBe('base-red:develop');
      return true;
    });
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'rebased' });
    expect(x.seams.rebase).toHaveBeenCalledTimes(1);
    expect(x.seams.commitInHead).toHaveBeenCalledWith('/w/r', expect.anything(), GREEN_SHA, PR_HEAD);
    expect(x.notes).toEqual([[
      'Autopilot: rebased on base: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc',
      'AP-1: rebased on base: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc in r. It used no attempt.',
    ]]);
  });

  it('rebases each repo once when several checks are base red', async () => {
    const x = ctx();
    expect(await baseRedStep(x.c, [check('Visual'), check('Visual 2')])).toEqual({ kind: 'rebased' });
    expect(x.seams.rebase).toHaveBeenCalledTimes(1);
    expect(x.notes).toHaveLength(2);
  });

  it('tags the marker stopped and gives none with the check in earlier when the rebase pushed nothing', async () => {
    const x = ctx({ rebase: false });
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
    expect(baseRedRuns(store, id, 'r', 'Visual')).toEqual([{ runId: '100', base: 'develop', stopped: true, rerunAt: 5_000 }]);
    expect(x.notes[0]![0]).toBe('Autopilot: rebase on base stopped: Visual failed on develop too (5d7aef5a5) and develop is green at ccccccccc');
  });

  it('(b) waits with no rebase while develop is red with the same ids, and writes one event per develop run', async () => {
    const red = { runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': [ID], '1': [ID] } };
    const first = ctx(red);
    expect(await baseRedStep(first.c, [check()])).toEqual({ kind: 'waiting' });
    expect(first.seams.rebase).not.toHaveBeenCalled();
    expect(first.notes.map((n) => n[0])).toEqual(['Autopilot: waiting for a green develop: Visual fails there too']);
    const second = ctx(red);
    expect(await baseRedStep(second.c, [check()])).toEqual({ kind: 'waiting' });
    expect(second.notes).toEqual([]);
    const newer = ctx({ runs: [run('4', 'failure'), run('1', 'failure')], ids: { '4': [ID], '1': [ID] } });
    expect(await baseRedStep(newer.c, [check()])).toEqual({ kind: 'waiting' });
    expect(newer.notes).toHaveLength(1);
  });

  it('(c) gives none when one failing check is not base red', async () => {
    const x = ctx();
    x.seams.readJobLog.mockImplementation(async (_cwd: string, c: { runId: string }) => (c.runId === '100' ? PR_LOG : ' FAIL  src/own.test.ts > breaks\n'));
    expect(await baseRedStep(x.c, [check('Visual'), check('Unit', 'r', '101')])).toEqual({ kind: 'none', earlier: new Map() });
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('gives none when a PR id is missing from the develop ids, or no id was extracted', async () => {
    expect((await baseRedStep(ctx({ ids: { '1': ['other'] } }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ prLog: 'npm error\n' }).c, [check()])).kind).toBe('none');
  });

  it('gives none when the newest develop run was cancelled or failed with other ids', async () => {
    expect((await baseRedStep(ctx({ runs: [run('3', 'cancelled'), run('1', 'failure')] }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': ['other'], '1': [ID] } }).c, [check()])).kind).toBe('none');
  });

  it('gives none when the green develop commit is already in the PR head', async () => {
    const x = ctx({ inHead: true });
    expect((await baseRedStep(x.c, [check()])).kind).toBe('none');
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('gives none when one develop is green and in the head and another is red', async () => {
    const x = ctx({ inHead: true });
    x.seams.listBaseRuns.mockImplementation(async (_cwd: string, c: { runId: string }) =>
      (c.runId === '100' ? [run('2', 'success', GREEN_SHA), run('1', 'failure')] : [run('5', 'failure'), run('1', 'failure')]));
    x.seams.baseRunIds.mockImplementation(async () => [ID]);
    expect((await baseRedStep(x.c, [check('Visual'), check('Other', 'r', '101')])).kind).toBe('none');
  });

  it('waits and does not rebase when one develop is green and another is still red', async () => {
    const x = ctx();
    x.seams.listBaseRuns.mockImplementation(async (_cwd: string, c: { runId: string }) =>
      (c.runId === '100' ? [run('2', 'success', GREEN_SHA), run('1', 'failure')] : [run('5', 'failure'), run('1', 'failure')]));
    x.seams.baseRunIds.mockImplementation(async () => [ID]);
    expect(await baseRedStep(x.c, [check('Visual'), check('Other', 'r', '101')])).toEqual({ kind: 'waiting' });
    expect(x.seams.rebase).not.toHaveBeenCalled();
  });

  it('(d) gives none with the check in earlier when a marker is on an earlier run', async () => {
    markAutopilotRerun(store, id, { repo: 'r', runId: '99', checkName: 'Visual', headSha: PR_HEAD, pattern: 'base-red:develop', rerunAt: 1 });
    const x = ctx();
    expect(await baseRedStep(x.c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
    expect(x.seams.readJobLog).not.toHaveBeenCalled();
  });

  it('waits on a marker of the current run inside STALE_WAIT_MS, and not after it', async () => {
    markAutopilotRerun(store, id, { repo: 'r', runId: '100', checkName: 'Visual', headSha: PR_HEAD, pattern: 'base-red:develop', rerunAt: 1_000 });
    expect(await baseRedStep(ctx({ now: 1_000 + STALE_WAIT_MS - 1 }).c, [check()])).toEqual({ kind: 'rebased' });
    expect(await baseRedStep(ctx({ now: 1_000 + STALE_WAIT_MS }).c, [check()])).toEqual({ kind: 'none', earlier: new Map([['Visual', 'develop']]) });
  });

  it('(e) gives none on any gh error and never reads it as base red', async () => {
    expect((await baseRedStep(ctx({ prLog: new Error('gh') }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ runs: new Error('gh') }).c, [check()])).kind).toBe('none');
    expect((await baseRedStep(ctx({ inHead: new Error('gh') }).c, [check()])).kind).toBe('none');
    const x = ctx();
    x.seams.baseRunIds.mockRejectedValue(new Error('gh'));
    expect((await baseRedStep(x.c, [check()])).kind).toBe('none');
  });

  it('(f) stops waiting for a red develop after 24 hours', async () => {
    const red = { runs: [run('3', 'failure'), run('1', 'failure')], ids: { '3': [ID], '1': [ID] } };
    expect(await baseRedStep(ctx({ ...red, now: 1_000 }).c, [check()])).toEqual({ kind: 'waiting' });
    expect(await baseRedStep(ctx({ ...red, now: 1_000 + BASE_RED_WAIT_MS - 1 }).c, [check()])).toEqual({ kind: 'waiting' });
    const late = ctx({ ...red, now: 1_000 + BASE_RED_WAIT_MS });
    expect(await baseRedStep(late.c, [check()])).toEqual({ kind: 'none', earlier: new Map() });
    expect(late.seams.listBaseRuns).not.toHaveBeenCalled();
  });

  it('gives none for a check without a job url or without a base, and for no failing check', async () => {
    expect((await baseRedStep(ctx().c, [{ ...check(), url: null }])).kind).toBe('none');
    expect((await baseRedStep(ctx().c, [check('Visual', 'r', '100', null)])).kind).toBe('none');
    expect((await baseRedStep(ctx().c, [])).kind).toBe('none');
  });

  it('reads at most MAX_BASE_RED_LOGS failed develop runs and stops at the first proof', async () => {
    const runs = [run('9', 'success', GREEN_SHA), ...['8', '7', '6', '5', '4', '3'].map((r) => run(r, 'failure'))];
    const none = ctx({ runs, ids: {} });
    expect((await baseRedStep(none.c, [check()])).kind).toBe('none');
    expect(none.seams.baseRunIds).toHaveBeenCalledTimes(5);
    const hit = ctx({ runs, ids: { '8': [ID] } });
    expect((await baseRedStep(hit.c, [check()])).kind).toBe('rebased');
    expect(hit.seams.baseRunIds).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/extension/ops/autopilotBaseRed.test.ts`
Expected: FAIL (`Cannot find module './autopilotBaseRed.js'`).

- [ ] **Step 3: Write the implementation**

```ts
// src/extension/ops/autopilotBaseRed.ts
import type { Store } from '../../store/db.js';
import { baseRedRuns, baseRedWaitStart, markAutopilotRerun, markBaseRedStopped, markBaseRedWait } from '../../store/autopilot.js';
import type { BaseRedSeams, BaseRun } from '../../integrations/ciRerun.js';
import { BASE_RED_PREFIX, extractFailingTestIds, isBaseRed } from '../../workflow/baseRedCi.js';
import { parseCheckUrl, type CheckUrl } from '../../workflow/transientCi.js';
import { STALE_WAIT_MS } from './autopilotStaleRebase.js';
import type { FailedCheck } from './autopilotRerun.js';

/**
 * Base red (T1383, @arch:AP-12): when EVERY failing check of the open PRs failed on test ids that a failed develop push run of
 * the same job also failed, the failure is not the ticket's. A green develop that the PR does not hold yet gets one Rebase on
 * base per repo; a develop that is still red makes the ticket wait, with no park. No attempt, no agent round, no PR re-run.
 */

/** How long the ticket waits for a red develop on one PR run. Then today's rules apply. */
export const BASE_RED_WAIT_MS = 24 * 60 * 60_000;
/** The failed develop runs whose job log is read per check, newest first. */
export const MAX_BASE_RED_LOGS = 5;

export interface BaseRedContext {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly seams: BaseRedSeams;
  readonly now: () => number;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
}

export type BaseRedStep =
  /** Today's rules apply. `earlier` maps each check that was rebased before and failed again to the base it named. */
  | { readonly kind: 'none'; readonly earlier: ReadonlyMap<string, string> }
  /** A rebase ran, or a rebase of the current run is still in its wait: the ticket waits for the next probe. */
  | { readonly kind: 'rebased' }
  /** Develop is still red with the same ids: no round, no park, no attempt. */
  | { readonly kind: 'waiting' };

interface Proof {
  readonly target: FailedCheck;
  readonly url: CheckUrl;
  readonly base: string;
  readonly prHead: string;
  /** The failed develop run whose ids hold every PR id. */
  readonly red: BaseRun;
  /** The newest completed develop run. */
  readonly newest: BaseRun;
  readonly state: 'green' | 'green-in-head' | 'red';
}

const NONE: BaseRedStep = { kind: 'none', earlier: new Map() };
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function baseRedStep(c: BaseRedContext, fails: readonly FailedCheck[]): Promise<BaseRedStep> {
  const marked = markerState(c, fails);
  if (marked !== null) return marked;
  if (fails.length === 0) return NONE;
  const proofs: Proof[] = [];
  for (const target of fails) {
    const url = parseCheckUrl(target.url);
    if (!url || !target.base) return NONE;
    const since = baseRedWaitStart(c.store, c.ticketId, target.repo, target.name, url.runId);
    if (since !== null && c.now() - since >= BASE_RED_WAIT_MS) return NONE;
    let proof: Proof | null;
    // A gh failure is never base red: today's rules apply, and the transient step reports the error.
    try { proof = await prove(c, target, url, target.base); } catch (err) {
      c.debug(`[ship] autopilot ticket ${c.key} ci: base-red check of ${target.name} not read (${messageOf(err)})`);
      return NONE;
    }
    if (proof === null) return NONE;
    proofs.push(proof);
  }
  if (proofs.some((p) => p.state === 'green-in-head')) return NONE;
  if (proofs.some((p) => p.state === 'red')) {
    for (const p of proofs) if (p.state === 'red') noteWait(c, p);
    return { kind: 'waiting' };
  }
  return rebaseRepos(c, proofs);
}

/** A rebase marker decides alone: on the current run (pushed, inside STALE_WAIT_MS) the ticket waits; on an earlier run, today's rules. */
function markerState(c: BaseRedContext, fails: readonly FailedCheck[]): BaseRedStep | null {
  const earlier = new Map<string, string>();
  let waiting = false;
  for (const f of fails) {
    const runs = baseRedRuns(c.store, c.ticketId, f.repo, f.name);
    if (runs.length === 0) continue;
    const runId = parseCheckUrl(f.url)?.runId ?? '';
    if (runs.some((r) => r.runId === runId && !r.stopped && c.now() - r.rerunAt < STALE_WAIT_MS)) waiting = true;
    else earlier.set(f.name, runs[0]!.base);
  }
  if (earlier.size > 0) return { kind: 'none', earlier };
  return waiting ? { kind: 'rebased' } : null;
}

/** The proof that this check failed the same way on develop, and the state of the newest develop run. Null: not base red. */
async function prove(c: BaseRedContext, target: FailedCheck, url: CheckUrl, base: string): Promise<Proof | null> {
  const prIds = extractFailingTestIds(await c.seams.readJobLog(target.cwd, url));
  if (prIds.length === 0) return null;
  const workflowId = await c.seams.readRunWorkflowId(target.cwd, url);
  const runs = await c.seams.listBaseRuns(target.cwd, url, workflowId, base);
  const newest = runs[0];
  if (newest === undefined) return null;
  let red: BaseRun | null = null;
  for (const r of runs.filter((x) => x.conclusion === 'failure').slice(0, MAX_BASE_RED_LOGS)) {
    const ids = await c.seams.baseRunIds(target.cwd, url, r.runId, target.name);
    if (ids !== null && isBaseRed(prIds, ids)) { red = r; break; }
  }
  if (red === null) return null;
  const prHead = await c.seams.readRunHeadSha(target.cwd, url);
  if (newest.conclusion === 'success') {
    const inHead = await c.seams.commitInHead(target.cwd, url, newest.headSha, prHead);
    return { target, url, base, prHead, red, newest, state: inHead ? 'green-in-head' : 'green' };
  }
  if (newest.conclusion !== 'failure') return null;
  const ids = newest.runId === red.runId ? prIds : await c.seams.baseRunIds(target.cwd, url, newest.runId, target.name);
  return ids !== null && isBaseRed(prIds, ids) ? { target, url, base, prHead, red, newest, state: 'red' } : null;
}

/** One event per (ticket, check, develop run): the wait row of that develop run is the dedup. */
function noteWait(c: BaseRedContext, p: Proof): void {
  const fresh = markBaseRedWait(c.store, c.ticketId, {
    repo: p.target.repo, baseRunId: p.newest.runId, checkName: p.target.name, prRunId: p.url.runId, headSha: p.newest.headSha, at: c.now(),
  });
  if (!fresh) return;
  const line = `waiting for a green ${p.base}: ${p.target.name} fails there too`;
  c.note(`Autopilot: ${line}`, `${c.key}: ${p.target.name} failed in ${p.target.repo} on the same tests as ${p.base} at ${p.newest.headSha.slice(0, 9)}. No round starts and no attempt is used until ${p.base} is green.`);
  c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
}

async function rebaseRepos(c: BaseRedContext, proofs: readonly Proof[]): Promise<BaseRedStep> {
  const repos = new Map<string, Proof[]>();
  for (const p of proofs) repos.set(p.target.repo, [...(repos.get(p.target.repo) ?? []), p]);
  const stopped = new Map<string, string>();
  let done = 0;
  for (const [repo, group] of repos) {
    // The marker is written BEFORE the rebase: a reload or a second window that sees it never rebases the same check again.
    const marked = group.filter((p) => markAutopilotRerun(c.store, c.ticketId, {
      repo, runId: p.url.runId, checkName: p.target.name, headSha: p.prHead, pattern: `${BASE_RED_PREFIX}${p.base}`, rerunAt: c.now(),
    }));
    if (marked.length === 0) continue;
    const pushed = await c.seams.rebase(repo).catch(() => false);
    if (pushed) done += marked.length;
    for (const p of marked) {
      const what = `${p.target.name} failed on ${p.base} too (${p.red.headSha.slice(0, 9)}) and ${p.base} is green at ${p.newest.headSha.slice(0, 9)}`;
      const line = pushed ? `rebased on base: ${what}` : `rebase on base stopped: ${what}`;
      c.note(`Autopilot: ${line}`, `${c.key}: ${line} in ${repo}. It used no attempt.${pushed ? '' : ' Today\'s rules apply.'}`);
      c.debug(`[ship] autopilot ticket ${c.key} ci: ${line}`);
      if (!pushed) {
        stopped.set(p.target.name, p.base);
        markBaseRedStopped(c.store, c.ticketId, repo, p.url.runId, p.target.name);
      }
    }
  }
  return done > 0 ? { kind: 'rebased' } : { kind: 'none', earlier: stopped };
}
```

If `baseRedStep` grows over ~50 lines, keep the split above (marker state, prove, noteWait, rebaseRepos). The file must stay under 800 lines.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/extension/ops/autopilotBaseRed.test.ts`
Expected: PASS. If the "MAX_BASE_RED_LOGS" test counts 6 calls, check that `prove` does not call `baseRedIds` for `newest` when `newest` is `success` (it must not).

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/autopilotBaseRed.ts src/extension/ops/autopilotBaseRed.test.ts
git commit -m "feat: autopilot base-red step: rebase once on a green develop, wait while it is red"
```

---

### Task 6: Engine wiring (step order, wait, park suffix, eligibility)

**Files:**
- Modify: `src/extension/ops/autopilotOps.ts` (imports; `AutopilotDeps` after `staleRebase` ~line 111; `findProblem` `fails` map ~line 249; `runRound` ~lines 605–618; new `baseRedStepOf` next to `staleStep` ~line 672)
- Test: `src/extension/ops/autopilotOps.test.ts` (new `describe` after the stale block ~line 1500)

**Interfaces:**
- Consumes: `baseRedStep`, `BaseRedStep` (Task 5); `BaseRedSeams` (Task 3); `FailedCheck.base` (Task 4).
- Produces: `AutopilotDeps.baseRed?: BaseRedSeams`.

- [ ] **Step 1: Write the failing test**

```ts
describe('autopilotTick base red (T1383)', () => {
  const URL_V = 'https://github.com/o/r/actions/runs/100/job/200';
  const ID = 'dark pages.visual.ts::a: full-page screenshot';
  const LOG = `- ${ID}: 3 pixels (ratio 0.01 of all image pixels) are different\n`;
  const withUrl = (...names: string[]) => ({ ...failing(...names), failing: names.map((name) => ({ name, url: URL_V })) });
  const GREEN = [{ runId: '2', headSha: 'c'.repeat(40), conclusion: 'success' }, { runId: '1', headSha: 'd'.repeat(40), conclusion: 'failure' }];
  const RED = [{ runId: '3', headSha: 'e'.repeat(40), conclusion: 'failure' }, { runId: '1', headSha: 'd'.repeat(40), conclusion: 'failure' }];

  function baseRig(runs = GREEN, over: Partial<AutopilotDeps> = {}) {
    const rebase = vi.fn(async (_repo: string) => true);
    const r = rig({
      baseRed: {
        readJobLog: async () => LOG, readRunHeadSha: async () => 'a'.repeat(40), readRunWorkflowId: async () => '9',
        listBaseRuns: async () => runs, baseRunIds: async () => [ID], commitInHead: async () => false, rebase,
      },
      ...over,
    });
    return { ...r, rebase };
  }
  const seedBase = (checks: unknown): void => {
    seedPr(checks);
    store.db.prepare("UPDATE prs SET base_ref = 'develop' WHERE ticket_id = ?").run(id);
  };

  it('rebases, starts no ci round, takes no attempt and writes no park', async () => {
    seedBase(withUrl('build'));
    const r = baseRig();
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'rebased' });
    expect(r.rebase).toHaveBeenCalledTimes(1);
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(stageBlock(store, id, 'ship')?.reason).toBe(NORMAL_BLOCK);
  });

  it('runs before the stale step', async () => {
    seedBase(withUrl('build'));
    const staleRebase = { readJobLog: vi.fn(async () => ''), readRunHeadSha: async () => 'a'.repeat(40), regenerate: () => [], rebase: vi.fn(async () => true) };
    const r = baseRig(GREEN, { staleRebase });
    await autopilotTick(r.deps);
    expect(staleRebase.readJobLog).not.toHaveBeenCalled();
  });

  it('waits on a red develop: nothing, no round, no attempt, and an existing park stays', async () => {
    seedBase(withUrl('Visual'));
    parkGateStage(store, { ticketId: id, stageKey: 'ship', kind: 'awaiting-merge', reason: 'auto-fix not run: ci check Visual is not on the allowlist', runAt: '2026-08-09T10:00:00.000Z', gates: [] });
    const r = baseRig(RED);
    expect(await autopilotTick(r.deps)).toEqual({ kind: 'nothing' });
    expect(r.rebase).not.toHaveBeenCalled();
    expect(r.sendCi).not.toHaveBeenCalled();
    expect(getAutopilotBudget(store, id, 'r', 'ci').attempts).toBe(0);
    expect(stageBlock(store, id, 'ship')?.reason).toBe('auto-fix not run: ci check Visual is not on the allowlist');
    expect(r.notes.map((n) => n[0])).toEqual(['Autopilot: waiting for a green develop: Visual fails there too']);
  });

  it('skips the step for a graph ticket and a sandboxed ticket', async () => {
    seedBase(withUrl('build'));
    const graph = baseRig(GREEN, { isGraphTicket: () => true });
    await autopilotTick(graph.deps);
    expect(graph.rebase).not.toHaveBeenCalled();
    const sandbox = baseRig(GREEN, { placement: async () => 'sandbox' });
    await autopilotTick(sandbox.deps);
    expect(sandbox.rebase).not.toHaveBeenCalled();
  });

  it('ends the park reason with the base-red suffix for a check rebased on an earlier run', async () => {
    seedBase(withUrl('Visual'));
    markAutopilotRerun(store, id, { repo: 'r', runId: '99', checkName: 'Visual', headSha: 'a'.repeat(40), pattern: 'base-red:develop', rerunAt: 1 });
    const r = baseRig();
    const out = await autopilotTick(r.deps);
    expect(out).toEqual({ kind: 'parked', reason: 'auto-fix not run: ci check Visual is not on the allowlist (rebased once because develop was red and it failed again)' });
    expect(r.rebase).not.toHaveBeenCalled();
  });

  it('applies today\'s rules when the seams are absent', async () => {
    seedBase(withUrl('build'));
    const r = rig();
    expect((await autopilotTick(r.deps)).kind).toBe('armed');
  });
});
```

Add `markAutopilotRerun` and `parkGateStage` to the imports of the test file if they are not there. If the parked result shape differs (check an existing park test in this file, for example the allowlist park test), match that shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/extension/ops/autopilotOps.test.ts -t "base red"`
Expected: FAIL (`baseRed` is not a known dep; no rebase).

- [ ] **Step 3: Implement**

Imports at the top of `autopilotOps.ts`:

```ts
import { baseRedStep } from './autopilotBaseRed.js';
import type { BaseRedSeams } from '../../integrations/ciRerun.js';
```

In `AutopilotDeps`, after `staleRebase`:

```ts
  /** gh and host seams of the base-red step (T1383, @arch:AP-12). Absent: today's rules apply. */
  readonly baseRed?: BaseRedSeams;
```

In `findProblem`, change the `fails` line to carry the base:

```ts
  const fails = ci.prs.flatMap((p) => p.failing.map((f) => ({ repo: p.repo, cwd: p.cwd, name: f.name, url: f.url, base: p.base ?? null })));
```

In `runRound`, replace:

```ts
  const stale = await staleStep(d, problem);
  if ('result' in stale) return stale.result;
```

with:

```ts
  // A failure that develop shares (T1383) is not the ticket's: one rebase on a green develop, or a wait with no park.
  const baseRed = await baseRedStepOf(d, problem);
  if ('result' in baseRed) return baseRed.result;
  const stale = await staleStep(d, problem);
  if ('result' in stale) return stale.result;
```

and replace the `again` line with:

```ts
    const redBase = baseRed.earlier.get(name);
    const again = redBase !== undefined ? ` (rebased once because ${redBase} was red and it failed again)` : stale.earlier.has(name) ? ' (rebased once for a stale generated file and it failed again)' : rerun.earlier.has(name) ? ' (re-run once after a network error and it failed again)' : '';
```

Add after `staleStep`:

```ts
/** The base-red step (T1383, @arch:AP-12): a result to return, or the checks rebased before (for the park reason). A wait is `nothing`: it clears no park. */
async function baseRedStepOf(d: AutopilotDeps, problem: Problem): Promise<{ result: AutopilotResult } | { earlier: ReadonlyMap<string, string> }> {
  if (!d.baseRed || !problem.fails) return { earlier: new Map() };
  // Same eligibility as the stale step: a host ticket only (@arch:AP-04).
  const placed = await d.placement().catch(() => null);
  if (d.isGraphTicket() || placed === null || placed === 'sandbox') return { earlier: new Map() };
  const step = await baseRedStep(
    { store: d.store, ticketId: d.ticketId, key: d.key, seams: d.baseRed, now: d.now ?? Date.now, note: d.note, debug: d.debug },
    problem.fails,
  );
  if (step.kind === 'rebased') return { result: { kind: 'rebased' } };
  if (step.kind === 'waiting') return { result: { kind: 'nothing' } };
  return { earlier: step.earlier };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotOpsBranches.test.ts`
Expected: PASS. `wc -l src/extension/ops/autopilotOps.ts` must stay under 960 (the file is legacy-large; add no other code).

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/autopilotOps.ts src/extension/ops/autopilotOps.test.ts
git commit -m "feat: autopilot runs the base-red step before the stale step and waits on a red develop with no park"
```

---

### Task 7: Binding and wiring

**Files:**
- Modify: `src/extension/ops/autopilotWiring.ts` (seam type ~line 107; forward ~line 203)
- Modify: `src/extension/autopilotBinding.ts` (~lines 14, 315–316)
- Test: `src/extension/autopilotBindingSeams.test.ts` (the `vi.mock('../integrations/ciRerun.js', …)` at line 22; the "pass the optional seams" test ~line 156)
- Test: `src/extension/ops/autopilotWiring.test.ts` (one forward test, by the pattern of the `staleRebase` forward test in that file)

**Interfaces:**
- Consumes: `makeBaseRedSeams(gh, rebase)` (Task 3), `AutopilotDeps.baseRed` (Task 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

In `src/extension/autopilotBindingSeams.test.ts`:
- Change the mock at line 22 to:

```ts
vi.mock('../integrations/ciRerun.js', () => ({
  makeTransientCiSeams: vi.fn(() => ({ readJobLog: 'RJL', readRunHeadSha: 'RRS' })),
  makeBaseRedSeams: vi.fn((_gh: unknown, rebase: unknown) => ({ kind: 'BASE_RED', rebase })),
}));
```

- In "pass the optional seams only when the deps carry them": add `'baseRed'` to the array of the `bare` assertion, and add:

```ts
    expect(full.seams.baseRed).toEqual({ kind: 'BASE_RED', rebase: expect.any(Function) });
```

- Add a test that the base-red rebase goes through the same held rebase as the stale one:

```ts
  it('rebases for base red through the held Rebase on base (T1383)', async () => {
    const r = rig({ gh: vi.fn() as never });
    const { handle, seams } = open(r);
    await expect((seams.baseRed as unknown as { rebase: (repo: string) => Promise<boolean> }).rebase('repo-a')).resolves.toBe(true);
    expect(rebaseOnBaseAction).toHaveBeenCalledWith(expect.anything(), expect.any(Function), { repos: new Set(['repo-a']) });
    handle.dispose();
  });
```

Import `rebaseOnBaseAction` from `./ops/ciActionsWiring.js` in the test if the file does not already do so (it is mocked at line 18). Use the helper names `rig`/`open` the file already has.

In `src/extension/ops/autopilotWiring.test.ts`, copy the existing `staleRebase` forward test and change `staleRebase` to `baseRed`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/extension/autopilotBindingSeams.test.ts src/extension/ops/autopilotWiring.test.ts`
Expected: FAIL (`baseRed` is undefined).

- [ ] **Step 3: Implement**

`src/extension/ops/autopilotWiring.ts`:
- Import `type BaseRedSeams` from `../../integrations/ciRerun.js`.
- After `readonly staleRebase?: StaleRebaseSeams;` add:

```ts
  /** gh and host seams of the base-red step (T1383, @arch:AP-12). Absent: today's rules apply. */
  readonly baseRed?: BaseRedSeams;
```

- After `...(seams.staleRebase ? { staleRebase: seams.staleRebase } : {}),` add:

```ts
        ...(seams.baseRed ? { baseRed: seams.baseRed } : {}),
```

`src/extension/autopilotBinding.ts`:
- Change the import to `import { makeBaseRedSeams, makeTransientCiSeams } from '../integrations/ciRerun.js';`.
- Above the `sweep` (after `rebaseHeld`), add one helper so both steps use the same held rebase:

```ts
  // Rebase on base for one repo with no confirm prompt, held for a whole round: the stale step (T1081) and the base-red step (T1383) share it.
  const heldRebase = (id: number) => (repo: string): Promise<boolean> =>
    rebaseHeld(id, () => rebaseOnBaseAction(d.ciInput(id), (r) => regenerateEntries(d.manifest(), r), { repos: new Set([repo]) }));
```

- Replace the `staleRebase` line and add the `baseRed` line:

```ts
        ...(d.gh ? { staleRebase: makeStaleRebaseSeams(d.gh, (repo) => regenerateCommands(d.manifest(), repo), heldRebase(id)) } : {}),
        ...(d.gh ? { baseRed: makeBaseRedSeams(d.gh, heldRebase(id)) } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/extension/autopilotBindingSeams.test.ts src/extension/ops/autopilotWiring.test.ts src/extension/autopilotBinding.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run -s typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/extension/ops/autopilotWiring.ts src/extension/ops/autopilotWiring.test.ts src/extension/autopilotBinding.ts src/extension/autopilotBindingSeams.test.ts
git commit -m "feat: wire the base-red seams into the autopilot binding"
```

---

### Task 8: Docs, system map, and gates

**Files:**
- Modify: `docs/arch/autopilot.md` (new block after `@arch:AP-11`; AP-00, AP-03, AP-05 edits)
- Regenerate: `docs/arch/system-map.md`

- [ ] **Step 1: Add the AP-12 block**

Append after `END_DOC_BLOCK: [@arch:AP-11]`:

```markdown
## [@arch:AP-12] Base red: a CI failure that develop shares
covers: src/extension/ops/autopilotBaseRed.ts, src/workflow/baseRedCi.ts, src/integrations/ciRerun.ts#makeBaseRedSeams, src/store/autopilot.ts#baseRedRuns, src/store/autopilot.ts#markBaseRedWait, src/extension/ops/autopilotOps.ts

A PR check can fail on a test that also fails on the base branch. Then the failure is not the ticket's, and an agent round or a re-run of the PR jobs cannot fix it (T1376). The base-red step runs FIRST in the CI step order, before the stale step (`@arch:AP-05`). It has the same eligibility: a host ticket only, never a graph ticket or a sandboxed ticket (`@arch:AP-04`), and every failing check needs a job url and a known PR base.

1. **Classify.** The engine reads the job log of each failing check (bounded, read as text, never evaluated) and extracts the failing test ids with a closed set of patterns (`extractFailingTestIds`): visual-sweep-gate `- <project> <file>::<title>` lines, the playwright failure list `<n>) [<project>] › <file>:<l>:<c> › … › <title>`, and vitest `FAIL <file> > <name>` lines. Each id is normalized (no ANSI, timing, tags or diff tail). The per-test `✘` line is not read, because a flaky test shows it and then passes. An empty set gives today's rules.
2. **Prove.** gh lists at most 20 completed push runs of the same workflow on the PR base. The engine reads the job of the same name in at most 5 failed runs, newest first. A check is base red when one such run failed with ids that hold EVERY id of the PR check. The ids of a develop job are memoized, because a completed run does not change.
3. **Act.** N is the newest completed develop run. When any failing check is not base red, or any N is green and already in the PR head (GitHub compare `ahead` or `identical`), the step gives today's rules. Else, when any N is still red with the same ids, the ticket waits: no round, no park, no attempt, and an existing park stays. One event `Autopilot: waiting for a green <base>: <check> fails there too` is written per (ticket, check, develop run). Else every N is green and not in the PR head: Rebase on base runs once per repo (the held `rebaseOnBaseAction`, no confirm prompt), and one event per check reads `Autopilot: rebased on base: <check> failed on <base> too (<sha>) and <base> is green at <sha>`. It uses no attempt and re-runs no PR job.

The rebase marker is the `autopilot_reruns` row of the PR run with pattern `base-red:<base>`, written before the rebase. A marker on the current run waits by `STALE_WAIT_MS`; a rebase that pushed nothing is tagged `(stopped)`. A marker on an earlier run means the check failed again after the rebase: it gets today's rules, and a park reason ends with `(rebased once because <base> was red and it failed again)`. A wait row is keyed by the develop run (pattern `base-red-wait:<pr run>`), so it never takes the key of the rebase marker. The wait ends `BASE_RED_WAIT_MS` (24 hours) after the first wait on the PR run; then today's rules apply. A gh error is never read as base red: it gives today's rules.

END_DOC_BLOCK: [@arch:AP-12]
```

- [ ] **Step 2: Edit AP-00, AP-03 and AP-05**

- In `@arch:AP-00` "Purpose", add one sentence after the sandbox sentence: `A CI failure that the base branch shares gets no round: see @arch:AP-12.`
- In `@arch:AP-03`, add one sentence at the end of the body (before `END_DOC_BLOCK`): `A base-red marker (\`base-red:\` or \`base-red-wait:\`, @arch:AP-12) is not a network re-run: the transient and no-change steps skip it.`
- In `@arch:AP-05`, change the first sentence that names the order, or add at the end: `The base-red step (@arch:AP-12) runs before this step.`

Keep the block format: do not touch other headers or `END_DOC_BLOCK` lines.

- [ ] **Step 3: Regenerate the system map**

Run: `npm run -s docs:graph`
Expected: exit 0. `git status` shows `docs/arch/system-map.md` changed (new modules).

- [ ] **Step 4: Commit**

```bash
git add docs/arch/autopilot.md docs/arch/system-map.md
git commit -m "docs: add @arch:AP-12 base red and point AP-00, AP-03 and AP-05 to it"
```

- [ ] **Step 5: Run the docs gate**

Run: `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs 2>&1 | tail -n 30`
Expected: PASS. If it BLOCKs on a block that this change does not falsify (for example `@arch:AP-07` for `ciFailure.ts`, `@arch:AP-08` or `@arch:AP-11` for `autopilotOps.ts` / `autopilotBinding.ts`), run for each one:

```bash
node "$KARST_CLI" arch cite @arch:AP-07 --why "ciFailure adds the PR base to each failing PR; optional-check rules are unchanged" --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket FEAT-AUTOPILOT-A-CI-CHECK-THAT
```

Write a reason that is true for that block. If a block's rule no longer holds, edit the block instead.

- [ ] **Step 6: Final checks**

Read `.claude/skills/gates-and-ci/SKILL.md` and run only the cheap checks it lists. At minimum:

```bash
npm run -s typecheck
npx vitest run src/workflow/baseRedCi.test.ts src/store/autopilot.test.ts src/integrations/ciRerun.test.ts src/workflow/ciFailure.test.ts src/extension/ops/autopilotRerun.test.ts src/extension/ops/autopilotNoChange.test.ts src/extension/ops/autopilotBaseRed.test.ts src/extension/ops/autopilotOps.test.ts src/extension/ops/autopilotWiring.test.ts src/extension/autopilotBindingSeams.test.ts src/extension/autopilotBinding.test.ts src/extension/ops/autopilotStaleRebase.test.ts
npm run -s lint:layers 2>&1 | tail -n 20
```

Expected: all exit 0. Commit any fix with a `fix:` or `test:` message.

---

## Self-Review

**Spec coverage:**
- Classify with three closed patterns, normalized → Task 1.
- Prove with ≤20 develop runs of the same workflow and the same job; subset rule → Tasks 3, 5.
- Act: rebase once per repo on a green develop not in the PR head; event text; marker before rebase; no attempt → Tasks 5, 6.
- Wait on a red develop with the same ids; one event per (ticket, check, develop run); no park; existing park kept → Tasks 2, 5, 6.
- Several checks → one rebase per repo → Task 5 test.
- Marker on the current run waits by `STALE_WAIT_MS`; earlier run → `earlier` and park suffix → Tasks 5, 6.
- Stopped rebase tagged → Tasks 2, 5.
- 24h wait end → Tasks 2, 5.
- gh error → `none` → Task 5 (e).
- Not base red (different ids, cancelled, no ids, missing id) → `none` → Task 5.
- N green and already in the PR head → `none` → Task 5.
- Graph or sandboxed ticket skipped → Task 6.
- No job url → `none` → Task 5.
- No PR re-run → the step has no re-run seam; the transient and no-change steps skip the markers → Tasks 3, 4.
- `staleRebaseRuns` does not read `base-red:` rows → Task 2 test.
- Docs AP-12 and pointers; system map → Task 8.

**Type consistency:** `BaseRedSeams` (Task 3) is used by Tasks 5, 6, 7. `BaseRedStep.earlier` is `ReadonlyMap<string, string>` in Tasks 5 and 6. `FailedCheck.base` (Task 4) is read in Task 5 and filled in Task 6. `markBaseRedWait`/`baseRedWaitStart` signatures match between Tasks 2 and 5.
