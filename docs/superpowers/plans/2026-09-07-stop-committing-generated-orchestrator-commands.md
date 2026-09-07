# Stop Committing Machine-Specific Generated Orchestrator Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the checked-in, machine-path-baked generated workflow skill `.agents/skills/karst-rpi/SKILL.md` from the repository, ignore it going forward, and add a guard test that fails if any file under `.agents/` ever again contains an absolute path outside the repository.

**Architecture:** Three changes, in TDD order. First a new vitest guard (`src/agent/agentsTreeGuard.test.ts`) that walks the tracked `.agents/` tree and asserts no absolute-machine-path substring — RED on the current tree. Then delete the one offending file (`git rm`) — GREEN. Then close the loop so it cannot come back: a `.gitignore` entry for that exact directory, and a regression test pinning the reason (`writeGeneratedArtifact` refuses to overwrite an unstamped tracked file, so a committed copy does not merely go stale — it permanently blocks regeneration).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, `node:fs`/`node:path`, `git`.

**Spec:** the ticket body of `PROMPT-02-GENERATED-ARTIFACTS` (Karst ticket), reproduced in the Findings section below. There is no separate spec file.

## Global Constraints

- ESM: every relative import needs an explicit `.js` suffix; `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` is on: array/index access needs `!` or a guard.
- Strict TDD: write the failing test, run it, see it fail, then fix. No implementation before a RED run.
- Conventional commits. Final commit subject is fixed by the ticket: `fix: stop committing machine-specific generated orchestrator commands`.
- Keep files small (<400 lines typical).
- Tests are colocated beside the module they cover (`src/<area>/<name>.test.ts`), matching the existing repo convention (e.g. `src/runtime/karstExcludes.test.ts`).
- Unit tests run with `npm run test:unit`; a single file with `npx vitest run <path>`.
- Do NOT touch `KARST_EXCLUDE_RULES` in this ticket — see Finding 4. That list is already correct.

---

## Findings (read this before starting — it is the whole argument)

These were established by inspecting the tree; an executor who skips them will delete the wrong files.

**Finding 1 — exactly one file leaks.**
`grep -rlE '/Users/|/home/|C:\\' .agents` over the tracked tree returns exactly one path:
`.agents/skills/karst-rpi/SKILL.md`. `.agents/skills/karst-two-phase/**` does not exist in this repository at all (the ticket asked us to check; the answer is "not present, nothing to do").

**Finding 2 — that file is generated output, not source.**
Its body is verbatim `renderWorkflowCommand` output (`src/agent/workflowCommand.ts`), materialized by `CodexAdapter.materializeApproach` (`src/agent/codex.ts:750-770`), which writes to `join(opts.sessionDir, '.agents', 'skills', prefix)` where `prefix = karst-<idSlug>`. Its git history is a single commit (`7abfe3e add templates for commits and PRs (#9)`) — it has never been hand-edited. The absolute paths in it (`/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js`, the Cursor-family `globalStorage/karst.karst/karst.db`, `/Users/nd/Work/projects/karst/.karst/karst.yml`) are the `cliContextPrefix` / `cliStagePrefix` / `cliPhasePrefix` values from one developer's machine at materialize time. **Verdict: generated. Remove it.**

**Finding 3 — the committed copy actively BLOCKS regeneration; it is not merely stale.**
The tracked file predates `src/agent/generatedArtifact.ts` and therefore does not carry `GENERATED_STAMP` (`<!-- karst:generated — rewritten on every launch -->`). `writeGeneratedArtifact` refuses to clobber any existing file lacking that stamp:

```ts
export function writeGeneratedArtifact(path: string, content: string): boolean {
  if (existsSync(path) && !isGeneratedArtifact(path)) return false;
  ...
}
```

So on every clean checkout of this repo, `materializeApproach` finds the unstamped tracked file, returns `false`, and leaves another machine's dead commands in place forever. This is the sharpest reason the file must leave git, and Task 3 pins it as a regression test.

