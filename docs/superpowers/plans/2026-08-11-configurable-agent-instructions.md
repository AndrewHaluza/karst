# Configurable Agent Instructions (UAT Tester / Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users replace the UAT Tester and Review findings prompts' role/strategy section via a new `instructions` field on the `processes.uatTester` / `processes.review` config, while the structured-output rules stay fixed.

**Architecture:** `instructions` is a new optional string on `ProcessAssignmentConfig` (manifest `processes.<key>`), parsed by the existing validator, resolved verbatim into `ProcessAssignmentSnapshot` by `resolveProcessAssignment` (alongside agentName/provider/model), and threaded to the two prompt builders — `buildTesterPrompt(target, instructions?)` and `buildFindingsPrompt(repo, baseRef?, instructions?)` — which prepend it in place of the default role/strategy lines and keep the "Output rules (strict)" block byte-identical. The settings Agents tab renders a textarea for the two consuming roles. All existing tests pin the no-instructions output byte-for-byte, which is the backward-compatibility guarantee.

**Tech Stack:** TypeScript ESM (`type:module`, `.js` import suffixes), vitest, js-yaml, self-contained settings webview.

## Global Constraints

- `instructions` blank/absent → the existing built-in prompts, byte-identical (no behavior change; existing tests keep passing untouched).
- `instructions` set → replaces the role/strategy portion of the prompt ONLY; the structured-output rules ("Output rules (strict):" JSON array contract for the tester, findings format for review) remain exactly as today — never user-editable.
- `parseFindings` is unchanged; it must still parse a response produced under user instructions.
- Instructions round-trip through `writeManifest` (save → load → same value).
- Settings UI shows the instructions field for tester and reviewer agent configs only — the four roles with fixed prompt paths (uatFix/reviewFix/prDescription/ticketAnalysis) get no dead field.
- Strict TDD (RED→GREEN per task). Conventional commits. Files stay < 400 lines.
- `noUncheckedIndexedAccess` is on: array access needs `!` or a guard.
- Mirrored TS→HTML constants are BEHAVIOR (UI-R34): the webview's `PROCESS_KEYS_WITH_INSTRUCTIONS` mirror is pinned in `webview.test.ts`.
- Webview changes are judged against `docs/ui/UI-RULES.md` (UI-R09 label+textarea, UI-R19 explanation not title-only, UI-R24 accessible name).

---
### Task 1: Manifest field — type, validation, round-trip

**Files:**
- Modify: `src/manifest/types.ts:352-358` (`ProcessAssignmentConfig`)
- Modify: `src/manifest/validate/processAssignments.ts:107-113` (inside `validateProcessAssignment`)
- Modify: `src/manifest/validate/processAssignments.test.ts`
- Modify: `src/manifest/writeManifest.test.ts:599-622` (round-trip test)
- Modify: `src/manifest/load.test.ts:1988-2021` (`WITH_PROCESSES` fixture + expected model)
- Modify: `karst.example.yml:210-224` (documented example)

**Interfaces:**
- Consumes: existing `optionalString(raw, where)` helper in `validate/processAssignments.ts` (blank/whitespace normalizes to `undefined`, non-blank returned untrimmed — newlines preserved).
- Produces: `ProcessAssignmentConfig.instructions?: string` — the field Tasks 2–5 read.

- [ ] **Step 1: Write the failing validation tests**

In `src/manifest/validate/processAssignments.test.ts`, append inside the `describe('validateProcessAssignments')` block (after the existing `'normalizes a blank model to unset, like defaultModel'` test):

```ts
  it('parses an instructions string into the typed config, preserving newlines', () => {
    const result = validateProcessAssignments(
      {
        uatTester: {
          instructions: 'Focus on API endpoint behavior.\nTest edge cases around authentication.',
        },
        review: { instructions: 'Check for regression patterns.' },
      },
      AGENTS,
    );
    expect(result?.uatTester).toEqual({
      instructions: 'Focus on API endpoint behavior.\nTest edge cases around authentication.',
      enabled: true,
    });
    expect(result?.review).toEqual({ instructions: 'Check for regression patterns.', enabled: true });
  });

  it('rejects a non-string instructions value, naming the field', () => {
    expect(() =>
      validateProcessAssignments({ uatTester: { instructions: ['security'] } }, AGENTS),
    ).toThrow('processes.uatTester.instructions must be a string');
  });

  it('normalizes a blank instructions to unset, like agentName', () => {
    const result = validateProcessAssignments({ uatTester: { instructions: '   ' } }, AGENTS);
    expect(result?.uatTester).toEqual({ enabled: true });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts`
