# Draft Carries Its Evidence Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A planning draft names its evidence files in an `attachments` field. The host keeps a copy of each file. Review stages the files. Save attaches them to the new ticket before the launch.

**Architecture:** The proposal schema gets an `attachments` list. The outbox copies the files async under the existing `checking` latch into `<storage>/attachments/draft-<id>/`. The result lives in the reserved `hostAttachments` key of `payload_json`. The ticket form shows the files as staged rows with no ticket row. `persistDraft` becomes async and ingests the staged files before `commitPrefill`.

**Tech Stack:** TypeScript (ESM, `.js` import suffix, `noUncheckedIndexedAccess`), better-sqlite3, vitest 4, vanilla webview (`src/ui/ticketForm/webview.html`).

**Spec:** Ticket T1355 / FEAT-PLANNING-A-DRAFT-CARRIES (run `karst context FEAT-PLANNING-A-DRAFT-CARRIES`). Docs: `@arch:PLANNING`, `@arch:CLI-13`, `@arch:CLI-17`, `@arch:DRAFT-QUALITY`, `@arch:DRAFT-CONSTRAINTS`, `@ui:TICKET-FORM-MIGRATION-EXCEPTIONS`.

## Global Constraints

- `attachments`: at most 10 entries `{path, note?, binding?}`. `path` is at most 300 chars, relative to `KARST_ARTIFACTS`, with no `..` segment and no leading `/`. `note` is at most 200 chars, one line, controls stripped.
- Agent input with the key `hostAttachments` is rejected, like `hostWarnings` (`src/planning/proposal.ts`).
- Limits: 10 MB per file (`MAX_PASTE_BYTES`), 25 MB per draft, `MIRROR_MAX_BYTES` (2 MB) for the sandbox mirror.
- Every read of an artifact file: realpath inside the realpath of the artifacts dir, `lstat` is not a symlink, regular file, `nlink` is 1, open with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, `fstat` dev/ino equal to the `lstat` values.
- Host copy path: `<storage>/attachments/draft-<proposalId>/<sha16>.<ext>` (tmp file + rename).
- Refusal warning, at most 60 chars (`clipToken`): `attachment refused: <name> (<reason>)`. Reason is one of `missing`, `outside`, `link`, `not a file`, `hardlink`, `too large`, `type`, `draft cap`.
- Mirror warning: `attachment >2 MB, not in sandbox: <name>`.
- Leak warning text: `plan path not in attachments (attach or inline)`.
- `scan()` stays sync. No `spawnSync`. `draftQualityChecks.ts` stays pure.
- Every payload write keeps `hostAttachments`: `splitPayload`, `setProposalWarnings`, `setProposalBaseShas`, `updateProposalPayload`.
- Opening Review never calls `ensureTicket`. Staged files are ingested before `ctx.commitPrefill()`. A failure throws before `commitPrefill`.
- Never run the full suite. Run single files with `npx vitest run <file>`. Run `npm run -s typecheck` after test edits.
- Do not use `sed -i`. Commit with conventional commits.
- A vanilla view gets a recorded migration exception (Task 8).

## File Structure

| File | Change |
| --- | --- |
| `src/planning/proposal.ts` | `attachments` key, validation, `hostAttachments` rejection, `ProposalAttachment` type |
| `src/cli/registry.ts` | `attachments` in the `draft` input schema |
| `src/store/planningProposals.ts` | `hostAttachments` storage, `setProposalHostAttachments`, carry-forward |
| `src/planning/draftAttachments.ts` (new) | Async snapshot of the files into host storage, cleanup helpers |
| `src/extension/ops/planningOutbox.ts` | Run the snapshot under the latch, new `storageDir` dep |
| `src/planning/draftQualityChecks.ts` | Leak warning strips listed paths |
| `src/extension/ops/planningProposalOps.ts` | `prefillOf` adds `attachments`, cleanup on accept and discard, `storageDir` dep |
| `src/extension.ts` | Pass `storageDir` to both factories |
| `src/ui/ticketForm/panel.ts`, `state.ts`, `messages.ts`, `actions.ts`, `webview.html` | Staged rows, `unstage-attachment`, async `persistDraft` |
| `src/planning/preamble.ts`, `src/cli/guide.ts` | Planner instructions |
| `docs/arch/*.md`, `docs/ui/UI-INVARIANTS.md` | Keyed block updates |

---

### Task 1: Proposal schema and CLI input

**Files:**
- Modify: `src/planning/proposal.ts` (`OPTIONAL_KEYS`, `ALLOWED_KEYS`, `Proposal`, `validateProposal`, near the `hostWarnings` check)
- Modify: `src/cli/registry.ts` (the `draft` tool input schema, near the `constraints` key)
- Test: `src/planning/proposal.test.ts`

**Interfaces:**
- Produces: `export interface ProposalAttachment { path: string; note?: string; binding?: boolean }`, `Proposal.attachments?: readonly ProposalAttachment[]`, constant `MAX_ATTACHMENTS = 10`.

