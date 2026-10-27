# Setup prompt/guide: explicit path, compact manifest view, verify-by-status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix retro items 3, 4, 6, 7: `propose-change` takes an explicit `path`, the agent reads a comment-free active manifest, the setup prompt states the proposal-only / verify-by-status / payload-in-file rules, and the scaffold no longer references missing repos or scripts.

**Architecture:** `path` is an optional field on `ChangeProposal`, resolved host-side by a pure `resolveChangeDir` (`src/setup/changeTarget.ts`); the resolved dir is shown in the consent modal and used as the cwd, so `setupProposalOps` gets a `resolveDir` seam and `runCommand`/`applyPatch` take a cwd instead of a repo name. `karst manifest show --active` dumps the manifest file through js-yaml (comments drop). Prompt steering lives in `instructions.ts` + `guide.ts` text only for process rules no check can enforce. The scaffold keeps one live service-less repo (`app`, path stamped at scaffold time); the four placeholder repos and the Playwright/verify-uat gates become a commented cookbook that a test proves still loads.

**Tech Stack:** TypeScript (ESM, `.js` import suffix, `noUncheckedIndexedAccess`), vitest, js-yaml, Stryker.

**Spec:** ticket SETUP-PROMPT-GUIDE-PROPOSE (`karst context SETUP-PROMPT-GUIDE-PROPOSE`); builds on D270 (`setup status`/ledger, PR #775). Docs: `docs/arch/cli.md` (`arch:CLI-14`, `CLI-02`).

## Global Constraints

- Strict TDD; conventional commits; each commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run `npm run -s <script>`; single file `npx vitest run <path>`; never `--reporter=...`; full suite once, at the end.
- `src/extension/**` change must keep Stryker score ≥ 85 (`npx stryker run --mutate <files>` then `node scripts/mutationSummary.mjs`).
- `extension/setupWiring.ts` imports `vscode`: bindings only, no new logic (logic stays in vscode-free modules).
- No `spawnSync` on new paths. Files < 400 lines typical.
- Edit `karst.example.yml` (source), never `dist/`. Keep the keyed-block format of any `docs/` file you edit.
- Prompt text: no prose for what a check enforces (D269 `setup check` covers manifest/baseline/origin); only the process rules listed in the ticket.

## File Structure

- Modify `src/setup/changeTarget.ts` (+ `.test.ts`): add `resolveChangeDir`.
- Modify `src/setup/proposal.ts` (+ `.test.ts`): optional `path` on `ChangeProposal`.
- Modify `src/cli/setupCommand.ts` (+ test), `src/cli/registry.ts`: forward `path`.
- Modify `src/setup/review.ts` (+ test): modal shows resolved directory.
- Modify `src/extension/ops/setupProposalOps.ts` (+ test), `src/extension/setupWiring.ts`: `resolveDir` seam.
- Modify `src/cli/manifestCommand.ts` (+ test), `src/cli/main.ts`, `src/cli/registry.ts`: `manifest show --active`.
- Modify `src/setup/instructions.ts` (+ test), `src/cli/guide.ts`: prompt/guide text.
- Modify `karst.example.yml`, `src/manifest/example.test.ts`, `src/extension/manifestResolve.ts`: scaffold.
- Modify `docs/arch/cli.md`: CLI-14 note.

---

### Task 1: `path` on a change proposal, resolved and shown in consent

**Files:**
- Modify: `src/setup/changeTarget.ts`, `src/setup/changeTarget.test.ts`
- Modify: `src/setup/proposal.ts`, `src/setup/proposal.test.ts`
- Modify: `src/setup/review.ts`, `src/setup/review.test.ts`
- Modify: `src/extension/ops/setupProposalOps.ts`, `src/extension/ops/setupProposalOps.test.ts`
- Modify: `src/extension/setupWiring.ts` (lines ~100-112, 149-150)
- Modify: `src/cli/setupCommand.ts` (`toChangeProposalInput`), `src/cli/setupCommand.test.ts`, `src/cli/registry.ts` (`setup` spec)

**Interfaces:**
- Produces: `export type ChangeDir = { ok: true; dir: string } | { ok: false; reason: string }`
- Produces: `export function resolveChangeDir(change: { repo: string; path?: string }, workspaceRoot: string, registeredRepoPath: string | undefined): ChangeDir`
- Produces: `ChangeProposal.path?: string`; `export const MAX_SETUP_PATH = 1024`
- Produces: `describeChangeProposal(change: ChangeProposal, dir: string): ProposalDescription` (detail starts with `Directory: <dir>`)
- Produces: `SetupProposalOpsDeps.resolveDir: (change: ChangeProposal) => ChangeDir`; `runCommand: (cwd: string, command: string) => Promise<void>`; `applyPatch: (cwd: string, patch: string) => Promise<void>`

- [ ] **Step 1: Failing tests — `resolveChangeDir`** (append to `src/setup/changeTarget.test.ts`, import `resolveChangeDir`)

```ts
describe('resolveChangeDir', () => {
  const root = '/ws';

  it('without a path keeps today’s resolution', () => {
    expect(resolveChangeDir({ repo: 'web' }, root, undefined)).toEqual({ ok: true, dir: '/ws/web' });
    expect(resolveChangeDir({ repo: 'web' }, root, 'apps/web')).toEqual({ ok: true, dir: '/ws/apps/web' });
  });

  it('"." means the workspace root itself (the retro case: repo macos_iot, root meant)', () => {
    expect(resolveChangeDir({ repo: 'macos_iot', path: '.' }, root, undefined)).toEqual({ ok: true, dir: '/ws' });
  });

  it('resolves a relative path against the root and wins over a registered repoPath', () => {
    expect(resolveChangeDir({ repo: 'web', path: 'sub/dir' }, root, '/elsewhere/web')).toEqual({ ok: true, dir: '/ws/sub/dir' });
  });

  it('accepts an absolute path inside the root', () => {
    expect(resolveChangeDir({ repo: 'web', path: '/ws/web' }, root, undefined)).toEqual({ ok: true, dir: '/ws/web' });
  });

  it.each(['..', '../x', 'a/../../x', '/etc', '/ws2/web'])('rejects %s (outside the root)', (path) => {
    const r = resolveChangeDir({ repo: 'web', path }, root, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`"${path}"`);
  });

  it('does not treat a ..-prefixed folder name as an escape', () => {
    expect(resolveChangeDir({ repo: 'web', path: '..cache' }, root, undefined)).toEqual({ ok: true, dir: '/ws/..cache' });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `npx vitest run src/setup/changeTarget.test.ts`
Expected: FAIL (`resolveChangeDir` is not exported).

- [ ] **Step 3: Implement** — in `src/setup/changeTarget.ts` change the first import to `import { isAbsolute, join, relative, resolve, sep } from 'node:path';` and append:

```ts
export type ChangeDir = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * The directory a change runs in. An explicit `path` (absolute, or relative to
 * the workspace root) wins and must stay inside the root — `.` is the root
 * itself. Without one, `resolveChangeRepoDir` keeps its repo-name resolution.
 * Lexical containment only: a symlink inside the root is the user's own choice.
 */
export function resolveChangeDir(
  change: { repo: string; path?: string },
  workspaceRoot: string,
  registeredRepoPath: string | undefined,
): ChangeDir {
  if (change.path === undefined) {
    return { ok: true, dir: resolveChangeRepoDir(change.repo, workspaceRoot, registeredRepoPath) };
  }
  const root = resolve(workspaceRoot);
  const dir = resolve(root, change.path);
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, reason: `path "${change.path}" is outside the workspace root ${root}` };
  }
  return { ok: true, dir };
}
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run src/setup/changeTarget.test.ts`

- [ ] **Step 5: Failing tests — proposal field** (append to `src/setup/proposal.test.ts` inside the existing change-proposal describe; reuse its imports `validateSetupProposal`)

```ts
describe('change proposal path', () => {
  const base = { kind: 'change', repo: 'web', reason: 'init', command: 'git init' };

  it('accepts an optional path and keeps it', () => {
    expect(validateSetupProposal({ ...base, path: '.' })).toEqual({ ok: true, value: { ...base, path: '.' } });
  });

  it.each([['', 'empty'], [42, 'not a string'], ['a\u0000b', 'control char'], ['x'.repeat(1025), 'too long']])(
    'rejects path %j (%s)',
    (path) => {
      const r = validateSetupProposal({ ...base, path });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('path');
    },
  );
});
```

- [ ] **Step 6: Run, confirm FAIL** — `npx vitest run src/setup/proposal.test.ts`

- [ ] **Step 7: Implement** in `src/setup/proposal.ts`:
  - after `MAX_SETUP_PATCH`: `export const MAX_SETUP_PATH = 1024;`
  - `ChangeProposal`: add
    ```ts
      /** Directory the change runs in: absolute, or relative to the workspace root; must stay inside it. Overrides `repo` for resolution. */
      path?: string;
    ```
  - in `validateChangeProposal`: change the `exactKeys` optional list to `['kind', 'repo', 'reason', 'command', 'patch', 'path']` and its message to `'change proposal keys must be exactly kind, repo, reason (plus an optional command or patch, and an optional path)'`; after the `patch` checks add
    ```ts
      const path = rec.path;
      if (
        path !== undefined &&
        (typeof path !== 'string' || path.trim() === '' || path.length > MAX_SETUP_PATH || path.replace(ALL_CONTROLS, '') !== path)
      ) {
        return fail(`path must be a non-empty string of at most ${MAX_SETUP_PATH} characters without control characters`);
      }
    ```
    and before `return { ok: true, value }` add `if (path !== undefined) value.path = path;`

- [ ] **Step 8: Run, confirm PASS** — `npx vitest run src/setup/proposal.test.ts`

- [ ] **Step 9: Failing tests — forwarding + modal.** In `src/cli/setupCommand.test.ts` add (reuse the file's existing propose-change helper style; the flat tool object path):

```ts
it('propose-change forwards path from the flat tool object', () => {
  // use the same deps/outbox fixture the neighbouring propose-change tests use
  const out = runSetupCommand(['setup', 'propose-change'], {
    outboxEnv: outboxDir,
    readStdin: () => JSON.stringify(toChangeProposalInput({ subcommand: 'propose-change', repo: 'macos_iot', path: '.', reason: 'init', command: 'git init' })),
  });
  const id = JSON.parse(out).id as string;
  expect(JSON.parse(readFileSync(join(outboxDir, `${id}.json`), 'utf8'))).toMatchObject({ repo: 'macos_iot', path: '.' });
});
```
(if the file already names its tmp outbox differently, use that name.) In `src/setup/review.test.ts` replace the two `describeChangeProposal(...)` calls with a second arg `'/ws/web'` and add:

```ts
it('names the resolved directory first in the detail', () => {
  const d = describeChangeProposal({ kind: 'change', repo: 'macos_iot', reason: 'init', command: 'git init', path: '.' }, '/ws');
  expect(d.detail.split('\n')[0]).toBe('Directory: /ws');
});
```

- [ ] **Step 10: Implement forwarding + modal.**
  - `src/cli/setupCommand.ts` `toChangeProposalInput`: key list becomes `['repo', 'reason', 'command', 'patch', 'path']`.
  - `src/cli/registry.ts` `setup` spec input: add `path: str,` after `repo: str,`.
  - `src/setup/review.ts` `describeChangeProposal(change, dir)`: `const lines: string[] = [`Directory: ${dir}`, change.reason];`

- [ ] **Step 11: Failing tests — ops.** Edit `src/extension/ops/setupProposalOps.test.ts`: in `deps()` add `resolveDir: (c: ChangeProposal) => ({ ok: true as const, dir: `/w/${c.path ?? c.repo}` })` to the returned `deps` object and keep a handle (`const resolveDir = vi.fn(...)`, expose as `f.resolveDir`). Update existing expectations: `runCommand` toHaveBeenCalledWith `('/w/web', 'npm ci')`, `applyPatch` with `('/w/api', '+++ b/.env\n')`. Add:

```ts
it('runs a change in the resolved path, and the modal names that directory', async () => {
  const change: ChangeProposal = { kind: 'change', repo: 'macos_iot', reason: 'init', command: 'git init', path: '.' };
  const f = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
  await createSetupProposalOps(f.deps).scan();
  expect(f.confirm.mock.calls[0]![0].detail).toContain('Directory: /w/.');
  expect(f.runCommand).toHaveBeenCalledWith('/w/.', 'git init');
});

