# Graph landWorkspaceChanges binary diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `landWorkspaceChanges` lands workspace diffs of any size, and keeps trailing blank context lines, because git writes each diff to a file and the code concatenates raw bytes.

**Architecture:** Each workspace diff goes to `frag-<i>.patch` through `git diff --binary --output=<file>`. A pure helper `normalizePatchFragment` (new file `patchFragment.ts`) makes each fragment end with one `0x0a` and never trims. `captureChangeSet` and `captureUntrackedPaths` throw when the runner reports `stdoutTruncated`. A `git add` refusal after a landed workspace patch keeps both trees and says in the diagnostic that the changes are already in the canonical worktree.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), Node `node:fs`, vitest 4, real git in temp dirs.

**Spec:** Ticket T1304 `FIX-GRAPH-LANDWORKSPACECHANGES` (`karst context FIX-GRAPH-LANDWORKSPACECHANGES`). Root causes: T1301 nodes 52 and 55 (1 MiB stdout cap), T1297 node 53 (`trimEnd()` corrupt patch).

## Global Constraints

- Do not change `GIT_MAX_OUTPUT_BYTES` in `src/integrations/git.ts` (rejected option).
- Never call `trimEnd()`, `trim()` or a regex trim on patch bytes. Never decode patch bytes as UTF-8.
- On `integration-conflict`, preserve the canonical worktree and the workspace. Never run `git reset` or `git checkout` on a `git add` failure (`pipeline.ts:43-44`, `pipeline.integration.test.ts:491-521`).
- Keep the reason prefix `integration-conflict: git add refused in <repos>` unchanged (`src/approaches/graph/coordinator/recovery.test.ts:1032` uses it).
- `pipeline.ts` is already 837 lines. Put new pure logic in a new file, not in `pipeline.ts`.
- Test naming: a file that spawns git is `*.integration.test.ts`. A pure test is `*.test.ts`.
- Do not run the full suite. Run single files, `npm run -s typecheck`, and the docs gate.
- Commit types: `fix:` / `test:`. End each commit body with the attribution lines from the session.

Facts that the plan depends on (checked):
- `git diff --binary --output=<abs> <base>` with no changes creates a 0-byte file and exits 0.
- `git diff --output` always ends its file with `\n` when the diff is not empty.
- The test harness runner in `makeDeps` (`pipeline.integration.test.ts:203`) uses `spawnSync` and `stdout.trim()`. Its `maxBuffer` is 1 MiB, so a large diff gives `exitCode -1`, not the production symptom. The large-binary test must override `git` with `defaultGitRunner` (`src/integrations/git.ts:265`).
- A throw in `captureChangeSet`/`captureUntrackedPaths` inside `captureDomainChangeSet` is caught at `pipeline.ts:672-682` and becomes `integration-conflict: change-set capture failed`.

---

### Task 1: Fail closed on truncated output in changeSet.ts

**Files:**
- Modify: `src/approaches/graph/integration/changeSet.ts` (`captureChangeSet`, `captureUntrackedPaths`)
- Test: `src/approaches/graph/integration/changeSet.integration.test.ts`

**Interfaces:**
- Consumes: `GitRunner`, `GitResult.stdoutTruncated?: boolean` from `src/integrations/git.ts`.
- Produces: no signature change. New error texts: `git diff --name-status ${baseRef} output was truncated`, `git ls-files --others output was truncated`.

- [ ] **Step 1: Write the failing tests.** Add `captureChangeSet` to the import from `./changeSet.js`. Append this block at the end of the file:

```ts
describe('truncated git output fails closed', () => {
  const truncated: GitRunner = () =>
    Promise.resolve({ stdout: 'M\ta.ts\n', stdoutTruncated: true, stderr: '', exitCode: 0 });
  const complete: GitRunner = () =>
    Promise.resolve({ stdout: 'M\ta.ts\n', stdoutTruncated: false, stderr: '', exitCode: 0 });

  it('captureChangeSet throws when the name-status output was truncated', async () => {
    await expect(captureChangeSet(truncated, { cwd: '/unused', baseRef: 'abc123' })).rejects.toThrow(
      'git diff --name-status abc123 output was truncated',
    );
  });

  it('captureUntrackedPaths throws when the ls-files output was truncated', async () => {
    await expect(captureUntrackedPaths(truncated, '/unused')).rejects.toThrow(
      'git ls-files --others output was truncated',
    );
  });

  it('output that was not truncated still parses', async () => {
    await expect(captureChangeSet(complete, { cwd: '/unused', baseRef: 'abc123' })).resolves.toEqual([
      { path: 'a.ts', kind: 'modified' },
    ]);
    await expect(captureUntrackedPaths(complete, '/unused')).resolves.toEqual(['M\ta.ts']);
  });
});
```

