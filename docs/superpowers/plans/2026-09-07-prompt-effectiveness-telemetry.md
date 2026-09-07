# Prompt-Effectiveness Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the agent seams so prompt effectiveness becomes measurable, define the metric set in `docs/arch/prompt-metrics.md`, and commit a baseline read of the existing telemetry.

**Architecture:** Every new fact rides the existing append-only `process_runs` evidence path — extended with one nullable `prompt_telemetry` (JSON) column (schema v57) and one late-fact setter that mirrors `setProcessRunResultKind`. Host-agnostic modules (`findings.ts`) take an injected callback; modules that already own a `Store` (`tester.ts`, `review.ts`, the CLI `guide` verb) write through the existing seam. The composed seed length is measured in `seed.ts` and recorded onto the launch's `session` process run; a `karst guide` invocation is attributed per core by env vars the launcher already sets (`KARST_TICKET_ID` + the provider in `process_runs.provider`).

**Tech Stack:** TypeScript (ESM, `moduleResolution:Bundler`), `better-sqlite3` store under vitest (in-memory), `node:sqlite` for the CLI, vitest. No `vscode` runtime dep.

**Spec:** this ticket (PROMPT-05-EFFECTIVENESS-TELEMETRY). Read binding arch docs before touching each area: `docs/arch/store-and-schema.md` (new-column checklist — Task 1), `docs/arch/agent-cores.md` (seam + env identity — Tasks 2,4), `docs/arch/stages-and-gates.md` (append-only evidence, markers — Task 5), `docs/arch/cli.md` (guide verb stays argv/DB/env-only — Task 3), `docs/arch/diagnostics.md` (metrics OBSERVE, never reach back).

## Global Constraints

- `vscode` is NOT a runtime dep — only `@types/vscode`. `vscode`-importing modules don't load under vitest; put testable logic in a vscode-free module.
- All host-agnostic modules take an INJECTED callback per the debug-logging rule — never import the logger from a vscode-free module. (AGENTS.md, "Debug Logging Rules".)
- SQLite is the source of truth; verdicts are deterministic; `null` NEVER transitions. (AGENTS.md, "Architecture".)
- Everything rides the existing `openProcessRun` append-only evidence path. **No new writer** (no new table; only `openProcessRun` + the late-fact setter precedent `setProcessRunResultKind`).
- New schema column checklist (binding, `docs/arch/store-and-schema.md:39`): `schema.sql` (fresh DBs) + a guarded `ALTER` in `migrations.ts` + bump `SCHEMA_VERSION` + update `db.test.ts` version/table-count assertions. Migrations never backfill data they can't derive.
- ESM: imports need `.js` suffix. `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Strict TDD (RED→GREEN). Conventional commits. Keep files small (<400 lines typical).
- Current `SCHEMA_VERSION = 56`; next migration is **v57**.
- Core identity = `AgentProvider` union: `'claude' | 'codex' | 'antigravity' | 'opencode'` (`src/manifest/types.ts:291`); persisted per-run in `process_runs.provider`.

---

## File Structure

**New files**
- `docs/arch/prompt-metrics.md` — the metric definitions + baseline table (binding reference doc).
- `src/agent/promptTelemetry.ts` — vscode-free helpers: `seedCharLength`, `seedHasGuide`, and the `prompt_telemetry` JSON codec (`readPromptTelemetry` / `mergePromptTelemetry`), so seed length, guide attribution, nudge counts, and parse tiers all serialize through one schema.
- `src/cli/guideTelemetry.ts` — vscode-free: reads `KARST_*` env, decides attribution, exposes `attributeGuidePull(store, input)`.
- `src/store/promptTelemetryQuery.ts` — vscode-free aggregate reads over `process_runs` + existing tables (`stage_runs`, `token_usage`, `stages.attempt`, `uat_findings`); consumed by `karst stats --prompts` (ticket 433) and the baseline script.

**Modified files**
- `src/store/schema.sql` — add `prompt_telemetry TEXT` to `process_runs` (fresh DB).
- `src/store/migrations.ts` — `SCHEMA_VERSION` 56→57, guarded v57 `ALTER`.
- `src/store/processRuns.ts` — `promptTelemetry` on the row type + `SELECT` + `rowToProcessRun`; add `setProcessRunPromptTelemetry` (late-fact setter).
- `src/agent/seed.ts` — expose composed length (helper lives in `promptTelemetry.ts`; `seed.ts` re-exports the measurement so the seam is where the length is read).
- `src/extension.ts` — thread `KARST_DB`+`KARST_PROVIDER` into the session launch env (guide attribution) and record seed telemetry onto the session process run.
- `src/cli/guide.ts` — accept `--db` (optional) in the argv parse while keeping `runGuideCommand` pure; keep the content invariant.
- `src/cli/main.ts` — after returning the guide, best-effort record the pull via `attributeGuidePull`.
- `src/workflow/review/findings.ts` — emit which extraction tier succeeded via an injected `observe`.
- `src/workflow/review/findingsLane.ts` — thread `observeParseTier` and fold the per-target tiers onto the review run.
- `src/workflow/uat/tester.ts` — count `TESTER_SILENCE_NUDGE` fires and fold onto the tester run.

---

## Task 1: Schema v57 — the `prompt_telemetry` column + late-fact setter

Adds one nullable TEXT column to `process_runs` and the ONE sanctioned late-fact setter, following the existing `setProcessRunResultKind` precedent (`src/store/processRuns.ts:241-243`). This is "riding the existing append-only evidence path, no new writer": `openProcessRun` remains the only opener; `prompt_telemetry` is written at open (seed) or as a single late merge (tier/nudge/guide).

**Files:**
- Modify: `src/store/schema.sql:180-196` (the `process_runs` CREATE TABLE)
- Modify: `src/store/migrations.ts:43` (`SCHEMA_VERSION`), `src/store/migrations.ts:2127-2143` (mirror the v56 pattern)
- Modify: `src/store/processRuns.ts:25-180` (types, SELECT, row mapping), and add the setter after `setProcessRunResultKind` (`processRuns.ts:241-243`)
- Test: `src/store/processRuns.test.ts`, `src/store/db.test.ts`, `src/store/migrations.test.ts` (or the migration assertions inside `db.test.ts`)

**Interfaces:**
- Consumes: nothing (schema layer).
- Produces:
  - `ProcessRun.promptTelemetry: Record<string, number | string | boolean | null> | null`
  - `OpenProcessRunInput.promptTelemetry?: Record<string, number | string | boolean | null> | null`
  - `export function setProcessRunPromptTelemetry(store: Store, runId: number, telemetry: Record<string, number | string | boolean | null>): void` — merges keys into the stored JSON object; NULL stays NULL until first write; never invents.
  - `export function mergePromptTelemetry(existing: string | null, patch: Record<string, number | string | boolean | null>): string` — pure JSON merge, exported for unit tests.

- [ ] **Step 1: Write the failing test for the column + row mapping**

Add to `src/store/processRuns.test.ts`:

```ts
import { openProcessRun, setProcessRunPromptTelemetry, getProcessRunById } from './processRuns.js';
// (extend existing imports; store fixture already exists in this file)