it('marks a change whose path escapes the root invalid without prompting', async () => {
  const warns: string[] = [];
  const change: ChangeProposal = { kind: 'change', repo: 'web', reason: 'r', command: 'ls', path: '../x' };
  const f = deps({ '/s/1/outbox/a.json': JSON.stringify(change) });
  f.deps.resolveDir = () => ({ ok: false as const, reason: 'path "../x" is outside the workspace root /w' });
  await createSetupProposalOps({ ...f.deps, notify: { info: () => {}, warn: (m: string) => void warns.push(m) } as never }).scan();
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.runCommand).not.toHaveBeenCalled();
  expect(f.fs.removed).toEqual(['/s/1/outbox/a.json']);
  expect(f.fs.results[0]).toMatchObject({ kind: 'change', status: 'invalid', reason: expect.stringContaining('outside the workspace root') });
  expect(warns.some((m) => /outside the workspace root/.test(m))).toBe(true);
});
```
(import `ChangeProposal` already present; if `f.deps` is readonly-typed, build `{ ...f.deps, resolveDir: ... }` instead.)

- [ ] **Step 12: Run, confirm FAIL** — `npx vitest run src/extension/ops/setupProposalOps.test.ts src/setup/review.test.ts src/cli/setupCommand.test.ts`

- [ ] **Step 13: Implement ops + wiring.**
  - `setupProposalOps.ts`: import `type ChangeDir` from `../../setup/changeTarget.js`; in deps interface replace the two members with
    ```ts
      /** Where a change runs: the explicit `path`, else the repo's directory. `ok: false` marks the proposal invalid. */
      resolveDir: (change: ChangeProposal) => ChangeDir;
      /** Run an approved change command in `cwd`. */
      runCommand: (cwd: string, command: string) => Promise<void>;
      /** Apply an approved change patch in `cwd`. */
      applyPatch: (cwd: string, patch: string) => Promise<void>;
    ```
    At the top of `handleChange` (before `confirm`):
    ```ts
        const target = deps.resolveDir(change);
        if (!target.ok) {
          deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${target.reason}).`);
          record(scratch, file, 'change', 'invalid', { reason: target.reason });
          fs.remove(file);
          return;
        }
    ```
    then `describeChangeProposal(change, target.dir)`, `deps.runCommand(target.dir, change.command)`, `deps.applyPatch(target.dir, change.patch)`.
  - `setupWiring.ts`: replace the `repoCwd` const (and its doc comment, keep one line saying the change runs in the resolved directory) with
    ```ts
      const resolveDir = (change: ChangeProposal): ChangeDir =>
        resolveChangeDir(change, workspaceRoot() ?? process.cwd(), deps.currentManifest()?.repositories[change.repo]?.repoPath);
    ```
    import `resolveChangeDir, type ChangeDir` from `../setup/changeTarget.js` and `type ChangeProposal` from `../setup/proposal.js`; pass `resolveDir`, and `runCommand: (cwd, command) => runShellCommand(cwd, command)`, `applyPatch: (cwd, patch) => applyPatch(cwd, patch)`.

