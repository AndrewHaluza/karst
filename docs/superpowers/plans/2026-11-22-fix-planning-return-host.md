# Planner feedback loop (host warnings, rejections, priority, `--file`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `karst draft propose` returns the host warnings and the host rejection reason to the planner, the `draft` schema accepts `priority`/`priorityReason`, and `--file` refuses symlinks and non-regular files.

**Architecture:** The host keeps the store as the source of truth and writes two agent-readable files into the session scratch: `proposals.json` (now with `warnings` and a `checking` latch) and one `outbox-rejections/<uuid>.json` file for each rejected outbox file. The CLI polls both files with bounded, `O_NOFOLLOW|O_NONBLOCK` reads. The CLI opens no store, and the host never reads back the contents of an agent-writable file.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), Node `fs`, vitest 4, better-sqlite3 (host store only).

**Spec:** ticket T1306 `FIX-PLANNING-RETURN-HOST` (run `karst context FIX-PLANNING-RETURN-HOST`). Design rules: `@arch:CLI-03`, `@arch:CLI-13`, `@arch:CLI-17`, `@arch:DRAFT-CONSTRAINTS` in `docs/arch/cli.md`, `@arch:PLANNING` in `docs/arch/store-and-schema.md`.

## Global Constraints

- `karst draft` opens no SQLite store and loads no manifest (`@arch:CLI-13`).
- Do not add `spawnSync` on any host path.
- The host never reads back the contents of a file in the agent-writable scratch dir. Metadata (`lstat`, `readdir`) for pruning is allowed.
- Every read of an agent-writable file is size-capped, `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and requires `fstatSync(fd).isFile()`.
- A host rejection makes `draft propose` throw: exit 1 in the CLI, `isError: true` in MCP. Never return `{ok: true}` for a rejected draft.
- Behavior is the same on every agent core (claude, codex, opencode, opencode2, antigravity).
- Do NOT touch `src/ui/**` or visual baselines. Do NOT add new quality heuristics.
- `src/extension.ts` may grow by at most 15 net lines (`src/extension/ops/ratchet.test.ts`).
- Test naming: a file that spawns a child process is `*.integration.test.ts`. Do not add `mkfifo` (a child process) to a unit test. Test the non-regular-file case with a directory.
- Output discipline: run `npx vitest run <file>` for one file. Do not run the full suite. Run `npm run -s typecheck` after test edits.
- Run `npm run -s rebuild:node` once before the first vitest run.
- Commit format: `<type>: <description>`, with the `Co-Authored-By` trailer from the session.
- Prose (comments, docs, commit bodies) uses ASD-STE100: short sentences, active voice.

## File map

| File | Change |
|---|---|
| `src/cli/registry.ts` | `draft` input gets `priority` (enum) and `priorityReason`. |
| `src/cli/commandInput.ts` | `readFileBounded` uses `O_NOFOLLOW|O_NONBLOCK` and a regular-file check. |
| `src/cli/main.ts` | `runCliAsync` forwards `env` to `runCli`. |
| `src/planning/proposalIndex.ts` | Entry fields `warnings`/`checking`; rejection file read and write with prune; `waitForProposalResult`. |
| `src/extension/ops/planningIndex.ts` | `checkingIds` option; `recordOutboxRejection`. |
| `src/extension/ops/planningOutbox.ts` | `checking` latch, `checkingIds()`, rejection record in `reject()`. |
| `src/extension.ts` | Pass `outbox.checkingIds()` into `refreshPlanningIndex` through a holder. |
| `src/cli/draftCommand.ts` | Use `waitForProposalResult`; return `warnings`, `hint`, `checksPending`; throw on rejection; `list` shows `warnings`. |
| `src/cli/guide.ts` | Document `--file`, returned warnings, rejections, `checksPending`. |
| `docs/arch/cli.md`, `docs/arch/store-and-schema.md` | Update the covered blocks. |

---

### Task 1: `draft` schema accepts `priority` and `priorityReason`

**Files:**
- Modify: `src/cli/registry.ts` (imports near line 20; `draft` spec near lines 384-403)
- Test: `src/cli/registry.test.ts`, `src/cli/mcp/server.test.ts`

**Interfaces:**
- Consumes: `PRIORITY_LEVELS` from `src/model/priority.ts` (`['urgent','high','normal','low'] as const`).
- Produces: `validateCommandInput('draft', {..., priority, priorityReason})` accepts a valid level and a string reason.

- [ ] **Step 1: Write the failing tests**

In `src/cli/registry.test.ts`, after the test `'draft accepts integer or D<n> ids for id and dependsOn, rejects other prefixes'`, add:

```ts
  it('draft accepts priority and priorityReason, rejects an unknown level or a non-string reason', () => {
    const base = { title: 't', description: 'd', summary: 's', repos: ['a'] };
    expect(() => validateCommandInput('draft', { ...base, priority: 'high', priorityReason: 'blocks release' })).not.toThrow();
    expect(() => validateCommandInput('draft', { ...base, priority: 'critical' })).toThrow(/priority/);
    expect(() => validateCommandInput('draft', { ...base, priorityReason: 7 })).toThrow(/priorityReason/);
  });
```

In `src/cli/mcp/server.test.ts`, after the test `'feeds the validated draft object back as stdin'`, add:

```ts
  it('passes priority and priorityReason through the draft tool', async () => {
    const { runner, calls } = recorder('{"ok":true,"file":"f","id":1}');
    const input = { title: 'T', description: 'D', summary: 'S', repos: ['extention'], priority: 'high', priorityReason: 'blocks release' };
    const result = await callTool('draft', input, NO_CONFIG, {}, runner);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(calls[0]!.io.readStdin(1 << 16))).toEqual(input);
  });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm run -s rebuild:node && npx vitest run src/cli/registry.test.ts src/cli/mcp/server.test.ts`
Expected: FAIL. The new tests report an `additionalProperties` error for `priority`.

- [ ] **Step 3: Write the minimal implementation**

In `src/cli/registry.ts`, add this import below the other imports:

```ts
import { PRIORITY_LEVELS } from '../model/priority.js';
```

In the `draft` spec, change the `input` properties to:

```ts
      {
        title: str,
        description: str,
        summary: str,
        repos: csvArray,
        id: draftRef,
        dependsOn: dependsOnArray,
        constraints: strArray,
        priority: { type: 'string', enum: [...PRIORITY_LEVELS] },
        priorityReason: str,
      },
```

Do not change the `required` list.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/cli/registry.test.ts src/cli/mcp/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/registry.ts src/cli/registry.test.ts src/cli/mcp/server.test.ts
git commit -m "fix: draft schema accepts priority and priorityReason for --file, --stdin and MCP"
```

---

### Task 2: Harden `--file` and forward `env` from `runCliAsync`

**Files:**
- Modify: `src/cli/commandInput.ts:16` (import) and `:48-64` (`readFileBounded`)
- Modify: `src/cli/main.ts:1023`
- Test: `src/cli/commandInput.test.ts`, `src/cli/main.test.ts`

**Interfaces:**
- Consumes: Task 1 (the `draft` schema accepts `priority`).
- Produces: no new exports. `--file` refuses a symlink (`ELOOP`) and a non-regular file (`not a regular file`).

- [ ] **Step 1: Write the failing tests**

In `src/cli/commandInput.test.ts`, change the `node:fs` import to:

```ts
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
```

Add this `describe` block at the end of the file:

```ts
describe('--file reads only a regular file', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-file-input-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a regular file from disk', () => {
    const path = join(dir, 'in.json');
    writeFileSync(path, '{"title":"Piece"}');
    const out = resolveStructuredInput(subtaskSpec(), ['subtask', '--file', path], deps(''));
    expect(out?.argv).toEqual(['subtask', 'create', '--title', 'Piece']);
  });

  it('refuses a symlink', () => {
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(real, '{"title":"Piece"}');
    symlinkSync(real, link);
    expect(() => resolveStructuredInput(subtaskSpec(), ['subtask', '--file', link], deps(''))).toThrow(
      /cannot read --file .*ELOOP/,
    );
  });

  it('refuses a path that is not a regular file', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    expect(() => resolveStructuredInput(subtaskSpec(), ['subtask', '--file', sub], deps(''))).toThrow(
      /cannot read --file .*not a regular file/,
    );
  });

  it('draft propose --file carries priority and priorityReason into the outbox', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox);
    const path = join(dir, 'draft.json');
    const draft = { title: 'T', description: 'D', summary: 'S', repos: ['api'], priority: 'high', priorityReason: 'blocks release' };
    writeFileSync(path, JSON.stringify(draft));
    const out = JSON.parse(
      runCli(['draft', 'propose', '--file', path], { KARST_OUTBOX: outbox }, { readStdin: () => '', timeoutMs: 0 }),
    );
    expect(JSON.parse(readFileSync(out.file, 'utf8'))).toMatchObject({ priority: 'high', priorityReason: 'blocks release' });
  });
});
```

If `beforeEach`/`afterEach` are not in the vitest import of the file, add them.

In `src/cli/main.test.ts`, change the `node:fs` import to add `mkdirSync`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
```

After the `describe('runCliAsync — base', …)` block, add:

```ts
describe('runCliAsync — fall-through to runCli', () => {
  it('forwards the injected env, not process.env', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-async-env-')));
    vi.stubEnv('KARST_OUTBOX', '');
    try {
      mkdirSync(join(dir, 'outbox'));
      writeFileSync(
        join(dir, 'proposals.json'),
        JSON.stringify([{ id: 7, uuid: 'u', title: 'T', status: 'pending', updatedAt: 'x' }]),
      );
      const out = await runCliAsync(['draft', 'list'], { KARST_OUTBOX: join(dir, 'outbox') });
      expect(JSON.parse(out)).toEqual([{ id: 7, ref: 'D7', status: 'pending', title: 'T' }]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/cli/commandInput.test.ts src/cli/main.test.ts`
Expected: FAIL. The symlink test reads the target. The directory test reports `EISDIR`, not `not a regular file`. The env test reports `KARST_OUTBOX is not set`.

- [ ] **Step 3: Write the minimal implementation**

In `src/cli/commandInput.ts`, change the import to:

```ts
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
```

Replace `readFileBounded` with:

```ts
/**
 * Read at most `max + 1` bytes from `path` and close it. Mirrors
 * `readStdinBounded`: the extra byte is enough to detect oversize, so a wrong
 * or enormous path never allocates the whole file before the size check.
 * `O_NOFOLLOW` refuses a symlink and `O_NONBLOCK` refuses to hang on a FIFO;
 * the fstat check refuses anything that is not a regular file. This is the
 * same posture as the host outbox read (`planningOutbox.ts`).
 */
