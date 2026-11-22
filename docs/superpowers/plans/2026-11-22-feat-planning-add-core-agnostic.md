# Core-agnostic draft contract and `--file` transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the planning preamble tell every agent core (claude, codex, opencode, opencode2, antigravity) what goes in `description`, `summary` and `constraints`, replace the heredoc propose form with a double-quoted `--file` form, ask the planner to act on host warnings, and keep `eval:form --pass plan` able to run the `--file` form.

**Architecture:** `planningInstructions` (`src/planning/preamble.ts`) stays a pure string builder. It gets one new pure helper, `draftContract(artifactsDir)`, and one new helper, `longTextLine(cli, artifactsDir)`. The eval bench (`scripts/evalForm/planRun.mjs`, `run.mjs`) passes the same artifacts dir to the preamble and to the headless env, and allows one `Edit(//<artifacts>/**)` rule.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest 4, plain `.mjs` bench scripts.

**Spec:** the ticket description of T1314 (`karst context FEAT-PLANNING-ADD-CORE-AGNOSTIC`) and its Context brief (D785).

## Global Constraints

- No `<<` heredoc text anywhere in the preamble.
- Double-quote every shell variable: `node "$KARST_CLI" draft propose --file "$KARST_ARTIFACTS/draft.json"`.
- When `artifactsDir` is absent, the preamble contains zero `KARST_ARTIFACTS` text.
- Keep `printf '%s' '…' | node "$KARST_CLI" draft propose` and `ONE shell command` (pinned in `preamble.test.ts:40-41`).
- Keep `MCP_TOOLS_PREFERRED` as it is. Do not claim that the MCP `draft` tool is mounted in a planning session.
- Do not wire launch-time MCP into `planningOps.ts`. Do not touch `src/ui/**`.
- `planTools` keeps its two `Bash(node …)` entries and never allows a bare `node`.
- The resident addition is about 160 tokens (`@arch:RESIDENT`).

## Deviations from the spec (decided, with evidence)

1. **`preamble.test.ts:97`** asserts that `/s/7/artifacts` occurs once. The spec adds the literal `/s/7/artifacts/draft.json` for `agy`, so the count becomes 2. The test changes on purpose: it pins the artifacts line once and the `--file` line once.
2. **`@arch:PLANNING-HISTORY` checklist bullet** says to cite sources "in the draft summary". The new contract puts citations in `constraints`. The bullet changes in the same commit.
3. **Bench write rule.** The claude headless adapter takes `allowedTools` as-is. `src/agent/claude.ts:328` writes an artifacts rule as `Edit(/<abs>/**)` (an Edit rule covers Write, Edit and MultiEdit). `planTools(cliEntry, artifactsDir)` uses the same form.
4. **Artifacts path in `planRun.mjs`** is `join(scratch, 'artifacts')`, the same rule as the existing `join(scratch, 'outbox')`. `planRun.mjs` runs under plain node and cannot import `preamble.ts` statically. `run.mjs` uses `preamble.planningArtifactsDir(w.scratch)`. A test pins that the two agree.

---

### Task 1: Preamble draft contract and `--file` transport

**Files:**
- Modify: `src/planning/preamble.ts:156-164` (checklist item 4), `src/planning/preamble.ts:223-230` (propose lines)
- Test: `src/planning/preamble.test.ts`

**Interfaces:**
- Produces: `planningInstructions(input)` text with the exact lines below. No new export.

- [ ] **Step 1: Write the failing tests** in `src/planning/preamble.test.ts`.

Remove `'-file'` from the banned list at L46 and add a comment: `// '--file' is allowed: structured input (commandInput.ts) is the long-text propose path.`

Replace the test at L94-99 with:

```ts
  it('names the artifacts dir once as the place for session files, and once in the --file propose line', () => {
    const text = planningInstructions({ sessionId: 7, title: 'T', manifest, artifactsDir: '/s/7/artifacts' });
    expect(text).toContain('$KARST_ARTIFACTS (/s/7/artifacts)');
    expect(text.match(/\/s\/7\/artifacts/g)).toHaveLength(2);
    expect(text).toContain(
      'For long text, write the JSON object to /s/7/artifacts/draft.json ("$KARST_ARTIFACTS/draft.json") and run: node "$KARST_CLI" draft propose --file "$KARST_ARTIFACTS/draft.json"',
    );
    expect(planningInstructions({ sessionId: 7, title: 'T', manifest })).not.toContain('KARST_ARTIFACTS');
  });
```

Add a new `describe`:

```ts
describe('planningInstructions draft contract', () => {
  const plain = planningInstructions({ sessionId: 1, title: 't', manifest });
  const withDir = planningInstructions({ sessionId: 1, title: 't', manifest, artifactsDir: '/a b/artifacts' });

  it('never recommends a heredoc', () => {
    for (const t of [plain, withDir]) expect(t).not.toContain('<<');
  });

  it('names a generic --file path without an artifacts dir', () => {
    expect(plain).toContain('For long text, write the JSON object to a file and run: node "$KARST_CLI" draft propose --file <path>');
  });

  it('double-quotes the artifacts path, even with a space in it', () => {
    expect(withDir).toContain('/a b/artifacts/draft.json');
    expect(withDir).toContain('--file "$KARST_ARTIFACTS/draft.json"');
    expect(withDir).not.toMatch(/--file \$KARST_ARTIFACTS/);
  });

  it('states the handoff, and names KARST_ARTIFACTS only with an artifacts dir', () => {
    expect(plain).toContain('never this conversation or a plan file you wrote):');
    expect(withDir).toContain('never this conversation or a plan file you wrote, also in $KARST_ARTIFACTS):');
  });

  it('gives each field one role and forbids inversion and duplication', () => {
    for (const t of [plain, withDir]) {
      expect(t).toContain('- "description" is the self-contained execution spec');
      expect(t).toMatch(/ticket prompt and the UAT criteria/);
      expect(t).toMatch(/exact ordered edits/);
      expect(t).toMatch(/acceptance criteria/);
      expect(t).toMatch(/Never a vague blurb or a path to a local plan file/);
      expect(t).toContain('- "summary" holds the decisions reached, the options rejected with reasons, and the key risks');
      expect(t).toContain('NOT a copy of "description" and NOT where the implementation plan lives');
      expect(t).toContain('- "constraints" holds bare @arch:KEY / @ui:KEY tokens');
    }
  });

  it('asks the planner to read warnings and revise in place', () => {
    expect(plain).toContain('After each propose, read the returned "warnings" or the host rejection error');
    expect(plain).toMatch(/revise the draft in place with "id"/);
  });

  it('asks for bare design-key tokens in the checklist', () => {
    expect(plain).toContain('4. Cite what you relied on in the draft\'s "constraints" as bare tokens');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/planning/preamble.test.ts`
Expected: FAIL on the new contract tests and on the count of 2.

- [ ] **Step 3: Write the minimal implementation** in `src/planning/preamble.ts`.

Checklist item 4:

```ts
  '4. Cite what you relied on in the draft\'s "constraints" as bare tokens: `@arch:KEY` / `@ui:KEY` (no trailing prose), commit hashes, D<n>/T<n> refs.',
```

New helpers above `planningInstructions`:

```ts
/** The long-text propose line: `--file`, double-quoted; a literal absolute path when the artifacts dir is known. */
function longTextLine(cli: string, artifactsDir: string | undefined): string {
  if (!artifactsDir) return `For long text, write the JSON object to a file and run: node ${cli} draft propose --file <path>`;
  const ref = `$${PLANNING_ARTIFACTS_ENV}/draft.json`;
  return `For long text, write the JSON object to ${artifactsDir}/draft.json ("${ref}") and run: node ${cli} draft propose --file "${ref}"`;
}

/** The resident draft contract (@arch:RESIDENT): field roles and the warning loop. */
function draftContract(artifactsDir: string | undefined): string[] {
  const where = artifactsDir ? `, also in $${PLANNING_ARTIFACTS_ENV}` : '';
  return [
    `Draft contract (the implementing agent and the UAT tester see only the draft, never this conversation or a plan file you wrote${where}):`,
    '- "description" is the self-contained execution spec: Review shows it first, and it becomes the ticket prompt and the UAT criteria.',
    '  Put the full verified plan in it: the root cause in verified files/symbols, the exact ordered edits, the scope boundaries',
    '  (no workarounds or unrequested refactors; split work over ~10k chars into drafts linked by "dependsOn"),',
    '  and explicit acceptance criteria with the test/verification commands. Never a vague blurb or a path to a local plan file.',
    '- "summary" holds the decisions reached, the options rejected with reasons, and the key risks; it becomes the ticket brief.',
    '  It is NOT a copy of "description" and NOT where the implementation plan lives. Propose one draft per piece of work.',
    '- "constraints" holds bare @arch:KEY / @ui:KEY tokens, commit hashes, D<n>/T<n> refs and short invariants the tests must check.',
    'After each propose, read the returned "warnings" or the host rejection error, and revise the draft in place with "id" to fix each real defect before you finish.',
  ];
}
```

In `planningInstructions`, replace L226 with `longTextLine(cli, input.artifactsDir),` and replace L229-230 with `...draftContract(input.artifactsDir),`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/planning/preamble.test.ts src/agent/promptText.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planning/preamble.ts src/planning/preamble.test.ts
git commit -m "feat(planning): resident draft contract and --file propose transport"
```

### Task 2: Bench passes the artifacts dir and allows `--file`

**Files:**
- Modify: `scripts/evalForm/planRun.mjs:10,38-47,75-78`, `scripts/evalForm/run.mjs:284`
- Test: `scripts/evalForm/plan.test.mjs`

**Interfaces:**
- Consumes: `planningArtifactsDir(scratch)` from `src/planning/preamble.ts`.
- Produces: `planTools(cliEntry: string, artifactsDir?: string): string[]`; `runPlannerHeadless({ …, artifactsDir? })`.

- [ ] **Step 1: Write the failing tests** in `scripts/evalForm/plan.test.mjs` (`describe('plan allowed tools and cleanup')`):

```js
  it('allows one Edit rule for the artifacts dir only, and keeps the two node prefixes', () => {
    expect(planTools(CLI, '/w/artifacts')).toEqual([...planTools(CLI), 'Edit(//w/artifacts/**)']);
    expect(planTools(CLI).some((x) => x.startsWith('Edit('))).toBe(false);
  });
  it('the --file propose command matches an allowed prefix, and the env names the same artifacts dir', async () => {
    const scratch = tmp();
    const artifactsDir = planningArtifactsDir(scratch);
    const instructions = planningInstructions({ sessionId: 1, title: 't', manifest: buildPlanManifest('core', '/w'), artifactsDir });
    expect(instructions).toContain(`${artifactsDir}/draft.json`);
    const cmd = /run: (node "\$KARST_CLI" draft propose) --file "\$KARST_ARTIFACTS\/draft\.json"/.exec(instructions)?.[1];
    const prefixes = planTools(CLI).filter((x) => x.startsWith('Bash(node')).map((x) => x.slice(5, -3));
    expect(prefixes).toContain(cmd);
    let seen;
    await run(fakeAdapter((o) => { seen = o; }), { cliEntry: CLI, artifactsDir });
    expect(seen.env).toMatchObject({ KARST_ARTIFACTS: artifactsDir, KARST_PLANNING_SESSION: '1' });
    expect(seen.allowedTools).toEqual(planTools(CLI, artifactsDir));
    expect(existsSync(artifactsDir)).toBe(true);
  });
  it('runPlanEval derives the artifacts dir as planningArtifactsDir(scratch)', async () => {
    const r = makeRepo();
    const scratch = tmp();
    let seen;
    const item = { id: 'c', repo: 'core', title: 'T', body: 'B', baseSha: r.base, fixPatch: FIX, testPatch: '', f2p: [] };
    await runPlanEval({
      opts: { judgeModel: 'j', maxDrafts: 3, timeoutMin: 1 }, items: [item], models: ['p'],
      adapter: fakeAdapter((o) => { seen = o; }), judgeAdapter: null,
      makeWork: () => ({ checkout: r.dir, scratch, cleanup: () => {} }),
      buildPrompt: () => ({ instructions: 'I', kickoff: 'K' }), validate: validateProposal, cliEntry: '/cli.js', cwd: tmp(),
    });
    expect(seen.env.KARST_ARTIFACTS).toBe(planningArtifactsDir(scratch));
  });