- [ ] **Step 14: Run, confirm PASS + typecheck**

Run: `npx vitest run src/extension/ops/setupProposalOps.test.ts src/setup src/cli/setupCommand.test.ts src/cli/registry.test.ts && npm run -s typecheck`
Expected: PASS, no type errors.

- [ ] **Step 15: Commit**

```bash
git add -A src/setup src/extension src/cli
git commit -m "feat: setup propose-change takes an explicit path, shown in the consent modal"
```

---

### Task 2: `karst manifest show --active`

**Files:**
- Modify: `src/cli/manifestCommand.ts`, `src/cli/manifestCommand.test.ts`, `src/cli/main.ts` (~line 235), `src/cli/registry.ts` (`manifest` spec)

**Interfaces:**
- Produces: `ManifestCommandDeps.manifestPath?: string`; `runManifestCommand(['manifest','show','--active'], { manifestPath })` returns comment-free YAML text.

- [ ] **Step 1: Failing tests** (append to `src/cli/manifestCommand.test.ts`; it already imports `runManifestCommand` and uses node fs tmp dirs — reuse its tmp helper or add `mkdtempSync`)

```ts
describe('manifest show --active', () => {
  const yml = '# top comment\nid: p\n# why\nhost: 127.0.0.1\nrepositories:\n  web:\n    repoPath: /w/web # inline\n';

  it('prints the active manifest without comments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mshow-'));
    const file = join(dir, 'karst.yml');
    writeFileSync(file, yml);
    const out = runManifestCommand(['manifest', 'show', '--active'], { manifestPath: file });
    expect(out).not.toContain('#');
    expect(out).toContain('id: p');
    expect(out).toContain('repoPath: /w/web');
  });

  it('needs --active', () => {
    expect(() => runManifestCommand(['manifest', 'show'], { manifestPath: '/x' })).toThrow(/--active/);
  });

  it('says there is no active manifest when the file is missing or no path is given', () => {
    expect(() => runManifestCommand(['manifest', 'show', '--active'], { manifestPath: '/nope/karst.yml' })).toThrow(/no active manifest/);
    expect(() => runManifestCommand(['manifest', 'show', '--active'], {})).toThrow(/--manifest/);
  });
});
```
Ensure imports `mkdtempSync, writeFileSync` (node:fs), `tmpdir` (node:os), `join` (node:path) exist at the top.

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run src/cli/manifestCommand.test.ts`

- [ ] **Step 3: Implement** in `src/cli/manifestCommand.ts`: add `import { dump, load } from 'js-yaml';`, `existsSync` to the `node:fs` import; add `manifestPath?: string;` to `ManifestCommandDeps` (doc: "the `--manifest` global; `show` reads it"); change `USAGE` to `'usage: karst manifest <validate|propose> --file <path> [--summary <text>] | karst manifest show --active'`; add

```ts
/**
 * `manifest show --active`: the active karst.yml re-dumped without comments.
 * A fresh scaffold is a long annotated template; this is the compact view the
 * setup agent reads instead (the annotated file stays a cookbook).
 */
