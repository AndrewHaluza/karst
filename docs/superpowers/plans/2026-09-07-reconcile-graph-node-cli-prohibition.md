# Reconcile graph-node CLI prohibition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the over-broad "do not call any karst CLI verb" prohibition from the graph-node prompt and replace it with the read/write split (forbid the ticket-driving verbs, permit the read verbs), pinning the layering so the session seed's guide pointer and done-marker never reach a node session.

**Architecture:** A graph node session is composed by `composeNodePrompt` (`src/approaches/graph/executors/agent.ts`), which concatenates the `karst-graph-node` prompt (= `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md`), the appended outcome reporter, ticket context, the instructions artifact and input artifacts. It does **not** pass through `buildSessionSeed` (`src/agent/seed.ts`), so the seed's `renderGuideInstruction` pointer and `renderDoneMarkerInstruction` marker never reach a node today. Because the prohibition text lives only in the skill, narrowing it is a markdown edit; the behaviour is protected by two tests: a content guard on the packaged skill's CLI-boundary wording, and a composition guard asserting the node prompt carries no seed guide pointer / stage marker.

**Tech Stack:** TypeScript (ESM), vitest, node:fs. No new dependencies. The `.agents/.../graph-node/SKILL.md` is the built-in package source (`builtInPackageDir` resolves it) and is the exact file `karst-graph-node` prompt bytes resolve from.

**Spec:** ticket `PROMPT-04-GRAPH-NODE-CLI-CONFLICT` — reconcile the graph-node CLI prohibition with the session seed's guide pointer. The plan argues from the ticket; executors read both.

## Global Constraints

- Conventional commit, ONE commit for the whole change, exact message: `fix: reconcile graph-node CLI prohibition with the session seed's guide pointer`
- The read/write split is the only axis: a node may not call the ticket-**driving** verbs (`stage`, `phase`, `graph submit`) because it is not the ticket's driver; that reason does not extend to **reading** state, so the read verbs (`context`, `guide`) are explicitly permitted.
- Edit the SOURCE skill `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` — never a `dist/` copy (dist assets are mirrored by `scripts/copy-assets.mjs`, not hand-edited).
- Do NOT modify `src/agent/seed.ts` or `src/approaches/graph/driver.ts` / `executors/agent.ts` logic. The investigation concluded the layering is already correct (nodes bypass the seed); this ticket only narrows the wording and pins the layering.
- `import.meta.dirname` is the test-cwd-safe way to resolve repo-relative paths (already used by `src/approaches/packageParity.test.ts`). Do not rely on `process.cwd()`.
- Keep files small; tests colocated as `<name>.test.ts`.
- Typecheck / unit-test gate: `npm run typecheck`, `npx vitest run <file>`.

---

### Task 1: Pin the narrowed node CLI-boundary wording in the packaged skill (RED)

**Files:**
- Modify: `src/approaches/packageParity.test.ts` (add one `it` in the `describe('built-in package VSIX parity', ...)` block, next to the existing planner prompt-guard `it` at ~line 59)

**Interfaces:**
- Consumes: `builtInPackageDir` (already imported), `repoRoot`, `readFileSync`, `join` (already imported).
- Produces: no new exports. Establishes the exact wording contract Task 2 must satisfy: a `ticket-driving` line that names `stage`, `phase`, `graph submit` and negates them; a `read verbs` line that names `context` and `guide`; and the absence of the blanket phrase `any other karst CLI verb`.

- [ ] **Step 1: Add the failing content-guard test**

Add this `it` inside the existing `describe('built-in package VSIX parity', ...)` in `src/approaches/packageParity.test.ts`, immediately after the existing `it('the planner prompt does not grant gate capabilities that do not exist', ...)` block (ends at line ~82):

