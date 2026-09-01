# Findings Parse & Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI reviewer/tester findings actually reach the store and actually block a stage — a model that wraps its JSON in prose must no longer read as "0 observations, clean review".

**Architecture:** One shared boundary (`review/findings.ts`'s `parseFindings`) reads BOTH the Review findings lane and the UAT Tester. Today it accepts only a whole-document JSON value or one-JSON-value-per-line; every core that narrates its work before printing a pretty-printed array parses as zero. Phase 1 adds a bounded extraction step (fenced block, then balanced bracket scan) in front of the existing readers, changing nothing about the validation contract below it. Phase 2 makes "we could not read the output" a distinct, visible outcome instead of an indistinguishable clean pass. Phase 3 lets a manifest opt a UAT Tester severity threshold into failing UAT, defaulting to today's advisory behavior. Phase 4 makes blocking findings that surface at `ship` visible instead of stranded.

## Context: what actually happened (the bug this closes)

Evidence in the ticket:
- Screenshot 2 — the Tester console shows a JSON array with 4 observations, one `"severity": "high"` (`src/extension.ts:5118`), preceded by ~6 lines of prose narration (`▶ read`, `Both pin regexes match…`).
- Screenshot 1 — the same run renders `Tester · 0 observations — advisory`, and UAT passes `2/2 command gates`.

Cause: `parseJsonEvents` (`src/workflow/review/findings.ts:145-160`) tries `JSON.parse(wholeTrimmedDocument)` — fails, the document starts with prose — then falls back to per-line `JSON.parse` — every line of a pretty-printed array (`[`, `  {`, `    "severity": "high",`) fails on its own. Result: `events.length === 0` → warn "not recognizable JSON or JSONL" → `[]`.

Consequences, both reported by the user:
1. The Tester's `high` observation was never recorded (it is advisory anyway — Phase 3).
2. The **Review** findings lane shares this exact parser (`review/findingsLane.ts:300`). Its `high` findings were parsed as zero, so `aggregateReview`'s R6 (`review/aggregate.ts:382-390`, `DEFAULT_REVIEW_FINDINGS.blockingSeverity = 'high'`) found nothing above threshold and review **passed** to `ship` instead of failing to `fix`. That is the "high issue should have blocked, it skipped" report, and it is why the findings only surfaced later at `ship` where no `failed` edge exists (`workflow/graph.ts:47`).
3. "Sometimes it runs fix, sometimes it doesn't" is explained by the same parser: a core that happens to emit a bare array (or one-finding-per-line) parses fine and routes to `fix`; a core that narrates first parses as zero and passes.

Non-goal in this plan: adding a `ship → fix` graph edge. `ship` is a CONFIRM stage and `done` means merged (`docs/arch/stages-and-gates.md`); a verdict edge out of `ship` is a stage-machine redesign, not a bug fix. Phase 4 instead makes stranded findings visible and steers the human to the existing `sendBack` action.

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `src/workflow/review/findings.ts` (modify) | Add `extractJsonCandidates` + `parseFindingsResult`; keep `parseFindings` as the array-returning wrapper | 1, 2 |
| `src/workflow/review/findings.test.ts` (modify) | RED tests for prose-wrapped, fenced, and trailing-prose output; the `unreadable` shape | 1, 2 |
| `src/workflow/review/findingsLane.ts` (modify) | Read the parse shape; report `unreadable` targets on the `ran` outcome | 2 |
| `src/workflow/review/aggregate.ts` (modify) | R6b — every target unreadable and nothing parsed → `blocked` rather than a vacuous pass | 2 |
| `src/workflow/uat/tester.ts` (modify) | Read the parse shape; close the process run `unreadable-output`; add `observationsBlockingSeverity` verdict input | 2, 3 |
| `src/model/inside/gates.ts` (modify) | Render `unreadable-output` distinctly from `0 observations` | 2 |
| `src/model/inside/ship.ts` (modify) | Ship warning row for unresolved blocking findings | 4 |
| `src/manifest/types.ts`, `src/manifest/validate/uat.ts` (modify) | `uat.testerObservations.blockingSeverity` | 3 |
| `src/workflow/stages/uat.ts` (modify) | Wire the Tester observation threshold into the UAT verdict | 3 |

**Interfaces:**
- Produces (Phase 1/2, consumed by Phases 2–4):
  ```ts
  // src/workflow/review/findings.ts
  export type FindingsParseShape = 'parsed' | 'empty' | 'unreadable';
  export interface FindingsParseResult {
    findings: Finding[];
    /** 'parsed' = at least one finding survived validation.
     *  'empty'  = a findings-shaped container was recognized and was empty (a clean review).
     *  'unreadable' = no JSON value, or no findings-shaped container, was found at all. */
    shape: FindingsParseShape;
  }
  export function parseFindingsResult(
    raw: string, ctx: ParseFindingsContext, warn?: WarnFn,
  ): FindingsParseResult;
  export function parseFindings(   // unchanged signature — delegates to the above
    raw: string, ctx: ParseFindingsContext, warn?: WarnFn,
  ): Finding[];
  ```
- Consumes: `Finding`, `ParseFindingsContext`, `WarnFn` (all already exported from the same module); `Severity` from `src/manifest/types.js`.

---

# Phase 1 — the parser finds JSON inside prose

## Task 1.1: RED — prose-wrapped pretty-printed array

- [ ] **Step 1: Write the failing tests**

Append to `src/workflow/review/findings.test.ts` (match the file's existing `describe`/context-builder style — reuse whatever `ctx` helper the file already defines; if it builds one inline, build one the same way with `{ repo: 'extention', worktreePath: '/w', max: 50 }`):

```ts
describe('parseFindings — JSON embedded in prose', () => {
  const ctx = { repo: 'extention', worktreePath: '/w', max: 50 };

  it('finds a pretty-printed array after narration prose', () => {
    const raw = [
      '▶ read',
      'Both pin regexes match (span 1172/1200 — tight headroom).',
      'I have enough to report.',
      '[',
      '  {',
      '    "severity": "high",',
      '    "title": "Auto-sweep removes worktree folders",',
      '    "detail": "…",',
      '    "file": "src/extension.ts",',
      '    "line": 5118',
      '  }',
      ']',
    ].join('\n');
    const findings = parseFindings(raw, ctx, () => {});
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
    expect(findings[0]!.file).toBe('src/extension.ts');
    expect(findings[0]!.line).toBe(5118);
  });

  it('finds an array inside a ```json fence', () => {
    const raw = 'Here is what I found:\n```json\n[{"severity":"low","title":"nit"}]\n```\nDone.';
    expect(parseFindings(raw, ctx, () => {})).toHaveLength(1);
  });

  it('finds an array followed by trailing prose', () => {
    const raw = '[{"severity":"medium","title":"t"}]\n\nLet me know if you want detail.';
    expect(parseFindings(raw, ctx, () => {})).toHaveLength(1);
  });

  it('keeps the LAST findings-shaped container when the narration echoes an earlier one', () => {
    const raw =
      'First draft:\n[{"severity":"low","title":"draft"}]\n' +
      'On reflection, the real report:\n[{"severity":"high","title":"final"}]';
    const findings = parseFindings(raw, ctx, () => {});
    expect(findings.map((f) => f.title)).toEqual(['draft', 'final']);
  });

  it('still returns [] for prose with no JSON at all', () => {
    const warn = vi.fn();
    expect(parseFindings('I could not find anything to report.', ctx, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not treat a bracketed prose fragment as findings', () => {
    const warn = vi.fn();
    expect(parseFindings('see the note [here] for context', ctx, warn)).toEqual([]);
  });
});
```

Note on the 4th test: both containers are kept and concatenated, matching the existing "every candidate JSON value is scanned; nothing is dropped" contract in the module doc. Do not "pick the last one" — that would silently drop findings the model listed in two batches.

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `npx vitest run src/workflow/review/findings.test.ts`
Expected: the first four tests FAIL (`[]` returned), the last two PASS.

- [ ] **Step 3: Implement the extraction step**

In `src/workflow/review/findings.ts`, add above `parseJsonEvents`:

```ts
/**
 * Bound on how much of a raw response the balanced scan will walk. A core that
 * streams tens of MB of tool narration must not turn one parse into a
 * quadratic scan; past this bound only the TAIL is scanned, because the report
 * a model is asked for is the last thing it writes.
 */