function readFileBounded(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.alloc(8192);
    while (total <= max) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, max + 1 - total), null);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
```

In `src/cli/main.ts` line 1023, change:

```ts
  if (rest[0] !== 'servers') return runCli(argv);
```

to:

```ts
  if (rest[0] !== 'servers') return runCli(argv, env);
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/cli/commandInput.test.ts src/cli/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commandInput.ts src/cli/commandInput.test.ts src/cli/main.ts src/cli/main.test.ts
git commit -m "fix: --file refuses symlinks and non-regular files; runCliAsync forwards env"
```

---

### Task 3: Proposal index fields, rejection files and `waitForProposalResult`

**Files:**
- Modify: `src/planning/proposalIndex.ts`
- Test: `src/planning/proposalIndex.test.ts`

**Interfaces:**
- Produces (all exported from `src/planning/proposalIndex.ts`):
  - `interface ProposalIndexEntry { id: number; uuid: string; title: string; status: ProposalIndexStatus; updatedAt: string; warnings?: string[]; checking?: boolean }`
  - `const OUTBOX_REJECTIONS_DIR = 'outbox-rejections'`
  - `const MAX_OUTBOX_REJECTIONS = 20`
  - `const MAX_OUTBOX_REJECTION_BYTES = 1 << 16`
  - `const MAX_REJECTION_REASON_CHARS = 2000`
  - `const PROPOSAL_UUID: RegExp` (`/^[0-9a-f-]{36}$/`, the same alphabet as the outbox `PROPOSAL_NAME`)
  - `interface OutboxRejectionEntry { uuid: string; reason: string; rejectedAt: string }`
  - `function outboxRejectionsDir(scratch: string): string`
  - `function readOutboxRejection(scratch: string, uuid: string, fs?: typeof nodeFs): OutboxRejectionEntry | undefined`
  - `function writeOutboxRejection(scratch: string, entry: OutboxRejectionEntry, fs?: typeof nodeFs): void` (throws on failure)
  - `type ProposalResult = { kind: 'ingested'; id: number; warnings: string[]; checksPending?: true } | { kind: 'rejected'; reason: string } | { kind: 'timeout' }`
  - `type WaitForProposalResultOpts = WaitForProposalIdOpts`
  - `function waitForProposalResult(scratch: string, uuid: string, opts?: WaitForProposalResultOpts): ProposalResult`
  - `waitForProposalId` stays, as a wrapper over `waitForProposalResult`.

- [ ] **Step 1: Write the failing tests**

In `src/planning/proposalIndex.test.ts`, change the imports to:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_OUTBOX_REJECTIONS,
  MAX_PROPOSAL_INDEX_BYTES,
  MAX_REJECTION_REASON_CHARS,
  OUTBOX_REJECTIONS_DIR,
  outboxRejectionsDir,
  readOutboxRejection,
  readProposalIndex,
  writeOutboxRejection,
  writeProposalIndex,
  waitForProposalId,
  waitForProposalResult,
  proposalIndexPath,
  type ProposalIndexEntry,
} from './proposalIndex.js';
```

Keep the existing tests. Add these blocks at the end of the file:

```ts
const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('proposal index entry fields', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-index-fields-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const base = { id: 1, uuid: UUID(1), title: 'T', status: 'pending', updatedAt: 'x' };

  it('keeps warnings and checking when they have the right types', () => {
    writeFileSync(proposalIndexPath(scratch), JSON.stringify([{ ...base, warnings: ['w'], checking: true }]));
    expect(readProposalIndex(scratch)).toEqual([{ ...base, warnings: ['w'], checking: true }]);
  });

  it('keeps an entry that omits both fields', () => {
    writeFileSync(proposalIndexPath(scratch), JSON.stringify([base]));
    expect(readProposalIndex(scratch)).toEqual([base]);
  });

  it('drops an entry with a bad warnings or checking value', () => {
    writeFileSync(
      proposalIndexPath(scratch),
      JSON.stringify([
        { ...base, id: 1, warnings: 'w' },
        { ...base, id: 2, warnings: [1] },
        { ...base, id: 3, checking: 'yes' },
        { ...base, id: 4, warnings: [], checking: false },
      ]),
    );
    expect(readProposalIndex(scratch).map((e) => e.id)).toEqual([4]);
  });
});

describe('outbox rejection files', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-rejections-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const entry = (n: number) => ({ uuid: UUID(n), reason: `reason ${n}`, rejectedAt: '2026-11-22T00:00:00.000Z' });

  it('round-trips one rejection under outbox-rejections/<uuid>.json, mode 0600', () => {
    writeOutboxRejection(scratch, entry(1));
    const file = join(scratch, OUTBOX_REJECTIONS_DIR, `${UUID(1)}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOutboxRejection(scratch, UUID(1))).toEqual(entry(1));
    expect(readOutboxRejection(scratch, UUID(2))).toBeUndefined();
  });

  it('caps the stored reason length', () => {
    writeOutboxRejection(scratch, { ...entry(1), reason: 'x'.repeat(MAX_REJECTION_REASON_CHARS + 50) });
    expect(readOutboxRejection(scratch, UUID(1))!.reason).toHaveLength(MAX_REJECTION_REASON_CHARS);
  });

  it('refuses an invalid uuid on write and reads it as no rejection', () => {
    expect(() => writeOutboxRejection(scratch, { ...entry(1), uuid: '../../etc/passwd' })).toThrow(/uuid/);
    expect(readOutboxRejection(scratch, '../x')).toBeUndefined();
  });

  it('reads a symlinked, malformed or mismatched rejection as none', () => {
    const dir = outboxRejectionsDir(scratch);
    mkdirSync(dir);
    writeFileSync(join(scratch, 'real.json'), JSON.stringify(entry(1)));
    symlinkSync(join(scratch, 'real.json'), join(dir, `${UUID(1)}.json`));
    writeFileSync(join(dir, `${UUID(2)}.json`), '{not json');
    writeFileSync(join(dir, `${UUID(3)}.json`), JSON.stringify(entry(4)));
    writeFileSync(join(dir, `${UUID(5)}.json`), JSON.stringify({ ...entry(5), reason: 5 }));
    for (const n of [1, 2, 3, 5]) expect(readOutboxRejection(scratch, UUID(n))).toBeUndefined();
  });

  it('refuses a symlinked rejections dir and touches nothing outside it', () => {
    const victim = join(scratch, 'victim');
    mkdirSync(victim);
    for (let n = 1; n <= 25; n++) writeFileSync(join(victim, `${UUID(n)}.json`), 'keep');
    symlinkSync(victim, outboxRejectionsDir(scratch));
    expect(() => writeOutboxRejection(scratch, entry(99))).toThrow(/not a plain directory/);
    expect(readdirSync(victim)).toHaveLength(25);
  });

  it(`keeps at most ${MAX_OUTBOX_REJECTIONS} files and prunes the oldest first`, () => {
    const dir = outboxRejectionsDir(scratch);
    mkdirSync(dir);
    for (let n = 1; n <= MAX_OUTBOX_REJECTIONS; n++) {
      const file = join(dir, `${UUID(n)}.json`);
      writeFileSync(file, JSON.stringify(entry(n)));
      utimesSync(file, 1_000 + n, 1_000 + n);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not a rejection');
    writeOutboxRejection(scratch, entry(100));
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(names).toHaveLength(MAX_OUTBOX_REJECTIONS);
    expect(names).not.toContain(`${UUID(1)}.json`);
    expect(names).toContain(`${UUID(2)}.json`);
    expect(names).toContain(`${UUID(100)}.json`);
    expect(readdirSync(dir)).toContain('notes.txt');
  });

  it(`prunes nothing at exactly ${MAX_OUTBOX_REJECTIONS} files`, () => {
    for (let n = 1; n < MAX_OUTBOX_REJECTIONS; n++) writeOutboxRejection(scratch, entry(n));
    writeOutboxRejection(scratch, entry(100));
    expect(readdirSync(outboxRejectionsDir(scratch))).toHaveLength(MAX_OUTBOX_REJECTIONS);
  });
});