```ts
it('the node prompt narrows the CLI prohibition to driving verbs and permits read verbs', () => {
  const body = readFileSync(
    join(packageRoot, 'skills', 'graph-node', 'SKILL.md'),
    'utf8',
  );
  // The read/write split (prompt-04): a node may not fire the ticket-DRIVING
  // verbs because it is not the ticket's driver; that reason does NOT extend to
  // reading state, so the read verbs are explicitly permitted. The blanket "or
  // any other karst CLI verb" wording must never come back.
  expect(body).not.toContain('any other karst CLI verb');
  const driving = body
    .split('\n')
    .find((l) => l.toLowerCase().includes('ticket-driving'));
  expect(driving, 'a ticket-driving prohibition line').toBeTruthy();
  for (const verb of ['stage', 'phase', 'graph submit']) {
    expect(driving!.toLowerCase()).toContain(verb);
  }
  expect(driving!.toLowerCase()).toMatch(/\b(not|never|may not|do not)\b/);
  const reading = body.split('\n').find((l) => /read verbs?/i.test(l));
  expect(reading, 'a read-verb permission line').toBeTruthy();
  expect(reading!.toLowerCase()).toContain('context');
  expect(reading!.toLowerCase()).toContain('guide');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/approaches/packageParity.test.ts -t "narrows the CLI prohibition"`
Expected: FAIL — the current SKILL still contains `any other karst CLI verb`, has no `ticket-driving` line, and has no `read verbs` line.

- [ ] **Step 3: (no code change in this task — RED is confirmed)**

Leave the skill file unchanged in this task; the next task turns it green.

---

### Task 2: Narrow the graph-node prohibition to driving verbs and permit the read verbs (GREEN)

**Files:**
- Modify: `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` — the `## Boundaries` bullet currently reading (lines 66-68):
  > `- Do not call the stage marker CLI or any other karst CLI verb — you are one`
  > `  node in a run, not a ticket's driver. The graph's guarded IMPL pass is`
  > `  handled by the run itself.`

**Interfaces:**
- Consumes: the wording contract pinned in Task 1.
- Produces: the new boundary wording that makes Task 1's guard pass. This is the text of the `karst-graph-node` prompt a node session reads.

- [ ] **Step 1: Replace the single prohibition bullet with the read/write split**

Replace the one bullet quoted above (exactly — it is the only bullet containing "CLI verb") with these two bullets:

```markdown
- Do not fire the ticket-driving verbs — `stage`, `phase`, `graph submit` — or
  any other transition you do not own: you are one node in a run, not a
  ticket's driver. The graph's guarded IMPL pass and every ticket transition
  are handled by the run itself.
- You MAY run the read verbs — `context`, `guide` — to read the ticket's live
  state. Reading does not make you the driver; only driving the ticket does.
```

- [ ] **Step 2: Run the guard test to verify it passes**

Run: `npx vitest run src/approaches/packageParity.test.ts -t "narrows the CLI prohibition"`
Expected: PASS.

- [ ] **Step 3: Re-run the full parity file to confirm nothing else drifted**

Run: `npx vitest run src/approaches/packageParity.test.ts`
Expected: PASS (all existing parity guards intact).

---

### Task 3: Pin that a node-launch prompt never carries the session seed's guide pointer (layering guard)

**Files:**
- Modify: `src/approaches/graph/transport/env.test.ts` — add one `it` in the existing `describe('graph seed contract', ...)` block (currently a single `it` at lines 79-94)

**Interfaces:**
- Consumes: `composeNodePrompt` (already imported), and the `renderGuideInstruction` prefix phrase `To understand how Karst works and what this CLI can do, run` from `src/cli/guide.ts`.
- Produces: no new exports. Pins the outcome of this ticket's investigation: a node session prompt is composed from the node layers only, so neither the seed's done-marker instruction nor its guide pointer may drift back into a node launch.

- [ ] **Step 1: Add the guide-pointer absence assertion**