Expected: the three new tests FAIL (`undefined` where instructions expected; no `.instructions must be a string` error thrown).

- [ ] **Step 3: Add the type field**

In `src/manifest/types.ts`, inside `ProcessAssignmentConfig` (after `model?: string;`, before `enabled`):

```ts
  /**
   * Author-declared prompt instructions for the role: replaces the built-in
   * role/strategy portion of the process's prompt. Blank/absent → the built-in
   * prompt (backward compatible). The structured-output rules are never
   * replaced — instructions sit above them. Consumed only by the UAT Tester
   * (`uatTester`) and Review findings (`review`); the other roles keep their
   * own fixed prompt paths and ignore the value.
   */
  instructions?: string;
```

- [ ] **Step 4: Add the validator parse**

In `src/manifest/validate/processAssignments.ts`, inside `validateProcessAssignment`, directly after the `model` block (lines 107-108) and before the `enabled` check:

```ts
  const instructions = optionalString(raw.instructions, `${where}.instructions`);
  if (instructions !== undefined) config.instructions = instructions;
```

- [ ] **Step 5: Run the validation tests**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts`
Expected: all pass.

- [ ] **Step 6: Write the failing round-trip test**

In `src/manifest/writeManifest.test.ts`, replace the body of the existing `'round-trips a processes block through load → write → load in meaning'` test (lines 599-622) with this version that carries a block-scalar instructions value:

```ts
  it('round-trips a processes block through load → write → load in meaning', () => {
    const { path, cleanup } = fixture(`${RAW}
processes:
  uatTester:
    agentName: My UAT Agent
    provider: codex
    model: gpt-5.6-sol
    instructions: |
      Focus on API endpoint behavior.
      Test edge cases around authentication.
`);
    try {
      const m = loadManifest(path);
      expect(m.processes).toEqual({
        uatTester: {
          agentName: 'My UAT Agent',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          // A `|` block scalar keeps its single trailing newline (js-yaml clip).
          instructions: 'Focus on API endpoint behavior.\nTest edge cases around authentication.\n',
          enabled: true,
        },
      });
      writeManifest(path, { ...m, host: '0.0.0.0' });
      expect(loadManifest(path).processes).toEqual(m.processes);
    } finally {
      cleanup();
    }
  });
```

Note: `writeManifest` already writes the `processes` block wholesale (`processes: manifest.processes`, write.ts:180), so NO change to `src/manifest/write.ts` is needed — the round-trip test is the proof.

- [ ] **Step 7: Run the round-trip test to verify it fails**

Run: `npx vitest run src/manifest/writeManifest.test.ts -t "round-trips a processes block"`
Expected: FAIL — the loaded `processes.uatTester` has no `instructions` key (the validator drops it).

- [ ] **Step 8: Extend the load fixture and its expected model**

In `src/manifest/load.test.ts`, add an `instructions:` line to the `uatTester` entry of `WITH_PROCESSES` (after `model: gpt-5.6-sol`):

```yaml
    instructions: Focus on API behavior.
```

and add `instructions: 'Focus on API behavior.',` to the expected `uatTester` object in the `'loads a processes block into the typed model'` test (after `model: 'gpt-5.6-sol',`).

- [ ] **Step 9: Run the manifest tests**

Run: `npx vitest run src/manifest/`
Expected: all pass, including the untouched `load.test.ts` valid/invalid cases and `writeManifest.test.ts`'s `'rejects an invalid processes edit'` (still rejects a bad provider, proving `instructions` does not loosen other validation).

- [ ] **Step 10: Document the field in the example manifest**

In `karst.example.yml`, extend the comment above `# processes:` (around line 211-212) with one line:

```
# `instructions` (uatTester / review only) replaces the built-in role/strategy
# prompt section; the JSON output rules stay fixed.
```

and add an `instructions` example to the `uatTester` entry:

```
#     instructions: |          # optional; blank/absent keeps the built-in prompt
#       Focus on API endpoint behavior. Test edge cases around
#       authentication and rate limiting. Ignore UI concerns.
```

- [ ] **Step 11: Run the full suite + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/manifest/types.ts src/manifest/validate/processAssignments.ts src/manifest/validate/processAssignments.test.ts src/manifest/writeManifest.test.ts src/manifest/load.test.ts karst.example.yml
git commit -m "feat: add processes.<key>.instructions manifest field"
```

---
### Task 2: Resolve instructions into the process assignment snapshot

**Files:**
- Modify: `src/agent/processAssignment.ts:38-43, 88-117`
- Modify: `src/agent/processAssignment.test.ts`

**Interfaces:**
- Consumes: `ProcessAssignmentConfig.instructions` (Task 1).
- Produces: `ProcessAssignmentSnapshot.instructions?: string` — read by Tasks 3 and 4 at the prompt call sites. Resolved ONLY from the process config (verbatim); there is no ticket override and no manifest default for instructions, so `ProcessTicketOverride` is unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/agent/processAssignment.test.ts`, append inside the `describe('resolveProcessAssignment')` block:

```ts
  it('resolves instructions verbatim from the process config', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: {
        uatTester: { instructions: 'Focus on API endpoints.\nIgnore UI.' },
        review: { instructions: 'Check for regression patterns.' },
      },
    };
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      instructions: 'Focus on API endpoints.\nIgnore UI.',
    });
    expect(resolveProcessAssignment(manifest, 'review')?.instructions).toBe(
      'Check for regression patterns.',
    );
  });

  it('carries no instructions key when none are configured', () => {
    expect(resolveProcessAssignment(BASE, 'uat-tester')).toEqual({
      agentName: 'UAT Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect('instructions' in (resolveProcessAssignment(BASE, 'uat-tester') ?? {})).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/agent/processAssignment.test.ts -t instructions`
Expected: FAIL — the snapshot never carries `instructions` yet.

- [ ] **Step 3: Add the snapshot field**

In `src/agent/processAssignment.ts`, extend `ProcessAssignmentSnapshot` (after `model?: string;`):

```ts
  /**
   * Author-declared prompt instructions (`processes.<key>.instructions`),
   * resolved verbatim. Absent → the process's built-in prompt. Snapshotted
   * like the identity fields: a Settings edit mid-run must not rewrite the
   * prompt a live run is reading.
   */
  instructions?: string;
```

- [ ] **Step 4: Resolve it in the resolver**

In `src/agent/processAssignment.ts`, change the return statement of `resolveProcessAssignment` (line 116) from:

```ts
  return { agentName, provider, model };
```

to:

```ts
  return {
    agentName,
    provider,
    model,
    ...(config?.instructions === undefined ? {} : { instructions: config.instructions }),
  };
```

Then update the doc comment's precedence list (the `Precedence per field` block, after the `model:` entry) with one line:

```
 *   instructions: config.instructions (verbatim — author-declared; absent →
 *              the built-in prompt; no ticket/manifest fallback exists)
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/agent/processAssignment.test.ts`
Expected: all pass — the new tests AND the existing `toEqual({ agentName, provider, model })` assertions (no `instructions` key when absent).

- [ ] **Step 6: Commit**

```bash
git add src/agent/processAssignment.ts src/agent/processAssignment.test.ts
git commit -m "feat: resolve process instructions into the assignment snapshot"
```

---
### Task 3: UAT Tester prompt accepts user instructions

**Files:**
- Modify: `src/workflow/uat/tester.ts:121-139` (`buildTesterPrompt`) and `:189-199` (the `runHeadless` call in `runUatTester`)
- Modify: `src/workflow/uat/tester.test.ts`