function runShow(rest: readonly string[], deps: ManifestCommandDeps): string {
  if (rest.length !== 1 || rest[0] !== '--active') {
    throw new Error(`karst manifest show: needs --active (${USAGE})`);
  }
  if (deps.manifestPath === undefined) {
    throw new Error('karst manifest show: no manifest path (pass --manifest "$KARST_MANIFEST")');
  }
  if (!existsSync(deps.manifestPath)) {
    throw new Error(`karst manifest show: no active manifest at ${deps.manifestPath}`);
  }
  return dump(load(readFileSync(deps.manifestPath, 'utf8')), { lineWidth: -1, noRefs: true });
}
```
and at the top of `runManifestCommand`: `if (argv[1] === 'show') return runShow(argv.slice(2), deps);`. Also change the error in `parseManifestArgs` to `want 'validate', 'propose' or 'show'`.

In `src/cli/main.ts` change the dispatch to `return runManifestCommand(rest, { outboxEnv: env.KARST_SETUP_OUTBOX, manifestPath });`.

In `src/cli/registry.ts` `manifest` spec: `subcommand` enum `['validate', 'propose', 'show']`; required list `['subcommand']`; add `globals: { manifest: true },`; summary `'Setup session: validate or propose a draft karst.yml file, or show the active manifest without comments.'`; toArgv:

```ts
toArgv: (input) => {
  const sub = requireString(input, 'subcommand');
  if (sub === 'show') return ['manifest', 'show', '--active'];
  const argv = ['manifest', sub, '--file', requireString(input, 'file')];
  pushFlag(argv, '--summary', input.summary);
  return argv;
},
```

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run src/cli/manifestCommand.test.ts src/cli/registry.test.ts src/cli/main.test.ts && npm run -s typecheck`. If a registry/main test pins the `manifest` spec shape, update it to the new enum/required list.