- [ ] **Step 2: Run the test and see it fail.**
Run: `npx vitest run --config vitest.integration.config.ts src/approaches/graph/integration/changeSet.integration.test.ts`
Expected: the two "throws" tests FAIL (the promise resolves).

- [ ] **Step 3: Implement.** In `captureChangeSet`, after the `exitCode` check:

```ts
  if (result.stdoutTruncated) {
    // A truncated list is not the change set: integrating it would land a
    // partial node. Fail closed, like a failed diff.
    throw new Error(`git diff --name-status ${opts.baseRef} output was truncated`);
  }
```

In `captureUntrackedPaths`, after the `exitCode` check:

```ts
  if (result.stdoutTruncated) {
    throw new Error('git ls-files --others output was truncated');
  }
```

- [ ] **Step 4: Run the test and see it pass.** Same command as Step 2. Expected: PASS.
- [ ] **Step 5: Commit.** `git add` the two files. Message: `fix(graph): fail closed when change-set git output is truncated`.

---

### Task 2: Pure patch-fragment normalizer

**Files:**
- Create: `src/approaches/graph/integration/patchFragment.ts`
- Test: `src/approaches/graph/integration/patchFragment.test.ts`

**Interfaces:**
- Produces: `export function normalizePatchFragment(raw: Buffer): Buffer | null` — `null` for an empty fragment, else the bytes with exactly one final `0x0a`.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from 'vitest';
import { normalizePatchFragment } from './patchFragment.js';