**Interfaces:**
- Consumes: `ProcessAssignmentSnapshot.instructions` (Task 2) via `RunUatTesterOpts.assignment` — already threaded into `runUatTester` by `stages/uat.ts`, so that stage file needs NO change.
- Produces: `buildTesterPrompt(target: TesterTarget, instructions?: string): string`. When `instructions` is blank/absent the output is byte-identical to today (the existing two `buildTesterPrompt` tests keep passing untouched).

- [ ] **Step 1: Write the failing prompt tests**

In `src/workflow/uat/tester.test.ts`, append inside the existing `describe('buildTesterPrompt')` block:

```ts
  it('replaces the role/strategy lines with user instructions, keeping the target context and output rules', () => {
    const prompt = buildTesterPrompt(
      TARGETS[0]!,
      'Focus on API endpoint behavior.\nTest edge cases around authentication and rate limiting.',
    );
    expect(prompt).toContain(
      'Focus on API endpoint behavior.\nTest edge cases around authentication and rate limiting.',
    );
    // The facts the agent needs survive — repo, base branch, service context.
    expect(prompt).toContain('Repository: /web');
    expect(prompt).toContain('develop');
    expect(prompt).toContain('npm run dev');
    // The default role/strategy lines are replaced...
    expect(prompt).not.toContain('Act as the UAT tester');
    expect(prompt).not.toContain('Try to BREAK');
    // ...but the structured-output contract is non-negotiable.
    expect(prompt).toContain('Output rules (strict):');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain('OBSERVATIONS, not verdicts');
  });

  it('treats blank or whitespace instructions as absent', () => {
    const blank = buildTesterPrompt(TARGETS[0]!, '   ');
    expect(blank).toContain('Act as the UAT tester');
    expect(blank).toContain('Try to BREAK');
  });
```

- [ ] **Step 2: Write the failing threading test**

In `src/workflow/uat/tester.test.ts`, inside the existing `describe('runUatTester')` block, append:

```ts
  it('threads the assignment instructions into the prompt it sends', async () => {
    const { adapter, calls } = rawAdapter('[]');
    const res = await runUatTester(
      store,
      opts({
        adapter,
        assignment: { ...ASSIGNMENT, instructions: 'Focus on API endpoint behavior.' },
      }),
      { now },
    );
    expect(res.kind).toBe('observed');
    expect(calls[0]!.prompt).toContain('Focus on API endpoint behavior.');
    expect(calls[0]!.prompt).toContain('Output rules (strict):');
    // The instructed run's output still parses ([] → zero findings recorded).
    expect(listUatFindings(store, ticketId)).toHaveLength(0);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/workflow/uat/tester.test.ts -t instructions`
Expected: FAIL — `buildTesterPrompt` takes no second argument and the prompt still contains "Act as the UAT tester".

- [ ] **Step 4: Implement `buildTesterPrompt`**

In `src/workflow/uat/tester.ts`, replace the whole `buildTesterPrompt` function (lines 121-139) with:

```ts
export function buildTesterPrompt(target: TesterTarget, instructions?: string): string {
  const baseClause = target.baseRef
    ? `against its base branch, \`${target.baseRef}\` (compare against \`origin/${target.baseRef}\` when available, otherwise the local \`${target.baseRef}\`).`
    : `against its base branch.`;
  const serviceClause = target.service?.start
    ? `\nThe repository's service starts with: \`${target.service.start}\`. You may stand it up to observe behavior.`
    : '';
  // User instructions REPLACE the role/strategy block (the ticket's
  // precedence: user override → built-in default). The target context is
  // kept — repo, base branch and service are facts the agent needs whatever
  // the strategy — and the output rules below are never replaced.
  const instructionsText = instructions?.trim() ?? '';
  const strategy =
    instructionsText.length > 0
      ? [
          instructionsText,
          `Repository: ${target.repo} ${baseClause}${serviceClause}`,
          '',
        ]
      : [
          `Act as the UAT tester for the changes in this worktree (repository: ${target.repo}) ${baseClause}`,
          `Try to BREAK the changes: run them, exercise the acceptance criteria, and report what you observe.${serviceClause}`,
        ];
  return [
    ...strategy,
    `Output rules (strict):`,
    `- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.`,
    `- Each element: {"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "detail": string, "file"?: string, "line"?: number}.`,
    `- "file" must be a path RELATIVE to this worktree's root — never absolute, never outside it.`,
    `- "title" is one short sentence; "detail" carries the explanation.`,
    `- No observations worth reporting → output exactly [].`,
    `- These are OBSERVATIONS, not verdicts: you cannot pass or fail the ticket; you report what you found.`,
  ].join('\n');
}
```

Also update the function's doc comment (the paragraph starting `The request. Strict output rules...`) to add: `\`instructions\` (optional) replaces the role/strategy lines with the author's own — the target context and the strict output rules always remain.`