describe('waitForProposalResult', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-wait-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const row = (over: Partial<ProposalIndexEntry> = {}): ProposalIndexEntry => ({
    id: 42,
    uuid: UUID(1),
    title: 'T',
    status: 'pending',
    updatedAt: 'x',
    ...over,
  });

  /** A fake clock; `onSleep(k)` runs on the k-th sleep (1-based). */
  function clock(onSleep: (k: number) => void = () => {}) {
    let t = 0;
    let k = 0;
    return {
      sleeps: () => k,
      opts: {
        timeoutMs: 1_000,
        intervalMs: 100,
        now: () => t,
        sleep: (ms: number) => {
          t += ms;
          k += 1;
          onSleep(k);
        },
      },
    };
  }

  it('returns rejected with the reason as soon as the rejection file appears', () => {
    const c = clock(() => writeOutboxRejection(scratch, { uuid: UUID(1), reason: 'unknown repositories x', rejectedAt: 'now' }));
    expect(waitForProposalResult(scratch, UUID(1), c.opts)).toEqual({ kind: 'rejected', reason: 'unknown repositories x' });
    expect(c.sleeps()).toBe(1);
  });

  it('returns ingested with the index warnings', () => {
    writeProposalIndex(scratch, [row({ warnings: ['unknown design key @arch:NOPE'] })]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['unknown design key @arch:NOPE'],
    });
  });

  it('returns warnings: [] when the entry has none', () => {
    writeProposalIndex(scratch, [row()]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({ kind: 'ingested', id: 42, warnings: [] });
  });

  it('waits while the entry is checking and returns once checking clears', () => {
    writeProposalIndex(scratch, [row({ checking: true })]);
    const c = clock((k) => {
      if (k === 2) writeProposalIndex(scratch, [row({ warnings: ['unknown commit abc1234'] })]);
    });
    expect(waitForProposalResult(scratch, UUID(1), c.opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['unknown commit abc1234'],
    });
    expect(c.sleeps()).toBe(2);
  });

  it('returns ingested with checksPending when the deadline passes mid-check', () => {
    writeProposalIndex(scratch, [row({ checking: true, warnings: ['w'] })]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['w'],
      checksPending: true,
    });
  });

  it('returns timeout when the host never answers', () => {
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({ kind: 'timeout' });
  });

  it('waitForProposalId returns the id, or undefined on a rejection', () => {
    writeProposalIndex(scratch, [row()]);
    expect(waitForProposalId(scratch, UUID(1), clock().opts)).toBe(42);
    writeOutboxRejection(scratch, { uuid: UUID(2), reason: 'r', rejectedAt: 'now' });
    expect(waitForProposalId(scratch, UUID(2), clock().opts)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/planning/proposalIndex.test.ts`
Expected: FAIL. The new imports do not exist.

- [ ] **Step 3: Write the minimal implementation**

In `src/planning/proposalIndex.ts`:

3a. Extend the header comment. Add this paragraph after the paragraph that ends with "no vscode — so the CLI and the host share one shape.":

```ts
 *
 * The host also tells the agent what it found. An entry carries `warnings`
 * (absent when there are none) and `checking: true` while an async host check
 * (the commit probe) still runs. A file the host REJECTS gets
 * `<scratch>/outbox-rejections/<uuid>.json` with the reason, so `draft
 * propose` fails at once with that reason. The host writes these files and
 * never reads their contents back.
```

3b. Replace the `ProposalIndexEntry` interface and `isEntry` with:

```ts
export interface ProposalIndexEntry {
  id: number;
  /** The outbox file's uuid that created or last revised this proposal. */
  uuid: string;
  title: string;
  status: ProposalIndexStatus;
  updatedAt: string;
  /** The host warnings on the draft; absent when it has none. */
  warnings?: string[];
  /** True while an async host check on this uuid still runs; absent otherwise. */
  checking?: boolean;
}
```

```ts
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((w) => typeof w === 'string');

function isEntry(v: unknown): v is ProposalIndexEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'number' &&
    Number.isInteger(e.id) &&
    typeof e.uuid === 'string' &&
    typeof e.title === 'string' &&
    typeof e.status === 'string' &&
    STATUSES.includes(e.status) &&
    typeof e.updatedAt === 'string' &&
    (e.warnings === undefined || isStringArray(e.warnings)) &&
    (e.checking === undefined || typeof e.checking === 'boolean')
  );
}
```

3c. Rename `readIndexBounded(path, fs)` to `readRegularFileBounded(path: string, max: number, fs: typeof nodeFs): string | undefined`. Replace each `MAX_PROPOSAL_INDEX_BYTES` inside its body with `max`. Change its doc comment first line to "Read at most `max` bytes, and only from a regular file:". In `readProposalIndex`, change the call to:

```ts
  const text = readRegularFileBounded(proposalIndexPath(scratch), MAX_PROPOSAL_INDEX_BYTES, fs);
```

3d. Add the rejection section after `writeProposalIndex`:

```ts
/** The dir under the session scratch that holds one file per rejected outbox file. */
export const OUTBOX_REJECTIONS_DIR = 'outbox-rejections';
/** The host keeps at most this many rejection files for each session (oldest pruned first). */
export const MAX_OUTBOX_REJECTIONS = 20;
/** The CLI reads a rejection file only up to this size. */
export const MAX_OUTBOX_REJECTION_BYTES = 1 << 16;
/** The host stores at most this many characters of a rejection reason. */
export const MAX_REJECTION_REASON_CHARS = 2000;
/** An outbox file uuid: the same alphabet the host scan accepts. No path separator can pass. */
export const PROPOSAL_UUID = /^[0-9a-f-]{36}$/;
const REJECTION_NAME = /^[0-9a-f-]{36}\.json$/;

export interface OutboxRejectionEntry {
  uuid: string;
  reason: string;
  rejectedAt: string;
}

export function outboxRejectionsDir(scratch: string): string {
  return join(scratch, OUTBOX_REJECTIONS_DIR);
}

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

function isRejection(v: unknown, uuid: string): v is OutboxRejectionEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return e.uuid === uuid && typeof e.reason === 'string' && typeof e.rejectedAt === 'string';
}