- [ ] **Step 5: Commit**

```bash
git add -A src/cli
git commit -m "feat: karst manifest show --active prints the active manifest without comments"
```

---

### Task 3: Setup instructions and guide text

**Files:**
- Modify: `src/setup/instructions.ts`, `src/setup/instructions.test.ts`, `src/cli/guide.ts` (lines ~157-186), plus whichever `guide` test pins the text (`grep -n "propose-change" src/cli/guide.test.ts`)

**Interfaces:**
- Consumes: `manifest show --active` (Task 2), `path` (Task 1), `setup status` (exists).

- [ ] **Step 1: Failing tests** (append to the describe in `src/setup/instructions.test.ts`; reuse its `text` builder — it builds via `setupInstructions({ title, manifest })`)

```ts
it('states the process rules a check cannot enforce', () => {
  const text = setupInstructions({ title: 't', manifest: undefined });
  // proposal-only, with the reason
  expect(text).toContain('the host is the only writer of karst.yml');
  // verify by status, one retry
  expect(text).toContain('setup status');
  expect(text).toContain('`applied`');
  expect(text).toMatch(/at most ONE retry/);
  // payload in a file, never shell echo
  expect(text).toContain('propose-change --file');
  expect(text).not.toContain("printf '%s'");
  // repo vs path
  expect(text).toContain('`path` overrides `repo`');
  expect(text).toContain('path: "."');
  // compact manifest, annotated template only as cookbook
  expect(text).toContain('manifest show --active');
  expect(text).toContain('cookbook');
});
```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run src/setup/instructions.test.ts`

- [ ] **Step 3: Implement `instructions.ts`.** Import `KARST_MANIFEST_ENV` from `../agent/cliEnv.js` and add `const manifestFlag = `--manifest ${envRef(KARST_MANIFEST_ENV)}`;`. Edits:
  - After `'You change the project ONLY through proposals the extension applies after the user approves.',` insert: `'Manifest edits are proposal-only: the host is the only writer of karst.yml and applies a proposal only after the user consents — never write it yourself.',`
  - In phase 2 after the discover paragraph lines add:
    ```ts
    `   Read the ACTIVE manifest with \`node ${cli} manifest show --active ${manifestFlag}\` (comments stripped).`,
    '   Do NOT read karst.yml whole: a fresh scaffold is a long annotated template. Treat it as a',
    '   cookbook — grep it for the one field you need, never load it end to end.',
    ```
  - Phase 6 (PROPOSE): append after the `NEVER change id` line:
    ```ts
    `   The command's ok only means the proposal was queued. After EACH proposal run \`node ${cli} setup status\``,
    '   and confirm that proposal id shows `applied` (for a manifest, with the karst.yml sha256). `pending` = the',
    '   user has not answered yet; `declined`/`invalid`/`superseded` carry a reason. Make at most ONE retry of a',
    '   failed proposal, then stop and report it — do not loop.',
    ```
  - Replace the `printf` example block (lines `'and one JSON object on stdin, e.g.:'` and the `printf` line) with:
    ```ts
    'and ONE JSON object. Build it in a file (never with shell echo/printf — quoting corrupts the JSON), then:',
    `  node ${cli} setup propose-change --file <path>`,
    '  {"subcommand":"propose-change","repo":"web","reason":"node_modules missing","command":"npm ci"}',
    '`--file` validates the payload against the schema and the proposal rules and rejects it with a reason',
    'before anything is queued, so a bad payload costs nothing; fix the file and run it again.',
    '`repo` is the manifest repository name, or the folder name of a not-yet-registered repo, which runs in',
    '<workspace>/<repo>. The optional `path` overrides `repo` for WHERE the change runs: absolute or relative',
    'to the workspace root, inside it, `.` = the root itself (git init the root: `path: "."`). The consent',
    'dialog shows the resolved directory.',
    ```
    keep the following `A change carries EITHER ...` lines.

- [ ] **Step 4: Run, confirm PASS** — `npx vitest run src/setup/instructions.test.ts`. If an older assertion in that file pins the removed `printf` text, change it to the new `--file` form.

- [ ] **Step 5: Guide.** In `src/cli/guide.ts`: (a) in the `setup propose-change` entry replace "Reads ONE JSON object on stdin, `{"kind":"change","repo":…,"reason":…,"command":…}`" with: "Reads ONE JSON object (`--file <path>` is preferred — build the payload in a file; shell echo corrupts quoting): `{"subcommand":"propose-change","repo":…,"reason":…,"command":…,"path":…}`. `repo` is a manifest repository name or a folder name; `path` (optional, absolute or relative to the workspace root, must stay inside it, `.` = the root) overrides `repo` for where the change runs — use `path: "."` to git init the root. The consent dialog shows the resolved directory." keep the rest of that entry. (b) add after the `manifest propose` entry:
```
 - \`manifest show --active\` — ONLY inside a setup session. Prints the active
    \`karst.yml\` re-dumped WITHOUT comments (pass \`--manifest "$KARST_MANIFEST"\`).
    Read this instead of the annotated file, which is a long cookbook.
```
(c) in the `setup status` entry add: "After each proposal, confirm it shows `applied` (plus the sha256 for a manifest) — the propose command's ok only means queued; retry at most once, then report."
Update the guide test that pins this text, then run it.