const SCAN_MAX_CHARS = 2_000_000;

/** Bound on how many candidate substrings the scan will hand to `JSON.parse`. */
const SCAN_MAX_CANDIDATES = 64;

/**
 * Every ```-fenced block's body, in document order. A fence is the shape a
 * chat-tuned core reaches for even when told not to, and its body is exact —
 * so it is tried before the heuristic bracket scan below.
 */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1];
    if (body !== undefined) blocks.push(body);
    if (blocks.length >= SCAN_MAX_CANDIDATES) break;
  }
  return blocks;
}

/**
 * Balanced `[...]` / `{...}` substrings of `text`, scanning top-level opens
 * only (a nested brace inside an accepted span is never a second candidate).
 * String literals and their escapes are tracked so a bracket inside a JSON
 * string never closes a span. This is a LEXICAL scan, not a parser: every
 * candidate it yields is still handed to `JSON.parse`, and a candidate that
 * does not parse is simply skipped.
 */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let opener = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      if (depth === 0) {
        start = i;
        opener = ch;
      }
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const closesOpener = (opener === '[' && ch === ']') || (opener === '{' && ch === '}');
        if (closesOpener) spans.push(text.slice(start, i + 1));
        start = -1;
        if (spans.length >= SCAN_MAX_CANDIDATES) break;
      }
    }
  }
  return spans;
}
```

Then rewrite `parseJsonEvents` to keep its current fast paths first and fall back to extraction:

```ts
function parseJsonEvents(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const whole = tryParseJson(trimmed);
  if (whole !== undefined) return [whole];

  const values: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') continue;
    const value = tryParseJson(lineTrimmed);
    if (value !== undefined) values.push(value);
  }
  if (values.length > 0) return values;

  // Neither shape read: the document is prose with JSON somewhere inside it —
  // the ordinary answer from a chat-tuned core that narrates its work before
  // printing the report it was asked for. Fences first (exact), then the
  // balanced scan (heuristic); every candidate still goes through JSON.parse.
  const scanned =
    trimmed.length > SCAN_MAX_CHARS ? trimmed.slice(trimmed.length - SCAN_MAX_CHARS) : trimmed;
  const candidates = [...fencedBlocks(scanned), ...balancedSpans(scanned)];
  const extracted: unknown[] = [];
  for (const candidate of candidates) {
    const value = tryParseJson(candidate.trim());
    if (value !== undefined) extracted.push(value);
  }
  return extracted;
}
```

Also update the module doc comment's **Reading shape** paragraph to name the third step, keeping the existing tone:

> …and only when NEITHER shape reads does it fall back to extraction: every ```-fenced block's body first, then every balanced top-level `[...]`/`{...}` span, each still handed to `JSON.parse`. A chat-tuned core that narrates its tool calls before printing the array it was asked for is the ordinary case, not the exotic one — reading that as zero findings turned a `high` finding into a silent pass.

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx vitest run src/workflow/review/findings.test.ts`
Expected: PASS, including every pre-existing test in the file (the two fast paths are unchanged, so nothing that parsed before may parse differently now).

- [ ] **Step 5: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS. If `src/workflow/review/findingsLane.test.ts` or `src/workflow/uat/tester.test.ts` has a test asserting that prose yields zero findings, that assertion encoded the bug — update it to assert the findings are now read, and say so in the commit body.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/review/findings.ts src/workflow/review/findings.test.ts
git commit -m "fix(review): read findings JSON embedded in a core's narration

parseJsonEvents accepted only a whole-document JSON value or one value per
line, so a core that narrates before printing a pretty-printed array parsed as
zero findings. A high finding then never reached R6 and review passed to ship
instead of failing to fix. Falls back to fenced blocks then balanced top-level
spans, both still validated by JSON.parse and the unchanged field contract."
```