/**
 * The host's rejection of the outbox file `uuid`, or `undefined` when there is
 * none, or when the file is not a bounded regular file of the right shape.
 */
export function readOutboxRejection(
  scratch: string,
  uuid: string,
  fs: typeof nodeFs = nodeFs,
): OutboxRejectionEntry | undefined {
  if (!PROPOSAL_UUID.test(uuid)) return undefined;
  const text = readRegularFileBounded(join(outboxRejectionsDir(scratch), `${uuid}.json`), MAX_OUTBOX_REJECTION_BYTES, fs);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isRejection(raw, uuid) ? raw : undefined;
}

/**
 * Create the rejections dir when it is missing, and return it only when it is
 * a real directory at its own realpath. The scratch dir is agent-writable: a
 * symlinked dir would let the host write or prune files outside the scratch.
 */
function verifiedRejectionsDir(scratch: string, fs: typeof nodeFs): string {
  const dir = outboxRejectionsDir(scratch);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') throw e;
  }
  if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== join(fs.realpathSync(scratch), OUTBOX_REJECTIONS_DIR)) {
    throw new Error(`${OUTBOX_REJECTIONS_DIR} is not a plain directory`);
  }
  return dir;
}

/**
 * Delete the oldest rejection files past the cap. Metadata only (readdir +
 * lstat): the host never reads an agent-writable file back. Only regular files
 * with a `<uuid>.json` name are counted or deleted. A prune failure is
 * ignored on purpose: the rejection itself is already written.
 */
function pruneOutboxRejections(dir: string, keep: string, fs: typeof nodeFs): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const files = names
    .filter((name) => REJECTION_NAME.test(name) && name !== keep)
    .flatMap((name) => {
      try {
        const st = fs.lstatSync(join(dir, name));
        return st.isFile() ? [{ name, mtimeMs: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    });
  const excess = files.length + 1 - MAX_OUTBOX_REJECTIONS;
  if (excess <= 0) return;
  const oldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name)).slice(0, excess);
  for (const f of oldest) {
    try {
      fs.unlinkSync(join(dir, f.name));
    } catch {
      // best effort — the next write prunes again
    }
  }
}

/**
 * Write one rejection atomically (tmp `wx` 0600, then rename) and prune the
 * oldest files past `MAX_OUTBOX_REJECTIONS`. One file for each uuid, so two
 * windows never read-modify-write a shared file. Throws on a failed write.
 */