**Finding 4 — DO NOT widen or add a `KARST_EXCLUDE_RULES` entry.**
`src/runtime/karstExcludes.ts` already carries `'/.agents/skills/karst-*/'`. That is the correct, already-shipped rule and it needs no change. Note *why* it has not been protecting this file: git ignore rules never apply to **tracked** files. The fix is `git rm`, not a new rule.

**Finding 5 — two neighbouring `.agents/` trees are SOURCE. Do not delete or ignore them.**

| Path | Status | Evidence |
| --- | --- | --- |
| `.agents/skills/karst-graph-engineering/**` | **SOURCE — shipped in the VSIX** | `src/approaches/builtInId.ts` declares `BUILT_IN_PACKAGE_PATH = '.agents/skills/karst-graph-engineering'`; `builtInPackageDir(extRoot)` resolves it at runtime. `src/approaches/builtIn.ts` points `planner.prompt.artifact` at `skills/graph-planner/SKILL.md` inside it. Hand-edited repeatedly (`3619707`, `0c92f02`, `58244fa`). |
| `.agents/skills/karst-rpi-*/**` (11 dirs) | **SOURCE — hand-maintained** | Hand-edited in `4155ba4` ("collapse duplicate frontmatter in rpi-implement skill"). Their frontmatter (`argument-hint:`, human-written `description:`) does not match the adapter-generated shape (`Use the <base> workflow from <label>.`). No absolute paths in any of them. |
| `.agents/karst-graph-engineering/*.md` | **SOURCE — deliberate user overrides** | `src/agent/graphPrompts.ts` writes graph prompt OVERRIDES to `<agentsDir>/karst-graph-engineering/<role>.md` — i.e. `.agents/karst-graph-engineering/`, which sits *outside* `.agents/skills/` and is not matched by any rule this plan touches. The ticket explicitly warned about these. |

The `.gitignore` line added in Task 2 names one exact directory for this reason.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/agent/agentsTree.ts` (create, ~50 lines) | Pure, fs-only helpers: walk a directory tree returning relative file paths, and detect absolute-machine-path substrings in text. No vitest, no vscode. One responsibility: "what does the `.agents/` tree contain and does it leak host paths". |
| `src/agent/agentsTree.test.ts` (create, ~60 lines) | Unit tests for the helpers against a temp fixture tree — proves the detector catches `/Users/`, `/home/`, `C:\` and does not false-positive on repo-relative paths. |
| `src/agent/agentsTreeGuard.test.ts` (create, ~45 lines) | The repository-level guard. Walks the real `.agents/` tree at the repo root and asserts zero leaks. This is the assertion the ticket demands, and it is the RED in Task 1. |
| `src/agent/generatedArtifact.test.ts` (modify) | Add the Finding-3 regression: an unstamped file at a generated artifact's path is never overwritten — the reason a committed copy must not exist. |
| `.gitignore` (modify) | One narrow entry keeping the regenerated skill out of future commits. |
| `.agents/skills/karst-rpi/SKILL.md` (delete) | The generated artifact being removed from git. |

Separating `agentsTree.ts` (logic) from `agentsTreeGuard.test.ts` (the repo assertion) is deliberate: ticket 01's `.agents/skills/**` scan harness and ticket 03's corpus scan both need the same walker, and a helper module is importable where a test file is not.

---

### Task 1: The absolute-path guard (RED) and the removal (GREEN)

**Files:**
- Create: `src/agent/agentsTree.ts`
- Create: `src/agent/agentsTree.test.ts`
- Create: `src/agent/agentsTreeGuard.test.ts`
- Delete: `.agents/skills/karst-rpi/SKILL.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (later tasks and tickets 01/03 rely on these exact names):
  - `export function listFilesRecursive(root: string): string[]` — absolute paths of every regular file under `root`, recursively, skipping nothing. Returns `[]` if `root` does not exist.
  - `export const ABSOLUTE_HOST_PATH_PATTERNS: readonly RegExp[]`
  - `export function findAbsoluteHostPaths(text: string): string[]` — every matched absolute-path substring in `text`, deduplicated, in first-seen order.

- [ ] **Step 1: Write the guard test (this is the RED)**

Create `src/agent/agentsTreeGuard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listFilesRecursive, findAbsoluteHostPaths } from './agentsTree.js';

/**
 * Everything under `.agents/` ships to another machine — the graph package is
 * packed into the VSIX, the rpi skills are read by whatever agent the developer
 * runs. An absolute path from the machine that wrote the file is dead on every
 * other one: a different extension install dir, a different IDE-family
 * globalStorage (there are three karst.db instances across VS Code, Cursor and
 * Antigravity), a different checkout root, CI.
 *
 * This guard is the reason `.agents/skills/karst-rpi/SKILL.md` was removed from
 * git: it was `renderWorkflowCommand` output, materialized on one laptop and
 * committed with that laptop's paths baked into every command.
 */