## Task 1.2: Guard the scan's bounds

- [ ] **Step 1: Write the failing tests**

Append to the same `describe` in `src/workflow/review/findings.test.ts`:

```ts
it('reads the report from the tail of a very large narration', () => {
  const noise = 'tool output line\n'.repeat(200_000); // ≈3.4 MB, over SCAN_MAX_CHARS
  const raw = `${noise}[{"severity":"critical","title":"found"}]`;
  const findings = parseFindings(raw, ctx, () => {});
  expect(findings).toHaveLength(1);
  expect(findings[0]!.severity).toBe('critical');
});

it('stays bounded on a document of unclosed brackets', () => {
  const raw = '['.repeat(500_000);
  expect(parseFindings(raw, ctx, () => {})).toEqual([]);
});

it('does not close a span on a bracket inside a JSON string', () => {
  const raw = 'note:\n[{"severity":"low","title":"a ] bracket in prose"}]';
  const findings = parseFindings(raw, ctx, () => {});
  expect(findings).toHaveLength(1);
  expect(findings[0]!.title).toBe('a ] bracket in prose');
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run src/workflow/review/findings.test.ts`
Expected: PASS with the Task 1.1 implementation as written. If any fails, the bound or the string-tracking in `balancedSpans` is wrong — fix `findings.ts`, not the test.

- [ ] **Step 3: Commit**

```bash
git add src/workflow/review/findings.test.ts
git commit -m "test(review): pin the findings scan's size and string-literal bounds"
```

---

# Phase 2 — "could not read the output" stops looking like "clean"

