# Approach Execution Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed a ticket's implement session with its chosen approach's entrypoint prompt, degrading silently to a bare launch when nothing is resolvable.

**Architecture:** A pure resolver reads the entrypoint prompt body from the installed approach package; the agent adapter accepts an optional initial prompt and passes it as a positional CLI arg; `openSession` threads it; the `karst.openSession` host command resolves and passes it. Every failure path yields `null` = today's bare launch.

**Tech Stack:** TypeScript ESM, vitest with fakes, `js-yaml` (already a dep), Node `fs`.

## Global Constraints

- Host-agnostic: no `vscode` import outside `extension.ts`/`*host.ts`/`manifestResolve.ts`. U1–U4 pure/injected, unit-tested with fakes; only Task 5 (host glue) touches vscode.
- Immutable data; new objects, never mutate. Files <400 lines.
- ESM: `.js` import suffix on every import; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` is ON: array access needs `!` or a guard.
- Reuse the existing `assertSafeId` traversal guard in `src/approaches/pkg.ts` — do NOT write new path-traversal logic.
- Strict TDD RED→GREEN per step. Conventional commits.
- Resolution NEVER throws to the user: every failure path returns `null` and the session launches bare.

---

## Task 1: `readPromptBody` helper in pkg.ts

**Files:**
- Modify: `src/approaches/pkg.ts` (add exported function after `readApproachPackage`)
- Test: `src/approaches/pkg.test.ts` (add cases to the existing suite)

**Interfaces:**
- Consumes: existing `approachDir(baseDir, id)` and `assertSafeId(id, where)` in the same file.
- Produces: `readPromptBody(baseDir: string, id: string, promptName: string): string | null`

- [ ] **Step 1: Write the failing tests**

Add to `src/approaches/pkg.test.ts`. Use the existing temp-dir pattern in that file (it already imports `mkdtempSync`/`tmpdir`/`writeApproachPackage` for other tests — follow whatever helper the suite uses to create a package on disk).

```ts
import { readPromptBody } from './pkg.js';