Add this `it` inside `describe('graph seed contract', ...)` in `src/approaches/graph/transport/env.test.ts`, after the existing `it('a graph node seed contains no done-marker instruction and no cliStagePrefix', ...)`:

```ts
it('a node launch prompt carries no session-seed guide pointer', () => {
  // A graph node session is composed from its own layers (node base prompt,
  // ticket context, instructions, inputs) and does NOT pass through
  // buildSessionSeed, so the seed's `renderGuideInstruction` pointer must not
  // appear in the node prompt (prompt-04 layering pin). Reading state stays
  // PERMITTED by the node prompt itself; the seed nudge is simply absent.
  const seed = composeNodePrompt(
    '# karst-graph-node',
    '# ticket context',
    '# instructions',
    ['# input artifact'],
  );
  expect(seed).toContain('# karst-graph-node');
  expect(seed).not.toContain('To understand how Karst works');
  expect(seed).not.toContain('guide');
  expect(seed).not.toMatch(/stage\s+(impl|fix)\s+pass/);
});
```

- [ ] **Step 2: Run it to verify it passes (documents current, correct layering)**

Run: `npx vitest run src/approaches/graph/transport/env.test.ts`
Expected: PASS. This test is the drift guard: it is green today and must stay green. If a future change routes the seed's guide pointer (or a `stage … pass` marker) into node launches, this test goes red and forces a deliberate reconciliation.

- [ ] **Step 3: Run the seed composition tests to confirm the two seams are consistent**

Run: `npx vitest run src/agent/seed.test.ts src/approaches/graph/transport/env.test.ts`
Expected: PASS — the driver/approach/solo seed still composes its guide pointer (`seed.test.ts`), while the node prompt (env test) never receives it.

---

### Task 4: Full verification and single commit

**Files:**
- No new file changes beyond Tasks 1-3. This task verifies and commits.

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the touched test files**

Run: `npx vitest run src/approaches/packageParity.test.ts src/approaches/graph/transport/env.test.ts`
Expected: all pass.

- [ ] **Step 3: Review the diff**

Run: `git -C <worktree> diff --stat && git -C <worktree> diff`
Expected: exactly two source changes — `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` (the read/write split) and `src/approaches/graph/transport/env.test.ts` — plus `src/approaches/packageParity.test.ts`. No `seed.ts`/`driver.ts`/`agent.ts` logic changes. No `dist/` edits.

- [ ] **Step 4: Commit**

```bash
git add .agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md src/approaches/packageParity.test.ts src/approaches/graph/transport/env.test.ts
git commit -m "fix: reconcile graph-node CLI prohibition with the session seed's guide pointer"
```

- [ ] **Step 5: Confirm the tree is clean**

Run: `git status`
Expected: nothing to commit, working tree clean.

---

## Self-Review

**1. Spec coverage**
- Scope item 1 (investigation writeup): the investigation is documented in the plan header/architecture (and reflected in Task 3's rationale). Outcome 1 confirmed — node receives only the node prompt, not the seed; therefore narrow the wording (this is the chosen outcome).
- Scope item 2 (narrow prohibition to driving verbs, permit read verbs): Task 1 (guard) + Task 2 (edit) — forbids `stage`, `phase`, `graph submit`; permits `context`, `guide`.
- Scope item 3 (test pinning which instruction blocks compose): Task 3 pins the node-launch prompt carries no guide pointer and no stage marker; Task 1 pins the skill wording. Layering cannot drift back.
- Commit message: Global Constraints + Task 4 uses the exact prescribed message.

**2. Placeholder scan:** no TBD/TODO; each code/markdown step gives the literal content to add/replace and the exact run command + expected result.

**3. Type consistency:** test helper imports (`builtInPackageDir`, `readFileSync`, `join`, `composeNodePrompt`) already exist in the target files; no new functions or renames introduced across tasks. The guard phrase `To understand how Karst works` matches `renderGuideInstruction`'s literal prefix in `src/cli/guide.ts:132-137`.