- [ ] **Step 1: Write the failing tests** (append to `src/planning/proposal.test.ts`; reuse the file's existing valid-proposal fixture, named `base` here — use the real name)

```ts
describe('attachments', () => {
  const ok = (a: unknown) => validateProposal({ ...base, attachments: a });
  it('accepts a list and strips controls from a note', () => {
    const r = ok([{ path: 'proto/a.html', note: 'x\u0007y', binding: true }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.attachments).toEqual([{ path: 'proto/a.html', note: 'xy', binding: true }]);
  });
  it.each([
    [[{ path: '../x' }]],
    [[{ path: '/etc/passwd' }]],
    [[{ path: 'a/../b' }]],
    [[{ path: 'a'.repeat(301) }]],
    [[{ path: 'a', note: 'n'.repeat(201) }]],
    [[{ path: 'a', note: 'two\nlines' }]],
    [Array.from({ length: 11 }, (_, i) => ({ path: `f${i}` }))],
    [[{ path: '' }]],
    ['x'],
  ])('rejects %j', (a) => {
    expect(ok(a).ok).toBe(false);
  });
  it('rejects the reserved key hostAttachments', () => {
    expect(validateProposal({ ...base, hostAttachments: [] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/planning/proposal.test.ts`
Expected: FAIL (`attachments` is an unknown key).

- [ ] **Step 3: Implement.** In `proposal.ts` add `'attachments'` to `OPTIONAL_KEYS`. Add the type, the constant and a validator. Place the reserved-key check next to the `hostWarnings` line.

```ts
export const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_PATH = 300;
const MAX_ATTACHMENT_NOTE = 200;
export interface ProposalAttachment { path: string; note?: string; binding?: boolean }

function validateAttachments(raw: unknown): { ok: true; value: ProposalAttachment[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments must be an array' };
  if (raw.length > MAX_ATTACHMENTS) return { ok: false, error: `attachments has more than ${MAX_ATTACHMENTS} entries` };
  const value: ProposalAttachment[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return { ok: false, error: 'attachments entries must be objects' };
    const r = e as Record<string, unknown>;
    const p = r.path;
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_ATTACHMENT_PATH) return { ok: false, error: 'attachment path must be 1..300 chars' };
    if (p.startsWith('/') || p.split(/[\\/]/).includes('..')) return { ok: false, error: 'attachment path must be relative with no ".." segment' };
    const out: ProposalAttachment = { path: p };
    if (r.note !== undefined) {
      if (typeof r.note !== 'string') return { ok: false, error: 'attachment note must be a string' };
      const note = r.note.replace(ALL_CONTROLS_NO_NL, '');
      if (/[\r\n]/.test(r.note) || note.length > MAX_ATTACHMENT_NOTE) return { ok: false, error: 'attachment note must be one line of at most 200 chars' };
      out.note = note;
    }
    if (r.binding !== undefined) {
      if (typeof r.binding !== 'boolean') return { ok: false, error: 'attachment binding must be a boolean' };
      out.binding = r.binding;
    }
    value.push(out);
  }
  return { ok: true, value };
}
```

`ALL_CONTROLS_NO_NL` is a new regex `/[\u0000-\u001f\u007f]/g` placed next to the existing `ALL_CONTROLS`. The newline test runs on the raw note first, so a note with `\n` is rejected and is not silently joined. In `validateProposal`, after the `hostWarnings` check add:

```ts
if ('hostAttachments' in rec) return fail('hostAttachments is host-owned and may not be supplied');
```

and after the other optional keys, call `validateAttachments(rec.attachments)` when the key is present, return `fail(error)` on error, and set `proposal.attachments = value`. Match the local style of the file for how `fail` and the built proposal object are used.

In `registry.ts`, add to the `draft` input `properties`:

```ts
attachments: {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    properties: { path: str, note: str, binding: bool },
    required: ['path'],
    additionalProperties: false,
  },
},
```

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/planning/proposal.test.ts src/cli/registry.test.ts`
Expected: PASS. If a registry snapshot test names the key list, update it.

- [ ] **Step 5: Commit**

```bash
git add src/planning/proposal.ts src/planning/proposal.test.ts src/cli/registry.ts
git commit -m "feat(planning): a draft proposal accepts an attachments list"
```

---

### Task 2: Store the host attachments and carry them through every write

**Files:**
- Modify: `src/store/planningProposals.ts` (`ProposalPayload`, `PlanningProposal`, `splitPayload`, `toProposal`, `insertProposal`, `updateProposalPayload`, `setProposalWarnings`, `setProposalBaseShas`)
- Test: `src/store/planningProposals.test.ts`

**Interfaces:**
- Produces:
  - `export interface HostAttachment { name: string; storedName: string; kind: string; byteSize: number; note?: string; binding?: boolean }`
  - `PlanningProposal.attachments: readonly HostAttachment[]` (`[]` when absent or corrupt).
  - `ProposalPayload.attachments?: readonly ProposalAttachment[]` stays in the body: it is the agent request.
  - `setProposalHostAttachments(store: Store, id: number, sourceUuid: string, list: readonly HostAttachment[]): boolean` writes only if the row is pending and `source_uuid === sourceUuid`.
- Consumes: Task 1 `ProposalAttachment`.

- [ ] **Step 1: Write the failing tests** (in `planningProposals.test.ts`, inside the existing describe, which has `store`, `sessionId`, `payload`)

```ts
describe('host attachments', () => {
  const list = [{ name: 'a.html', storedName: '0123456789abcdef.html', kind: 'file', byteSize: 5 }];
  it('writes only for the matching uuid and pending row', () => {
    const p = insertProposal(store, sessionId, payload, 'u1', [], undefined);
    expect(setProposalHostAttachments(store, p.id, 'other', list)).toBe(false);
    expect(setProposalHostAttachments(store, p.id, 'u1', list)).toBe(true);
    expect(getProposal(store, p.id)!.attachments).toEqual(list);
  });
  it('keeps the list across warnings, base shas and a payload rewrite', () => {
    const p = insertProposal(store, sessionId, payload, 'u1', [], undefined);
    setProposalHostAttachments(store, p.id, 'u1', list);
    setProposalWarnings(store, p.id, 'u1', ['w']);
    setProposalBaseShas(store, p.id, 'u1', { api: 'sha' });
    expect(getProposal(store, p.id)!.attachments).toEqual(list);
    updateProposalPayload(store, p.id, { ...payload, title: 'T2' }, 'u2', [], undefined);
    expect(getProposal(store, p.id)!.attachments).toEqual(list);
  });
  it('does not expose hostAttachments in payload and returns [] when corrupt', () => {
    const p = insertProposal(store, sessionId, payload, 'u1', [], undefined);
    setProposalHostAttachments(store, p.id, 'u1', list);
    expect(JSON.stringify(getProposal(store, p.id)!.payload)).not.toContain('hostAttachments');
    store.db.prepare(`UPDATE planning_proposals SET payload_json = json_set(payload_json,'$.hostAttachments','x') WHERE id = ?`).run(p.id);
    expect(getProposal(store, p.id)!.attachments).toEqual([]);
  });
});
```

Add `setProposalHostAttachments` to the import. Read the real signatures of `setProposalWarnings` and `setProposalBaseShas` in the file first and match the argument order in the test. The raw SQL accessor (`store.db`) and table name must match the file; copy them from an existing raw query in the file.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/store/planningProposals.test.ts -t "host attachments"`
Expected: FAIL (`setProposalHostAttachments` is not exported).

- [ ] **Step 3: Implement.**
  - Add `const HOST_ATTACHMENTS_KEY = 'hostAttachments'`.
  - Give `splitPayload` a third parameter `hostAttachments: readonly HostAttachment[]`. Put it in `body` under the key when the list is not empty, like `hostWarnings`.
  - Add a private `readHostAttachments(payloadJson: string): HostAttachment[]`. It parses the JSON, checks `Array.isArray`, and keeps each entry whose `name`, `storedName`, `kind` are strings and `byteSize` is a finite number. Otherwise it returns `[]`.
  - `toProposal` strips `hostAttachments` from `payload` like `hostWarnings` and sets `attachments`.
  - `insertProposal` passes `[]` to `splitPayload`.
  - `updateProposalPayload`: read the current row, pass its host attachments to `splitPayload` (a revise keeps the old list until the late write replaces it).
  - `setProposalWarnings`: pass `p.attachments` to `splitPayload`.
  - `setProposalBaseShas` writes only the `base_shas` column, so it needs no change. The test pins it.
  - `setProposalHostAttachments`: inside a transaction, load the row, return `false` unless pending and `sourceUuid === uuid`, rebuild with `splitPayload(p.payload, p.warnings, list)`, write `payload_json` only (do not touch `revision_count`), return `true`.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/store/planningProposals.test.ts && npm run -s typecheck`
Expected: PASS. Fix any other caller of `splitPayload` that typecheck reports.

- [ ] **Step 5: Commit**

```bash
git add src/store/planningProposals.ts src/store/planningProposals.test.ts
git commit -m "feat(planning): store host-owned attachments with the proposal and keep them across payload writes"
```

---

### Task 3: The async snapshot module

**Files:**
- Create: `src/planning/draftAttachments.ts`
- Test: `src/planning/draftAttachments.test.ts`

**Interfaces:**
- Consumes: `ProposalAttachment` (Task 1), `HostAttachment` (Task 2), `validateAttachment` and `MAX_PASTE_BYTES` from `src/attachments/ingest.js`, `attachmentsRoot` from `src/attachments/paths.js`, `MIRROR_MAX_BYTES` from `src/agent/bridge/mirror.js`, `clipToken` and `MAX_WARNING_CHARS` from `./draftQualityChecks.js`.
- Produces:
  - `export const MAX_DRAFT_BYTES = 25 * 1024 * 1024`
  - `export function draftAttachmentDir(storageDir: string, proposalId: number): string` returns `join(attachmentsRoot(storageDir), 'draft-' + proposalId)`.
  - `export async function snapshotDraftAttachments(args: { storageDir: string; artifactsDir: string; proposalId: number; entries: readonly ProposalAttachment[] }): Promise<{ list: HostAttachment[]; warnings: string[] }>`
  - `export async function pruneDraftAttachments(storageDir: string, proposalId: number, keep: readonly HostAttachment[]): Promise<void>` removes blobs not in `keep`.
  - `export async function removeDraftAttachments(storageDir: string, proposalId: number): Promise<void>` removes the dir (`rm` recursive, force).

First read `src/attachments/ingest.ts` for the exact signatures of `validateAttachment` and `ingestBytes`. The snapshot uses `validateAttachment` for the name and type check only. It writes the blob itself, so the host copy is not a ticket attachment.

- [ ] **Step 1: Write the failing tests** (`src/planning/draftAttachments.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDraftAttachments, pruneDraftAttachments, removeDraftAttachments, draftAttachmentDir } from './draftAttachments.js';