```

Add `existsSync` to the `node:fs` import and `planningArtifactsDir` to the `preamble.ts` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/evalForm/plan.test.mjs`
Expected: FAIL (no `Edit(` rule, no `KARST_ARTIFACTS` in env).

- [ ] **Step 3: Write the minimal implementation**

`planRun.mjs`:

```js
/** Read tools plus ONLY the propose command (pipe and `--file` forms), and file writes only under the artifacts dir. No bare `node:*`: it would allow `node -e` writes outside the copy. */
export const planTools = (cliEntry, artifactsDir) => [
  'Read', 'Grep', 'Glob', 'Bash(printf:*)', `Bash(node ${cliEntry} draft propose:*)`, 'Bash(node "$KARST_CLI" draft propose:*)',
  ...(artifactsDir ? [`Edit(/${artifactsDir}/**)`] : []),
];
```

In `runPlannerHeadless`, take `artifactsDir`, `mkdirSync(artifactsDir, { recursive: true })` when set, pass `allowedTools: planTools(cliEntry, artifactsDir)` and
`env: { KARST_OUTBOX: outbox, KARST_CLI: cliEntry, KARST_PLANNING_SESSION: '1', ...(artifactsDir ? { KARST_ARTIFACTS: artifactsDir } : {}) }`.

In `runPlanEval`, pass `artifactsDir: join(w.scratch, 'artifacts')`.

`run.mjs:284`: `preamble.planningInstructions({ sessionId: 1, title: item.title, manifest: buildPlanManifest(item.repo, w.checkout), artifactsDir: preamble.planningArtifactsDir(w.scratch) })`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/evalForm/plan.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/evalForm/planRun.mjs scripts/evalForm/run.mjs scripts/evalForm/plan.test.mjs
git commit -m "feat(eval): plan bench passes KARST_ARTIFACTS and allows draft propose --file"
```

### Task 3: Docs

**Files:**
- Modify: `docs/arch/cli.md` (`@arch:PLANNING-HISTORY`), `docs/arch/prompt-metrics.md` (`@arch:FORMEVAL-PLAN`)

- [ ] **Step 1:** In `@arch:PLANNING-HISTORY`, change the checklist bullet to cite in `constraints` as bare tokens. Add a **Draft contract** bullet (field roles, warning loop, why resident per `@arch:RESIDENT`, `@arch:PRE-BASELINE` baseline numbers from the ticket) and a **Propose transport** bullet (`printf … |` fallback, `--file "$KARST_ARTIFACTS/draft.json"` with the literal path for `agy`, no heredoc, no `KARST_ARTIFACTS` text without `artifactsDir`).
- [ ] **Step 2:** In `@arch:FORMEVAL-PLAN`, state that `planRun.mjs` also sets `KARST_ARTIFACTS` (`<scratch>/artifacts`) and `KARST_PLANNING_SESSION`, and allows `Edit(//<artifacts>/**)`.
- [ ] **Step 3:** Run `npm run -s typecheck` and `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs` after the commit. If the gate blocks on a block that still holds, run `karst arch cite @arch:KEY --why "<reason>"`.
- [ ] **Step 4: Commit**

```bash
git add docs/arch/cli.md docs/arch/prompt-metrics.md
git commit -m "docs(arch): draft contract, --file transport and bench artifacts dir"
```