describe('normalizePatchFragment', () => {
  it('skips an empty fragment', () => {
    expect(normalizePatchFragment(Buffer.alloc(0))).toBeNull();
  });

  it('appends one newline to a fragment that has none, without mutating the input', () => {
    const raw = Buffer.from('+x');
    const out = normalizePatchFragment(raw);
    expect(out?.toString('latin1')).toBe('+x\n');
    expect(raw.toString('latin1')).toBe('+x');
  });

  it('does not double a final newline', () => {
    const out = normalizePatchFragment(Buffer.from('+x\n'));
    expect(out?.toString('latin1')).toBe('+x\n');
  });

  it('keeps a trailing blank context line byte-identical (T1297)', () => {
    const raw = Buffer.from('@@ -1,2 +1,2 @@\n-a\n+b\n \n');
    expect(normalizePatchFragment(raw)?.equals(raw)).toBe(true);
  });

  it('keeps non-UTF-8 bytes verbatim', () => {
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x20, 0x0a]);
    expect(normalizePatchFragment(raw)?.equals(raw)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and see it fail.** Run: `npx vitest run src/approaches/graph/integration/patchFragment.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**

```ts
/**
 * One workspace fragment of the integration patch (`git diff --binary
 * --output=<file>`), normalized for concatenation. The bytes stay verbatim:
 * no UTF-8 decode and no trim. A hunk that ends on a blank context line ends
 * in `" \n"`, and a trim that removes its space makes `git apply` report
 * "corrupt patch" (T1297). An empty fragment is skipped (`null`). A fragment
 * without a final newline gets exactly one, so the next fragment starts on
 * its own line.
 */

const NEWLINE = 0x0a;

export function normalizePatchFragment(raw: Buffer): Buffer | null {
  if (raw.byteLength === 0) return null;
  if (raw[raw.byteLength - 1] === NEWLINE) return raw;
  return Buffer.concat([raw, Buffer.from([NEWLINE])]);
}
```

- [ ] **Step 4: Run and see it pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `fix(graph): add a byte-exact patch fragment normalizer`.

---

### Task 3: landWorkspaceChanges writes each diff to a file

**Files:**
- Modify: `src/approaches/graph/integration/pipeline.ts` (imports at lines 108-110, `landWorkspaceChanges` at lines 425-494)
- Test: `src/approaches/graph/integration/pipeline.integration.test.ts`

**Interfaces:**
- Consumes: `normalizePatchFragment(raw: Buffer): Buffer | null` from `./patchFragment.js` (Task 2). `defaultGitRunner`, `GIT_MAX_OUTPUT_BYTES` from `src/integrations/git.ts`.
- Produces: no signature change to `landWorkspaceChanges` or `LandResult`.

- [ ] **Step 1: Write the failing tests.** In the test file, add `import { randomBytes } from 'node:crypto';` (merge with the existing `createHash` import), and `import { defaultGitRunner, GIT_MAX_OUTPUT_BYTES } from '../../../integrations/git.js';` (merge with the existing `type GitRunner` import). Add this `describe` block AFTER `makeWorkspaceClone` and `pathLease` are defined (after the `Slice 5 Task 5` describe block):

```ts
describe('runCompletionPipeline — workspace patch bytes (T1304)', () => {
  /** Commit everything in a workspace clone. The clone has no user config. */
  function commitAll(cwd: string, message: string): void {
    git(cwd, ['add', '-A']);
    git(cwd, ['-c', 'user.email=t@karst', '-c', 'user.name=T', 'commit', '-qm', message]);
  }

  it('lands a binary workspace diff larger than the 1 MiB stdout cap (T1301)', async () => {
    const h = harness();
    cleanups.push(h.close);
    mkdirSync(join(h.worktree, 'bin'), { recursive: true });
    writeFileSync(join(h.worktree, 'bin/mod.bin'), randomBytes(256 * 1024));
    writeFileSync(join(h.worktree, 'bin/del.bin'), randomBytes(256 * 1024));
    git(h.worktree, ['add', '-A']);
    git(h.worktree, ['commit', '-qm', 'binary base']);
    const baseSha = git(h.worktree, ['rev-parse', 'HEAD']);

    insertNodeRun(h, 71, 'completing');
    const ws = makeWorkspaceClone(h.worktree, baseSha);
    const modified = randomBytes(512 * 1024);
    const added = randomBytes(1024 * 1024);
    writeFileSync(join(ws, 'bin/mod.bin'), modified);
    writeFileSync(join(ws, 'bin/new.bin'), added);
    rmSync(join(ws, 'bin/del.bin'));
    commitAll(ws, 'node work');

    // The fixture must exceed the runner cap, or it proves nothing.
    const raw = spawnSync('git', ['diff', '--binary', baseSha], { cwd: ws, maxBuffer: 64 * 1024 * 1024 });
    expect(raw.stdout.byteLength).toBeGreaterThan(GIT_MAX_OUTPUT_BYTES);

    const domain = domainKeyOf(canonicalPath(h.worktree), gitCommonDirOf2(h.worktree));
    recordBaseHead(h, 71, domain, baseSha);
    const deps = makeDeps(h, {
      git: defaultGitRunner,
      declaredWritesOf: () => [{ domainKey: domain, paths: ['bin'] }],
      workspaceCwdOf: (nodeRunId) => (nodeRunId === 71 ? ws : undefined),
    });

    const result = await runCompletionPipeline(deps, { graphRunId: h.graphRunId, nodeRunId: 71 });
    expect(result).toEqual({ kind: 'integrated', committed: true });
    expect(git(h.worktree, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(h.worktree, 'bin/mod.bin')).equals(modified)).toBe(true);
    expect(readFileSync(join(h.worktree, 'bin/new.bin')).equals(added)).toBe(true);
    expect(existsSync(join(h.worktree, 'bin/del.bin'))).toBe(false);
  });

  it('lands a diff whose last line is a blank context line without corrupt patch (T1297)', async () => {
    const h = harness();
    cleanups.push(h.close);
    writeFileSync(join(h.worktree, 'a.ts'), 'l1\nl2\nl3\nl4\n\n');
    git(h.worktree, ['commit', '-qam', 'trailing blank line']);
    const baseSha = git(h.worktree, ['rev-parse', 'HEAD']);

    insertNodeRun(h, 72, 'completing');
    const ws = makeWorkspaceClone(h.worktree, baseSha);
    const edited = 'l1\nl2\nl3\nL4\n\n';
    writeFileSync(join(ws, 'a.ts'), edited);

    // The fixture must end on a blank context line: " \n".
    const raw = spawnSync('git', ['diff', '--binary', baseSha], { cwd: ws, encoding: 'utf8' });
    expect(raw.stdout.endsWith('\n \n')).toBe(true);

    const domain = domainKeyOf(canonicalPath(h.worktree), gitCommonDirOf2(h.worktree));
    recordBaseHead(h, 72, domain, baseSha);
    const deps = makeDeps(h, {
      workspaceCwdOf: (nodeRunId) => (nodeRunId === 72 ? ws : undefined),
    });

    const result = await runCompletionPipeline(deps, { graphRunId: h.graphRunId, nodeRunId: 72 });
    expect(result).toEqual({ kind: 'integrated', committed: true });
    expect(readFileSync(join(h.worktree, 'a.ts'), 'utf8')).toBe(edited);
    expect(git(h.worktree, ['status', '--porcelain'])).toBe('');
  });
});
```

Note: the second test uses the default harness runner on purpose. That runner trims stdout, which is the same defect class (a trimmed trailing `" \n"`). With `--output`, stdout is empty, so the trim has no effect.

- [ ] **Step 2: Run and see both tests fail.**
Run: `npx vitest run --config vitest.integration.config.ts src/approaches/graph/integration/pipeline.integration.test.ts -t "T1304"`
Expected: both FAIL with `kind: 'integration-conflict'`. Check that the reason of the T1297 test names `corrupt patch` (read `blocked_reason` if needed). This proves the RED is the production defect.

- [ ] **Step 3: Implement.** In `pipeline.ts`, change the `node:fs` import to:

```ts
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

and add `import { normalizePatchFragment } from './patchFragment.js';` next to the other `./` imports. In `landWorkspaceChanges`, replace the body from `const fragments: string[] = [];` up to and including `writeFileSync(patchFile, patch);` with:

```ts
    const fragmentBuffers: Buffer[] = [];
    const untracked: { from: string; rel: string }[] = [];
    for (const [i, cwd] of workspaceCwds.entries()) {
      // git writes the patch to a file, never to stdout: the runner caps
      // stdout at GIT_MAX_OUTPUT_BYTES, and a binary baseline sweep is larger
      // (T1301). The bytes stay verbatim; see normalizePatchFragment.
      const fragFile = join(patchDir, `frag-${i}.patch`);
      const diff = await deps.git(
        ['diff', '--binary', `--output=${fragFile}`, baseRef, '--', ...paths],
        cwd,
      );
      if (diff.exitCode !== 0) {
        return { ok: false, stderr: diff.stderr, reason: 'change-set diff failed' };
      }
      if (existsSync(fragFile)) {
        const fragment = normalizePatchFragment(readFileSync(fragFile));
        if (fragment) fragmentBuffers.push(fragment);
      }
      let untrackedPaths: string[];
      try {
        untrackedPaths = await captureUntrackedPaths(deps.git, cwd);
      } catch (err) {
        return { ok: false, stderr: String(err), reason: 'untracked enumeration failed' };
      }
      for (const rel of untrackedPaths) {
        if (declaredClaims.some((claim) => isPathWithinClaim(rel, claim))) {
          untracked.push({ from: join(cwd, rel), rel });
        }
      }
    }
    if (fragmentBuffers.length > 0) {
      writeFileSync(patchFile, Buffer.concat(fragmentBuffers));
```

Keep the `git apply --check` / `--reverse --check` / `git apply` flow and the untracked copy unchanged. Delete the old "Normalize the concatenation ..." comment.

- [ ] **Step 4: Run the whole pipeline integration file.**
Run: `npx vitest run --config vitest.integration.config.ts src/approaches/graph/integration/pipeline.integration.test.ts`
Expected: PASS, including all existing workspace tests.
- [ ] **Step 5: Run `npm run -s typecheck`.** Expected: exit 0.
- [ ] **Step 6: Commit.** Message: `fix(graph): land workspace diffs from git diff --output files, byte-exact`.

---

### Task 4: git add refusal diagnostic names the landed changes

**Files:**
- Modify: `src/approaches/graph/integration/pipeline.ts` (the `git add --all` refusal, about lines 733-743)
- Test: `src/approaches/graph/integration/pipeline.integration.test.ts` (inside the `T1304` describe block)

**Interfaces:**
- Consumes: `DomainCapture.workspaceCwds` (existing).
- Produces: reason text `integration-conflict: git add refused in <repos> (<stderr>); workspace changes already landed in the canonical worktree, preserved uncommitted for diagnosis` for a workspace node. A canonical-tree node keeps the old text.

- [ ] **Step 1: Write the failing test.** Add inside the `T1304` describe block:

```ts
  it('a git add refusal after a landed workspace patch preserves both trees and says the changes landed', async () => {
    const h = harness();
    cleanups.push(h.close);
    insertNodeRun(h, 73, 'completing');
    const ws = makeWorkspaceClone(h.worktree, h.baseSha);
    writeFileSync(join(ws, 'a.ts'), 'ws-73\n');
    const domain = domainKeyOf(canonicalPath(h.worktree), gitCommonDirOf2(h.worktree));
    recordBaseHead(h, 73, domain, h.baseSha);
    const realGit = makeDeps(h).git;
    const deps = makeDeps(h, {
      git: (args, cwd, options) =>
        args[0] === 'add'
          ? Promise.resolve({ stdout: '', stderr: 'fatal: forced add refusal', exitCode: 1 })
          : realGit(args, cwd, options),
      workspaceCwdOf: (nodeRunId) => (nodeRunId === 73 ? ws : undefined),
    });
    const headBefore = git(h.worktree, ['rev-parse', 'HEAD']);

    const result = await runCompletionPipeline(deps, { graphRunId: h.graphRunId, nodeRunId: 73 });
    expect(result.kind).toBe('integration-conflict');
    const run = h.db
      .prepare('SELECT blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(h.graphRunId) as { blocked_reason: string };
    expect(run.blocked_reason).toContain('integration-conflict: git add refused in api');
    expect(run.blocked_reason).toContain('workspace changes already landed in the canonical worktree');
    // Preserved: no reset, no checkout.
    expect(git(h.worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(h.worktree, ['status', '--porcelain'])).toContain('a.ts');
    expect(readFileSync(join(h.worktree, 'a.ts'), 'utf8')).toBe('ws-73\n');
    expect(readFileSync(join(ws, 'a.ts'), 'utf8')).toBe('ws-73\n');
  });
```

- [ ] **Step 2: Run and see it fail.**
Run: `npx vitest run --config vitest.integration.config.ts src/approaches/graph/integration/pipeline.integration.test.ts -t "git add refusal after"`
Expected: FAIL on the `already landed` assertion.

- [ ] **Step 3: Implement.** Replace the `const reason = ...git add refused...` line with:

```ts
      // The workspace patch is already in the canonical tree. Keep it there
      // (no reset, no checkout: both trees are preserved for diagnosis) and
      // say so, so the operator does not read the tree as untouched.
      const landedNote =
        capture.workspaceCwds.length > 0
          ? '; workspace changes already landed in the canonical worktree, preserved uncommitted for diagnosis'
          : '';
      const reason = `integration-conflict: git add refused in ${domain.repoNames.join('/')} (${boundedGitReason(add.stderr)})${landedNote}`;
```

- [ ] **Step 4: Run the whole pipeline integration file.** Command from Task 3 Step 4. Expected: PASS.
- [ ] **Step 5: Run `npx vitest run src/approaches/graph/coordinator/recovery.test.ts` and `npm run -s typecheck`.** Expected: PASS, exit 0.
- [ ] **Step 6: Commit.** Message: `fix(graph): git add refusal says workspace changes already landed`.

---

### Task 5: Final checks (controller, not a subagent)

- [ ] Run: `npx vitest run src/approaches/graph/integration/` (unit files).
- [ ] Run: `npx vitest run --config vitest.integration.config.ts src/approaches/graph/integration/pipeline.integration.test.ts src/approaches/graph/integration/changeSet.integration.test.ts`.
- [ ] Run: `npm run -s typecheck`.
- [ ] Run: `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs`. If it blocks on a `covers:` block, update that block or cite it with `karst arch cite`.
- [ ] Read the `gates-and-ci` skill. Run only the cheap checks it lists.
- [ ] Fire the impl marker.