describe('snapshotDraftAttachments', () => {
  let root: string; let art: string; let storage: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-da-'));
    art = join(root, 'artifacts'); storage = join(root, 'storage');
    mkdirSync(art, { recursive: true }); mkdirSync(storage, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (entries: { path: string; note?: string; binding?: boolean }[]) =>
    snapshotDraftAttachments({ storageDir: storage, artifactsDir: art, proposalId: 7, entries });

  it('copies a file content-addressed and keeps the note and binding', async () => {
    mkdirSync(join(art, 'proto'));
    writeFileSync(join(art, 'proto', 'a.html'), '<p>hi</p>');
    const r = await run([{ path: 'proto/a.html', note: 'n', binding: true }]);
    expect(r.warnings).toEqual([]);
    expect(r.list).toHaveLength(1);
    const a = r.list[0]!;
    expect(a).toMatchObject({ name: 'a.html', byteSize: 9, note: 'n', binding: true });
    expect(readFileSync(join(draftAttachmentDir(storage, 7), a.storedName), 'utf8')).toBe('<p>hi</p>');
  });
  it('refuses missing, outside, link, hardlink, folder, too large', async () => {
    writeFileSync(join(root, 'secret.txt'), 's');
    symlinkSync(join(root, 'secret.txt'), join(art, 'ln.txt'));
    writeFileSync(join(art, 'h1.txt'), 'x'); linkSync(join(art, 'h1.txt'), join(art, 'h2.txt'));
    mkdirSync(join(art, 'dir'));
    writeFileSync(join(art, 'big.txt'), Buffer.alloc(10 * 1024 * 1024 + 1));
    const r = await run([
      { path: 'nope.txt' }, { path: 'ln.txt' }, { path: 'h2.txt' }, { path: 'dir' }, { path: 'big.txt' },
    ]);
    expect(r.list).toEqual([]);
    expect(r.warnings).toEqual([
      'attachment refused: nope.txt (missing)',
      'attachment refused: ln.txt (link)',
      'attachment refused: h2.txt (hardlink)',
      'attachment refused: dir (not a file)',
      'attachment refused: big.txt (too large)',
    ]);
  });
  it('refuses a path whose realpath leaves the artifacts dir (via a linked folder)', async () => {
    mkdirSync(join(root, 'elsewhere')); writeFileSync(join(root, 'elsewhere', 'f.txt'), 'x');
    symlinkSync(join(root, 'elsewhere'), join(art, 'out'));
    const r = await run([{ path: 'out/f.txt' }]);
    expect(r.warnings).toEqual(['attachment refused: f.txt (outside)']);
  });
  it('flags a kept file over 2 MB and enforces the draft cap', async () => {
    for (const n of ['a', 'b', 'c']) writeFileSync(join(art, `${n}.bin.txt`), Buffer.alloc(9 * 1024 * 1024, n));
    const r = await run([{ path: 'a.bin.txt' }, { path: 'b.bin.txt' }, { path: 'c.bin.txt' }]);
    expect(r.list.map((x) => x.name)).toEqual(['a.bin.txt', 'b.bin.txt']);
    expect(r.warnings).toContain('attachment >2 MB, not in sandbox: a.bin.txt');
    expect(r.warnings).toContain('attachment refused: c.bin.txt (draft cap)');
  });
  it('prune keeps named blobs and remove deletes the dir', async () => {
    writeFileSync(join(art, 'a.txt'), 'a'); writeFileSync(join(art, 'b.txt'), 'b');
    const r = await run([{ path: 'a.txt' }, { path: 'b.txt' }]);
    await pruneDraftAttachments(storage, 7, [r.list[0]!]);
    expect(readdirSync(draftAttachmentDir(storage, 7))).toEqual([r.list[0]!.storedName]);
    await removeDraftAttachments(storage, 7);
    expect(existsSync(draftAttachmentDir(storage, 7))).toBe(false);
  });
});
```

The test name `name` for a refused entry is the base name of the path. The "type" reason comes from `validateAttachment` when it rejects the extension. Add one test for it after you read `kinds.ts` (use an extension that file rejects). Warnings pass through `clipToken` with `MAX_WARNING_CHARS`, so keep names short in tests.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/planning/draftAttachments.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/planning/draftAttachments.ts`.

Order of checks per entry (each failure pushes one warning and goes on to the next entry):
1. `joined = resolve(artifactsDir, entry.path)`. `realpath(joined)` throws `ENOENT` → `missing`. Any other error → `missing`.
2. `realpath(artifactsDir)` computed once. Require `real === rootReal` is false and `real.startsWith(rootReal + sep)`. Otherwise → `outside`.
3. `lstat(joined)`: `isSymbolicLink()` → `link`. Not `isFile()` → `not a file`. `nlink > 1` → `hardlink`. Check the symlink case before the `realpath` outside check when the last segment is the link: do `lstat` on `joined` first so a link to an outside file gives `link` (the test above expects `link`, and a linked folder in the middle gives `outside`).
4. `size > MAX_PASTE_BYTES` → `too large`.
5. `validateAttachment(name, size)` failure → `type` (or `too large` when its reason says size).
6. Running total plus size above `MAX_DRAFT_BYTES` → `draft cap`.
7. `open(joined, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, `fstat`: require `isFile()`, `dev` and `ino` equal to the `lstat` values, else `link`. Read at most `MAX_PASTE_BYTES + 1` bytes in a loop; if the read exceeds the size → `too large`. Always close the handle in `finally`.
8. `sha16 = createHash('sha256').update(bytes).digest('hex').slice(0, 16)`. `storedName = sha16 + extname(name).toLowerCase()`. Write to `<dir>/<storedName>.<random>.tmp`, then `rename`. `mkdir` the dir with `recursive: true` first.
9. Push `{ name, storedName, kind, byteSize, note, binding }`. `kind` comes from `validateAttachment`'s result. If `byteSize > MIRROR_MAX_BYTES`, push `attachment >2 MB, not in sandbox: <name>`.

Dedupe: two entries with the same `storedName` produce one list item. Every warning goes through `clipToken(warning, MAX_WARNING_CHARS)` — read its signature in `draftQualityChecks.ts` first. Use `node:fs/promises` for all calls. Wrap each entry in a try/catch that maps an unexpected error to a `missing` warning, so one bad file never throws out of the function.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/planning/draftAttachments.test.ts && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planning/draftAttachments.ts src/planning/draftAttachments.test.ts
git commit -m "feat(planning): snapshot draft evidence files into host storage with confinement checks"
```

---

### Task 4: Run the snapshot from the outbox

**Files:**
- Modify: `src/extension/ops/planningOutbox.ts` (deps, `willVerify`, the new-draft path, the revise path, `verifyAsync`)
- Modify: `src/extension.ts` (`createPlanningOutbox` call, near line 7577: add `storageDir`)
- Test: `src/extension/ops/planningOutbox.integration.test.ts`

**Interfaces:**
- Consumes: `snapshotDraftAttachments`, `pruneDraftAttachments` (Task 3), `setProposalHostAttachments`, `setProposalWarnings` (Task 2).
- Produces: new dep `storageDir: string` in `PlanningOutboxDeps`.

Design: after the proposal row exists, if `payload.attachments` is not empty, run `snapshotAsync(id, uuid, scratch, entries)` under the same latch as `verifyAsync`. The latch `checking.set(id, uuid)` is set once before any async work and cleared in one `finally`. When both a path probe and an attachment snapshot run, run them in sequence inside one `async` function, so one `finally` clears the latch. The late write order is:
1. `setProposalHostAttachments(store, id, uuid, list)`. If it returns `false`, stop (the draft was revised or discarded).
2. Merge the snapshot warnings into the current warnings (`cur.warnings` plus new ones, deduped) and call `setProposalWarnings`.
3. `safeRefresh()`, then `onWarnings` as the existing code does.

On a revise: the new `updateProposalPayload` keeps the old `hostAttachments` (Task 2). The snapshot then re-reads the files and the late write replaces the list. After a successful late write on a revise, the old blobs are NOT removed (an open Review keeps its staged files). They are removed at accept or discard (Task 6).

- [ ] **Step 1: Write the failing tests** (append to `planningOutbox.integration.test.ts`; use `make`, `put`, `settle`, `scratch`, `outbox` from the file. Add `storageDir` to `make`'s defaults: `storageDir: join(root, 'storage')`.)

```ts
describe('attachments', () => {
  const withFile = (name: string, body: string) => {
    mkdirSync(join(scratch, 'artifacts'), { recursive: true });
    writeFileSync(join(scratch, 'artifacts', name), body);
  };
  it('copies a listed file and keeps no refusal warning', async () => {
    withFile('p.html', '<b>x</b>');
    make().scan();
    // scan claims the outbox file written below; write first, then scan
  });
});
```

Replace the stub above with the full test: write `put(`${UUID(1)}.json`, { ...good, attachments: [{ path: 'p.html', binding: true }] })`, call `make().scan()`, `await settle()` (use `await new Promise((r) => setTimeout(r, 20))` if one tick is too short for real fs), then assert:
  - `pending()[0]!.attachments` has one item named `p.html` with `binding: true`.
  - the blob exists under `join(root, 'storage', 'attachments', 'draft-' + id)`.
  - `pending()[0]!.warnings` has no entry that starts with `attachment refused`.

Second test: a listed missing file keeps the draft and adds `attachment refused: nope.txt (missing)`. Third test: a late warning (`setProposalWarnings` run after the snapshot) keeps `attachments`. Fourth test: a revise (second file with the same `id` of the first draft) re-reads the files, `attachments` reflects the new list, and the old blob still exists on disk. Fifth test: discard before the snapshot ends makes `setProposalHostAttachments` return `false` and writes nothing (create the row, call `discardProposal`, then `settle`).

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/extension/ops/planningOutbox.integration.test.ts -t attachments`
Expected: FAIL (`storageDir` is not a known dep, no snapshot runs).

- [ ] **Step 3: Implement.** Add `readonly storageDir: string` to `PlanningOutboxDeps`. Extend `willVerify(p)` so it also returns true when `p.attachments?.length`. Add the snapshot step to the async function that `verifyAsync` runs, before the commit and path probes or after them, but inside the same `try` so the `finally` still clears the latch. Use `planningArtifactsDir(session.scratch)` for `artifactsDir`. Log failures with the file's existing `debug('[planning] ...')` callback and never throw. In `extension.ts`, pass `storageDir` (the variable defined near line 686) to `createPlanningOutbox`.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/extension/ops/planningOutbox.integration.test.ts && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/planningOutbox.ts src/extension/ops/planningOutbox.integration.test.ts src/extension.ts
git commit -m "feat(planning): the outbox snapshots listed draft files under the checking latch"
```

---

### Task 5: Leak warning ignores listed files

**Files:**
- Modify: `src/planning/draftQualityChecks.ts` (`LEAK_WARNING`, `draftQualityWarnings`)
- Test: `src/planning/draftQualityChecks.test.ts`

**Interfaces:**
- Consumes: `Proposal.attachments` (Task 1; the checker already receives the proposal).
- Produces: `LEAK_WARNING = 'plan path not in attachments (attach or inline)'`.

- [ ] **Step 1: Write the failing tests.** Update every test that asserts the old constant text to use `LEAK_WARNING` from the module (or the new literal). Add:

```ts
it('does not warn when the cited plan path is a listed attachment', () => {
  const p = { ...base, description: 'See /artifacts/proto/a.html and a.html for the layout.', attachments: [{ path: 'proto/a.html' }] };
  expect(draftQualityWarnings(p, opts)).not.toContain(LEAK_WARNING);
});
it('keeps the warning for a path that is not listed', () => {
  const p = { ...base, description: 'See /artifacts/proto/b.html for the layout.', attachments: [{ path: 'proto/a.html' }] };
  expect(draftQualityWarnings(p, opts)).toContain(LEAK_WARNING);
});
it('uses the new warning text', () => {
  expect(LEAK_WARNING).toBe('plan path not in attachments (attach or inline)');
});
```

Use the file's real fixture names (`base`, `opts`) and export `LEAK_WARNING` if it is private.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/planning/draftQualityChecks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In the leak check, build `const text = \`${desc}\n${sum}\``. For each listed attachment `a`, remove `/artifacts/${a.path}` (all occurrences, use `split(x).join('')`), then remove the bare file name `basename(a.path)` the same way (strip the longest string first). Run `LEAK_PATTERNS` on the stripped text. Do not import `node:fs`. Use a local `posix`-style `lastIndexOf('/')` for the base name so the module stays pure.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/planning/draftQualityChecks.test.ts src/planning/proposal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/planning/draftQualityChecks.ts src/planning/draftQualityChecks.test.ts
git commit -m "feat(planning): the leak warning ignores files the draft lists as attachments"
```

---

### Task 6: Review prefill carries the files; accept and discard clean up

**Files:**
- Modify: `src/extension/ops/planningProposalOps.ts` (`prefillOf`, `discard`, deps)
- Modify: `src/ui/ticketForm/panel.ts` (`TicketFormPrefill` interface: add `attachments?: readonly StagedAttachment[]`)
- Modify: `src/extension.ts` (`createPlanningProposalOps` call near line 799: add `storageDir`)
- Test: `src/extension/ops/planningProposalOps.test.ts`

**Interfaces:**
- Consumes: `HostAttachment` (Task 2), `draftAttachmentDir`, `removeDraftAttachments` (Task 3).
- Produces:
  - `export interface StagedAttachment { name: string; storedName: string; kind: string; byteSize: number; binding?: boolean }` in `panel.ts` (a subset of `HostAttachment`).
  - `TicketFormPrefill.attachments?: readonly StagedAttachment[]`.
  - Deps: `storageDir: string`, plus an optional `removeDir?: (storageDir: string, id: number) => Promise<void>` that defaults to `removeDraftAttachments` (a seam for tests).

- [ ] **Step 1: Write the failing tests** (in `planningProposalOps.test.ts`; copy its existing `make` and fixture style)

```ts
it('prefillOf lists the host attachments, binding first', () => {
  const p = pendingWithAttachments([
    { name: 'b.txt', storedName: 'b.txt', kind: 'file', byteSize: 1 },
    { name: 'a.html', storedName: 'a.html', kind: 'file', byteSize: 1, binding: true },
  ]);
  const f = ops.prefillOf(p);
  expect(f.attachments!.map((a) => a.name)).toEqual(['a.html', 'b.txt']);
});
it('removes the host copy after accept and never throws when removal fails', async () => {
  const removeDir = vi.fn().mockRejectedValue(new Error('boom'));
  const { ops, store } = make({ removeDir });
  const f = ops.prefillOf(pending());
  await expect(f.onCreated(ticketId)).resolves.not.toThrow();
  expect(removeDir).toHaveBeenCalledWith(storageDir, pending().id);
  expect(getProposal(store, id)!.status).toBe('accepted');
});
it('removes the host copy after discard', async () => {
  const removeDir = vi.fn().mockResolvedValue(undefined);
  const { ops } = make({ removeDir });
  await ops.discard(id);
  expect(removeDir).toHaveBeenCalledWith(storageDir, id);
});
```

Match the real names in the file (`make`, `pending`, the way `onCreated` is typed: sync or async). `pendingWithAttachments` is a helper that inserts a proposal and calls `setProposalHostAttachments`. If `onCreated` is sync, run the removal as a fire-and-forget promise whose rejection is caught and logged, and the test uses `await Promise.resolve()` before the assertion.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/extension/ops/planningProposalOps.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `prefillOf`, add `attachments: sortBindingFirst(p.attachments)` where the helper returns a new array, binding entries first, order otherwise stable. In `onCreated`, after `markProposalAccepted` and the refresh, call `void removeDir(storageDir, p.id).catch((e) => debug('[planning] draft attachment cleanup failed: ' + String(e)))`. Use the file's injected `debug` dep (add one with a no-op default if it has none). In `discard()`, call the same cleanup after the store call, outside the `guarded()` result path, so a cleanup failure never turns a successful discard into an error. Pass `storageDir` from `extension.ts`.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/extension/ops/planningProposalOps.test.ts && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/planningProposalOps.ts src/extension/ops/planningProposalOps.test.ts src/ui/ticketForm/panel.ts src/extension.ts
git commit -m "feat(planning): Review prefill carries the host attachments and accept or discard removes the copy"
```

---

### Task 7: Ticket form stages the files and Save attaches them

Read `docs/ui/README.md` first (UI rules and verification). Do not edit baselines or the layout ledger.

**Files:**
- Modify: `src/ui/ticketForm/state.ts` (`AttachmentView`, `applyPrefill`)
- Modify: `src/ui/ticketForm/messages.ts` (new `unstage-attachment` parse and dispatch)
- Modify: `src/ui/ticketForm/panel.ts` (staged list, `ctx.stagedAttachments()`, `ctx.clearStaged()`, overlay while unbound)
- Modify: `src/ui/ticketForm/actions.ts` (`persistDraft` async, `ingestStaged`, the two callers, bind-before-Save)
- Modify: `src/ui/ticketForm/webview.html` (`renderAttachments`, click handler)
- Test: `src/ui/ticketForm/state.test.ts`, `messages.test.ts`, `panel.test.ts`, `actions.test.ts`, and the existing webview test file for the form

**Interfaces:**
- Consumes: `StagedAttachment`, `TicketFormPrefill.attachments` (Task 6); `attachmentPath(storageDir, 'draft-<id>' ...)` or `draftAttachmentDir` (Task 3) to find the host copy; `ingestBytes(storageDir, ticketId, originalName, bytes)`.
- Produces:
  - `AttachmentView` gains `staged?: true` and `storedName?: string`. Staged rows use `id: -1 - index` so they never collide with a numeric row id.
  - Message `{ type: 'unstage-attachment', storedName: string }`.
  - `ctx.stagedAttachments(): readonly StagedAttachment[]` and `ctx.unstage(storedName: string): void`, `ctx.clearStaged(): void`.
  - `actions.ts`: `async function persistDraft(ctx, deps, input): Promise<void>`; the factory exposes `ingestStaged(ticketId: number): Promise<void>`.

Sub-steps, each with its own test first (RED), then code (GREEN):

- [ ] **Step 1: state and messages (failing tests).**
  - `state.test.ts`: `applyPrefill` with `attachments` returns `attachments` rows with `staged: true`, binding first, and `src` empty. Without a bound id the state shows the staged rows. With a bound id (`boundId` set) it shows only real rows.
  - `messages.test.ts`: `parse({type:'unstage-attachment', storedName:'abc.html'})` is accepted. A missing, non-string or path-like `storedName` (`'../x'`, `'a/b'`, empty, longer than 64 chars) is rejected. The dispatch calls `handlers.unstage(storedName)`.
  Run: `npx vitest run src/ui/ticketForm/state.test.ts src/ui/ticketForm/messages.test.ts` → FAIL.

- [ ] **Step 2: implement state and messages.** Add the fields and the validator `isStoredName = /^[0-9a-f]{16}(\.[a-z0-9]{1,10})?$/` (copy the exact extension rule from `ingest.ts`). Add the dispatch case next to `detach-attachment`. Run the same command → PASS.

- [ ] **Step 3: panel (failing tests, then code).**
  - `panel.test.ts`: opening with a prefill that has `attachments` calls no `ensureTicket` (the fake store has no new row) and the pushed state lists the staged rows. `unstage` removes one row from the next push. A restored form (`restored` set) rebuilds the staged list from `prefillFor`. Close with no Save leaves no row and the staged files stay on disk (the host copy is removed only at accept or discard, owned by Task 6).
  - Code: keep a panel-held `let staged = [...(prefill?.attachments ?? [])]`. Overlay it in `pushState` while `boundId === undefined`. `ctx.unstage` filters it and calls `pushState`. `ctx.clearStaged` empties it.
  Run: `npx vitest run src/ui/ticketForm/panel.test.ts`.

- [ ] **Step 4: actions (failing tests, then code).**
  - `actions.test.ts` (use `mkCtx()` and its fakes):
    1. `submit` with staged files creates the ticket, then the attachments rows exist with `originalName` equal to the staged names, then `commitPrefill` is called. Assert the call order with a shared `calls: string[]` log.
    2. Manual attach (`attachBytes`) while staged files exist: the staged files are ingested into that row first and `ctx.clearStaged` was called.
    3. Analyze (`attachBriefAttachment` path) does the same.
    4. Failure: `ingestBytes` rejects for one file → `persistDraft` rejects, `commitPrefill` is not called, an error toast runs, no launch runs.
    5. A callers test: `submit` and `save` both `await persistDraft` (a slow `ingestStaged` delays the launch).
  - Code:
    - Inside the factory, add `async function ingestStaged(ticketId: number)`: for each `ctx.stagedAttachments()`, read bytes from `join(draftAttachmentDir(storageDir, draftId), storedName)`, call `ingestBytes(storageDir, ticketId, name, bytes)`, then the same `beginAttachmentWrite`/`record()` path the other attach functions use. After all succeed, call `ctx.clearStaged()`. On the first failure throw an `Error` with a plain message and leave the rest staged.
    - Call `await ingestStaged(ticketId)` in `attachBytes`, `attachPick` and `attachBriefAttachment` right after `ensureTicket(draft)` and before their own `record(...)`.
    - Make `persistDraft` async. After the row exists, call `await deps.ingestStaged(ticketId)` and only then `ctx.commitPrefill()`. Wrap in the existing `try { ... } finally { deps.onChange(); }`. Convert both call sites (`submit` ~1541 and `save` ~1655) to `await persistDraft(...)`, and make their enclosing handlers async if they are not.
    - If the draft id or `storageDir` is missing, `ingestStaged` is a no-op, so tickets without staged files behave as before.
  Run: `npx vitest run src/ui/ticketForm/actions.test.ts`.

- [ ] **Step 5: webview (failing test, then code).**
  - In the form's webview test (find it with `ls src/ui/ticketForm/*.test.ts`; it uses `renderWebviewReady('ticketForm')` or the file's own helper), post a state with two staged rows. Assert the rows use the same `.attach*` classes as normal rows, binding first, the remove button posts `unstage-attachment` with the `storedName`, and the open button is absent or inert for a staged row.
  - Code: in `renderAttachments` (~1068) add a branch for `a.staged` that reuses the normal tile markup, sets `data-stored="<storedName>"` and no `data-id`. In the click handler (~2767), `.attachdetach` on a staged tile posts `{ type: 'unstage-attachment', storedName }`. `.attachopen` on a staged tile does nothing.

- [ ] **Step 6: typecheck and the five form test files**

Run: `npm run -s typecheck && npx vitest run src/ui/ticketForm/state.test.ts src/ui/ticketForm/messages.test.ts src/ui/ticketForm/panel.test.ts src/ui/ticketForm/actions.test.ts`
Expected: PASS. Run the form's webview test file too. Do not edit visual baselines. If a baseline changes for a staged-row render, report it in the done note instead of re-recording.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ticketForm
git commit -m "feat(planning): Review stages draft files and Save attaches them before the launch"
```

---

### Task 8: Planner instructions and docs

**Files:**
- Modify: `src/planning/preamble.ts` (near the lines that describe the draft fields, ~162, ~211, ~249-254)
- Modify: `src/cli/guide.ts` (~150-165)
- Modify: `docs/arch/planning.md` (`@arch:PLANNING`, `@arch:DRAFT-QUALITY`, `@arch:DRAFT-CONSTRAINTS` — find the file with `grep -rE '^## \[@arch:PLANNING\]' docs`), `docs/arch/cli.md` (`@arch:CLI-13`, `@arch:CLI-17`), `docs/ui/UI-INVARIANTS.md` (`@ui:TICKET-FORM-MIGRATION-EXCEPTIONS`)
- Test: the existing preamble and guide tests (`src/planning/preamble.test.ts`, `src/cli/guide.test.ts`)

- [ ] **Step 1: Write the failing tests.** Assert the preamble text contains `attachments`, the word `binding`, and says to cite the file by its file name. Assert the guide lists `attachments` in the `draft propose` fields. Run `npx vitest run src/planning/preamble.test.ts src/cli/guide.test.ts` → FAIL.

- [ ] **Step 2: Implement the text.** Preamble: "List each evidence file the ticket needs in `attachments` (`path` relative to `KARST_ARTIFACTS`, at most 10, at most 10 MB each). Set `binding: true` on the prototype the implementer must follow. Cite a file by its file name in the description. Do not cite `/artifacts/...` paths: the host removes the plan directory." Guide: add `attachments` to the field list with the same limits. Keep ASD-STE100 sentences.

- [ ] **Step 3: Update the docs blocks.** Extract each block with the `awk` command from `CLAUDE.md`, edit only its body, and keep the `## [@ns:ID]` and `END_DOC_BLOCK` lines. Content per block:
  - `@arch:PLANNING`: the `attachments` field, `hostAttachments`, the host copy path, the async snapshot under the `checking` latch, the cleanup at accept and discard.
  - `@arch:CLI-13`, `@arch:CLI-17`: the new `draft propose` field and its limits.
  - `@arch:DRAFT-QUALITY`: the new leak warning text, the strip of listed paths, the refusal and mirror warnings.
  - `@arch:DRAFT-CONSTRAINTS`: the confinement rules (realpath, lstat, nlink, `O_NOFOLLOW`, dev/ino) and the caps.
  - `@ui:TICKET-FORM-MIGRATION-EXCEPTIONS`: add "Eighth recorded exception (T1355)" with the staged rows and the `unstage-attachment` message, and add T1355 to the ticket list in the block title or intro line, as the seven earlier entries do.

- [ ] **Step 4: Run the docs scripts**

Run: `npm run -s docs:graph && npm run -s docs:check`
Expected: exit 0. If `docs:graph` rewrites `docs/arch/system-map.md`, stage it (it is generated, never hand-merged).

- [ ] **Step 5: Run the preamble and guide tests, then commit**

Run: `npx vitest run src/planning/preamble.test.ts src/cli/guide.test.ts`
Expected: PASS.

```bash
git add src/planning/preamble.ts src/cli/guide.ts docs
git commit -m "docs: planner instructions and arch blocks for draft attachments"
```

---

### Task 9: Final verification

- [ ] **Step 1:** `npm run -s typecheck` and `npm run -s lint` exit 0.
- [ ] **Step 2:** `npx vitest related $(git diff --name-only develop...HEAD | grep '\.ts$' | grep -v test)` passes. Do not run the full suite.
- [ ] **Step 3:** `npm run -s lint:layers` exits 0 (the new `planning` → `attachments` and `agent/bridge` imports must obey the layer rules; if a rule blocks `draftAttachments.ts`, move the 2 MB constant into the module and add a comment that it mirrors `MIRROR_MAX_BYTES`).
- [ ] **Step 4:** `BASE_REF=develop PR_BODY= node scripts/docsGate.mjs` after the commits. If it blocks and the block still holds, run `karst arch cite @arch:KEY --why "<reason>"`.
- [ ] **Step 5:** Read `.claude/skills/gates-and-ci/SKILL.md` and run only the cheap checks it lists.
- [ ] **Step 6:** Fire the impl marker with the `stage` tool: `{ stage: "impl" }`.

## Self-Review

- **Spec coverage:** schema and reserved key (Task 1); `hostAttachments` storage and carry-forward (Task 2); confined async snapshot, caps, warnings (Task 3); latch and late write, revise keeps blobs (Task 4); leak warning (Task 5); `prefillOf`, accept and discard cleanup (Task 6); staged rows, `unstage-attachment`, bind-before-Save, async `persistDraft`, failure before `commitPrefill`, restored form (Task 7); planner text and docs, Eighth exception (Task 8). `karst context` and the sandbox mirror need no code: they already read ticket attachments, and the 2 MB cap is `MIRROR_MAX_BYTES`.
- **Placeholder scan:** Task 4 and Task 7 name test helpers from the existing files (`make`, `mkCtx`, `renderWebviewReady`). The implementer reads those files first. The code steps show the exact behavior and call order.
- **Type consistency:** `ProposalAttachment` (agent input), `HostAttachment` (stored), `StagedAttachment` (form) are used with the same names in Tasks 1 to 7. `setProposalHostAttachments(store, id, uuid, list)` has the same signature in Tasks 2 and 4. `draftAttachmentDir(storageDir, id)` is used in Tasks 3, 6 and 7.