- [ ] **Step 5: Thread the snapshot's instructions at the call site**

In `src/workflow/uat/tester.ts`, inside `runUatTester`'s loop, change the `runHeadless` call's prompt line (line 190) from:

```ts
        prompt: buildTesterPrompt(target),
```

to:

```ts
        prompt: buildTesterPrompt(target, opts.assignment.instructions),
```

- [ ] **Step 6: Run the tester tests**

Run: `npx vitest run src/workflow/uat/tester.test.ts`
Expected: all pass — the two new prompt tests, the threading test, AND the pre-existing byte-compat assertions (`'names the target repository, its base branch and its host-known service context'` and `'falls back to generic wording...'`).

- [ ] **Step 7: Commit**

```bash
git add src/workflow/uat/tester.ts src/workflow/uat/tester.test.ts
git commit -m "feat: uat tester prompt accepts configurable instructions"
```

---
### Task 4: Review findings prompt accepts user instructions

**Files:**
- Modify: `src/workflow/review/findingsLane.ts:112-128` (`buildFindingsPrompt`) and `:218-228` (the `runHeadless` call in `runFindingsLane`)
- Modify: `src/workflow/review/findingsLane.test.ts`

**Interfaces:**
- Consumes: `ProcessAssignmentSnapshot.instructions` (Task 2) via `FindingsProcessInput.assignment` (`RunFindingsLaneOpts.process`). The `stages/review.ts` stage already threads the full assignment through `process: { assignment, adapter, ... }`, so it needs NO change.
- Produces: `buildFindingsPrompt(repo: string, baseRef?: string | null, instructions?: string): string`. Blank/absent → byte-identical output (the three existing `buildFindingsPrompt` tests keep passing untouched). `parseFindings` is not touched.

- [ ] **Step 1: Write the failing prompt tests**

In `src/workflow/review/findingsLane.test.ts`, append inside the existing `describe('buildFindingsPrompt')` block:

```ts
  it('replaces the review lines with user instructions, keeping the target context and output rules', () => {
    const prompt = buildFindingsPrompt(
      '/web',
      'develop',
      'Focus on error handling and regression patterns.',
    );
    expect(prompt).toContain('Focus on error handling and regression patterns.');
    // The facts the agent needs survive — repo and base branch.
    expect(prompt).toContain('Repository: /web');
    expect(prompt).toContain('develop');
    // The default review strategy lines are replaced...
    expect(prompt).not.toContain('Review the uncommitted and committed changes');
    expect(prompt).not.toContain('DIFF ONLY');
    // ...but the structured-output contract is non-negotiable.
    expect(prompt).toContain('Output rules (strict):');
    expect(prompt).toContain('JSON array');
  });

  it('treats blank instructions as absent', () => {
    const prompt = buildFindingsPrompt('/web', 'develop', '  ');
    expect(prompt).toContain('Review the uncommitted and committed changes');
  });
```

- [ ] **Step 2: Write the failing lane test (threading + parse under instructions)**

In `src/workflow/review/findingsLane.test.ts`, inside the existing `describe('runFindingsLane')` block, append:

```ts
  it('threads the process assignment instructions into the prompt and still parses the output', async () => {
    const runHeadless = vi.fn().mockResolvedValue({
      sessionId: '',
      verdict: null,
      raw: JSON.stringify([{ severity: 'high', title: 'leak', detail: 'x', file: 'src/a.ts' }]),
    });
    const outcome = await runFindingsLane({
      config: CONFIG,
      adapter: adapter('[]'),
      targets: [TARGET],
      ticketId: 1,
      process: {
        assignment: {
          agentName: 'Review Agent',
          provider: 'claude',
          instructions: 'Check error handling.',
        },
        adapter: { ...adapter('[]'), runHeadless },
      },
    });
    expect(outcome.kind).toBe('ran');
    expect(outcome).toEqual({
      kind: 'ran',
      findings: [expect.objectContaining({ severity: 'high', title: 'leak' })],
    });
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Check error handling.');
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Output rules (strict):');
  });
```

(Note: `FindingsProcessInput.adapter` REPLACES `RunFindingsLaneOpts.adapter`, per `runFindingsLane`'s `const adapter = opts.process?.adapter ?? opts.adapter;`.)

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/workflow/review/findingsLane.test.ts -t instructions`
Expected: FAIL — `buildFindingsPrompt` takes no third argument; the prompt still contains "Review the uncommitted and committed changes".

- [ ] **Step 4: Implement `buildFindingsPrompt`**

In `src/workflow/review/findingsLane.ts`, replace the whole `buildFindingsPrompt` function (lines 112-128) with:

```ts
export function buildFindingsPrompt(
  repo: string,
  baseRef?: string | null,
  instructions?: string,
): string {
  const baseClause = baseRef
    ? `against its base branch, \`${baseRef}\` (compare against \`origin/${baseRef}\` when available, otherwise the local \`${baseRef}\`).`
    : `against its base branch.`;
  // User instructions REPLACE the role/scope block; the target context line
  // and the output rules below are never replaced.
  const instructionsText = instructions?.trim() ?? '';
  const strategy =
    instructionsText.length > 0
      ? [instructionsText, `Repository: ${repo} ${baseClause}`, '']
      : [
          `Review the uncommitted and committed changes in this worktree (repository: ${repo}) ${baseClause}`,
          `Report findings about the DIFF ONLY — code you did not touch is out of scope, however wrong it looks.`,
          ``,
        ];
  return [
    ...strategy,
    `Output rules (strict):`,
    `- Output ONLY a JSON array, nothing else: no preamble, no markdown fence, no commentary.`,
    `- Each element: {"severity": "critical"|"high"|"medium"|"low"|"info", "title": string, "detail": string, "file"?: string, "line"?: number}.`,
    `- "file" must be a path RELATIVE to this worktree's root — never absolute, never outside it.`,
    `- "title" is one short sentence; "detail" carries the explanation.`,
    `- No changes worth reporting → output exactly [].`,
    `- Use "critical" only for something that will break in production (data loss, security, crash); "high" for a real bug or a clear regression; "medium"/"low"/"info" for style, maintainability, or a suggestion.`,
  ].join('\n');
}
```

Also update the function's doc comment to add: `\`instructions\` (optional) replaces the review strategy lines with the author's own — the target context and the strict output rules always remain.`

- [ ] **Step 5: Thread the snapshot's instructions at the call site**

In `src/workflow/review/findingsLane.ts`, inside `runFindingsLane`'s loop, change the `runHeadless` call's prompt line (line 219) from:

```ts
        prompt: buildFindingsPrompt(target.repo, target.baseRef),
```

to:

```ts
        prompt: buildFindingsPrompt(target.repo, target.baseRef, opts.process?.assignment.instructions),
```

- [ ] **Step 6: Run the lane tests**

Run: `npx vitest run src/workflow/review/findingsLane.test.ts`
Expected: all pass — the new tests AND the untouched byte-compat assertions, including `'debug lines never carry the prompt'` (its needle is the default first line, which is still emitted when no instructions are set).

- [ ] **Step 7: Run the review stage tests (no-change proof for `stages/review.ts`)**

Run: `npx vitest run src/workflow/stages/review.test.ts`
Expected: all pass untouched.

- [ ] **Step 8: Commit**

```bash
git add src/workflow/review/findingsLane.ts src/workflow/review/findingsLane.test.ts
git commit -m "feat: review findings prompt accepts configurable instructions"
```

---
### Task 5: Settings UI — instructions field for tester and reviewer

**Files:**
- Modify: `src/ui/settings/webview.html` (CSS near line 441, constant near line 3124, row template lines 3204-3211, input handler lines 2573-2577)
- Modify: `src/ui/settings/webview.test.ts` (Agents tab describe block)

**Interfaces:**
- Consumes: `ProcessAssignmentConfig.instructions` (Task 1) — the webview binds it to `draft.processes[key].instructions` exactly like the existing `agentName` field; `updateProcessAssignment` and the `change` listener already handle arbitrary `data-proc-field` values, so no routing change beyond the `input` handler.
- Produces: a `<textarea>` Instructions control rendered ONLY for the `uatTester` and `review` rows (the two roles that consume the value — no dead field for the other four). The mirrored constant `PROCESS_KEYS_WITH_INSTRUCTIONS` is pinned in `webview.test.ts` (UI-R34).

- [ ] **Step 1: Write the failing webview tests**

In `src/ui/settings/webview.test.ts`, inside the `describe('settings agents tab — process assignments')` block (after the existing `'mirrors the host PROCESS_KEYS vocabulary exactly'` test), append:

```ts
  it('mirrors the host instructions-consumer vocabulary exactly', () => {
    expect(HTML).toContain(`const PROCESS_KEYS_WITH_INSTRUCTIONS = ['uatTester', 'review'];`);
  });

  it('renders the instructions textarea only for uatTester and review rows', () => {
    expect(HTML).toContain('data-proc-field="instructions"');
    const render = loadProcessRowRenderer();
    const tester = render(
      'uatTester',
      { instructions: 'Focus on API endpoints.' },
      view('uatTester', 'UAT Tester'),
    );
    expect(tester).toContain('data-proc-field="instructions"');
    expect(tester).toContain('Focus on API endpoints.');
    expect(tester).toContain('Blank = the built-in prompt');
    const fix = render('uatFix', {}, view('uatFix', 'UAT Fix'));
    expect(fix).not.toContain('data-proc-field="instructions"');
  });

  it('writes and clears the instructions field through updateProcessAssignment', () => {
    const sandbox: Record<string, unknown> = {
      draft: { processes: { uatTester: { provider: 'codex' } } },
      markDirty: () => {},
      renderProcessAssignments: () => {},
    };
    const source = `
      ${functionSource('updateProcessAssignment')}
      updateProcessAssignment('uatTester', { instructions: 'Focus on API endpoints.' });
    `;
    runInNewContext(source, sandbox);
    expect((sandbox.draft as { processes: Record<string, unknown> }).processes.uatTester).toEqual({
      provider: 'codex',
      instructions: 'Focus on API endpoints.',
    });

    const cleared: Record<string, unknown> = {
      draft: { processes: { uatTester: { provider: 'codex', instructions: 'Focus on API.' } } },
      markDirty: () => {},
      renderProcessAssignments: () => {},
    };
    const clearSource = `
      ${functionSource('updateProcessAssignment')}
      updateProcessAssignment('uatTester', { instructions: '' });
    `;
    runInNewContext(clearSource, cleared);
    expect((cleared.draft as { processes: Record<string, unknown> }).processes.uatTester).toEqual({
      provider: 'codex',
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ui/settings/webview.test.ts -t instructions`
Expected: FAIL — the HTML has no `PROCESS_KEYS_WITH_INSTRUCTIONS`, no `data-proc-field="instructions"`.

- [ ] **Step 3: Add the CSS for the wide field**

In `src/ui/settings/webview.html`, next to the existing `.proc-row .proc-field{...}` rule (line 441), add:

```css
  .proc-row .proc-field-wide{flex:1 1 100%}
```

- [ ] **Step 4: Add the mirrored constant**

In `src/ui/settings/webview.html`, directly after the `PROCESS_KEYS` definition (line 3124), add:

```js
  // The two roles whose prompts consume `processes.<key>.instructions` (UAT
  // Tester / Review findings); the other roles keep their own fixed prompt
  // paths, so they offer no Instructions control (no dead field). Mirrored
  // from the consumption sites — pinned by webview.test.ts (UI-R34).
  const PROCESS_KEYS_WITH_INSTRUCTIONS = ['uatTester', 'review'];
```

- [ ] **Step 5: Render the textarea in the row template**

In `src/ui/settings/webview.html`, inside `renderProcessAssignmentRow`, after the Display name `.proc-field` div (the `agentName` input block ending at line 3208) and before the closing `+ \`</div>\`` of `.proc-fields` (line 3209), add:

```js
      + (PROCESS_KEYS_WITH_INSTRUCTIONS.includes(key) ? `<div class="proc-field proc-field-wide">`
        + `<label for="proc-${key}-instructions">Instructions</label>`
        + `<textarea id="proc-${key}-instructions" class="proc-input" data-proc-field="instructions" data-proc-key="${key}" rows="4" aria-label="${esc(label)} — instructions" placeholder="Blank = the built-in prompt">${esc(cfg.instructions || '')}</textarea>`
        + `<span class="proc-hint">Blank = the built-in prompt. Replaces the role/strategy section; the JSON output rules stay fixed.</span>`
        + `</div>` : '')
```

- [ ] **Step 6: Extend the input handler so typing keeps focus**

In `src/ui/settings/webview.html`, replace the `input` listener (lines 2573-2577) with:

```js
  document.addEventListener('input', (e) => {
    const t = e.target;
    // agentName and instructions commit per keystroke WITHOUT a re-render, so
    // the field being typed into never loses focus; the `change` listener
    // above still commits them on blur.
    if (!t.dataset || (t.dataset.procField !== 'agentName' && t.dataset.procField !== 'instructions')) return;
    updateProcessAssignment(t.dataset.procKey, { [t.dataset.procField]: t.value }, { rerender: false });
  });
```

- [ ] **Step 7: Run the webview tests**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: all pass — the three new tests plus the untouched row-render assertions at lines 2084-2100.

- [ ] **Step 8: Run the settings suite + full verification**

Run: `npx vitest run src/ui/settings/` then `npm test` then `npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: settings exposes instructions field for uatTester and review"
```

---
## Self-Review

**Spec coverage:**
- "add `instructions?: string` to ProcessConfig" → Task 1.
- "validate instructions field" → Task 1 (string-typed, blank normalizes to unset).
- "round-trip instructions in writeManifest" → Task 1 Step 6-7 (no write.ts change needed — the block is written wholesale; the round-trip test pins it).
- "tester.ts accept optional user instructions, prepend to output rules" → Task 3.
- "stages/uat.ts thread instructions" → Task 3 Step 5: the snapshot already reaches `runUatTester` via `opts.assignment`, so no stage edit is required (documented in the task).
- "review same pattern" → Task 4 (same snapshot-carrier rationale; `stages/review.ts` verified untouched in Task 4 Step 7).
- "processAssignment.ts resolve instructions" → Task 2.
- "settings UI expose instructions" → Task 5.
- Acceptance: blank/absent → built-in prompts (existing byte-compat tests untouched); replaces role/strategy, rules remain (Tasks 3/4 tests); parseFindings still parses (Task 4 Step 2); round-trip (Task 1); UI shows field for tester+reviewer only (Task 5); `npm test` + `npm run typecheck` (each task's verification).

**Placeholder scan:** no TBD/TODO; every step carries real code and expected results.

**Type consistency:** `instructions?: string` on `ProcessAssignmentConfig` (Task 1) → `ProcessAssignmentSnapshot.instructions?: string` (Task 2) → consumed as `opts.assignment.instructions` (Task 3) and `opts.process?.assignment.instructions` (Task 4) → bound as `draft.processes[key].instructions` and `cfg.instructions` in the webview (Task 5). `buildTesterPrompt(target, instructions?)` / `buildFindingsPrompt(repo, baseRef?, instructions?)` signatures match every call site and test.