- [ ] **Step 6: Run** — `npx vitest run src/cli/guide.test.ts src/setup/instructions.test.ts`; Expected PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/setup src/cli
git commit -m "feat: setup prompt and guide state path, status verification and payload-in-file rules"
```

---

### Task 4: Scaffold without dead placeholders

**Files:**
- Modify: `karst.example.yml` (repositories block ~L220-395, `uat:` block ~L595-630, plus any other `backend|frontend|db|tooling` reference found by grep)
- Modify: `src/manifest/example.test.ts`
- Modify: `src/extension/manifestResolve.ts` (`scaffoldManifest`, line ~75)

**Interfaces:**
- Produces: template token `/__WORKSPACE_ROOT__` in `karst.example.yml`, replaced at scaffold time; markers `# COOKBOOK-REPOS-BEGIN` / `# COOKBOOK-REPOS-END` around the commented repos.

- [ ] **Step 1: Failing tests** — rewrite `src/manifest/example.test.ts` expectations:
  - add `import { writeFileSync, mkdtempSync } from 'node:fs'`, `tmpdir`, as needed.
  - Test 1 becomes: live repos are exactly `['app']`, `warnings` is `[]`, and `manifest.repositories.app!.service` is undefined.
  - New helper in the file:
    ```ts
    /** The cookbook repos, uncommented and added to the live ones — proves the examples still load. */
    function withCookbookRepos(text: string): string {
      const lines = text.split('\n');
      const begin = lines.indexOf('# COOKBOOK-REPOS-BEGIN');
      const end = lines.indexOf('# COOKBOOK-REPOS-END');
      expect(begin).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(begin);
      const body = lines.slice(begin + 1, end).map((l) => l.replace(/^# ?/, ''));
      return [...lines.slice(0, begin), ...body, ...lines.slice(end + 1)].join('\n');
    }
    function loadText(text: string) {
      const dir = mkdtempSync(join(tmpdir(), 'example-'));
      const file = join(dir, 'karst.yml');
      writeFileSync(file, text);
      return loadManifestWithDiagnostics(file);
    }
    ```
  - The old `backend/db/tooling` tests (docker shape, `node server.mjs`/8000, tooling no service) now run against `loadText(withCookbookRepos(readFileSync(path, 'utf8'))).manifest` and also assert `Object.keys(manifest.repositories).sort()` equals `['app','backend','db','frontend','tooling']`.
  - New test: scaffold has no dead references:
    ```ts
    it('references no repo or script it does not declare', () => {
      const text = readFileSync(path, 'utf8');
      const live = text.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
      expect(live).not.toMatch(/verify-uat|playwright|repo: (frontend|backend|db|tooling)|^\s{4}frontend:/m);
      // loading validates every repo ref in uat/review against the declared repos
      expect(() => loadManifestWithDiagnostics(path)).not.toThrow();
    });
    ```