export function writeOutboxRejection(
  scratch: string,
  entry: OutboxRejectionEntry,
  fs: typeof nodeFs = nodeFs,
): void {
  if (!PROPOSAL_UUID.test(entry.uuid)) throw new Error(`invalid proposal uuid ${JSON.stringify(entry.uuid)}`);
  const dir = verifiedRejectionsDir(scratch, fs);
  const body: OutboxRejectionEntry = {
    uuid: entry.uuid,
    reason: entry.reason.slice(0, MAX_REJECTION_REASON_CHARS),
    rejectedAt: entry.rejectedAt,
  };
  const name = `${entry.uuid}.json`;
  const tmp = join(dir, `.tmp-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, join(dir, name));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort — the rename is the atomic step
    }
    throw e;
  }
  pruneOutboxRejections(dir, name, fs);
}
```

3e. Replace `waitForProposalId` (keep `WaitForProposalIdOpts`, `PROPOSAL_ID_TIMEOUT_MS`, `PROPOSAL_ID_POLL_MS` and `defaultSleep`) with:

```ts
export type WaitForProposalResultOpts = WaitForProposalIdOpts;

export type ProposalResult =
  | { kind: 'ingested'; id: number; warnings: string[]; checksPending?: true }
  | { kind: 'rejected'; reason: string }
  | { kind: 'timeout' };

/**
 * Poll (bounded) for the host's answer to the outbox file `uuid`. A rejection
 * file returns `rejected` at once. An index entry returns `ingested` once it
 * is no longer `checking`. At the deadline an entry that is still checking
 * returns `ingested` with `checksPending: true`; no entry returns `timeout`.
 * Synchronous by design: the CLI's `runCli` is synchronous and this is the
 * one bounded wait it makes.
 */
export function waitForProposalResult(
  scratch: string,
  uuid: string,
  opts: WaitForProposalResultOpts = {},
): ProposalResult {
  const timeoutMs = opts.timeoutMs ?? PROPOSAL_ID_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? PROPOSAL_ID_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (;;) {
    const rejected = readOutboxRejection(scratch, uuid, opts.fs);
    if (rejected) return { kind: 'rejected', reason: rejected.reason };
    const found = readProposalIndex(scratch, opts.fs).find((e) => e.uuid === uuid);
    if (found && found.checking !== true) return { kind: 'ingested', id: found.id, warnings: found.warnings ?? [] };
    const remaining = deadline - now();
    if (remaining <= 0) {
      return found
        ? { kind: 'ingested', id: found.id, warnings: found.warnings ?? [], checksPending: true }
        : { kind: 'timeout' };
    }
    sleep(Math.min(intervalMs, remaining));
  }
}

/** The host-assigned id of the outbox file `uuid`, or `undefined` on a rejection or a timeout. */
export function waitForProposalId(
  scratch: string,
  uuid: string,
  opts: WaitForProposalIdOpts = {},
): number | undefined {
  const result = waitForProposalResult(scratch, uuid, opts);
  return result.kind === 'ingested' ? result.id : undefined;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/planning/proposalIndex.test.ts && npm run -s typecheck`
Expected: PASS, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/planning/proposalIndex.ts src/planning/proposalIndex.test.ts
git commit -m "feat: proposal index carries host warnings and a checking latch; per-uuid rejection files"
```

---

### Task 4: `refreshProposalIndex` writes `warnings`/`checking`; `recordOutboxRejection`

**Files:**
- Modify: `src/extension/ops/planningIndex.ts`
- Create: `src/extension/ops/planningIndex.test.ts`

**Interfaces:**
- Consumes: Task 3 `ProposalIndexEntry`, `writeProposalIndex`, `writeOutboxRejection`.
- Produces:
  - `interface RefreshProposalIndexOpts { fs?: typeof nodeFs; checkingIds?: ReadonlySet<number> }`
  - `function refreshProposalIndex(store: Store, sessionId: number, scratch: string, opts?: RefreshProposalIndexOpts): void`
  - `function recordOutboxRejection(scratch: string, uuid: string, reason: string, nowMs: number, opts?: { fs?: typeof nodeFs }): void` (throws on failure)

- [ ] **Step 1: Write the failing test**

Create `src/extension/ops/planningIndex.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import { insertProposal } from '../../store/planningProposals.js';
import { readOutboxRejection, readProposalIndex } from '../../planning/proposalIndex.js';
import { recordOutboxRejection, refreshProposalIndex } from './planningIndex.js';

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = { title: 'Fix auth', description: 'd', summary: 's', repos: ['api'] };

describe('refreshProposalIndex', () => {
  let store: Store;
  let sessionId: number;
  let scratch: string;
  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
    scratch = mkdtempSync(join(tmpdir(), 'karst-plan-index-'));
  });
  afterEach(() => {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  const byId = () => new Map(readProposalIndex(scratch).map((e) => [e.id, e]));

  it('writes warnings only for a draft that has some', () => {
    const a = insertProposal(store, sessionId, payload, UUID(1), ['unknown design key @arch:NOPE']);
    const b = insertProposal(store, sessionId, payload, UUID(2));
    refreshProposalIndex(store, sessionId, scratch);
    expect(byId().get(a)!.warnings).toEqual(['unknown design key @arch:NOPE']);
    expect('warnings' in byId().get(b)!).toBe(false);
  });

  it('marks checking: true only for the ids in checkingIds', () => {
    const a = insertProposal(store, sessionId, payload, UUID(1));
    const b = insertProposal(store, sessionId, payload, UUID(2));
    refreshProposalIndex(store, sessionId, scratch, { checkingIds: new Set([a]) });
    expect(byId().get(a)!.checking).toBe(true);
    expect('checking' in byId().get(b)!).toBe(false);
    refreshProposalIndex(store, sessionId, scratch);
    expect('checking' in byId().get(a)!).toBe(false);
  });
});

describe('recordOutboxRejection', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-plan-reject-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('writes the reason with an ISO timestamp that the CLI reads', () => {
    recordOutboxRejection(scratch, UUID(3), 'unknown repositories x', Date.UTC(2026, 10, 22));
    expect(readOutboxRejection(scratch, UUID(3))).toEqual({
      uuid: UUID(3),
      reason: 'unknown repositories x',
      rejectedAt: '2026-11-22T00:00:00.000Z',
    });
  });
});
```

- [ ] **Step 2: Run the test to make sure it fails**

Run: `npx vitest run src/extension/ops/planningIndex.test.ts`
Expected: FAIL. `recordOutboxRejection` is not exported, and the index has no `warnings`.

- [ ] **Step 3: Write the minimal implementation**

Replace the body of `src/extension/ops/planningIndex.ts` below the imports, and change the `proposalIndex.js` import:

```ts
import * as nodeFs from 'node:fs';
import type { Store } from '../../store/db.js';
import { listSessionProposals } from '../../store/planningProposals.js';
import { writeOutboxRejection, writeProposalIndex, type ProposalIndexEntry } from '../../planning/proposalIndex.js';

export interface RefreshProposalIndexOpts {
  fs?: typeof nodeFs;
  /** Proposal ids whose async host checks still run; their entries get `checking: true`. */
  checkingIds?: ReadonlySet<number>;
}

/**
 * Rebuild a session's on-disk proposal index from the store, which is the sole
 * source of truth for every field including each proposal's `uuid`
 * (`source_uuid`, set when the outbox file was ingested or revised). The
 * agent-writable index file is NEVER read back: trusting it for correlation let
 * an edited index resolve a later `draft propose` to the wrong id. `warnings`
 * is written only when the draft has some; `checking` only for an id in
 * `checkingIds`.
 */
export function refreshProposalIndex(
  store: Store,
  sessionId: number,
  scratch: string,
  opts: RefreshProposalIndexOpts = {},
): void {
  const entries: ProposalIndexEntry[] = listSessionProposals(store, sessionId).map((p) => ({
    id: p.id,
    uuid: p.sourceUuid,
    title: p.payload.title,
    status: p.status,
    updatedAt: p.updatedAt,
    ...(p.warnings.length > 0 ? { warnings: [...p.warnings] } : {}),
    ...(opts.checkingIds?.has(p.id) ? { checking: true } : {}),
  }));
  writeProposalIndex(scratch, entries, opts.fs ?? nodeFs);
}

/**
 * Tell the planning agent why the host rejected its outbox file `uuid`.
 * `karst draft propose` polls for this file and fails with the reason. Throws
 * on a failed write; the caller decides whether that is fatal.
 */
export function recordOutboxRejection(
  scratch: string,
  uuid: string,
  reason: string,
  nowMs: number,
  opts: { fs?: typeof nodeFs } = {},
): void {
  writeOutboxRejection(scratch, { uuid, reason, rejectedAt: new Date(nowMs).toISOString() }, opts.fs ?? nodeFs);
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `npx vitest run src/extension/ops/planningIndex.test.ts && npm run -s typecheck`
Expected: PASS, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/planningIndex.ts src/extension/ops/planningIndex.test.ts
git commit -m "feat: proposal index refresh writes warnings and checking; record host rejections"
```

---

### Task 5: Outbox `checking` latch, rejection record, and `extension.ts` wiring

**Files:**
- Modify: `src/extension/ops/planningOutbox.ts` (interface at lines 66-68; `reject` at 186-190; `safeRefresh` at 198-204; `verifyCommits` at 216-230; `ingest` at 232-303; return object at 333-344)
- Modify: `src/extension.ts` (near lines 780-781 and after line 7508)
- Test: `src/extension/ops/planningOutbox.integration.test.ts`

**Interfaces:**
- Consumes: Task 4 `refreshProposalIndex(store, sessionId, scratch, { fs, checkingIds })` and `recordOutboxRejection(scratch, uuid, reason, nowMs, { fs })`. Task 3 `readOutboxRejection`, `readProposalIndex`.
- Produces: `interface PlanningOutbox { scan(): void; checkingIds(): ReadonlySet<number> }`.

- [ ] **Step 1: Write the failing tests**

In `src/extension/ops/planningOutbox.integration.test.ts`, change the proposal index import to:

```ts
import { readOutboxRejection, readProposalIndex } from '../../planning/proposalIndex.js';
```

Add these tests inside the top-level `describe('planning outbox', …)` (outside `constraint warnings`):

```ts
  it('writes the rejection reason for the CLI under outbox-rejections/<uuid>.json', () => {
    put(`${UUID(1)}.json`, { ...good, repos: ['nope'] });
    make().scan();
    expect(readOutboxRejection(scratch, UUID(1))).toMatchObject({ uuid: UUID(1), reason: 'unknown repositories nope' });
    expect(warns).toHaveLength(1);
  });

  it('records a revise rejection with the same reason as the warning', () => {
    put(`${UUID(2)}.json`, { ...good, id: 999 });
    make().scan();
    expect(readOutboxRejection(scratch, UUID(2))!.reason).toBe('no draft D999');
  });

  it('still rejects and warns when the rejection cannot be recorded', () => {
    writeFileSync(join(scratch, 'outbox-rejections'), 'not a dir');
    const debug = vi.fn();
    put(`${UUID(1)}.json`, { ...good, repos: ['nope'] });
    make({ debug }).scan();
    expect(readdirSync(outbox)).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(debug.mock.calls.some(([l]) => String(l).includes('rejection record'))).toBe(true);
  });
```

Add these tests inside `describe('constraint warnings', …)`:

```ts
    it('marks the index entry checking until the commit probe answers, then clears it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
      const ob = withRepo({ commitExists: async () => { await gate; return false; } });
      ob.scan();
      const id = pending()[0]!.id;
      expect(readProposalIndex(scratch)[0]).toMatchObject({ id, checking: true });
      expect(ob.checkingIds().has(id)).toBe(true);
      release();
      await flush();
      const entry = readProposalIndex(scratch)[0]!;
      expect('checking' in entry).toBe(false);
      expect(entry.warnings).toEqual(['unknown commit abc1234']);
      expect(ob.checkingIds().size).toBe(0);
    });

    it('clears checking when the probe adds no warning', async () => {
      put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
      withRepo({ commitExists: async () => true }).scan();
      expect(readProposalIndex(scratch)[0]!.checking).toBe(true);
      await flush();
      const entry = readProposalIndex(scratch)[0]!;
      expect('checking' in entry).toBe(false);
      expect('warnings' in entry).toBe(false);
    });

    it('clears checking when the probe fails', async () => {
      put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
      withRepo({ commitExists: async () => { throw new Error('no git'); } }).scan();
      await flush();
      expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
    });

    it('does not mark checking when no async check runs', () => {
      put(`${UUID(1)}.json`, good);
      make().scan();
      expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
    });

    it('a revise without async checks drops a stale checking flag', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let paths = [repo];
      const ob = make({ repoPaths: () => paths, commitExists: async () => { await gate; return false; } });
      put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
      ob.scan();
      const id = pending()[0]!.id;
      expect(readProposalIndex(scratch)[0]!.checking).toBe(true);
      paths = [];
      put(`${UUID(2)}.json`, { ...good, id });
      ob.scan();
      expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
      expect(ob.checkingIds().size).toBe(0);
      release();
      await flush();
      expect('checking' in readProposalIndex(scratch)[0]!).toBe(false);
    });

    it('a revise with async checks marks the new uuid checking', () => {
      const ob = withRepo({ commitExists: () => new Promise<boolean>(() => {}) });
      put(`${UUID(1)}.json`, { ...good, constraints: ['abc1234'] });
      ob.scan();
      const id = pending()[0]!.id;
      put(`${UUID(2)}.json`, { ...good, id, constraints: ['abc1234'] });
      ob.scan();
      expect(readProposalIndex(scratch)[0]).toMatchObject({ id, uuid: UUID(2), checking: true });
    });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/extension/ops/planningOutbox.integration.test.ts`
Expected: FAIL. No rejection file is written, `checking` is never set, and `checkingIds` is not a function.

- [ ] **Step 3: Write the minimal implementation in `planningOutbox.ts`**

3a. Change the import from `./planningIndex.js` to:

```ts
import { recordOutboxRejection, refreshProposalIndex } from './planningIndex.js';
```

3b. Replace the `PlanningOutbox` interface with:

```ts
export interface PlanningOutbox {
  scan(): void;
  /**
   * The proposal ids whose async host checks still run. Every index refresh
   * (also an accept or a discard of a sibling draft) must pass this set, or
   * it strips `checking: true` and `draft propose` returns too early.
   */
  checkingIds(): ReadonlySet<number>;
}
```

3c. At the start of `createPlanningOutbox`, after the `debug` constant, add:

```ts
  /**
   * In-flight async checks: proposal id → the outbox uuid they check. Only the
   * check of the CURRENT uuid may clear the latch, so a late answer for a
   * revised draft does not clear the latch of the newer check.
   */
  const checking = new Map<number, string>();
  const checkingIds = (): ReadonlySet<number> => new Set(checking.keys());