describe('readPromptBody', () => {
  it('returns the body of an existing prompt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-pkg-'));
    writeApproachPackage(
      dir,
      { id: 'tdd', label: 'TDD', prompts: ['research.md'] },
      [{ name: 'research.md', body: '# Research first\n' }],
    );
    expect(readPromptBody(dir, 'tdd', 'research.md')).toBe('# Research first\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the prompt file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-pkg-'));
    writeApproachPackage(dir, { id: 'tdd', label: 'TDD', prompts: [] }, []);
    expect(readPromptBody(dir, 'tdd', 'missing.md')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the package dir does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-pkg-'));
    expect(readPromptBody(dir, 'nope', 'x.md')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on an id with a path separator', () => {
    expect(() => readPromptBody('/base', '../evil', 'x.md')).toThrow();
  });

  it('throws on a prompt name with ".."', () => {
    expect(() => readPromptBody('/base', 'tdd', '../../etc/passwd')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/approaches/pkg.test.ts`
Expected: FAIL — `readPromptBody` is not exported.

- [ ] **Step 3: Implement**

Add to `src/approaches/pkg.ts` (it already imports `readFileSync`, `existsSync`, `join` and defines `approachDir`/`assertSafeId`):

```ts
/**
 * Read a single prompt file's body from an installed package's `prompts/`
 * directory. Both `id` and `promptName` are traversal-guarded. Returns null
 * when the file is absent (or the package/dir does not exist) — callers treat
 * that as "nothing to inject" rather than an error.
 */
export function readPromptBody(
  baseDir: string,
  id: string,
  promptName: string,
): string | null {
  assertSafeId(promptName, 'prompt name');
  const path = join(approachDir(baseDir, id), 'prompts', promptName);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8');
}
```

(`approachDir` already calls `assertSafeId(id, 'approach id')`, so the id is guarded there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/approaches/pkg.test.ts`
Expected: PASS (all new cases + existing suite).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/approaches/pkg.ts src/approaches/pkg.test.ts
git commit -m "feat(approaches): readPromptBody helper for single prompt file"
```

---

## Task 2: `resolveApproachPrompt` pure module

**Files:**
- Create: `src/approaches/resolve.ts`
- Test: `src/approaches/resolve.test.ts`

**Interfaces:**
- Consumes: `readPromptBody(baseDir, id, promptName)` from Task 1; `ApproachDef` from `src/manifest/types.js`.
- Produces: `resolveApproachPrompt(baseDir: string, approaches: readonly ApproachDef[], approachId: string | null | undefined): string | null`

- [ ] **Step 1: Write the failing tests**

Create `src/approaches/resolve.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ApproachDef } from '../manifest/types.js';

vi.mock('./pkg.js', () => ({
  readPromptBody: vi.fn(),
}));

import { readPromptBody } from './pkg.js';
import { resolveApproachPrompt } from './resolve.js';

const approaches: ApproachDef[] = [
  { id: 'tdd', label: 'TDD', entrypoint: 'test-driven-development' },
  { id: 'direct', label: 'Direct' }, // no entrypoint (built-in)
];

describe('resolveApproachPrompt', () => {
  it('returns the entrypoint body on a hit', () => {
    vi.mocked(readPromptBody).mockReturnValue('# Tests first\n');
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBe('# Tests first\n');
    expect(readPromptBody).toHaveBeenCalledWith('/base', 'tdd', 'test-driven-development.md');
  });

  it('returns null for a null/empty approach id', () => {
    expect(resolveApproachPrompt('/base', approaches, null)).toBeNull();
    expect(resolveApproachPrompt('/base', approaches, '')).toBeNull();
    expect(resolveApproachPrompt('/base', approaches, undefined)).toBeNull();
  });

  it('returns null when the id is not in the manifest', () => {
    expect(resolveApproachPrompt('/base', approaches, 'ghost')).toBeNull();
  });

  it('returns null when the approach has no entrypoint', () => {
    expect(resolveApproachPrompt('/base', approaches, 'direct')).toBeNull();
  });

  it('returns null when the prompt file is absent (readPromptBody null)', () => {
    vi.mocked(readPromptBody).mockReturnValue(null);
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });

  it('returns null (never throws) when readPromptBody throws', () => {
    vi.mocked(readPromptBody).mockImplementation(() => {
      throw new Error('traversal');
    });
    expect(resolveApproachPrompt('/base', approaches, 'tdd')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/approaches/resolve.test.ts`
Expected: FAIL — `./resolve.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/approaches/resolve.ts`:

```ts
import type { ApproachDef } from '../manifest/types.js';
import { readPromptBody } from './pkg.js';

/**
 * Resolve the entrypoint prompt body for a ticket's chosen approach, or null.
 *
 * Looks up `approachId` in the manifest's approach list, reads its
 * `entrypoint`, and returns `prompts/<entrypoint>.md` from the installed
 * package. Returns null — never throws — when the id is missing/unknown, the
 * approach has no entrypoint, the package is not installed, or the entrypoint
 * file is absent. The caller treats null as "launch a bare session".
 */
export function resolveApproachPrompt(
  baseDir: string,
  approaches: readonly ApproachDef[],
  approachId: string | null | undefined,
): string | null {
  if (approachId === null || approachId === undefined || approachId.length === 0) {
    return null;
  }

  const def = approaches.find((a) => a.id === approachId);
  if (def === undefined || def.entrypoint === undefined || def.entrypoint.length === 0) {
    return null;
  }

  try {
    return readPromptBody(baseDir, approachId, `${def.entrypoint}.md`);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/approaches/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/approaches/resolve.ts src/approaches/resolve.test.ts
git commit -m "feat(approaches): resolveApproachPrompt (entrypoint body or null)"
```

---

## Task 3: `initialPrompt` on the interactive adapter

**Files:**
- Modify: `src/agent/adapter.ts` (add optional field to `InteractiveCommandOpts`)
- Modify: `src/agent/claude.ts` (`buildInteractiveCommand` appends the positional arg)
- Test: `src/agent/claude.test.ts` (add cases; if the file does not exist, create it)

**Interfaces:**
- Consumes: existing `InteractiveCommandOpts { cwd; settingsPath? }` and `ClaudeAdapter.buildInteractiveCommand`.
- Produces: `InteractiveCommandOpts.initialPrompt?: string`; when present and non-empty, `buildInteractiveCommand` returns `args` with it as a trailing positional entry.

- [ ] **Step 1: Write the failing tests**

Add to `src/agent/claude.test.ts` (import `ClaudeAdapter` from `./claude.js`):

```ts
describe('buildInteractiveCommand initialPrompt', () => {
  const adapter = new ClaudeAdapter();

  it('appends initialPrompt as a positional arg after --settings', () => {
    const cmd = adapter.buildInteractiveCommand({
      cwd: '/wt',
      settingsPath: '/s.json',
      initialPrompt: 'do the thing',
    });
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['--settings', '/s.json', 'do the thing']);
  });

  it('appends initialPrompt even without settingsPath', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: 'go' });
    expect(cmd.args).toEqual(['go']);
  });

  it('omits the positional when initialPrompt is absent', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', settingsPath: '/s.json' });
    expect(cmd.args).toEqual(['--settings', '/s.json']);
  });

  it('omits the positional when initialPrompt is empty', () => {
    const cmd = adapter.buildInteractiveCommand({ cwd: '/wt', initialPrompt: '' });
    expect(cmd.args).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/claude.test.ts`
Expected: FAIL — `initialPrompt` not in the type / not appended.

- [ ] **Step 3: Implement**

In `src/agent/adapter.ts`, extend the interface:

```ts
export interface InteractiveCommandOpts {
  cwd: string;
  settingsPath?: string; // registers the HTTP hook, scoped to our sessions
  initialPrompt?: string; // seed prompt for the session (e.g. an approach entrypoint)
}
```

In `src/agent/claude.ts`, update `buildInteractiveCommand`:

```ts
  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand {
    const args: string[] = [];
    if (opts.settingsPath) {
      args.push('--settings', opts.settingsPath);
    }
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      args.push(opts.initialPrompt);
    }
    return { command: CLAUDE_BIN, args, env: {} };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/agent/adapter.ts src/agent/claude.ts src/agent/claude.test.ts
git commit -m "feat(agent): interactive initialPrompt seeds the session"
```

---

## Task 4: `openSession` threads `initialPrompt`

**Files:**
- Modify: `src/ui/session.ts` (`openSession` gains an optional `initialPrompt` param)
- Test: `src/ui/session.test.ts` (add cases; follow the existing fake-terminal/fake-adapter setup in that file)

**Interfaces:**
- Consumes: `InteractiveCommandOpts.initialPrompt` from Task 3.
- Produces: `openSession(ticketId, worktreePath, label?, initialPrompt?)` — passes `initialPrompt` into `buildInteractiveCommand` on a fresh launch; the re-open (focus) path never calls `buildInteractiveCommand`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/session.test.ts`. Reuse the file's existing fakes; capture the args the adapter is asked to build. If the existing fake adapter does not record `buildInteractiveCommand` calls, add a spy (`vi.fn`) that returns `{ command: 'claude', args: [], env: {} }` and records the opts.

```ts
it('passes initialPrompt to buildInteractiveCommand on a fresh launch', () => {
  const build = vi.fn().mockReturnValue({ command: 'claude', args: [], env: {} });
  const adapter = { buildInteractiveCommand: build /* + other members as the suite requires */ };
  const mgr = new SessionManager(adapter as never, host, () => '/s.json');

  mgr.openSession(1, '/wt', { key: 'K-1', title: 't' }, 'seed prompt');

  expect(build).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/wt', initialPrompt: 'seed prompt' }),
  );
});

it('does not re-seed on re-open (focus path skips buildInteractiveCommand)', () => {
  const build = vi.fn().mockReturnValue({ command: 'claude', args: [], env: {} });
  const adapter = { buildInteractiveCommand: build /* + other members */ };
  const mgr = new SessionManager(adapter as never, host, () => '/s.json');

  mgr.openSession(1, '/wt', undefined, 'seed prompt');
  mgr.openSession(1, '/wt', undefined, 'seed prompt');

  expect(build).toHaveBeenCalledTimes(1);
});
```

(Match `host`/adapter construction to the existing tests in the file — this snippet shows intent, not the file's exact fixture names.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/session.test.ts`
Expected: FAIL — `openSession` ignores the 4th arg.

- [ ] **Step 3: Implement**

In `src/ui/session.ts`, update `openSession`:

```ts
  openSession(
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      existing.show();
      return;
    }

    const settingsPath = this.settingsPathFor(ticketId, worktreePath);
    const cmd = this.adapter.buildInteractiveCommand({
      cwd: worktreePath,
      settingsPath,
      ...(initialPrompt ? { initialPrompt } : {}),
    });

    const terminal = this.host.createTerminal({
      name: `Karst: ${label?.key ?? `#${ticketId}`}`,
      description: label?.title ?? undefined,
      cwd: worktreePath,
      shellPath: cmd.command,
      shellArgs: cmd.args,
    });
    terminal.onDidClose(() => this.terminals.delete(ticketId));
    this.terminals.set(ticketId, terminal);
    terminal.show();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/ui/session.ts src/ui/session.test.ts
git commit -m "feat(session): thread initialPrompt into fresh session launch"
```

---

## Task 5: Host glue — resolve the approach prompt at `karst.openSession`

**Files:**
- Modify: `src/extension.ts` (the `karst.openSession` command handler, ~line 216-226)

**Interfaces:**
- Consumes: `resolveApproachPrompt` (Task 2), `openSession`'s new `initialPrompt` param (Task 4), the in-scope `currentManifest`, `approachesDirOrThrow()`, and `t` (the ticket, which carries `approach`).
- Produces: no new exports — wires the seam.

No unit test (vscode host seam, per Global Constraints). Verify with typecheck + build.

- [ ] **Step 1: Add the import**

At the top of `src/extension.ts`, alongside the other `./approaches/*` imports:

```ts
import { resolveApproachPrompt } from './approaches/resolve.js';
```

- [ ] **Step 2: Resolve and pass in the command handler**

Replace the body of the `karst.openSession` handler (currently ending in `sessions.openSession(ticketId, wt.path, { key: t.key, title: t.title });`) with:

```ts
    vscode.commands.registerCommand('karst.openSession', (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      const wt = listWorktreesByTicket(localStore, ticketId)[0];
      if (!wt) {
        void vscode.window.showWarningMessage(`Ticket #${ticketId} has no worktree yet — scope it first.`);
        return;
      }
      const t = getTicket(localStore, ticketId);

      // Seed the session with the ticket's chosen approach entrypoint, if one
      // resolves. Any failure (no folder, no package, bad id) → bare launch.
      let initialPrompt: string | undefined;
      try {
        const approaches = (currentManifest ?? emptyManifest()).approaches ?? [];
        initialPrompt = resolveApproachPrompt(approachesDirOrThrow(), approaches, t.approach) ?? undefined;
      } catch {
        initialPrompt = undefined;
      }

      sessions.openSession(ticketId, wt.path, { key: t.key, title: t.title }, initialPrompt);
    }),
```

(Confirm the ticket type from `getTicket` exposes `approach` — the onboarding writer sets it via `updateTicketOnboarding(store, ticketId, { approach: id })`. If the `Ticket` type does not surface `approach`, read it from the store the same way the onboarding read path does and pass that value instead; do NOT invent a new column.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean.

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: all tests pass (nothing regressed; new units covered in Tasks 1-4).

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat(extension): seed impl session with chosen approach entrypoint"
```

---

## Verification (end-to-end, manual F5)

1. `npm run typecheck`, `npm test`, `npm run build` green after every task.
2. F5 → Extension Dev Host. Install a git approach that has a `prompts/<entrypoint>.md` (e.g. `superpowers:test-driven-development`, entrypoint `test-driven-development`).
3. Create/onboard a ticket, pick that approach, scope it (so a worktree exists).
4. Run **karst.openSession** → the launched `claude` terminal opens with the entrypoint prompt as its initial message (agent starts inside the approach, not blank).
5. Pick a built-in approach (`direct`, no package) on another ticket → session launches bare (no error).
6. Delete the installed package on disk, re-open a ticket that referenced it → bare launch, no error.
7. Re-open an already-open session → it focuses the existing terminal, does not re-seed.

## Out of scope (explicit — next features)

- Multi-stage prompt mapping (research→scope, plan→plan). This plan: impl only, entrypoint only.
- Injecting sibling `prompts/*.md` or resolving entrypoint `@`-mentions from the worktree cwd.
- Model tiering (`model` on `RunHeadlessOpts`).
- Settings source-recipe editing, approach uninstall, package↔manifest reconcile.