- [ ] **Step 2: Run, confirm FAIL** — `npx vitest run src/manifest/example.test.ts`

- [ ] **Step 3: Edit `karst.example.yml`.**
  1. Replace the `repositories:` content: first a live block
     ```yaml
     repositories:
       # The folder karst opened. Replace `repoPath` with your real git repos (one entry
       # per repo); declare `service:` only where a real start command + port exist.
       app:
         repoPath: /__WORKSPACE_ROOT__
         hasMigrations: false
     ```
     then the line `# COOKBOOK-REPOS-BEGIN`, the former `backend`, `frontend`, `db` and `tooling` blocks (everything from `  backend:` up to, not including, the `  # MONOREPO with several runnable processes.` comment) with every non-empty line prefixed by `# ` (blank lines stay blank), then `# COOKBOOK-REPOS-END`. Preceding the BEGIN marker add one comment line: `# COOKBOOK — shapes to copy into the repositories above (uncomment and adjust):`. A line like `  backend:` becomes `#   backend:`; the strip regex `^# ?` restores it exactly.
  2. `uat:`: comment out (same `# ` prefix, with a one-line `# Cookbook (needs a declared repo / a real script):` lead-in) the `e2e` gate line (keep the `test` gate), the `testerVerifier:` line, and the `repositories:` + `frontend:` + its `gates:` list under `uat`.
  3. `grep -n "backend\|frontend\|verify-uat\|playwright" karst.example.yml` and comment out or reword any remaining live reference (e.g. in `review:`/`agents:`); run Step 4 to confirm.
  4. Update the file-header comment (line 1) to mention the live `app` entry and the cookbook section.