const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const AGENTS_DIR = join(REPO_ROOT, '.agents');

describe('the .agents tree', () => {
  it('contains no absolute path from the machine that wrote it', () => {
    const offenders: string[] = [];
    for (const file of listFilesRecursive(AGENTS_DIR)) {
      const hits = findAbsoluteHostPaths(readFileSync(file, 'utf8'));
      if (hits.length > 0) {
        offenders.push(`${relative(REPO_ROOT, file)}: ${hits.join(', ')}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the helper module**

Create `src/agent/agentsTree.ts`:

```ts
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Absolute paths belonging to the machine a file was WRITTEN on. A generated
 * artifact that carries one is dead everywhere else, so these are the shapes the
 * `.agents/` guard refuses. Deliberately narrow: only path prefixes that can
 * only be a host root, never a repo-relative path a document legitimately names.
 */
export const ABSOLUTE_HOST_PATH_PATTERNS: readonly RegExp[] = [
  // macOS home dirs.
  /\/Users\/[^\s"'`)\]]+/gu,
  // Linux home dirs.
  /\/home\/[^\s"'`)\]]+/gu,
  // Windows drive-letter roots (`C:\Users\...`, `D:\work\...`).
  /[A-Za-z]:\\[^\s"'`)\]]+/gu,
];

/** Every absolute host path in `text`, deduplicated, in first-seen order. */
export function findAbsoluteHostPaths(text: string): string[] {
  const seen = new Set<string>();
  for (const pattern of ABSOLUTE_HOST_PATH_PATTERNS) {
    // A `g` regex carries lastIndex across calls; match on a fresh copy.
    for (const match of text.matchAll(new RegExp(pattern.source, 'gu'))) {
      seen.add(match[0]!);
    }
  }
  return [...seen];
}

/**
 * Absolute paths of every regular file under `root`, recursively. A missing
 * `root` yields `[]` — the caller is asking "what is in this tree", and an
 * absent tree is empty, not an error.
 */
export function listFilesRecursive(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listFilesRecursive(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
```

- [ ] **Step 3: Run the guard and confirm it FAILS**

Run: `npx vitest run src/agent/agentsTreeGuard.test.ts`

Expected: FAIL. The assertion message names the one offender, e.g.

```
.agents/skills/karst-rpi/SKILL.md: /Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js, /Users/nd/Library/Application, /Users/nd/Work/projects/karst/.karst/karst.yml
```

If it names any file other than `.agents/skills/karst-rpi/SKILL.md`, **stop and re-read Finding 5** before deleting anything — the other `.agents/` trees are source and must be de-pathed, not removed.

- [ ] **Step 4: Write the helper unit tests**

Create `src/agent/agentsTree.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { listFilesRecursive, findAbsoluteHostPaths } from './agentsTree.js';

describe('findAbsoluteHostPaths', () => {
  it('catches a macOS home path', () => {
    expect(findAbsoluteHostPaths('node "/Users/nd/dist/cli/main.js" guide'))
      .toEqual(['/Users/nd/dist/cli/main.js']);
  });

  it('catches a Linux home path', () => {
    expect(findAbsoluteHostPaths('--db /home/ci/.local/karst.db'))
      .toEqual(['/home/ci/.local/karst.db']);
  });

  it('catches a Windows drive-letter path', () => {
    expect(findAbsoluteHostPaths('node C:\\Users\\nd\\main.js'))
      .toEqual(['C:\\Users\\nd\\main.js']);
  });

  it('deduplicates a path repeated across lines', () => {
    const text = '/Users/nd/a.js\nand again /Users/nd/a.js\n';
    expect(findAbsoluteHostPaths(text)).toEqual(['/Users/nd/a.js']);
  });

  it('does not flag a repo-relative path a document legitimately names', () => {
    const text = 'see src/agent/workflowCommand.ts and .agents/skills/x/SKILL.md';
    expect(findAbsoluteHostPaths(text)).toEqual([]);
  });

  it('does not flag an absolute path that is not a host root', () => {
    // `/usr/bin/env` and `/tmp` are the same on every machine; the guard is
    // about paths that identify ONE developer's laptop.
    expect(findAbsoluteHostPaths('#!/usr/bin/env node')).toEqual([]);
  });
});

describe('listFilesRecursive', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'agents-tree-'));
    mkdirSync(join(root, 'skills', 'a'), { recursive: true });
    writeFileSync(join(root, 'top.md'), 'top');
    writeFileSync(join(root, 'skills', 'a', 'SKILL.md'), 'nested');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns every file at every depth', () => {
    const found = listFilesRecursive(root)
      .map((path) => relative(root, path))
      .sort();
    expect(found).toEqual([join('skills', 'a', 'SKILL.md'), 'top.md'].sort());
  });

  it('returns an empty list for a tree that does not exist', () => {
    expect(listFilesRecursive(join(root, 'nope'))).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the helper tests and confirm they PASS**

Run: `npx vitest run src/agent/agentsTree.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Remove the generated file from git (this is the GREEN)**

```bash
git rm .agents/skills/karst-rpi/SKILL.md
rmdir .agents/skills/karst-rpi 2>/dev/null || true
```

- [ ] **Step 7: Run the guard and confirm it PASSES**

Run: `npx vitest run src/agent/agentsTreeGuard.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 8: Confirm nothing else in the tree was disturbed**

```bash
git status --porcelain
```

Expected: exactly the deletion of `.agents/skills/karst-rpi/SKILL.md`, plus the three new untracked/added source files. **No other `.agents/` path may appear.** If `karst-graph-engineering` or any `karst-rpi-*` directory shows as deleted, restore it (`git checkout -- .agents/`) and re-read Finding 5.

- [ ] **Step 9: Commit**

```bash
git add src/agent/agentsTree.ts src/agent/agentsTree.test.ts src/agent/agentsTreeGuard.test.ts
git commit -m "fix: stop committing machine-specific generated orchestrator commands

.agents/skills/karst-rpi/SKILL.md was renderWorkflowCommand output,
materialized on one laptop and committed with that laptop's extension
dir, Cursor globalStorage karst.db and checkout root baked into every
command — dead on any other machine, in CI, and under the other two
IDE-family storage dirs.

Guard: no file under .agents/ may contain an absolute host path.
Kept: .agents/skills/karst-graph-engineering (shipped in the VSIX via
BUILT_IN_PACKAGE_PATH) and .agents/skills/karst-rpi-* (hand-maintained)."
```

---

### Task 2: Keep it out of future commits

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `listFilesRecursive` / `findAbsoluteHostPaths` from Task 1 (only indirectly — the Task 1 guard must stay green).
- Produces: nothing importable.

Context an executor needs: karst is developed in the repository it also drives. Launching a session in this checkout runs `CodexAdapter.materializeApproach`, which re-writes `.agents/skills/karst-rpi/SKILL.md` with the *current* machine's paths. `KARST_EXCLUDE_RULES` writes `/.agents/skills/karst-*/` into each **worktree's** `.git/info/exclude`, but the developer's main checkout is not a karst-created worktree, and ship's `git add -A` will happily stage the regenerated file. One `.gitignore` line closes that. It must name the one directory and not the source trees in Finding 5.

- [ ] **Step 1: Add the entry**

Append to `.gitignore`, after the `.karst-plugin/` block (it is the same class of thing — a materialized approach artifact):

```gitignore
# The `karst-rpi` workflow skill CodexAdapter materializes from
# renderWorkflowCommand. karst is developed in the repo it also drives, so every
# launch here rewrites it with THIS machine's extension dir, globalStorage
# karst.db and checkout root — and a committed copy is worse than stale: it
# predates GENERATED_STAMP, so writeGeneratedArtifact refuses to clobber it and
# another machine's dead commands survive forever (see agentsTreeGuard.test.ts).
# Named exactly, NOT as `karst-*`: `.agents/skills/karst-graph-engineering/` is
# shipped in the VSIX (BUILT_IN_PACKAGE_PATH) and `.agents/skills/karst-rpi-*/`
# is hand-maintained — both are source.
/.agents/skills/karst-rpi/
```

- [ ] **Step 2: Verify the rule ignores the generated file and nothing else**

```bash
git check-ignore -v .agents/skills/karst-rpi/SKILL.md
git check-ignore -v .agents/skills/karst-graph-engineering/SKILL.md; echo "exit=$?"
git check-ignore -v .agents/skills/karst-rpi-plan/SKILL.md; echo "exit=$?"
```

Expected: the first prints `.gitignore:<n>:/.agents/skills/karst-rpi/	.agents/skills/karst-rpi/SKILL.md`. The second and third print nothing and report `exit=1` (not ignored — they are source).

- [ ] **Step 3: Verify the source trees are still tracked**

```bash
git ls-files .agents | wc -l
```

Expected: `14` (15 before, minus the one removed file).

- [ ] **Step 4: Confirm regeneration is now unblocked on a clean checkout**

```bash
git stash list   # note the current entries; do not pop anything
git ls-files --error-unmatch .agents/skills/karst-rpi/SKILL.md; echo "exit=$?"
```

Expected: `error: pathspec ... did not match any file`, `exit=1` — the path is untracked, so a fresh clone has no unstamped file there, so `writeGeneratedArtifact` writes rather than refusing. (Task 3 turns that sentence into a test.)

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore the materialized karst-rpi workflow skill"
```

---

### Task 3: Pin the reason — an unstamped file blocks regeneration

**Files:**
- Modify: `src/agent/generatedArtifact.test.ts`

**Interfaces:**
- Consumes: `writeGeneratedArtifact(path: string, content: string): boolean` and `GENERATED_STAMP: string` from `src/agent/generatedArtifact.js` (both already exported).
- Produces: nothing importable.

Why this task exists rather than being folded into Task 1: it is a separate claim about a separate module. Task 1 says "the tree is clean now"; this says "and here is why re-committing it would be worse than untidy". A reviewer could accept one and reject the other.

- [ ] **Step 1: Read the existing test file**

Run: `sed -n '1,30p' src/agent/generatedArtifact.test.ts` — note the existing imports and how it creates temp paths, and match that style rather than introducing a second convention.

- [ ] **Step 2: Write the failing test**

Append to `src/agent/generatedArtifact.test.ts` (adjust the temp-dir helper to whatever the file already uses):

```ts
describe('a checked-in artifact at a generated path', () => {
  it('is never overwritten, so a committed copy outlives the machine that wrote it', () => {
    // The concrete incident: `.agents/skills/karst-rpi/SKILL.md` was committed
    // BEFORE GENERATED_STAMP existed. Every later launch on every other machine
    // hit this branch, left the file alone, and ran an orchestrator command
    // pointing at one laptop's extension dir. Removing it from git is the fix;
    // this is the assertion that says why it must stay removed.
    const dir = mkdtempSync(join(tmpdir(), 'generated-artifact-'));
    const path = join(dir, 'SKILL.md');
    const committed = 'node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" guide';
    writeFileSync(path, committed);

    const wrote = writeGeneratedArtifact(path, withStamp('# regenerated'));

    expect(wrote).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(committed);
    rmSync(dir, { recursive: true, force: true });
  });

  it('IS overwritten once the file carries the stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generated-artifact-'));
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, withStamp('# stale'));

    const wrote = writeGeneratedArtifact(path, withStamp('# regenerated'));

    expect(wrote).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('# regenerated');
    expect(readFileSync(path, 'utf8')).toContain(GENERATED_STAMP);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Ensure the file's import list covers `mkdtempSync`, `writeFileSync`, `readFileSync`, `rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `GENERATED_STAMP`, `withStamp`, `writeGeneratedArtifact` from `./generatedArtifact.js`.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run src/agent/generatedArtifact.test.ts`
Expected: PASS. (These assert existing behaviour, so they are green immediately — that is correct. They are a *regression* pin, not a new feature; the RED for this ticket was Task 1 Step 3.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: all pass. If `src/agent/materializedCleanup.test.ts`, `src/agent/codex.test.ts`, `src/runtime/worktree.test.ts`, `src/ui/session.test.ts` or `src/approaches/builtIn.test.ts` fail, they are the modules that reference `.agents/skills` — read the failure before changing anything; it most likely means a source tree from Finding 5 was deleted by mistake.

- [ ] **Step 6: Commit**

```bash
git add src/agent/generatedArtifact.test.ts
git commit -m "test: pin that an unstamped artifact blocks its own regeneration"
```

---

## Self-Review

**1. Spec coverage.** Each ticket requirement maps to a task:

| Ticket requirement | Where |
| --- | --- |
| Decide generated vs source, from git history, before deleting | Findings 1–3 (already done; Task 1 Step 3 re-confirms before the delete) |
| Check `.agents/skills/karst-two-phase/**` for the same leakage | Finding 1 — the tree does not exist in this repository; the Task 1 guard covers it if it ever appears |
| Remove from git | Task 1 Step 6 |
| Add to `.gitignore` / `KARST_EXCLUDE_RULES` as appropriate | Task 2 (`.gitignore`); Finding 4 explains why `KARST_EXCLUDE_RULES` is deliberately untouched |
| Exclusion must be narrow; must not catch graph prompt overrides | Task 2 Step 1 (exact directory) and Step 2 (three `git check-ignore` assertions); Finding 5 |
| Confirm the materialize path regenerates on a clean checkout | Task 2 Step 4 (the path is untracked) + Task 3 Steps 2–3 (the stamp branch that was blocking it) |
| Guard: no file under `.agents/` may contain `/Users/`, `/home/`, `C:\` | Task 1 Steps 1–2, `agentsTreeGuard.test.ts` + `ABSOLUTE_HOST_PATH_PATTERNS` |
| RED fails on the current tree; GREEN after removal | Task 1 Step 3 (FAIL) → Step 6 (delete) → Step 7 (PASS) |
| Commit message `fix: stop committing machine-specific generated orchestrator commands` | Task 1 Step 9 |
| Reusable by ticket 01's harness and ticket 03's corpus scan | `src/agent/agentsTree.ts` is a plain importable module, not test-file-local |

**2. Placeholder scan.** No TBD/TODO; every code step carries the literal file body; no "similar to Task N".

**3. Type consistency.** `listFilesRecursive(root: string): string[]` and `findAbsoluteHostPaths(text: string): string[]` are declared once in the Task 1 Interfaces block and used with those exact names and arities in `agentsTreeGuard.test.ts` and `agentsTree.test.ts`. `writeGeneratedArtifact` / `withStamp` / `GENERATED_STAMP` are used in Task 3 with the signatures they already have in `src/agent/generatedArtifact.ts`.