## Task 2.1: A parse result that names the shape

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/review/findings.test.ts`:

```ts
describe('parseFindingsResult', () => {
  const ctx = { repo: 'extention', worktreePath: '/w', max: 50 };

  it('reports parsed when findings survive validation', () => {
    const r = parseFindingsResult('[{"severity":"high","title":"t"}]', ctx, () => {});
    expect(r.shape).toBe('parsed');
    expect(r.findings).toHaveLength(1);
  });

  it('reports empty for an explicit empty container', () => {
    expect(parseFindingsResult('[]', ctx, () => {}).shape).toBe('empty');
    expect(parseFindingsResult('{"findings":[]}', ctx, () => {}).shape).toBe('empty');
  });

  it('reports unreadable for prose with no JSON', () => {
    expect(parseFindingsResult('nothing to report, honestly', ctx, () => {}).shape)
      .toBe('unreadable');
  });

  it('reports unreadable when JSON parsed but carried no findings container', () => {
    expect(parseFindingsResult('{"result":{"ok":true}}', ctx, () => {}).shape)
      .toBe('unreadable');
  });

  it('reports empty when a recognized container held only findings that failed validation', () => {
    // severity is not in the closed vocabulary -> the finding drops, but the
    // container WAS recognized: this is a model that answered badly, not an
    // output we could not read.
    expect(parseFindingsResult('[{"severity":"URGENT","title":"t"}]', ctx, () => {}).shape)
      .toBe('empty');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run src/workflow/review/findings.test.ts`
Expected: FAIL — `parseFindingsResult` is not exported.

- [ ] **Step 3: Implement**

In `src/workflow/review/findings.ts`, rename the existing `parseFindings` body into `parseFindingsResult` returning the shape, and make `parseFindings` a thin wrapper. The shape is decided from state the function already computes:

```ts
export type FindingsParseShape = 'parsed' | 'empty' | 'unreadable';

export interface FindingsParseResult {
  findings: Finding[];
  shape: FindingsParseShape;
}

export function parseFindingsResult(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
): FindingsParseResult {
  const events = parseJsonEvents(raw);
  if (events.length === 0) {
    warn(
      `review findings: ${ctx.repo}'s review output was not recognizable JSON or JSONL — treated as zero findings, not as an error.`,
    );
    return { findings: [], shape: 'unreadable' };
  }
  // …existing body, unchanged, up to and including the `max` truncation…
  // then, at each return point:
  //   const shape = !anyRecognized ? 'unreadable' : parsed.length > 0 ? 'parsed' : 'empty';
  //   return { findings: <what the old code returned>, shape };
}

export function parseFindings(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
): Finding[] {
  return parseFindingsResult(raw, ctx, warn).findings;
}
```

Keep both `warn(...)` calls exactly as they are — the log text is asserted by existing tests and read by `docs/arch/diagnostics.md`'s buffer.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/workflow/review/findings.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/review/findings.ts src/workflow/review/findings.test.ts
git commit -m "feat(review): parseFindingsResult names the parse shape

'unreadable' (no JSON, or no findings container) is now distinguishable from
'empty' (a clean review). parseFindings keeps its array signature."
```

## Task 2.2: The Tester records an unreadable response as such

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/uat/tester.test.ts`, matching the file's existing store/adapter fake setup:

```ts
it('closes the run as unreadable-output when the core answered prose', async () => {
  const store = openStore(':memory:');
  // …build the ticket + adapter fake exactly as the neighbouring tests do,
  // with the adapter returning { raw: 'I ran the tests and everything looked fine.' }
  const result = await runUatTester(store, opts);
  expect(result).toEqual({ kind: 'unreadable-output' });
  const run = listProcessRuns(store, ticketId).at(-1)!;
  expect(run.resultKind).toBe('unreadable-output');
  expect(run.status).toBe('failed');
});

it('still closes as observed when every target answered an empty array', async () => {
  // adapter returns { raw: '[]' }
  const result = await runUatTester(store, opts);
  expect(result).toEqual({ kind: 'observed', findingIds: [] });
});
```

Use whatever process-run listing helper `src/store/processRuns.ts` exports (check its exports; if there is no list helper, read the row with a direct `store.db.prepare('select * from process_runs where id = ?')` the way neighbouring store tests do).

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run src/workflow/uat/tester.test.ts`
Expected: FAIL — the run closes `passed`/`observed`.

- [ ] **Step 3: Implement in `src/workflow/uat/tester.ts`**

1. Extend the result union and document it:

```ts
export type TesterRunResult =
  | { kind: 'observed'; findingIds: number[] }
  | { kind: 'execution-failed'; message: string }
  /**
   * Every target answered, and not one answer carried a findings-shaped
   * container we could read. Distinct from `observed` with zero findings: a
   * clean run is silent BY SAYING SO (`[]`), and reading an unreadable answer
   * as a clean one is what turned a `high` observation into "0 observations —
   * advisory". Advisory still: the ordinary UAT gates decide the stage.
   */
  | { kind: 'unreadable-output' }
  | { kind: 'interrupted' };
```

2. Switch the call site (currently `parseFindings(...)` at line ~329) to `parseFindingsResult`, and track shapes per target:

```ts
const shapes: FindingsParseShape[] = [];
// …inside the target loop, after the call:
const parseResult = parseFindingsResult(result.raw, { repo: target.repo, worktreePath: target.worktreePath, max: cap }, opts.warn);
shapes.push(parseResult.shape);
const parsed = parseResult.findings.map((f) => ({ severity: f.severity, repo: f.repo, file: f.file, line: f.line, title: f.title }));
debug?.(
  `[gate] uat tester ticket ${opts.ticketId}: target ${target.repo} returned ` +
    `${parsed.length} observation(s) (${parseResult.shape})`,
);
```

Note: the deterministic wrong-checkout observation (the `continue` branch) pushes no shape — it never asked the core.

3. After the loop, before `recordUatFindings`:

```ts
// Every target that was actually ASKED came back unreadable, and nothing
// deterministic was recorded either: there is no evidence here, and calling
// that "0 observations" is the bug this branch exists to close.
if (shapes.length > 0 && shapes.every((s) => s === 'unreadable') && collected.length === 0) {
  debug?.(
    `[gate] uat tester ticket ${opts.ticketId}: ${shapes.length} target(s) answered ` +
      `unreadable output — recorded no observations`,
  );
  close('failed', 'unreadable-output');
  return { kind: 'unreadable-output' };
}
```

4. Update the module doc comment's closed-result sentence to name `unreadable-output`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/workflow/uat/tester.test.ts && npm run typecheck`
Expected: PASS. `tsc` will flag every `switch`/`if` chain over `TesterRunResult` that is now non-exhaustive — the UAT stage (`src/workflow/stages/uat.ts`) is the one caller; handle `unreadable-output` there exactly as `execution-failed` is handled today (warn, let the gates decide), and add a test in `src/workflow/uat/*.test.ts` asserting the stage does not fail on it.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/tester.ts src/workflow/uat/tester.test.ts src/workflow/stages/uat.ts
git commit -m "fix(uat): an unreadable Tester answer is not a clean run

Every asked target answering unparseable prose now closes the process run
unreadable-output instead of observed-with-zero. Still advisory: the gates
decide the stage."
```

## Task 2.3: The dashboard says so

- [ ] **Step 1: Write the failing test**

In `src/model/inside/gates.test.ts`, beside the existing `'renders advisory tester observations as note rows and never a fix'` test (line ~464):

```ts
it('renders an unreadable Tester answer distinctly from zero observations', () => {
  const view = /* the same builder the neighbouring test uses */ ({
    ...baseInput,
    run: { ...baseRun, resultKind: 'unreadable-output' },
  });
  expect(view.detail).toBe('output unreadable — no observations recorded');
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run src/model/inside/gates.test.ts`
Expected: FAIL — `detail` is `undefined`.

- [ ] **Step 3: Implement**

In `src/model/inside/gates.ts`, in the Tester `detail` chain (line ~620), add a branch before `execution-failed`:

```ts
: run.resultKind === 'unreadable-output'
  ? 'output unreadable — no observations recorded'
```

and add `'unreadable-output'` to that view's `failedResultKinds` array (line ~617) so the row renders with the same failed treatment `verification-failed` gets. Per `docs/ui/UI-RULES.md` this is a copy + status change on an existing row; cite the rule id for status iconography (`.k-status` is icon-only, `docs/ui/UI-INVARIANTS.md`) in the commit if the row's icon changes.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/model/inside/gates.test.ts && npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/gates.ts src/model/inside/gates.test.ts
git commit -m "fix(ui): Tester row distinguishes unreadable output from zero observations"
```

## Task 2.4: The Review lane refuses a vacuous pass

- [ ] **Step 1: Write the failing tests**

In `src/workflow/review/aggregate.test.ts`:

```ts
it('blocks when the findings lane ran and every target was unreadable', () => {
  const outcome = aggregateReview(/* the file's usual passing-gates entries */, {
    kind: 'ran',
    findings: [],
    unreadable: ['extention'],
  }, { ...baseOpts, findingsBlockingSeverity: 'high' });
  expect(outcome.kind).toBe('blocked');
  expect(outcome).toMatchObject({ blocker: 'capability-missing' });
  expect(outcome.reason).toContain('unreadable');
});

it('passes when the lane ran clean (recognized, empty)', () => {
  const outcome = aggregateReview(/* passing gates */, { kind: 'ran', findings: [] }, baseOpts);
  expect(outcome.kind).toBe('passed');
});

it('does not block on unreadable when the threshold is none', () => {
  const outcome = aggregateReview(/* passing gates */, {
    kind: 'ran', findings: [], unreadable: ['extention'],
  }, { ...baseOpts, findingsBlockingSeverity: 'none' });
  expect(outcome.kind).toBe('passed');
});
```

In `src/workflow/review/findingsLane.test.ts`: a target whose adapter returns narrated prose containing a valid array yields the findings (Phase 1 regression at the lane level); a target returning pure prose contributes its repo name to `unreadable`.

- [ ] **Step 2: Run them, confirm they fail**

Run: `npx vitest run src/workflow/review/aggregate.test.ts src/workflow/review/findingsLane.test.ts`
Expected: FAIL — `unreadable` is not a member of the outcome, and the aggregate passes.

- [ ] **Step 3: Implement the lane**

In `src/workflow/review/findingsLane.ts`: switch line ~300's `parseFindings` to `parseFindingsResult`; collect `target.repo` into an `unreadable: string[]` whenever `shape === 'unreadable'`; include `unreadable` on the returned `{ kind: 'ran' }` only when non-empty (mirroring how `crashes` is attached).

- [ ] **Step 4: Implement the outcome type and R6b**

In `src/workflow/review/aggregate.ts`, add to the `ran` member of `FindingsLaneOutcome`, documented in the module's existing voice:

```ts
/**
 * Repos whose call returned output no findings-shaped container could be read
 * out of. Distinct from a clean review (`findings: []` with nothing here):
 * a review whose ONLY answer was unreadable has produced no signal at all, and
 * reading that as a pass is the vacuous green R6 exists to prevent.
 */
unreadable?: readonly string[];
```

Then, in the R6 block (line ~382), before the severity filter:

```ts
// R6b — the lane ran, the threshold is on, and not one target produced a
// readable answer. Blocked, not failed: an unreadable answer is the core
// misbehaving, not the code being wrong, so it must not spend a fix round.
if (
  findingsLane.kind === 'ran' &&
  opts.findingsBlockingSeverity !== 'none' &&
  (findingsLane.unreadable?.length ?? 0) > 0 &&
  findingsLane.findings.length === 0
) {
  return {
    kind: 'blocked',
    blocker: 'capability-missing',
    reason: `${FINDINGS_FAILURE_PREFIX}unreadable output from ${findingsLane.unreadable!.join(', ')} — no findings could be read`,
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/review/findingsLane.ts src/workflow/review/aggregate.ts src/workflow/review/*.test.ts
git commit -m "fix(review): an unreadable findings answer blocks instead of passing

R6b: the lane ran, the threshold is on, and no target produced a readable
answer -> blocked (capability-missing), never a vacuous green review."
```

---

# Phase 3 — a UAT Tester severity threshold, opt-in

Rationale: `docs/arch/stages-and-gates.md` and `uat/testerVerifier.ts` make the Tester's observations advisory by construction, and that invariant stays the default. This phase adds ONE manifest knob so a project can say "a critical/high observation fails UAT", which is what the ticket reports the user expected. Default `'none'` — behavior is byte-identical for every existing manifest.

## Task 3.1: The manifest field

- [ ] **Step 1: Write the failing test**

In `src/manifest/load.test.ts` (per CLAUDE.md, manifest validation is tested through `loadManifest`, never a schema test):

```ts
it('reads uat.testerObservations.blockingSeverity', async () => {
  const m = await loadManifestFromYaml(`
uat:
  maxFixAttempts: 2
  testerObservations:
    blockingSeverity: high
`);
  expect(m.uat?.testerObservations?.blockingSeverity).toBe('high');
});

it('defaults uat.testerObservations.blockingSeverity to none', async () => {
  const m = await loadManifestFromYaml(`
uat:
  maxFixAttempts: 2
`);
  expect(m.uat?.testerObservations?.blockingSeverity ?? 'none').toBe('none');
});

it('rejects an unknown blockingSeverity', async () => {
  await expect(loadManifestFromYaml(`
uat:
  maxFixAttempts: 2
  testerObservations:
    blockingSeverity: URGENT
`)).rejects.toThrow(/blockingSeverity/);
});
```

Use the file's own manifest-loading helper rather than inventing `loadManifestFromYaml` if one already exists.

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run src/manifest/load.test.ts`

- [ ] **Step 3: Implement**

Follow `docs/arch/manifest-and-settings.md`'s new-field checklist end to end. Concretely:
- `src/manifest/types.ts` — add beside `testerVerifier` (line ~361):
  ```ts
  export interface UatTesterObservationsConfig {
    /**
     * The worst severity a Tester observation may carry without failing UAT's
     * verdict. `'none'` (the default, and the shipped behavior) keeps every
     * observation advisory — see `uat/testerVerifier.ts`. Any Severity turns an
     * observation at or above it into a failed UAT verdict that opens a
     * Tester-attributed recovery round, exactly like the review lane's R6.
     */
    blockingSeverity: Severity | 'none';
  }
  ```
  and `testerObservations?: UatTesterObservationsConfig;` on `UatConfig`.
- `src/manifest/validate/uat.ts` — validate the key against the closed vocabulary plus `'none'`, rejecting anything else with a message naming the path.
- `karst.example.yml` (repo root, mirrored into `dist/` by `scripts/copy-assets.mjs` — edit the SOURCE) — a commented example showing the default.
- `docs/arch/manifest-and-settings.md` — one row in the config table.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/manifest/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manifest src/manifest/load.test.ts karst.example.yml docs/arch/manifest-and-settings.md
git commit -m "feat(manifest): uat.testerObservations.blockingSeverity (default none)"
```

## Task 3.2: The threshold decides a UAT verdict

- [ ] **Step 1: Write the failing tests**

In `src/workflow/uat/tester.test.ts`:

```ts
it('reports blocking observations when the threshold is set', async () => {
  // adapter returns a high + a low observation; opts.observationsBlockingSeverity: 'high'
  const result = await runUatTester(store, { ...opts, observationsBlockingSeverity: 'high' });
  expect(result).toMatchObject({ kind: 'observed', blocking: 1 });
});

it('reports no blocking observations when the threshold is none', async () => {
  const result = await runUatTester(store, opts); // no threshold
  expect(result).toMatchObject({ kind: 'observed', blocking: 0 });
});
```

In `src/workflow/uat/aggregate.test.ts` (or the UAT stage test that owns the verdict — check which file asserts the stage's verdict today and use that one):

```ts
it('fails uat when a blocking Tester observation was recorded', () => {
  // gates all passed; tester reported blocking: 1
  expect(verdict).toMatchObject({ kind: 'failed' });
  expect(verdict.reason).toContain('uat tester observations: 1 high');
});

it('passes uat when observations are advisory (threshold none)', () => {
  expect(verdict).toMatchObject({ kind: 'passed' });
});
```

- [ ] **Step 2: Run them, confirm they fail**

Run: `npx vitest run src/workflow/uat/`

- [ ] **Step 3: Implement**

- `src/workflow/uat/tester.ts`: add `observationsBlockingSeverity?: Severity | 'none'` to `RunUatTesterOpts` (documented: absent → `'none'`, advisory, the shipped behavior), and add `blocking: number` to the `observed` result — counted with the module's existing `SEVERITY_RANK` over the FINAL capped `observations` array, so a truncated observation never counts.
- Export a reason prefix beside `TESTER_VERIFIER_FAILURE_PREFIX`:
  ```ts
  /** The prefix that attributes a failed UAT verdict to the Tester's OBSERVATIONS (not its verifier gate) — the same pattern review's FINDINGS_FAILURE_PREFIX uses. */
  export const TESTER_OBSERVATIONS_FAILURE_PREFIX = 'uat tester observations: ';
  ```
- `src/workflow/stages/uat.ts`: pass the manifest value in; when `result.kind === 'observed' && result.blocking > 0`, produce `{ kind: 'failed', reason: `${TESTER_OBSERVATIONS_FAILURE_PREFIX}${summary}` }` and attribute the recovery round to `sourceProcessId: 'tester'`, matching exactly what the verifier's failure path already does in that file.

Do NOT change `aggregateUat`'s inputs — the Tester's observations must stay out of the pure gate aggregate (`uat/tester.ts`'s module contract). The verdict override belongs in the stage, next to the verifier's.

- [ ] **Step 4: Run tests**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Update the docs that state the invariant**

Edit `docs/arch/stages-and-gates.md` and the module doc comments in `src/workflow/uat/tester.ts` and `src/workflow/uat/testerVerifier.ts`: observations are advisory **by default**, and the ONE way they become a verdict is `uat.testerObservations.blockingSeverity`. State that the default is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/uat src/workflow/stages/uat.ts docs/arch/stages-and-gates.md
git commit -m "feat(uat): opt-in Tester observation severity threshold

blockingSeverity (default none) turns a critical/high observation into a failed
UAT verdict with a tester-attributed recovery round. Advisory stays the default."
```

---

# Phase 4 — findings that surface at ship are visible, not stranded

Rationale (from the ticket's attached report): `ship` has no `failed` edge (`workflow/graph.ts:47`) and `transition` is stage-guarded (`machine.ts:86-90`), so a blocking finding recorded while the ticket sits at `ship` can route nowhere. Adding a `ship → fix` edge is a stage-machine redesign and is explicitly out of scope. This phase makes the stranded evidence impossible to miss and points at the existing `sendBack` action (`workflow/sendBack.ts:30,115`).

## Task 4.1: A ship warning row for unresolved blocking findings

- [ ] **Step 1: Write the failing test**

In `src/model/inside/ship.test.ts` (mirror the file's existing input builder for `shipProcesses`):

```ts
it('warns when blocking-severity findings exist for a ticket parked at ship', () => {
  const views = shipProcesses({
    ...baseInput,
    findings: [{ id: 1, severity: 'high', repo: 'extention', title: 'Auto-sweep removes worktrees', file: 'src/extension.ts', line: 5118 }],
    findingsBlockingSeverity: 'high',
  });
  const warning = views.find((v) => v.id === 'ship-findings');
  expect(warning).toBeDefined();
  expect(warning!.detail).toBe('1 high finding — send back to Implement to fix it');
});

it('shows no warning when every finding is below the threshold', () => {
  const views = shipProcesses({ ...baseInput, findings: [{ /* severity: 'low' */ }], findingsBlockingSeverity: 'high' });
  expect(views.find((v) => v.id === 'ship-findings')).toBeUndefined();
});

it('shows no warning when the threshold is none', () => {
  const views = shipProcesses({ ...baseInput, findings: [{ /* high */ }], findingsBlockingSeverity: 'none' });
  expect(views.find((v) => v.id === 'ship-findings')).toBeUndefined();
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run src/model/inside/ship.test.ts`

- [ ] **Step 3: Implement**

In `src/model/inside/ship.ts`:
- Add to `ShipProcessesInput` (line ~49): `findings?: readonly Finding[]` (the ticket's latest batch, via `latestFindingBatch` from `src/store/reviewFindings.ts`) and `findingsBlockingSeverity?: Severity | 'none'`.
- In `shipProcesses` (line ~728), when the threshold is not `'none'` and at least one finding is at or above it, prepend a view with `id: 'ship-findings'`, a warning status, and the detail above. It is a READ of existing evidence and carries no action beyond the file locations the findings already have — reporting observes and never reaches back (`docs/arch/diagnostics.md`).
- Wire the two new inputs at the host call site (grep for `shipProcesses(` outside tests) using `latestFindingBatch(store, ticketId)` and the manifest's `review.findings.blockingSeverity`.

Check `docs/ui/UI-RULES.md` before adding the row and cite the rule id in the commit if the change exists to satisfy one (UI-R35).

- [ ] **Step 4: Run tests**

Run: `npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/ship.ts src/model/inside/ship.test.ts src/extension.ts
git commit -m "feat(ship): surface unresolved blocking findings at the ship stage

ship has no failed edge (graph.ts:47), so a blocking finding recorded there can
route nowhere. Rather than a stage-machine change, the row names the evidence
and points at the existing Send back to Implement action."
```

---

# Verification (run before declaring the ticket done)

- [ ] **Step 1: Full unit suite**

Run: `npm run test:unit`
Expected: PASS, zero failures.

- [ ] **Step 2: E2E suite**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Confirm the reported symptom is gone**

Paste the ticket's own attached Tester output (`Screenshot 2026-09-01 at 00.27.31.png`, transcribed — prose narration, then the 4-element pretty-printed array with the `high` at `src/extension.ts:5118`) into a scratch test against `parseFindings` with `worktreePath` set to this worktree. Expected: 4 findings, one `high`, `file: 'src/extension.ts'`, `line: 5118`. Delete the scratch test — the equivalent permanent coverage is Task 1.1.

- [ ] **Step 5: Manual F5 check**

Run F5 in VS Code, run a ticket through UAT with a core that narrates, and confirm the Tester row reads `N observations`, not `0 observations — advisory`.

---

# Plan self-review

**Spec coverage:**
- "Tester shows 0 observations" → Phase 1 (parser), Phase 2.2/2.3 (unreadable is visible).
- "found issues doesn't took to account" → Phase 1 (review lane shares the parser), Phase 2.4 (no vacuous pass).
- "high issue, by config should be fixed before advance, but it skipped" → Phase 1 restores R6's failed→fix routing; Phase 3 adds the same for the Tester by config.
- "same later done on AI reviewer" → same parser, Phase 1.
- "sometimes it run fix, sometimes it doesn't" → explained and closed by Phase 1 (output-shape-dependent parsing).
- Attached report's `ship` analysis → Phase 4 (visibility); the `ship → fix` edge is explicitly declined with a reason, not silently dropped.

**Type consistency:** `FindingsParseShape` / `FindingsParseResult` / `parseFindingsResult` are used with those exact names in Phases 1–3. `unreadable?: readonly string[]` is a lane-outcome member in both `findingsLane.ts` and `aggregate.ts`. `blockingSeverity: Severity | 'none'` matches the existing `findingsBlockingSeverity` type in `aggregate.ts`. `TesterRunResult` gains `{ kind: 'unreadable-output' }` and `observed` gains `blocking: number` — both are handled at the single caller (`stages/uat.ts`).

**Known risk:** `balancedSpans` is a heuristic. It cannot create a finding that the field validators would not accept (every candidate still goes through `JSON.parse`, the closed severity vocabulary, worktree containment, and `collapseDiagnostic`), so its worst case is a false-positive candidate that fails to parse and is skipped. Task 1.2 pins its size and string-literal bounds.