```

3d. Replace `reject` with:

```ts
  /** Unlink and warn about a claimed file the host refused, naming the reason; tell the CLI why. */
  function reject(sessionId: number, scratch: string, claimed: string, proposal: string, reason: string): void {
    remove(claimed);
    safeRecordRejection(sessionId, scratch, proposal.replace(/\.json$/, ''), reason);
    debug(`session ${sessionId}: ${proposal} rejected (${reason})`);
    deps.notify.warn(`A draft of planning session ${formatId('plan', sessionId)} was rejected (${reason}).`);
  }

  /**
   * Write the rejection file `draft propose` polls, swallowing a failure: the
   * rejection itself stands, and the CLI then falls back to its timeout.
   */
  function safeRecordRejection(sessionId: number, scratch: string, uuid: string, reason: string): void {
    try {
      recordOutboxRejection(scratch, uuid, reason, deps.now(), { fs });
    } catch (e) {
      debug(`session ${sessionId}: rejection record for ${uuid} failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
```

3e. In `safeRefresh`, change the call to:

```ts
      refreshProposalIndex(deps.store, sessionId, scratch, { fs, checkingIds: checkingIds() });
```

3f. Replace `verifyCommits` with two functions:

```ts
  /** True when the async commit probe will run for this draft (a probe and repo paths exist). */
  function willVerifyCommits(p: Proposal): boolean {
    return deps.commitExists !== undefined && (deps.repoPaths?.(p.repos) ?? []).length > 0;
  }

  /**
   * Unknown-commit warnings need git; they land on the stored row once the
   * probe answers. The `finally` ALWAYS clears this uuid's latch and refreshes
   * the index (also with no extra warning, and on an error), so `checking:
   * true` never sticks.
   */
  function verifyCommits(sessionId: number, scratch: string, id: number, uuid: string, p: Proposal): void {
    const paths = deps.repoPaths?.(p.repos) ?? [];
    if (!deps.commitExists || paths.length === 0) return;
    void commitWarnings(p.constraints ?? [], paths, deps.commitExists, debug)
      .then((extra) => {
        if (extra.length === 0) return;
        const cur = getProposal(deps.store, id);
        // A revise or resolution since ingest owns the warnings now.
        if (!cur || cur.status !== 'pending' || cur.sourceUuid !== uuid) return;
        setProposalWarnings(deps.store, id, [...cur.warnings, ...extra]);
        const row = getProposal(deps.store, id);
        if (row) deps.onWarnings?.(row);
      })
      .catch((e: unknown) => debug(`commit check for proposal ${id} failed (${e instanceof Error ? e.message : String(e)})`))
      .finally(() => {
        if (checking.get(id) !== uuid) return;
        checking.delete(id);
        safeRefresh(sessionId, scratch);
      });
  }
```

3g. In `ingest`, change every `reject(sessionId, claimed, proposal, …)` call to `reject(sessionId, scratch, claimed, proposal, …)`. There are four calls (read failure, `depReason`, revise `reason`, pending cap).

3h. In the revise branch of `ingest`, replace the lines from `updateProposalPayload(...)` to `verifyCommits(...)` with:

```ts
      updateProposalPayload(deps.store, requestedId, payload, uuid, quickWarnings(read.value));
      // A revise owns the latch: drop the old uuid's latch first, then set it
      // again only when this revision runs its own async check.
      checking.delete(requestedId);
      if (willVerifyCommits(read.value)) checking.set(requestedId, uuid);
      safeRefresh(sessionId, scratch);
      remove(claimed);
      const row = getProposal(deps.store, requestedId);
      if (row) deps.onProposal(row, 'updated');
      resolveBaseShasLate(requestedId, uuid, read.value);
      verifyCommits(sessionId, scratch, requestedId, uuid, read.value);
```

3i. In the new-draft branch of `ingest`, replace the lines from `const id = insertProposal(...)` to `verifyCommits(...)` with:

```ts
    const id = insertProposal(deps.store, sessionId, payload, uuid, quickWarnings(read.value));
    // Set the latch BEFORE the first index write, so `draft propose` never
    // sees this entry without `checking` while the probe still runs.
    if (willVerifyCommits(read.value)) checking.set(id, uuid);
    safeRefresh(sessionId, scratch);
    remove(claimed);
    const row = getProposal(deps.store, id);
    if (row) deps.onProposal(row);
    resolveBaseShasLate(id, uuid, read.value);
    verifyCommits(sessionId, scratch, id, uuid, read.value);
```

3j. In the returned object, add `checkingIds` after `scan`:

```ts
  return {
    scan(): void {
      // unchanged body
    },
    checkingIds,
  };
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run src/extension/ops/planningOutbox.integration.test.ts`
Expected: PASS. If an existing test fails because it lists the scratch dir contents, check whether the new `outbox-rejections` dir is the cause. Then update only that assertion to allow the dir.

- [ ] **Step 5: Wire `checkingIds` in `src/extension.ts`**

Find these lines (near line 780):

```ts
  const refreshPlanningIndex = (sessionId: number): void =>
    refreshProposalIndex(localStore, sessionId, join(storageDir, 'planning-scratch', String(sessionId)));
```

Replace them with:

```ts
  // The outbox is created later in activate; until then no async check runs.
  let planningCheckingIds: () => ReadonlySet<number> = () => new Set();
  const refreshPlanningIndex = (sessionId: number): void =>
    refreshProposalIndex(localStore, sessionId, join(storageDir, 'planning-scratch', String(sessionId)), { checkingIds: planningCheckingIds() });
```

Do not reference `outbox` inside `refreshPlanningIndex`: `outbox` is a `const` declared later, and an early call would throw a TDZ `ReferenceError`.

Find the line that ends the `createPlanningOutbox({ … })` call (near line 7508, it ends with `onWarnings: () => provider.refresh() });`). Add this line directly after it:

```ts
  planningCheckingIds = () => outbox.checkingIds();
```

- [ ] **Step 6: Run the checks**

Run: `npm run -s typecheck && npx vitest run src/extension/ops/ratchet.test.ts src/extension/ops/planningOutbox.integration.test.ts`
Expected: typecheck exits 0. Both test files PASS. If typecheck reports another object typed as `PlanningOutbox` without `checkingIds`, add `checkingIds: () => new Set()` to that object.

- [ ] **Step 7: Commit**

```bash
git add src/extension/ops/planningOutbox.ts src/extension/ops/planningOutbox.integration.test.ts src/extension.ts
git commit -m "fix: host records draft rejections and keeps a checking latch until async checks finish"
```

---

### Task 6: `draft propose` returns warnings and fails on a rejection; guide text

**Files:**
- Modify: `src/cli/draftCommand.ts` (import at line 6; `runPropose` at 65-95; `runList` at 97-102)
- Modify: `src/cli/guide.ts` (lines 132-170)
- Test: `src/cli/draftCommand.test.ts`, `src/cli/guide.test.ts`

**Interfaces:**
- Consumes: Task 3 `waitForProposalResult`, `readProposalIndex`, `writeOutboxRejection`, `ProposalIndexEntry.warnings`.
- Produces: the `draft propose` output `{ok, file, id, ref, warnings?, hint?, checksPending?}`; the `draft list` output `[{id, ref, status, title, warnings?}]`.

- [ ] **Step 1: Write the failing tests**

In `src/cli/draftCommand.test.ts`, add this import:

```ts
import { writeOutboxRejection } from '../planning/proposalIndex.js';
```

Add these tests inside `describe('draft propose / draft list', …)`:

```ts
  const fileUuid = (): string => readdirSync(outbox).find((f) => f.endsWith('.json'))!.replace(/\.json$/, '');
  const writeIndex = (entries: unknown[]): void => writeFileSync(join(dir, 'proposals.json'), JSON.stringify(entries));
  const idx = (uuid: string, over: Record<string, unknown> = {}) => ({
    id: 42, uuid, title: 'Add auth', status: 'pending', updatedAt: 'now', ...over,
  });

  it('fails at once with the host rejection reason', () => {
    let clock = 0;
    let sleeps = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      sleeps += 1;
      writeOutboxRejection(dir, { uuid: fileUuid(), reason: 'unknown repositories api', rejectedAt: 'now' });
    };
    expect(() =>
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    ).toThrow('karst draft propose: rejected by host (unknown repositories api)');
    expect(sleeps).toBe(1);
  });

  it('returns the host warnings with a revise hint', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid(), { warnings: ['unknown design key @arch:NOPE'] })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ ok: true, id: 42, ref: 'D42', warnings: ['unknown design key @arch:NOPE'] });
    expect(out.hint).toContain('"id":42');
    expect('checksPending' in out).toBe(false);
  });

  it('omits warnings and hint for a clean draft', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid())]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toEqual({ ok: true, file: out.file, id: 42, ref: 'D42' });
  });

  it('waits for the async checks and returns their warnings', () => {
    let clock = 0;
    let sleeps = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      sleeps += 1;
      writeIndex([sleeps === 1 ? idx(fileUuid(), { checking: true }) : idx(fileUuid(), { warnings: ['unknown commit abc1234'] })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ id: 42, warnings: ['unknown commit abc1234'] });
    expect(sleeps).toBe(2);
  });

  it('returns checksPending when the deadline passes mid-check', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid(), { checking: true })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 300, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ ok: true, id: 42, ref: 'D42', checksPending: true });
    expect('warnings' in out).toBe(false);
  });

  it('draft list adds warnings only to a flagged draft', () => {
    writeIndex([idx('u1', { id: 1, warnings: ['w'] }), idx('u2', { id: 2 })]);
    expect(JSON.parse(run(['draft', 'list'], ''))).toEqual([
      { id: 1, ref: 'D1', status: 'pending', title: 'Add auth', warnings: ['w'] },
      { id: 2, ref: 'D2', status: 'pending', title: 'Add auth' },
    ]);
  });
```

In `src/cli/guide.test.ts`, after the test `'documents draft propose for planning sessions: stdin JSON into the outbox, a human confirms'`, add:

```ts
  it('documents draft propose --file, the returned warnings and host rejections', () => {
    expect(AGENT_GUIDE).toContain('karst draft propose --file <path>');
    expect(AGENT_GUIDE).toContain('"warnings":[…]');
    expect(AGENT_GUIDE).toContain('"checksPending":true');
    expect(AGENT_GUIDE).toMatch(/REJECTS the\s+draft/);
    expect(AGENT_GUIDE).not.toContain('it takes no flags');
  });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npx vitest run src/cli/draftCommand.test.ts src/cli/guide.test.ts`
Expected: FAIL. The rejection test times out to `id: null`. The output has no `warnings`. The guide has no `--file` text.

- [ ] **Step 3: Write the minimal implementation in `draftCommand.ts`**

Change the import at line 6 to:

```ts
import { readProposalIndex, waitForProposalResult } from '../planning/proposalIndex.js';
```

Change the header comment sentence "It then waits briefly for the host to ingest the file and publish the id in the session's proposal index." to:

```ts
 * It then waits briefly for the host's answer: the id and warnings in the
 * session's proposal index, or the reason in `outbox-rejections/<uuid>.json`.
 * A rejection throws (exit 1, or `isError` in MCP) so no core can miss it.
```

Add this function above `runPropose`:

```ts
/** What a planner does with host warnings: fix and revise, or leave them for the reviewer. */
function reviseHint(id: number): string {
  return `the host flagged this draft; fix the warnings and propose it again with "id":${id}, or leave them for the reviewer`;
}
```

Replace the lines of `runPropose` from `const id = waitForProposalId(...)` to the end of the function with:

```ts
  const result = waitForProposalResult(scratchOf(dir), uuid, {
    now: deps.now,
    sleep: deps.sleep,
    timeoutMs: deps.timeoutMs,
  });
  if (result.kind === 'rejected') throw new Error(`karst draft propose: rejected by host (${result.reason})`);
  if (result.kind === 'timeout') {
    return JSON.stringify({
      ok: true,
      file,
      id: null,
      hint: 'the host has not ingested it yet; run `karst draft list` to see its id',
    });
  }
  return JSON.stringify({
    ok: true,
    file,
    id: result.id,
    ref: formatId('draft', result.id),
    ...(result.warnings.length > 0 ? { warnings: result.warnings, hint: reviseHint(result.id) } : {}),
    ...(result.checksPending ? { checksPending: true } : {}),
  });
}
```

Replace `runList` with:

```ts
function runList(deps: DraftProposeDeps, pendingOnly: boolean): string {
  const dir = outboxDir(deps.outboxEnv);
  const all = readProposalIndex(scratchOf(dir));
  const entries = pendingOnly ? all.filter((e) => e.status === 'pending') : all;
  return JSON.stringify(
    entries.map(({ id, status, title, warnings }) => ({
      id,
      ref: formatId('draft', id),
      status,
      title,
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    })),
  );
}
```

- [ ] **Step 4: Update `src/cli/guide.ts`**

Replace this text:

```
    proposal into the session's \`$KARST_OUTBOX\`; it takes no flags. No ticket
```

with:

```
    proposal into the session's \`$KARST_OUTBOX\`. To avoid shell quoting, put the
    same object in a file and run \`karst draft propose --file <path>\` (a regular
    file, not a symlink), or pipe it with \`--stdin\`; the MCP \`draft\` tool takes
    the same object. No other flag is accepted. No ticket
```

Replace this text:

```
    appended to the ticket brief, and the host warns on unknown keys/commits. On success it prints \`{"ok":true,"file":…,"id":N}\` — the draft's #id;
    if the host has not answered within ~10s it prints \`{"ok":true,"file":…,"id":null}\` with
    a hint, and \`draft list\` will show the id once the host has ingested it.
```

with:

```
    appended to the ticket brief, and the host warns on unknown keys/commits. On success it prints \`{"ok":true,"file":…,"id":N,"ref":"D<n>"}\` — the draft's #id.
    When the host flags the draft, the output also has \`"warnings":[…]\` and a
    \`hint\`: fix the warnings and revise the draft with its \`id\`, or leave them
    for the reviewer. The host finishes its commit checks first; when they still
    run at the deadline, the output adds \`"checksPending":true\` (read \`draft list\`
    later for the final warnings). When the host REJECTS the
    draft (an unknown repository, a bad dependency, the pending cap, a draft that
    is not yours), the command exits non-zero and names the reason: fix it and
    propose again. If the host has not answered within ~10s it prints \`{"ok":true,"file":…,"id":null}\` with
    a hint, and \`draft list\` will show the id once the host has ingested it.
```

Replace this text:

```
    index and prints its drafts as JSON \`[{"id":N,"status":…,"title":…}]\`; use
```

with:

```
    index and prints its drafts as JSON \`[{"id":N,"ref":"D<n>","status":…,"title":…}]\`
    (plus \`"warnings":[…]\` on a draft the host flagged); use
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `npx vitest run src/cli/draftCommand.test.ts src/cli/guide.test.ts src/cli/main.test.ts && npm run -s typecheck`
Expected: PASS, and typecheck exits 0.

Run: `grep -rn "takes no flags\|or rejected it" src --include=*.ts`
Expected: hits only in `src/cli/main.ts` and `src/cli/draftCommand.ts` refusal messages for unknown flags. These messages are still correct. Do not change them.

- [ ] **Step 6: Commit**

```bash
git add src/cli/draftCommand.ts src/cli/draftCommand.test.ts src/cli/guide.ts src/cli/guide.test.ts
git commit -m "fix: draft propose returns host warnings and fails with the host rejection reason"
```

---

### Task 7: Update the architecture docs

**Files:**
- Modify: `docs/arch/cli.md` (blocks `@arch:CLI-00` table row near line 77, `@arch:CLI-03`, `@arch:CLI-13`, `@arch:CLI-17`, `@arch:DRAFT-CONSTRAINTS`)
- Modify: `docs/arch/store-and-schema.md` (block `@arch:PLANNING`)

**Interfaces:**
- Consumes: the names from Tasks 1-6.
- Produces: no code.

Keep the keyed block format. Edit only text inside the blocks named here.

- [ ] **Step 1: `@arch:CLI-00` failure table**

Replace the row:

```
| Outbox proposal ingest times out (~10 s) | Returns `{"ok":true,"id":null}` with fallback hint | Host ingests in background; agent checks status via `karst draft list` |
```

with:

```
| Outbox proposal ingest times out (~10 s) | Returns `{"ok":true,"id":null}` with fallback hint; an entry still `checking` returns its id with `"checksPending":true` | Host ingests in background; agent checks status via `karst draft list` |
| Host rejects an outbox proposal | `draft propose` exits 1 with `rejected by host (<reason>)`, read from `outbox-rejections/<uuid>.json` | Agent fixes the named problem and proposes again |
```

- [ ] **Step 2: `@arch:CLI-03`**

After the paragraph that starts with "`--file <path>` and `--stdin` let a command take its whole input", add this paragraph:

```
`--file` opens the path with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and requires `fstat().isFile()`, the same posture as the host outbox read. A symlink fails with `ELOOP` and a FIFO, a directory or a device fails with `not a regular file`, so a hostile path never hangs or redirects the read. `runCliAsync` passes its injected `env` through when it falls back to `runCli`. The `draft` spec lists every optional key that `validateProposal` accepts (`id`, `dependsOn`, `constraints`, `priority` from `PRIORITY_LEVELS`, `priorityReason`), so `--file`, `--stdin` and the MCP `draft` tool accept the same objects as stdin.
```

- [ ] **Step 3: `@arch:CLI-13`**

In the bullet that starts with "**Input is one JSON object on stdin**", replace:

```
`{title, description, summary, repos}` plus OPTIONAL `dependsOn`, `constraints` and an integer `id`.
```

with:

```
`{title, description, summary, repos}` plus OPTIONAL `dependsOn`, `constraints`, `priority`, `priorityReason` and an integer `id`. `karst draft propose --file <path>`, `--stdin` and the MCP `draft` tool feed the same object (`@arch:CLI-03`).
```

and replace:

```
exact keys (the four required, plus the optional `dependsOn`, `constraints`, `id`)
```

with:

```
exact keys (the four required, plus the optional `dependsOn`, `constraints`, `priority`, `priorityReason`, `id`)
```

In the bullet that starts with "**The host publishes ids back through a session index.**", replace:

```
`propose` then polls that file for its own uuid for a bounded ~10 s and prints `{"ok":true,"file":…,"id":N}` (on timeout `{"ok":true,"file":…,"id":null}` with a hint to run `draft list`). `draft list` reads the same file (no store) and prints `[{id,status,title}]`.
```

with:

```
An entry also carries `warnings` (only when the draft has some) and `checking: true` while an async host check of that uuid still runs. `propose` then polls for a bounded ~10 s (`waitForProposalResult`). A host rejection file `<scratch>/outbox-rejections/<uuid>.json` makes it throw `rejected by host (<reason>)` at once (exit 1; `isError` in MCP). An entry that is not `checking` prints `{"ok":true,"file":…,"id":N,"ref":"D<n>"}`, plus `warnings` and a revise `hint` when the host flagged the draft. At the deadline an entry still `checking` prints its id with `"checksPending":true`; no entry prints `{"ok":true,"file":…,"id":null}` with a hint to run `draft list`. `draft list` reads the same file (no store) and prints `[{id,ref,status,title}]`, plus `warnings` on a flagged draft. Both reads are bounded, so the planner sees the result on every core with no store access.
```

- [ ] **Step 4: `@arch:CLI-17`**

After the bullet that starts with "**propose → outbox → host scan → human confirm.**", add:

```
- **The host answers the planner without blocking.** A rejected file gets `<scratch>/outbox-rejections/<uuid>.json` (`recordOutboxRejection` → `writeOutboxRejection`: one file for each uuid, tmp `wx` 0600 + rename, into a dir that must be a real directory at its own realpath, the oldest files past `MAX_OUTBOX_REJECTIONS` = 20 pruned on write by name and lstat only). A failed record logs a `[planning]` debug line and never stops the scan. When the async commit probe runs, `planningOutbox` holds `checking` (proposal id → uuid) and sets it BEFORE the first index write. The probe's `finally` clears it only for the same uuid and refreshes the index, also with no extra warning and on an error. A revise always drops the old latch first. `checkingIds()` goes into every index refresh, also the accept, discard and priority refreshes in `extension.ts`, so a sibling refresh keeps the flag.
```

- [ ] **Step 5: `@arch:DRAFT-CONSTRAINTS`**

At the end of the bullet that starts with "**Checks are warnings, never rejections**", add:

```
 The planner sees the warnings too: the index entry carries them, and `draft propose` waits until the async probe finishes (`checking` clears) and prints them with a revise hint (`@arch:CLI-13`).
```

- [ ] **Step 6: `@arch:PLANNING`**

In the paragraph that starts with "**The session proposal index.**", replace:

```
as `[{id, uuid, title, status, updatedAt}]` for the session.
```

with:

```
as `[{id, uuid, title, status, updatedAt}]` for the session, plus `warnings` when the draft has some and `checking: true` while an async check of that uuid runs.
```

At the end of the same paragraph, add:

```
 A rejected outbox file gets `<scratch>/outbox-rejections/<uuid>.json` (`{uuid, reason, rejectedAt}`), so `draft propose` fails with the reason. The host writes these files and prunes them by metadata; it never reads their contents. The `checking` latch lives in the memory of the window that ingested the file. A refresh in another window can drop the flag early; `draft propose` then returns the warnings known at that time, and `draft list` shows the later ones.
```

- [ ] **Step 7: Commit the docs**

```bash
git add docs/arch/cli.md docs/arch/store-and-schema.md
git commit -m "docs: planner feedback loop: returned warnings, rejection files, --file hardening"
```

- [ ] **Step 8: Run the docs gates**

Run: `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs`
Expected: exit 0. If it BLOCKs on `@arch:CLI-05` (it covers `src/cli/guide.ts#AGENT_GUIDE`), the rule in that block still holds. Run:

```bash
node "$KARST_CLI" arch cite @arch:CLI-05 --why "guide text documents draft propose --file and returned warnings; the node:sqlite rule is unchanged" --db "$KARST_DB" --manifest "$KARST_MANIFEST" --ticket FIX-PLANNING-RETURN-HOST
```

For any other BLOCK, edit the named block so it describes the change, commit, and run the gate again.

Run: `npm run -s docs:graph -- --check`
Expected: exit 0. If it reports drift, run `npm run -s docs:graph`, then commit `docs/arch/system-map.md` with `docs: regenerate system map`.

---

### Task 8: Final verification

- [ ] **Step 1: Read the gate rules**

Read `.claude/skills/gates-and-ci/SKILL.md`. Run only the cheap checks it lists for the implementer.

- [ ] **Step 2: Run the acceptance commands**

```bash
npm run -s rebuild:node
npx vitest run src/planning/proposalIndex.test.ts src/cli/draftCommand.test.ts src/cli/commandInput.test.ts src/cli/registry.test.ts src/cli/guide.test.ts src/cli/main.test.ts src/cli/mcp/server.test.ts src/extension/ops/planningIndex.test.ts src/extension/ops/planningOutbox.integration.test.ts src/extension/ops/ratchet.test.ts
npm run -s typecheck
BASE_REF=develop PR_BODY= node scripts/docsGate.mjs
```

Expected: all PASS, and each command exits 0.

- [ ] **Step 3: Check the invariants**

Run: `grep -n "sqlite\|openStore\|spawnSync" src/cli/draftCommand.ts src/planning/proposalIndex.ts src/extension/ops/planningIndex.ts src/extension/ops/planningOutbox.ts`
Expected: no hits.

- [ ] **Step 4: Confirm the tree is clean**

Run: `git status --short`
Expected: no output. All work is committed.