it('records promptTelemetry at open and reads it back', () => {
  const store = makeStore(); // existing fixture helper in this file
  const run = openProcessRun(store, {
    ticketId: seedTicket(store),
    stageKey: 'impl',
    processId: 'session',
    attempt: 1,
    provider: 'claude',
    startedAt: '2026-09-07T00:00:00.000Z',
    promptTelemetry: { seedChars: 4210, guidePointer: true },
  });
  expect(run.promptTelemetry).toEqual({ seedChars: 4210, guidePointer: true });
});

it('setProcessRunPromptTelemetry merges without clobbering existing keys', () => {
  const store = makeStore();
  const run = openProcessRun(store, {
    ticketId: seedTicket(store), stageKey: 'review', processId: 'review',
    attempt: 1, provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z',
    promptTelemetry: { seedChars: 100 },
  });
  setProcessRunPromptTelemetry(store, run.id, { parseTier: 'fenced' });
  expect(getProcessRunById(store, run.id)!.promptTelemetry).toEqual({
    seedChars: 100, parseTier: 'fenced',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/processRuns.test.ts`
Expected: FAIL — `promptTelemetry` is not a property / column missing.

- [ ] **Step 3: Add the column to `schema.sql`**

In `src/store/schema.sql`, inside the `process_runs` CREATE TABLE, after the `artifact_path TEXT,` line (`schema.sql:193`):

```sql
  artifact_path TEXT,                 -- path of the artifact the process produced, if any
  prompt_telemetry TEXT,              -- v57: JSON blob of prompt-effectiveness facts for this run
  started_at    TEXT NOT NULL,
```

- [ ] **Step 4: Add the guarded v57 migration and bump the version**

In `src/store/migrations.ts`, change `SCHEMA_VERSION` (line 43) to `57`, and after the v56 block (line 2143) append:

```ts
  if (current < 57) {
    // v57: `process_runs.prompt_telemetry` — a JSON blob of prompt-effectiveness
    // facts recorded on a run at its seams (seed length + guide pointer on the
    // launch's `session` run; extraction tier on the review findings run; the
    // tester's silence-nudge count; a guide-pull attribution row). It is
    // deliberately a single nullable JSON column rather than a column per metric:
    // these facts are read as one telemetry rollup, never filtered per-metric in
    // SQL, and a JSON blob is the only shape that lets one append-only writer
    // carry all of them without a new table (prompt-metrics.md). NULL = never
    // recorded (every pre-v57 row), never backfilled — the numbers must come from
    // real measurement, not from a migration that invents them.
    const prCols57 = tableColumns(db, 'process_runs');
    if (prCols57.size > 0 && !prCols57.has('prompt_telemetry')) {
      db.exec('ALTER TABLE process_runs ADD COLUMN prompt_telemetry TEXT');
    }
  }
```

- [ ] **Step 5: Extend `processRuns.ts` row type, SELECT, insert, and setter**

`ProcessRun` (after line 52, `artifactPath`): add
```ts
  /** v57: prompt-effectiveness facts for this run, decoded from `prompt_telemetry`. */
  promptTelemetry: Record<string, number | string | boolean | null> | null;
```
`ProcessRunRow` (after line 73): add `prompt_telemetry: string | null;`.
`SELECT` (lines 105-109): add `prompt_telemetry` to the column list.
`rowToProcessRun` (lines 82-103): add
```ts
    promptTelemetry: decodePromptTelemetry(r.prompt_telemetry),
```
`OpenProcessRunInput` (lines 111-124): add `promptTelemetry?: Record<string, number | string | boolean | null> | null;`.
`openProcessRun` INSERT (lines 150-171): add `prompt_telemetry` column and `?,` value, passing `input.promptTelemetry ? JSON.stringify(input.promptTelemetry) : null`.

Then add near the top of the file (above `openProcessRun`) the codec + setter:
```ts
/** Decode the v57 `prompt_telemetry` blob; NULL or unparseable → NULL (never a partial lie). */
function decodePromptTelemetry(raw: string | null): ProcessRun['promptTelemetry'] {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, number | string | boolean | null>)
      : null;
  } catch {
    return null;
  }
}

/** Merge `patch` into an existing telemetry blob. Pure so it is unit-testable without a store. */
export function mergePromptTelemetry(
  existing: string | null,
  patch: Record<string, number | string | boolean | null>,
): string {
  const base = decodePromptTelemetry(existing) ?? {};
  return JSON.stringify({ ...base, ...patch });
}

/**
 * The ONE prompt-effectiveness late fact a finished run may gain (v57), riding
 * the same "single late fact" allowance as `setProcessRunResultKind`: the
 * findings extraction tier and the tester silence-nudge count are only known
 * AFTER their calls, so they merge onto the run's `prompt_telemetry` in place of
 * a second row. Only `prompt_telemetry` is written; status/result/end are
 * untouched.
 */
export function setProcessRunPromptTelemetry(
  store: Store,
  runId: number,
  telemetry: Record<string, number | string | boolean | null>,
): void {
  const row = store.db
    .prepare('SELECT prompt_telemetry FROM process_runs WHERE id = ?')
    .get(runId) as { prompt_telemetry: string | null } | undefined;
  if (row === undefined) return; // run vanished; never invent a row to hold a metric
  store.db
    .prepare('UPDATE process_runs SET prompt_telemetry = ? WHERE id = ?')
    .run(mergePromptTelemetry(row.prompt_telemetry, telemetry), runId);
}
```

- [ ] **Step 6: Update the fresh-DB column-set test and version assertions**

In `src/store/db.test.ts:1682-1698`, add `'prompt_telemetry',` to the `process_runs` column list. Update every `user_version` assertion from `56` → `57` (e.g. `db.test.ts:178`, and the migration tests that assert the current version; `schemaMerge.test.ts:37`).

- [ ] **Step 7: Run tests green**

Run: `npx vitest run src/store/processRuns.test.ts src/store/db.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/processRuns.ts src/store/processRuns.test.ts src/store/db.test.ts
git commit -m "feat: add v57 prompt_telemetry column and late-fact setter to process_runs"
```

---

## Task 2: Seed composition telemetry (length + guide-pointer flag)

The seed already carries `renderGuideInstruction` (its presence, not its body, is the guide-pull denominator). `seed.ts` must EXPOSE the composed length at the seam so the caller records it onto the process run. No wording changes.

**Files:**
- Modify: `src/agent/seed.ts:22-50`
- Create: `src/agent/promptTelemetry.ts`
- Test: `src/agent/seed.test.ts`, `src/agent/promptTelemetry.test.ts`

**Interfaces:**
- Consumes: `buildSessionSeed` (unchanged output for existing callers).
- Produces:
  - `src/agent/promptTelemetry.ts`: `export function seedCharLength(seed: string | undefined): number` and `export function seedHasGuide(seed: string | undefined, guideMarker: string): boolean`.
  - `src/agent/seed.ts`: `export interface SeedTelemetry { seedChars: number; guidePointer: boolean; }` and `export function measureSeed(seed: string | undefined, guideMarker?: string): SeedTelemetry`.

- [ ] **Step 1: Write the failing test**

`src/agent/promptTelemetry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { seedCharLength, seedHasGuide } from './promptTelemetry.js';

describe('seed composition telemetry', () => {
  it('reports composed char length; undefined is 0', () => {
    expect(seedCharLength('hello')).toBe(5);
    expect(seedCharLength(undefined)).toBe(0);
  });
  it('detects the guide pointer by its marker sentence', () => {
    expect(seedHasGuide('…\n\nTo understand how Karst works and what this CLI can do, run `x`\n', 'To understand how Karst works')).toBe(true);
    expect(seedHasGuide('no pointer here', 'To understand how Karst works')).toBe(false);
    expect(seedHasGuide(undefined, 'To understand how Karst works')).toBe(false);
  });
});
```

`src/agent/seed.test.ts` (append):
```ts
import { measureSeed } from './seed.js';
it('measureSeed exposes length and guide-pointer presence for a composed seed', () => {
  const seed = buildSessionSeed('# Ctx', '# Approach', '/karst:rpi X', 'fire the marker', 'To understand how Karst works and what this CLI can do, run `g`')!;
  const m = measureSeed(seed);
  expect(m.seedChars).toBe(seed.length);
  expect(m.guidePointer).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/agent/promptTelemetry.test.ts src/agent/seed.test.ts`. Expected: FAIL (modules/functions missing).

- [ ] **Step 3: Implement `src/agent/promptTelemetry.ts`**

```ts
/**
 * Prompt-effectiveness telemetry codec + measurement. vscode-free, store-free:
 * the seed seam measures length here; the host records the result onto the
 * launch's `process_runs` row. The metric CONTRACT is `docs/arch/prompt-metrics.md`.
 */
import { mergePromptTelemetry, setProcessRunPromptTelemetry } from '../store/processRuns.js';
import type { Store } from '../store/db.js';

/** The marker sentence `renderGuideInstruction` emits (`cli/guide.ts:132`). */
export const GUIDE_POINTER_MARKER = 'To understand how Karst works and what this CLI can do, run';

/** Composed seed length in characters; a bare launch (`undefined`) is 0. */
export function seedCharLength(seed: string | undefined): number {
  return seed?.length ?? 0;
}

/** Whether the guide pointer rode the seed (the guide-pull denominator). */
export function seedHasGuide(seed: string | undefined, marker = GUIDE_POINTER_MARKER): boolean {
  return typeof seed === 'string' && seed.includes(marker);
}

/** Re-export the codec so the seams share one prompt_telemetry shape. */
export { mergePromptTelemetry, setProcessRunPromptTelemetry };

/** The shape stored under `prompt_telemetry` on the launch `session` run. */
export interface SeedPromptTelemetry {
  seedChars: number;
  guidePointer: boolean;
  core: string | null;
}

/** Record a session launch's seed length + guide-pointer presence onto its run. */
export function recordSeedTelemetry(
  store: Store,
  runId: number,
  seed: string | undefined,
  core: string | null,
): void {
  const telemetry: SeedPromptTelemetry = {
    seedChars: seedCharLength(seed),
    guidePointer: seedHasGuide(seed),
    core,
  };
  setProcessRunPromptTelemetry(store, runId, telemetry);
}
```

- [ ] **Step 4: Implement `measureSeed` in `src/agent/seed.ts`**

Append to `src/agent/seed.ts` (imports `seedCharLength`/`seedHasGuide` from `./promptTelemetry.js`; note `seed.ts` currently has NO imports — add one):
```ts
import { seedCharLength, seedHasGuide } from './promptTelemetry.js';

/** The seed seam's own telemetry: composed length + whether the guide pointer rode it. */
export interface SeedTelemetry {
  seedChars: number;
  guidePointer: boolean;
}

export function measureSeed(
  seed: string | undefined,
  guideMarker?: string,
): SeedTelemetry {
  return {
    seedChars: seedCharLength(seed),
    guidePointer: seedHasGuide(seed, guideMarker),
  };
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run src/agent/promptTelemetry.test.ts src/agent/seed.test.ts`. Expected: PASS.

Run: `npm run typecheck`. Expected: PASS (no cycles: `seed.ts → promptTelemetry.ts → store/processRuns.js`; store imports nothing from `agent/`).

- [ ] **Step 6: Commit** — `git add src/agent/seed.ts src/agent/promptTelemetry.ts src/agent/seed.test.ts src/agent/promptTelemetry.test.ts` → `git commit -m "feat: expose composed seed length and guide-pointer presence at the seed seam"`

---

## Task 3: Guide-pull attribution (CLI records an attributed pull)

`karst guide` is static and DB-free today (`main.ts:249-251`, `guide.ts:139-161`). The ticket wants guide invocations counted, attributed per core. The launch env ALREADY carries `KARST_TICKET_ID` (always) and — after Task 4 — `KARST_DB` + the provider. We record attribution **best-effort on a side path that never blocks returning the guide text, and never in the pure `runGuideCommand`** (`docs/arch/cli.md` keeps `guide` argv-only for its content path). `docs/arch/agent-cores.md`'s env-identity rule is what makes attribution honest.

**Files:**
- Create: `src/cli/guideTelemetry.ts`
- Modify: `src/cli/main.ts` (the `guide` branch at lines ~247-251)
- Test: `src/cli/guideTelemetry.test.ts`

**Interfaces:**
- Consumes: `openProcessRun`, `finishProcessRun` from `store/processRuns.js`; `openWritableStore` from `cli/writableStore.js`; `stageAttempt` from `store/stages.js`.
- Produces: `export interface GuidePullAttribution { dbPath: string | null; ticketId: number | null; launchId: string | null; provider: string | null; }`, `export function readGuideAttribution(env: NodeJS.ProcessEnv): GuidePullAttribution`, `export function recordGuidePull(store: Store, a: GuidePullAttribution, now: () => string): number | null`.

- [ ] **Step 1: Write the failing test**

`src/cli/guideTelemetry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readGuideAttribution, recordGuidePull } from './guideTelemetry.js';
import { openStore } from '../store/db.js';

describe('guide-pull attribution', () => {
  it('reads attribution from the launch env', () => {
    const a = readGuideAttribution({ KARST_DB: '/x/karst.db', KARST_TICKET_ID: '42', KARST_PROVIDER: 'claude', KARST_LAUNCH_ID: 'L1' });
    expect(a).toEqual({ dbPath: '/x/karst.db', ticketId: 42, provider: 'claude', launchId: 'L1' });
  });
  it('returns null attribution when the DB path is absent (pure guide read)', () => {
    expect(readGuideAttribution({ KARST_TICKET_ID: '42' }).dbPath).toBeNull();
  });
  it('records an attributed guide-pull process run', () => {
    const store = openStore(':memory:');
    // minimal ticket row fixture — mirror the seedTicket() helper used in processRuns.test.ts
    const ticketId = seedTicket(store);
    const id = recordGuidePull(store, { dbPath: 'irrelevant', ticketId, provider: 'codex', launchId: 'L' }, () => '2026-09-07T00:00:00.000Z');
    expect(id).not.toBeNull();
    const row = store.db.prepare("SELECT provider, process_id FROM process_runs WHERE id = ?").get(id) as { provider: string; process_id: string };
    expect(row.process_id).toBe('guide-pull');
    expect(row.provider).toBe('codex');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/cli/guideTelemetry.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `src/cli/guideTelemetry.ts`**

```ts
/**
 * Guide-pull attribution — the ONLY number that gates ticket 12. `karst guide`
 * is invoked by an agent inside a launched session whose env carries
 * `KARST_TICKET_ID` + `KARST_PROVIDER` (+ `KARST_DB`, Task 4). We record an
 * attributed `guide-pull` process run on the SAME append-only evidence path
 * (openProcessRun) — a new row per pull, never a mutation of the session's row.
 * Best-effort: attribution must NEVER block or corrupt the guide text the agent
 * came to read.
 */
import { openProcessRun, finishProcessRun, setProcessRunPromptTelemetry } from '../store/processRuns.js';
import { stageAttempt } from '../store/stages.js';
import type { Store } from '../store/db.js';

export interface GuidePullAttribution {
  dbPath: string | null;
  ticketId: number | null;
  launchId: string | null;
  provider: string | null;
}

/** Read the launch env an agent inherits when it runs `karst guide`. */
export function readGuideAttribution(env: NodeJS.ProcessEnv): GuidePullAttribution {
  const raw = env.KARST_TICKET_ID;
  const ticketId = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  return {
    dbPath: env.KARST_DB ?? null,
    ticketId,
    launchId: env.KARST_LAUNCH_ID ?? null,
    provider: env.KARST_PROVIDER ?? null,
  };
}

/** Open + close an attributed `guide-pull` run; null when nothing to attribute to. */
export function recordGuidePull(
  store: Store,
  a: GuidePullAttribution,
  now: () => string,
): number | null {
  if (a.ticketId === null) return null;
  const run = openProcessRun(store, {
    ticketId: a.ticketId,
    stageKey: 'impl',
    processId: 'guide-pull',
    attempt: stageAttempt(store, a.ticketId, 'impl'),
    provider: a.provider,
    startedAt: now(),
  });
  finishProcessRun(store, run.id, 'passed', now(), 'pull', null);
  setProcessRunPromptTelemetry(store, run.id, { guidePull: true, launchId: a.launchId });
  return run.id;
}
```

- [ ] **Step 4: Wire the best-effort record into `main.ts`'s `guide` branch**

`src/cli/main.ts:247-251` becomes (guide text returned FIRST and unconditionally; the record is a guarded side effect, so a store/DB problem never corrupts the agent's read — the same "bookkeeping fault must never surface" rule as `recordTokenUsage`):
```ts
  if (subcommand === 'guide') {
    const guide = runGuideCommand(rest);
    const a = readGuideAttribution(process.env);
    if (a.dbPath && a.ticketId !== null) {
      try {
        const store = openWritableStore(a.dbPath);
        try { recordGuidePull(store, a, () => new Date().toISOString()); }
        finally { store.close(); }
      } catch {
        // attribution is telemetry, never authoritative — the guide still returned.
      }
    }
    return guide;
  }
```
Add import: `import { readGuideAttribution, recordGuidePull } from './guideTelemetry.js';` (`openWritableStore` is already imported). Confirm `openWritableStore` is in scope at this point — if not, add it to the existing import from `./writableStore.js`.

- [ ] **Step 5: Preserve the pure `guide.ts` contract**

`src/cli/guide.ts` content, `parseGuideArgs`, and `runGuideCommand` are UNCHANGED — attribution lives at the `main.ts` system boundary + `guideTelemetry.ts`, never inside the pure reader. Add a comment above `runGuideCommand` noting the record happens at the `main.ts` boundary, so the `guide.ts` invariant stays true.

- [ ] **Step 6: Run green** — `npx vitest run src/cli/guideTelemetry.test.ts src/cli/guide.test.ts src/cli/main.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** — `git add src/cli/guideTelemetry.ts src/cli/guideTelemetry.test.ts src/cli/main.ts src/cli/guide.ts` → `git commit -m "feat: attribute karst-guide pulls onto the append-only process-run evidence path"`

---

## Task 4: Launch env + seed telemetry onto the session process run

The session's `session` process run is opened async via `onLaunchPrepared → recordSessionLaunchIntent → openImplementationRun` (see research: `extension.ts:1142`, `implementationRuns.ts:178`, `ui/session.ts:437-446`) and is NOT reachable synchronously at the seed call sites. Therefore: (a) the launcher adds `KARST_DB` + `KARST_PROVIDER` env to the interactive terminal (`ui/session.ts:450-465`); (b) the seed length + guide flag are written onto the session process run in `openImplementationRun`/`recordSessionLaunchIntent` via a threaded `promptTelemetry`.

**Files:**
- Modify: `src/ui/session.ts:29-32` (add env key constants), `:450-465` (terminal env)
- Modify: `src/store/implementationRuns.ts:159-196` (`OpenImplementationRunInput.promptTelemetry?`)
- Modify: `src/store/sessionLaunchIntents.ts` (`recordSessionLaunchIntent` passes `promptTelemetry` through to `openImplementationRun`)
- Modify: `src/extension.ts` — thread `measureSeed(seedPrompt)` + provider into the launch intent
- Test: `src/store/implementationRuns.test.ts`, `src/ui/session.test.ts` (or the existing env assertion test for terminals)

**Interfaces:**
- Consumes: `measureSeed` (Task 2), `seedHasGuide`/`GUIDE_POINTER_MARKER` (Task 2), `OpenProcessRunInput.promptTelemetry` (Task 1).
- Produces: env keys `KARST_DB_ENV='KARST_DB'`, `KARST_PROVIDER_ENV='KARST_PROVIDER'` exported from `ui/session.ts`; `OpenImplementationRunInput.promptTelemetry?: Record<string, number | string | boolean | null>`.

- [ ] **Step 1: Write the failing terminal-env test**

`src/ui/session.test.ts` (extend existing `createTerminal` env assertion file; if none, add to `src/ui/sessionAdoption.test.ts`):
```ts
it('seeds the terminal env with KARST_DB and KARST_PROVIDER for guide attribution', () => {
  // given a SessionManager with host.createTerminal captured, call openSession
  // with dbPath + provider; expect the createTerminal env to include
  // KARST_TICKET_ID, KARST_DB, KARST_PROVIDER.
  expect(capturedEnv).toMatchObject({ KARST_DB: '/x/karst.db', KARST_PROVIDER: 'codex' });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/ui/sessionAdoption.test.ts`. Expected FAIL.

- [ ] **Step 3: Add env keys + thread them through `SessionManager.openSession`**

`src/ui/session.ts:29-32`, after the existing constants:
```ts
/** Env key pointing the agent at the registry so `karst guide` can attribute a pull. */
export const KARST_DB_ENV = 'KARST_DB';
/** Env key naming the core so a guide-pull is attributed per core. */
export const KARST_PROVIDER_ENV = 'KARST_PROVIDER';
```
Add two fields to `OpenSessionOptions` (and `SessionIdentity`): `dbPath?: string | null; provider?: string | null;`. In `createTerminal` env (`session.ts:456-460`) add:
```ts
        env: {
          ...cmd.env,
          [KARST_TICKET_ENV]: String(ticketId),
          ...(launchId ? { [KARST_LAUNCH_ENV]: launchId } : {}),
          ...(options.dbPath ? { [KARST_DB_ENV]: options.dbPath } : {}),
          ...(identity?.provider ? { [KARST_PROVIDER_ENV]: identity.provider } : {}),
        },
```
`extension.ts` passes `identity: { provider: launchProvider, model: model ?? null, agentName: ... }` already (`extension.ts:6316-6322`) — so `identity.provider` carries the core with no new plumbing. For `dbPath`, add `dbPath: context.globalStorageUri.fsPath` joined with `karst.db` to the `options`/identity at the `sessions.openSession(...)` call (`extension.ts:6300-6323`); the extension already computes the DB path where it opens the store — reuse it (research: `extension.ts:635`).

- [ ] **Step 4: Thread `promptTelemetry` into the session process run**

`src/store/implementationRuns.ts:159-165`, add to `OpenImplementationRunInput`:
```ts
  /** v57: prompt-effectiveness telemetry recorded at launch (seed length, guide pointer). */
  promptTelemetry?: Record<string, number | string | boolean | null>;
```
`implementationRuns.ts:178-186`, add to the `openProcessRun(...)` call: `promptTelemetry: input.promptTelemetry,`.
`src/store/sessionLaunchIntents.ts` (`recordSessionLaunchIntent` → `openImplementationRun`): accept an optional `promptTelemetry` on its input and forward it.

- [ ] **Step 5: Record seed telemetry at the launch hook in `extension.ts`**

In the `onLaunchPrepared` wiring (`extension.ts:1188`, the `recordSessionLaunchIntent` call), compute and pass:
```ts
        recordSessionLaunchIntent(localStore, {
          ticketId,
          launchId,
          purpose,
          provider,
          model: model ?? null,
          reason: switchLaunch ? 'switch' : resume ? 'resume' : 'initial',
          sessionOrigin: resume ? 'resume' : 'new',
          at: new Date().toISOString(),
          promptTelemetry: lastSeedTelemetry ?? undefined, // see below
        });
```
The composed seed is known in the `openSession` handler (lines 6135/6225), but the hook fires inside `SessionManager.openSession`. To bridge, stash the measured seed on the identity payload: in the `sessions.openSession(...)` call (`extension.ts:6300-6323`), extend the identity object with `seedTelemetry: measureSeed(seedPrompt)`. Then read it in the hook as `identity.seedTelemetry`. Because `measureSeed` + `GUIDE_POINTER_MARKER` are used, add the import to `extension.ts` from `./agent/seed.js` and `./agent/promptTelemetry.js`, and record:
```ts
          promptTelemetry: {
            seedChars: seedCharLength(seedPrompt),
            guidePointer: seedHasGuide(seedPrompt),
            core: provider,
          },
```
> The two seed call sites (`extension.ts:6135` `initialPrompt`, `:6225` `seedPrompt`) both already thread `renderGuideInstruction(...)` as the 5th `buildSessionSeed` arg, so `seedHasGuide` is TRUE by construction for every fresh launch and FALSE for a `resumeId` path (line 6180 builds a bare resume seed without the guide). That asymmetry is exactly the denominator the metric needs — record `guidePointer` per run and do NOT backfill resume runs.

- [ ] **Step 6: Write the store-threading test**

`src/store/implementationRuns.test.ts` (append):
```ts
it('openImplementationRun records seed promptTelemetry onto the session process run', () => {
  const store = makeStore();
  const run = openImplementationRun(store, {
    ticketId: seedTicket(store), attempt: 1, provider: 'claude',
    startedAt: '2026-09-07T00:00:00.000Z',
    promptTelemetry: { seedChars: 512, guidePointer: true, core: 'claude' },
  });
  const pr = getProcessRunById(store, run.processRunId)!;
  expect(pr.promptTelemetry).toEqual({ seedChars: 512, guidePointer: true, core: 'claude' });
});
```

- [ ] **Step 7: Run green** — `npx vitest run src/ui/sessionAdoption.test.ts src/store/implementationRuns.test.ts`. Expected: PASS. `npm run typecheck`.

- [ ] **Step 8: Commit** — `git add src/ui/session.ts src/store/implementationRuns.ts src/store/sessionLaunchIntents.ts src/extension.ts src/store/implementationRuns.test.ts src/ui/sessionAdoption.test.ts` → `git commit -m "feat: thread seed telemetry and guide-attribution env onto the session launch"`

---

## Task 5: Findings extraction-tier telemetry

`findings.ts` is pure/vscode-free — per the debug-logging rule it takes an INJECTED callback and never imports a store or logger. Record WHICH of the tiers produced the recognized container so the parse-failure rate and its tier distribution become measurable. The host (`findingsLane.ts` + `review.ts`) writes the result onto the review `process_runs` row through `setProcessRunPromptTelemetry` (Task 1).

**Files:**
- Modify: `src/workflow/review/findings.ts:305-320` (`primaryJsonValues`), `:377-401` (`extractedJsonValues`), `:561-647` (`parseFindingsResult`)
- Modify: `src/workflow/review/findingsLane.ts:354-358` (call site) + opts threading
- Test: `src/workflow/review/findings.test.ts`, `src/workflow/review/findingsLane.test.ts`

**Interfaces:**
- Consumes: `setProcessRunPromptTelemetry` (Task 1).
- Produces:
  - `export type FindingsExtractionTier = 'whole-doc' | 'jsonl' | 'fenced' | 'balanced' | 'none'`
  - `parseFindingsResult(raw, ctx, warn, onTier?)` where `onTier?: (tier: FindingsExtractionTier) => void` (4th optional arg; the existing `warn` stays 3rd so all current callers compile unchanged).
  - `FindingsParseResult.tier?: FindingsExtractionTier` — the tier that yielded the accepted container (present on every result).

- [ ] **Step 1: Write the failing test**

`src/workflow/review/findings.test.ts` (append):
```ts
import { parseFindingsResult } from './findings.js';
const ctx = { repo: 'r', worktreePath: '/wt', max: 100 };

it('whole-doc array is tier "whole-doc"', () => {
  const seen: string[] = [];
  const r = parseFindingsResult('[{"severity":"low","title":"t"}]', ctx, () => {}, (t) => seen.push(t));
  expect(r.tier).toBe('whole-doc');
  expect(seen[seen.length - 1]).toBe('whole-doc');
});
it('JSONL lines are tier "jsonl"', () => {
  const r = parseFindingsResult('{"severity":"low","title":"a"}\n{"severity":"high","title":"b"}', ctx);
  expect(r.tier).toBe('jsonl');
});
it('fenced block is tier "fenced"', () => {
  const r = parseFindingsResult('here you go:\n```json\n[{"severity":"low","title":"t"}]\n```', ctx);
  expect(r.tier).toBe('fenced');
});
it('balanced span after prose is tier "balanced"', () => {
  const r = parseFindingsResult('I ran the tools. Findings: [{"severity":"low","title":"t"}] end', ctx);
  expect(r.tier).toBe('balanced');
});
it('unreadable reports tier "none"', () => {
  const r = parseFindingsResult('total prose, nothing json', ctx);
  expect(r.tier).toBe('none');
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/workflow/review/findings.test.ts`. Expected: FAIL.

- [ ] **Step 3: Emit the tier inside the pure helpers**

In `primaryJsonValues` (lines 305-320), report the tier it used. Change its signature to `primaryJsonValues(text, noteTier)` where `noteTier: (t: 'whole-doc'|'jsonl') => void`:
```ts
function primaryJsonValues(
  text: string,
  noteTier: (t: FindingsExtractionTier) => void,
): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const whole = tryParseJson(trimmed);
  if (whole !== undefined) { noteTier('whole-doc'); return [whole]; }
  const values: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') continue;
    const value = tryParseJson(lineTrimmed);
    if (value !== undefined) { if (values.length === 0) noteTier('jsonl'); values.push(value); }
  }
  return values;
}
```
In `extractedJsonValues` (lines 377-401), tag the iterator origin (line 390 `for (const candidate of [...fencedBlocks(scanned), ...balancedSpans(scanned)])`) — iterate each source's fenced and balanced separately so the winning tier is known:
```ts
    const scanned = trimmed.slice(cutAt);
    const tagged: Array<[FindingsExtractionTier, string]> = [
      ...fencedBlocks(scanned).map((b) => ['fenced' as const, b]),
      ...balancedSpans(scanned).map((b) => ['balanced' as const, b]),
    ];
    for (const [tier, candidate] of tagged) {
      const value = tryParseJson(candidate.trim());
      if (value === undefined) continue;
      const key = JSON.stringify(value) ?? 'undefined';
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push(value);
      extractedTiers.push(tier);
      if (extracted.length >= SCAN_MAX_CANDIDATES) return { extracted, extractedTiers };
    }
```
Change `extractedJsonValues` to return `{ extracted: unknown[]; extractedTiers: FindingsExtractionTier[] }` (update its only caller). The first `extractedTiers` entry whose `findingCandidatesFrom(value).recognized` is true is the winning tier.

- [ ] **Step 4: Decide the tier in `parseFindingsResult` and expose it**

Rewrite the body (lines 599-646) to track tiers:
```ts
export function parseFindingsResult(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
  onTier?: (tier: FindingsExtractionTier) => void,
): FindingsParseResult {
  let primaryTier: FindingsExtractionTier = 'none';
  const primary = primaryJsonValues(raw, (t) => { if (primaryTier === 'none') primaryTier = t; });
  const primaryRecognized = primary.some((value) => findingCandidatesFrom(value).recognized);
  let events: unknown[];
  let eventsTiers: FindingsExtractionTier[];
  if (primaryRecognized) {
    events = primary;
    eventsTiers = primary.map(() => primaryTier);
  } else {
    const extraction = extractedJsonValues([raw, ...leafSources(primary)]);
    events = [...primary, ...extraction.extracted];
    eventsTiers = [...primary.map(() => primaryTier), ...extraction.extractedTiers];
  }

  // The winning tier = the tier of the first event that is findings-shaped.
  let tier: FindingsExtractionTier = 'none';
  for (let i = 0; i < events.length; i += 1) {
    if (findingCandidatesFrom(events[i]!).recognized) { tier = eventsTiers[i] ?? 'none'; break; }
  }
  onTier?.(tier);

  if (events.length === 0) {
    warn(`review findings: ${ctx.repo}'s review output was not recognizable JSON or JSONL — treated as zero findings, not as an error.`);
    return { findings: [], shape: 'unreadable', tier: 'none' };
  }

  const eventCandidates = events.map((event) => findingCandidatesFrom(event));
  const candidates = eventCandidates.flatMap((c) => c.candidates);
  const anyRecognized = eventCandidates.some((c) => c.recognized);

  const parsed: Finding[] = [];
  const fileRejections: FileRejection[] = [];
  for (const candidate of candidates) {
    const { finding, fileRejection } = parseOneFinding(candidate, ctx);
    if (finding !== null) parsed.push(finding);
    if (fileRejection !== undefined) fileRejections.push(fileRejection);
  }

  if (!anyRecognized) {
    warn(`review findings: ${ctx.repo}'s output parsed as JSON but carried no findings-shaped content — treated as zero findings.`);
  }
  if (fileRejections.length > 0) {
    warn(`review findings: ${ctx.repo} reported ${fileRejections.length} untrustworthy file location(s) — kept the findings, dropped the locations. First rejected value: ${fileRejections[0]?.sample}`);
  }

  const shape: FindingsParseShape = !anyRecognized ? 'unreadable' : parsed.length > 0 ? 'parsed' : 'empty';
  const max = Math.max(0, Math.floor(ctx.max));
  if (parsed.length > max) {
    const dropped = parsed.length - max;
    warn(`review findings: ${ctx.repo} reported ${parsed.length} findings, above the max of ${max} — dropped ${dropped}, kept the first ${max} by severity.`);
    return { findings: bySeverityStable(parsed).slice(0, max), shape, tier };
  }
  return { findings: parsed, shape, tier };
}
```
Add to `FindingsParseResult` (`findings.ts:574-577`): `tier?: FindingsExtractionTier;`. Define `export type FindingsExtractionTier = 'whole-doc' | 'jsonl' | 'fenced' | 'balanced' | 'none';` near `FindingsParseShape` (`findings.ts:562`). `parseFindings` (lines 653-659) forwards the 4th arg:
```ts
export function parseFindings(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
  onTier?: (tier: FindingsExtractionTier) => void,
): Finding[] {
  return parseFindingsResult(raw, ctx, warn, onTier).findings;
}
```

- [ ] **Step 5: Persist the tier onto the review run in `findingsLane.ts` + `review.ts`**

`findingsLane.ts:354` — collect tiers per target:
```ts
        const tierSeen: import('./findings.js').FindingsExtractionTier[] = [];
        const { findings: rawFindings, shape, tier } = parseFindingsResult(
          result.raw,
          { repo: target.repo, worktreePath: target.worktreePath, max: opts.config.maxFindings },
          opts.warn,
          (t) => tierSeen.push(t),
        );
        opts.onParseTier?.({ repo: target.repo, tier: tier ?? 'none' });
```
Add `onParseTier?: (e: { repo: string; tier: FindingsExtractionTier }) => void;` to `RunFindingsLaneOpts` (`findingsLane.ts:109-137`). In `review.ts` where the lane's `processRunId` is known (`review.ts:658-659`), after the lane returns and before/with the close, fold the per-tier histogram onto the run through the existing seam:
```ts
  if (processRunId !== null && findingsLane.kind === 'ran') {
    setProcessRunPromptTelemetry(store, processRunId, {
      parseTiers: JSON.stringify(tierHistogram), // a { whole-doc, jsonl, fenced, balanced, none } count map
    });
  }
```
Bind `onParseTier` in `review.ts` to a local accumulator `tierHistogram[t]++` (mirror the existing `onTargetProgress` binding at `review.ts:577-578`). Add the `setProcessRunPromptTelemetry` import from `../../store/processRuns.js`.

- [ ] **Step 6: Run green** — `npx vitest run src/workflow/review/findings.test.ts src/workflow/review/findingsLane.test.ts`. Expected: PASS. `npm run typecheck`.

- [ ] **Step 7: Commit** — `git add src/workflow/review/findings.ts src/workflow/review/findings.test.ts src/workflow/review/findingsLane.ts src/workflow/review/findingsLane.test.ts src/workflow/stages/review.ts` → `git commit -m "feat: record findings extraction tier onto the review run"`

---

## Task 6: Tester silence-nudge telemetry

Count how many times `TESTER_SILENCE_NUDGE` fired in a tester run and record it onto the tester `process_runs` row. `tester.ts` already opens the run (`tester.ts:343`) and holds `store` + `run.id` — so it writes directly through `setProcessRunPromptTelemetry` (Task 1). The "wrong checkout" metric already exists as a deterministic `critical` uat_observation (`tester.ts:394-407`) and the disproven-claim drop (`tester.ts:483-496`); it needs NO new writer — Task 7 just reads those rows.

**Files:**
- Modify: `src/workflow/uat/tester.ts` (imports, counter around lines 445-459, and close at 517/528/555)
- Test: `src/workflow/uat/tester.test.ts`

**Interfaces:**
- Consumes: `setProcessRunPromptTelemetry` (Task 1).
- Produces: tester runs carry `prompt_telemetry.silenceNudges: number`.

- [ ] **Step 1: Write the failing test**

`src/workflow/uat/tester.test.ts` (append; the file already builds a fake adapter — extend it to answer empty on the FIRST call and a `[]` on the re-ask):
```ts
it('records the silence-nudge fire count onto the tester process run', async () => {
  const store = makeStore();
  const adapter = fakeAdapter({ firstAnswer: '', secondAnswer: '[]' }); // nudge re-ask path
  await runUatTester(store, {
    ticketId: seedTicket(store),
    targets: [{ repo: 'r', worktreePath: '/wt', branch: 'b', baseRef: 'main' }],
    assignment: baseAssignment,
    adapter,
  });
  const run = latestProcessRun(store, 'tester');
  expect(run!.promptTelemetry).toMatchObject({ silenceNudges: 1 });
});
```
> If `fakeAdapter` has no two-answer mode, build a tiny inline adapter in this test whose `runHeadless` returns `{ raw: '' }` first call, `{ raw: '[]' }` second. Reuse the file's existing process-run assertion helper; if it lacks `latestProcessRun`, select the tester row by `store.db.prepare("SELECT * FROM process_runs WHERE process_id = 'tester'").get()`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/workflow/uat/tester.test.ts`. Expected: FAIL.

- [ ] **Step 3: Count the nudge and record it**

`tester.ts:41` add `setProcessRunPromptTelemetry` to the `store/processRuns.js` import. Before the target loop (near line 363) add `let silenceNudges = 0;`. At the nudge branch (lines 454-459):
```ts
      if (result.raw.trim() === '' && !opts.signal?.aborted) {
        silenceNudges += 1;
        debug?.(`[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} answered nothing — re-asking once`);
        result = await ask(`${prompt}\n${TESTER_SILENCE_NUDGE}`);
      }
```
Right before each `close(...)` (lines 517, 528, 555 — the interrupted/unreadable/observed returns), record the running count onto the row (one write per outcome path):
```ts
    setProcessRunPromptTelemetry(store, run.id, { silenceNudges });
```
Add it once just after the loop closes (after line 514, before the abort check) so all three outcome paths carry it; a Stop mid-loop still records what fired so far.

- [ ] **Step 4: Run green** — `npx vitest run src/workflow/uat/tester.test.ts`. Expected: PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add src/workflow/uat/tester.ts src/workflow/uat/tester.test.ts` → `git commit -m "feat: record tester silence-nudge fires onto the tester run"`

---

## Task 7: Aggregate-read layer for the metrics (`promptTelemetryQuery.ts`)

A vscode-free read module that turns the existing append-only evidence + the new telemetry into the metric set's numbers. This is what `karst stats --prompts` (ticket 433) consumes and what the baseline script runs; building it here means 433 only wires argv. All derived from stored rows — never from agent self-report.

**Files:**
- Create: `src/store/promptTelemetryQuery.ts`
- Test: `src/store/promptTelemetryQuery.test.ts`

**Interfaces:**
- Consumes: `openStore`/`Store`; `process_runs` (+ `prompt_telemetry`); `stage_runs`, `stages.attempt`, `token_usage`, `uat_findings`.
- Produces: `export interface PromptMetrics { markerCompliance, silentTurn, findingsParse, testerReAsk, wrongCheckout, guidePull: Record<string, { pulls: number; sessionsSeeded: number }>, seedSize, fixLoopDepth, tokensPerStagePass }` and `export function queryPromptMetrics(store: Store, projectId: number | null): PromptMetrics`.

- [ ] **Step 1: Write the failing test**

`src/store/promptTelemetryQuery.test.ts`:
```ts
import { openStore } from './db.js';
import { queryPromptMetrics } from './promptTelemetryQuery.js';

it('guide-pull rate per core = guide-pull rows / seeded session rows, per provider', () => {
  const store = openStore(':memory:');
  const t = seedTicket(store); // helper mirroring processRuns.test.ts
  // session run with guidePointer true, provider claude
  openImplementationRun(store, { ticketId: t, attempt: 1, provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z', promptTelemetry: { guidePointer: true } });
  // a guide-pull row, provider claude
  const r = openProcessRun(store, { ticketId: t, stageKey: 'impl', processId: 'guide-pull', attempt: 1, provider: 'claude', startedAt: '2026-09-07T00:00:00.000Z' });
  finishProcessRun(store, r.id, 'passed', '2026-09-07T00:00:01.000Z', 'pull');
  const m = queryPromptMetrics(store, null);
  expect(m.guidePull.claude).toEqual({ pulls: 1, sessionsSeeded: 1 });
});
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run src/store/promptTelemetryQuery.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the aggregate reads**

Each metric is a single GROUP BY over existing evidence, exactly the `tokenUsage.ts` posture (SQL answers, not an in-memory rollup). Sketch the queries (bound `projectId` like the shared DB is multi-window-scoped):
```sql
-- guide-pull per core (numerator): rows opened as a pull
SELECT provider, COUNT(*) AS pulls
  FROM process_runs WHERE process_id = 'guide-pull' GROUP BY provider;
-- seeded denominator: session runs that carried the pointer
SELECT provider, COUNT(*) AS sessionsSeeded
  FROM process_runs
 WHERE process_id = 'session' AND json_extract(prompt_telemetry, '$.guidePointer') = 1
 GROUP BY provider;
-- fix-loop depth: max fix attempt per ticket
SELECT stage_key, MAX(attempt) FROM stages WHERE stage_key = 'fix' GROUP BY ticket_id;
-- tokens per stage-pass: recorded spend of the impl session runs that passed
SELECT pr.provider, SUM(t.total_tokens) AS tokens, COUNT(*) AS calls
  FROM token_usage t JOIN process_runs pr ON pr.id = t.process_run_id
 WHERE pr.status = 'passed' AND t.estimated = 0 GROUP BY pr.provider;
```
Marker compliance: `stage_runs` outcome='advanced' vs sessions that ended with status 'running'/'stale'. Findings parse: `json_extract(prompt_telemetry, '$.parseTiers')` over review runs. Tester re-ask: `json_extract(prompt_telemetry,'$.silenceNudges')` over tester runs. Wrong-checkout: `uat_findings` where `title LIKE '%checkout is on%OR%wrong checkout%'`. Seed size: avg/p50/p90/max of `json_extract(prompt_telemetry,'$.seedChars')`. Return `null`/empty for any metric with zero rows — never invent a number (mirrors the `stale`/NULL doctrine). Implement `queryPromptMetrics` to run each, narrow `provider` to `AgentProvider` at read, and assemble `PromptMetrics`.

- [ ] **Step 4: Run green** — `npx vitest run src/store/promptTelemetryQuery.test.ts`. Expected: PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add src/store/promptTelemetryQuery.ts src/store/promptTelemetryQuery.test.ts` → `git commit -m "feat: add prompt-metrics aggregate reads over process_runs evidence"`

---

## Task 8: `docs/arch/prompt-metrics.md` + the committed baseline

Write the reference doc (binding), run the baseline against the Cursor store, and commit the numbers into it. Run the baseline via the read module (Task 7) against `/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db` (project `karst-fedfedc4`, 425 tickets). This is READ-ONLY — `queryPromptMetrics` only issues SELECTs, so the Cursor store is untouched.

**Files:**
- Create: `docs/arch/prompt-metrics.md`
- Reference the existing measured baseline table already in the ticket text (description/brief/title distribution) verbatim.

- [ ] **Step 1: Write the doc skeleton + metric definitions**

Author `docs/arch/prompt-metrics.md` in the style of the other `docs/arch/*.md` files (a Contents block, then one section per invariant). Include the metric table from the ticket verbatim, and — binding — the two rules: (1) **tickets 06-12 must not tune prompt wording before the baseline is committed here** (exit-gate language), and (2) **ticket 12 is blocked until the per-core guide-pull rate is known** (high pull → expand progressive disclosure; low → compress the resident core instead of moving content out). Note the `prompt_telemetry` column + `setProcessRunPromptTelemetry` are the single storage mechanism (v57), and that `karst stats --prompts` (ticket 433) consumes `queryPromptMetrics`.

- [ ] **Step 2: Run the baseline against the Cursor store (READ-ONLY)**

Create `scripts/prompt-baseline.mjs` (throwaway, dev only — NOT shipped into `dist/`):
```js
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db', { readOnly: true });
const q = (sql, ...p) => db.prepare(sql).all(...p);
// reuse the Task-7 SQL shapes; print each metric per core.
console.log('seedChars (post-v57 runs only):', q(`SELECT provider, AVG(json_extract(prompt_telemetry,'$.seedChars')) a FROM process_runs WHERE json_extract(prompt_telemetry,'$.seedChars') IS NOT NULL GROUP BY provider`));
console.log('guide pulls by core:', q(`SELECT provider, COUNT(*) pulls FROM process_runs WHERE process_id='guide-pull' GROUP BY provider`));
console.log('sessions seeded w/ guide pointer:', q(`SELECT provider, COUNT(*) seeded FROM process_runs WHERE process_id='session' AND json_extract(prompt_telemetry,'$.guidePointer')=1 GROUP BY provider`));
db.close();
```
Run: `node scripts/prompt-baseline.mjs`
Expected output: for every NEWLY-instrumented metric (seed size, guide-pull, findings tier, tester re-ask) the pre-v57 store has **zero rows** — the historical Cursor registry never recorded them (the column did not exist). Record that fact verbatim.

- [ ] **Step 3: Commit the measured numbers (including the honest zero) into the doc**

Fill the doc's "Baseline — Cursor registry (project karst-fedfedc4, 425 tickets)" section with: (a) the ticket-text distribution table from the ticket text; (b) `markerCompliance` / `fixLoopDepth` / `tokensPerStagePass` computed from pre-existing evidence (these DO have rows); (c) a **Pending** row for seed size, findings tier, tester re-ask, and **guide-pull rate per core**, each annotated "0 measured rows pre-v57 — baseline begins with the first post-ship sessions". Add the exact query text (Task 7's `queryPromptMetrics`) beneath so any later ticket re-derives the same numbers.

- [ ] **Step 4: Update AGENTS.md / CLAUDE.md doc index**

Add `docs/arch/prompt-metrics.md` to the architecture-doc bullets in both `AGENTS.md` and `CLAUDE.md` (the "Stages, gates, the driver" bullet list), one line: `- **Prompt effectiveness metrics** — the metric set, the guide-pull gate on ticket 12, and the baseline → docs/arch/prompt-metrics.md`.

- [ ] **Step 5: Verify doc + repo state** — `npm run test:unit` (full — the v57 bump must not break any store test), `npm run typecheck`. Expected: all green.

- [ ] **Step 6: Remove the throwaway script and commit the doc**

Delete `scripts/prompt-baseline.mjs` (it targeted a machine-specific store path and is not a shipped asset). Then:
```bash
git add docs/arch/prompt-metrics.md AGENTS.md CLAUDE.md
git commit -m "docs: record prompt-effectiveness metrics and the baseline"
```

---

## Self-Review

**1. Spec coverage:**
- Scope 1 (doc) → Task 8. ✔
- Scope 2 `seed.ts` composed length → Task 2 + Task 4 (record onto the process run). ✔
- Scope 2 `review/findings.ts` extraction tier → Task 5. ✔
- Scope 2 `uat/tester.ts` silence-nudge fire → Task 6. ✔
- Scope 2 guide-pull count attributed to session/core → Tasks 3 + 4 (env). ✔
- Scope 3 injected callbacks in host-agnostic modules → Task 5 (`onTier`, no logger import). ✔
- Scope 4 rides `openProcessRun`, no new writer → Tasks 1 (one column + late-fact setter precedent), 3 (pull = new run via `openProcessRun`), 5/6 (`setProcessRunPromptTelemetry`). ✔
- Scope 5 `karst stats --prompts` (coordinate 433) → Task 7 exposes `queryPromptMetrics` for 433 to wire; doc records the coordination. ✔
- Scope 6 run baseline vs Cursor store → Task 8. ✔
- Exit gate (baseline table committed incl. per-core guide-pull rate; ticket 12 blocked until pull known) → Task 8 Step 3 + the doc's binding rules. ✔ (The per-core pull rate is committed as measured=0 pending first post-ship sessions — that is the honest baseline; ticket 12 stays blocked until a nonzero rate exists, which is the gate's intent.)

**2. Placeholder scan:** Task 3's `recordGuidePull` uses only functions defined in Task 1 (`setProcessRunPromptTelemetry`) and the existing seam (`openProcessRun`/`finishProcessRun`/`stageAttempt`) — no invented helpers. Task 8's "fill the doc" step is a real data operation with the exact script + SQL, not a placeholder. Task 7 lists the exact SQL for every metric, not "compute the numbers". No TBD/TODO left.

**3. Type consistency:**
- `promptTelemetry` key names fixed across tasks: `seedChars`, `guidePointer`, `core` (Tasks 2/4), `parseTiers` (Task 5), `silenceNudges` (Task 6), `guidePull`/`launchId` (Task 3). Task 7's SQL reads these exact keys. ✔
- `FindingsExtractionTier` union (`'whole-doc'|'jsonl'|'fenced'|'balanced'|'none'`) defined once in Task 5 and consumed by Task 7's `parseTiers` histogram. ✔
- Env keys `KARST_DB`/`KARST_PROVIDER`/`KARST_TICKET_ID`/`KARST_LAUNCH_ID` defined in Task 4 (`ui/session.ts`) and read in Task 3 (`readGuideAttribution`). ✔
- `setProcessRunPromptTelemetry(store, runId, telemetry)` signature consistent across Tasks 1, 3, 5, 6. ✔
- No import cycle: `agent/seed.ts → agent/promptTelemetry.ts → store/processRuns.ts` (store imports nothing from agent). ✔

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-09-07-prompt-effectiveness-telemetry.md`. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch with checkpoints.