- [ ] **Step 4: Stamp the workspace path.** In `src/extension/manifestResolve.ts` `scaffoldManifest`:
  ```ts
  const template = readFileSync(EXAMPLE_YML, 'utf8').replaceAll('/__WORKSPACE_ROOT__', folder.uri.fsPath);
  ```
  (`readScaffoldManifest` keeps parsing the raw template; the token is a valid absolute-looking path and only protected fields are compared.)

- [ ] **Step 5: Run, confirm PASS** — `npx vitest run src/manifest src/setup/manifestApply.test.ts && npm run -s typecheck`. If the loader rejects a repo path or `uat.repositories:` left empty, fix the template, not the loader.

- [ ] **Step 6: Commit**

```bash
git add karst.example.yml src/manifest/example.test.ts src/extension/manifestResolve.ts
git commit -m "fix: scaffold declares one real repo; backend/frontend/db/tooling and Playwright/verify-uat gates move to a commented cookbook"
```

---

### Task 5: Docs and full verification

**Files:**
- Modify: `docs/arch/cli.md` (the `arch:CLI-14` block; find with `grep -n 'CLI-14' docs/arch/cli.md`), `docs/COVERS.json` only if the docs check demands it

- [ ] **Step 1: Docs.** Extract the block: `awk -v id="[@arch:CLI-14]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/arch/cli.md`. Add two bullets inside it, same style: "`propose-change` accepts an optional `path` (absolute or workspace-relative, inside the root); `resolveChangeDir` (`src/setup/changeTarget.ts`) resolves it, the consent dialog shows the resolved directory, an escaping path marks the proposal `invalid`." and "`manifest show --active` prints the manifest comment-free (own parse path, takes `--manifest`)."

- [ ] **Step 2: Docs gates** — `npm run -s docs:graph -- --check 2>&1 | tail -15`. If it reports drift, run `npm run -s docs:graph` and include the regenerated file.

- [ ] **Step 3: Full checks (once)**

Run: `npm run -s typecheck && npm run -s lint:react && npm run -s test:unit 2>&1 | tail -15`
Expected: all green.

- [ ] **Step 4: Mutation gate**

Run: `npx stryker run --mutate src/extension/ops/setupProposalOps.ts,src/setup/changeTarget.ts,src/setup/proposal.ts,src/setup/review.ts 2>&1 | tail -5; node scripts/mutationSummary.mjs | head -30`
Expected: score ≥ 85. Kill survivors with tests (e.g. the `..` boundary and `rel === ''` cases in `changeTarget.test.ts`), never by editing Stryker config.

- [ ] **Step 5: Commit**

```bash
git add -A docs
git commit -m "docs: CLI-14 notes path and manifest show --active"
```

- [ ] **Step 6: Done marker** — `stage impl` via the karst MCP `stage` tool (only after all commits are on the ticket branch).

---

## Self-Review

- **Spec coverage:** item 3 (explicit path, resolved dir in modal, no-path unchanged, `.` ok, escape rejected) → Task 1. Guide + instructions one-liner on `repo`/`path` → Task 3. Compact manifest view (`manifest show --active`) and cookbook-only pointer → Tasks 2, 3. Three process rules (proposal-only + why, status-confirm + one retry, payload in file + validated first) → Task 3 (validation is the existing `--file` schema/proposal check; no new code). Scaffold dead placeholders → Task 4.
- **Placeholder scan:** none; Task 4 step 3.3 is a grep-driven edit with a test (`references no repo or script it does not declare`) that fails until done.
- **Type consistency:** `resolveChangeDir`/`ChangeDir`, `describeChangeProposal(change, dir)`, `resolveDir`/`runCommand(cwd, …)`, `manifestPath` dep, `MAX_SETUP_PATH` are named identically in every task.
- **Risk noted:** removing `repoCwd` in `setupWiring.ts` changes the `runCommand`/`applyPatch` arg meaning (repo → cwd); only `setupProposalOps` calls them (grep before editing). Containment is lexical, not realpath.
