# Ticket Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the create/edit ticket Prompt field accept image and video attachments that render inline in the panel and reach the agent as absolute paths in the ticket-context markdown.

**Architecture:** Bytes are copied into `<globalStorage>/attachments/<ticketId>/<sha>.<ext>` and indexed by a new `ticket_attachments` table (schema v17). A new pure-ish `src/attachments/` module owns the whitelist, path math, async ingest, and reaping. The onboarding webview gains a thumbnail strip fed by webview URIs minted through a new `OnboardingPanel.toWebviewUri` seam, under a CSP widened for that one panel only. `renderTicketContext` grows an `## Attachments` section so the launch seed and the `karst context` CLI both emit it from the single existing renderer.

**Tech Stack:** TypeScript ESM, better-sqlite3 (extension) / `node:sqlite` (CLI), vitest, VS Code webview API.

**Spec:** `docs/superpowers/specs/2026-08-01-ticket-attachments-design.md`

## Global Constraints

- ESM: every relative import needs a `.js` suffix. `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` is on — array/index access needs `!` or a guard.
- `vscode` is NOT a runtime dependency outside `host.ts` / `extension.ts`. Anything under `src/attachments/`, `src/store/`, `src/context/`, and `src/ui/onboarding/{state,messages,actions,panel}.ts` must import zero `vscode`.
- Strict TDD: write the failing test, run it, watch it fail, then implement. Conventional commits. Files under ~400 lines.
- All fs work in `src/attachments/` is **async** (`node:fs/promises`). Nothing may block the extension host event loop.
- `src/store/attachments.ts` must be driver-agnostic: `store.db.prepare(sql).get/all/run` only, positional `?` placeholders only, no named params, no `.pluck()`. The `karst context` CLI reads this table over `node:sqlite`.
- Whitelisted extensions, exactly: images `png`, `jpg`, `jpeg`, `gif`, `webp`; video `mp4`, `webm`, `mov`.
- Paste size cap: `10 * 1024 * 1024` bytes.
- Storage name format: `<sha256 hex, first 16 chars>.<ext>`.
- Run `npm test` and `npm run typecheck` before every commit.

## File Structure

**Create:**
- `src/attachments/kinds.ts` — extension→kind whitelist. Pure, no fs.
- `src/attachments/kinds.test.ts`
- `src/attachments/paths.ts` — directory/file path math. Pure, no fs.
- `src/attachments/paths.test.ts`
- `src/attachments/ingest.ts` — async hash + copy/write, returns the row to insert.
- `src/attachments/ingest.test.ts`
- `src/attachments/reap.ts` — async recursive removal of a ticket's directory.
- `src/attachments/reap.test.ts`
- `src/store/attachments.ts` — SQL for `ticket_attachments`.
- `src/store/attachments.test.ts`

**Modify:**
- `src/store/schema.sql` — add `ticket_attachments`.
- `src/store/migrations.ts` — `SCHEMA_VERSION` 16→17 + a guarded v17 step.
- `src/store/db.test.ts` — `EXPECTED_TABLES`, the "12 registry tables" title, and every `user_version` literal.
- `src/store/tickets.ts:440` — add `ticket_attachments` to `TICKET_CHILD_TABLES`.
- `src/context/ticketContext.ts` — `TicketContextAttachment`, `storageDir` param, `## Attachments` render.
- `src/cli/context.ts` — pass `dirname(dbPath)` as `storageDir`.
- `src/extension.ts` — pass `globalStorageUri.fsPath`; reap the directory on ticket delete; supply the file-picker dep.
- `src/model/csp.ts` — optional `mediaSource` argument.
- `src/ui/webviewCsp.test.ts` — assert onboarding widens, the other five do not.
- `src/ui/onboarding/state.ts` — `attachments` on `OnboardingState`.
- `src/ui/onboarding/panel.ts` — `toWebviewUri` on `OnboardingPanel`; map paths in `pushState`.
- `src/ui/onboarding/messages.ts` — four new messages + validation.
- `src/ui/onboarding/actions.ts` — four new actions.
- `src/ui/onboarding/webview.html` — strip markup, styles, paste handler, render function.
- `src/ui/onboarding/host.ts` — `localResourceRoots`, `asWebviewUri`, CSP media source.
- Their sibling `.test.ts` files.

---

### Task 1: The extension whitelist

**Files:**
- Create: `src/attachments/kinds.ts`
- Test: `src/attachments/kinds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type AttachmentKind = 'image' | 'video'`; `IMAGE_EXTENSIONS: readonly string[]`; `VIDEO_EXTENSIONS: readonly string[]`; `attachmentKind(name: string): AttachmentKind | null`; `attachmentExtension(name: string): string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/attachments/kinds.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  attachmentKind,
  attachmentExtension,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './kinds.js';

describe('attachmentKind', () => {
  it('classifies every whitelisted image extension', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(attachmentKind(`shot.${ext}`), ext).toBe('image');
    }
  });

  it('classifies every whitelisted video extension', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(attachmentKind(`clip.${ext}`), ext).toBe('video');
    }
  });

  it('is case-insensitive on the extension', () => {
    expect(attachmentKind('SHOT.PNG')).toBe('image');
    expect(attachmentKind('Clip.MOV')).toBe('video');
  });

  it('rejects a non-whitelisted extension', () => {
    expect(attachmentKind('notes.pdf')).toBeNull();
    expect(attachmentKind('script.sh')).toBeNull();
  });

  // The double extension is the interesting case: only the LAST segment counts,
  // so a file dressed up as an image is classified by what it actually is.
  it('classifies by the final extension only', () => {
    expect(attachmentKind('payload.png.exe')).toBeNull();
    expect(attachmentKind('archive.tar.png')).toBe('image');
  });

  it('rejects a name with no extension', () => {
    expect(attachmentKind('screenshot')).toBeNull();
    expect(attachmentKind('')).toBeNull();
  });

  // A leading dot is the whole name, not an extension: `.png` is a dotfile.
  it('rejects a dotfile whose name looks like an extension', () => {
    expect(attachmentKind('.png')).toBeNull();
  });
});

describe('attachmentExtension', () => {
  it('returns the normalized lowercase extension for a whitelisted name', () => {
    expect(attachmentExtension('SHOT.PNG')).toBe('png');
    expect(attachmentExtension('clip.Mp4')).toBe('mp4');
  });

  it('returns null for anything not whitelisted', () => {
    expect(attachmentExtension('notes.pdf')).toBeNull();
    expect(attachmentExtension('screenshot')).toBeNull();
  });

  // The stored filename is built from this value, so it must never carry a
  // separator — that is the whole reason the user's name is not used directly.
  it('never returns a value containing a path separator', () => {
    for (const ext of [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]) {
      expect(ext).not.toMatch(/[/\\.]/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/attachments/kinds.test.ts`
Expected: FAIL — `Failed to resolve import "./kinds.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/attachments/kinds.ts`:

```typescript
/**
 * The attachment type whitelist — the single place the accepted media formats
 * are named. Ingest classifies ONCE against this and stores the result; nothing
 * downstream re-derives a kind from a filename, so a row's kind cannot drift
 * from what was actually validated.
 *
 * Classification is by the FINAL extension only. `payload.png.exe` is an `exe`,
 * not an image — matching any interior segment is how a whitelist becomes a
 * suggestion. The extension also becomes the stored filename's suffix, so the
 * accepted values are deliberately alphanumeric and separator-free.
 */

export type AttachmentKind = 'image' | 'video';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'] as const;

const KIND_BY_EXTENSION = new Map<string, AttachmentKind>([
  ...IMAGE_EXTENSIONS.map((e) => [e, 'image'] as const),
  ...VIDEO_EXTENSIONS.map((e) => [e, 'video'] as const),
]);

/**
 * The lowercase final extension of `name`, with no leading dot. Null when there
 * is none — including for a dotfile like `.png`, where the dot begins the name
 * rather than separating an extension from it.
 */
function finalExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** The media kind for `name`, or null when the extension is not whitelisted. */
export function attachmentKind(name: string): AttachmentKind | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.get(ext) ?? null;
}

/**
 * The normalized extension to use in the stored filename, or null when `name`
 * is not whitelisted. Callers must treat null as a rejection, never as "use the
 * user's suffix anyway".
 */
export function attachmentExtension(name: string): string | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.has(ext) ? ext : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/attachments/kinds.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/attachments/kinds.ts src/attachments/kinds.test.ts
git commit -m "feat: attachment media-type whitelist

Classifies by the final extension only, so payload.png.exe is an exe.
The normalized extension is also what the stored filename uses, which is
why the accepted values are separator-free."
```

---

### Task 2: Attachment path math

**Files:**
- Create: `src/attachments/paths.ts`
- Test: `src/attachments/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ATTACHMENTS_ROOT: 'attachments'`; `attachmentsRoot(storageDir: string): string`; `attachmentDir(storageDir: string, ticketId: number): string`; `attachmentPath(storageDir: string, ticketId: number, storedName: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/attachments/paths.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  ATTACHMENTS_ROOT,
  attachmentsRoot,
  attachmentDir,
  attachmentPath,
} from './paths.js';

const STORAGE = '/tmp/globalStorage';

describe('attachment paths', () => {
  it('roots every attachment under one directory in global storage', () => {
    expect(attachmentsRoot(STORAGE)).toBe(join(STORAGE, ATTACHMENTS_ROOT));
  });

  it('gives each ticket its own directory, named by id', () => {
    expect(attachmentDir(STORAGE, 12)).toBe(join(STORAGE, ATTACHMENTS_ROOT, '12'));
  });

  it('places a stored file inside its ticket directory', () => {
    expect(attachmentPath(STORAGE, 12, 'a3f9e1.png')).toBe(
      join(STORAGE, ATTACHMENTS_ROOT, '12', 'a3f9e1.png'),
    );
  });

  // The webview's localResourceRoots is granted on attachmentsRoot(), so every
  // per-ticket directory must actually fall inside it. If these two ever
  // disagreed, images would silently fail to load with no error anywhere.
  it('keeps every ticket directory inside the granted root', () => {
    for (const id of [1, 42, 999999]) {
      expect(attachmentDir(STORAGE, id).startsWith(attachmentsRoot(STORAGE))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/attachments/paths.test.ts`
Expected: FAIL — `Failed to resolve import "./paths.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/attachments/paths.ts`:

```typescript
import { join } from 'node:path';

/**
 * Where a ticket's attachment bytes live:
 * `<globalStorage>/attachments/<ticketId>/<storedName>`.
 *
 * The same shape as the existing `<globalStorage>/artifacts/<ticketId>/` layout,
 * and in global storage for the same reason the registry is: every IDE window
 * shares it, so a panel in any window resolves the same file.
 *
 * `attachmentsRoot` is a separate export because it is exactly what the webview
 * is granted as a `localResourceRoots` entry — one directory, covering every
 * ticket, and nothing else on disk.
 *
 * Pure path math. No fs, so it is trivially testable and imports nothing.
 */

export const ATTACHMENTS_ROOT = 'attachments';

/** The single directory every attachment lives under. */
export function attachmentsRoot(storageDir: string): string {
  return join(storageDir, ATTACHMENTS_ROOT);
}

/** One ticket's attachment directory. */
export function attachmentDir(storageDir: string, ticketId: number): string {
  return join(attachmentsRoot(storageDir), String(ticketId));
}

/**
 * The absolute path of one stored file. `storedName` is always a value this
 * codebase generated (`<sha>.<ext>`), never a user-supplied filename — see
 * `ingest.ts`.
 */
export function attachmentPath(
  storageDir: string,
  ticketId: number,
  storedName: string,
): string {
  return join(attachmentDir(storageDir, ticketId), storedName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/attachments/paths.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachments/paths.ts src/attachments/paths.test.ts
git commit -m "feat: attachment storage path math

attachmentsRoot is its own export because it is exactly the directory
granted to the webview as localResourceRoots."
```

---

### Task 3: The `ticket_attachments` table

**Files:**
- Create: `src/store/attachments.ts`, `src/store/attachments.test.ts`
- Modify: `src/store/schema.sql` (append), `src/store/migrations.ts:9` and the tail before `db.pragma(...)`, `src/store/db.test.ts` (`EXPECTED_TABLES`, test title, every `user_version` literal), `src/store/tickets.ts:440` (`TICKET_CHILD_TABLES`)

**Interfaces:**
- Consumes: `AttachmentKind` from `src/attachments/kinds.js` (Task 1).
- Produces: `interface AttachmentRow { id: number; ticketId: number; kind: AttachmentKind; storedName: string; originalName: string; byteSize: number; createdAt: string }`; `interface AttachmentInput { ticketId: number; kind: AttachmentKind; storedName: string; originalName: string; byteSize: number }`; `listAttachments(store, ticketId): AttachmentRow[]`; `insertAttachment(store, input): AttachmentRow`; `findAttachmentByStoredName(store, ticketId, storedName): AttachmentRow | null`; `getAttachment(store, id): AttachmentRow | null`; `deleteAttachment(store, id): void`.

- [ ] **Step 1: Write the failing test**

Create `src/store/attachments.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicket, deleteTicket } from './tickets.js';
import {
  listAttachments,
  insertAttachment,
  findAttachmentByStoredName,
  getAttachment,
  deleteAttachment,
} from './attachments.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshStore(): Store {
  const store = openStore(':memory:');
  cleanups.push(() => store.close());
  return store;
}

function seedTicket(store: Store, key = 'T-1'): number {
  return createTicket(store, { key, title: `title ${key}` }).id;
}

describe('ticket attachments store', () => {
  it('returns an empty list for a ticket with no attachments', () => {
    const store = freshStore();
    expect(listAttachments(store, seedTicket(store))).toEqual([]);
  });

  it('round-trips every field of an inserted attachment', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'a3f9e1b2c3d4e5f6.png',
      originalName: 'login-error.png',
      byteSize: 4096,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listAttachments(store, ticketId)).toEqual([
      {
        id: row.id,
        ticketId,
        kind: 'image',
        storedName: 'a3f9e1b2c3d4e5f6.png',
        originalName: 'login-error.png',
        byteSize: 4096,
        createdAt: row.createdAt,
      },
    ]);
  });

  it('scopes the list to one ticket', () => {
    const store = freshStore();
    const a = seedTicket(store, 'T-A');
    const b = seedTicket(store, 'T-B');
    insertAttachment(store, {
      ticketId: a, kind: 'image', storedName: 'aaa.png', originalName: 'a.png', byteSize: 1,
    });
    insertAttachment(store, {
      ticketId: b, kind: 'video', storedName: 'bbb.mp4', originalName: 'b.mov', byteSize: 2,
    });
    expect(listAttachments(store, a).map((r) => r.storedName)).toEqual(['aaa.png']);
    expect(listAttachments(store, b).map((r) => r.storedName)).toEqual(['bbb.mp4']);
  });

  it('orders oldest first, then by id', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    for (const n of ['one', 'two', 'three']) {
      insertAttachment(store, {
        ticketId, kind: 'image', storedName: `${n}.png`, originalName: `${n}.png`, byteSize: 1,
      });
    }
    expect(listAttachments(store, ticketId).map((r) => r.storedName)).toEqual([
      'one.png', 'two.png', 'three.png',
    ]);
  });

  it('finds an existing row by its content-addressed stored name', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'dead.png', originalName: 'x.png', byteSize: 9,
    });
    expect(findAttachmentByStoredName(store, ticketId, 'dead.png')).toEqual(row);
    expect(findAttachmentByStoredName(store, ticketId, 'beef.png')).toBeNull();
  });

  // Scoped by ticket, not global: the same bytes attached to two tickets are two
  // files in two directories, so a dedupe hit must not cross a ticket boundary.
  it('does not find another ticket\'s row by stored name', () => {
    const store = freshStore();
    const a = seedTicket(store, 'T-A');
    const b = seedTicket(store, 'T-B');
    insertAttachment(store, {
      ticketId: a, kind: 'image', storedName: 'same.png', originalName: 'x.png', byteSize: 1,
    });
    expect(findAttachmentByStoredName(store, b, 'same.png')).toBeNull();
  });

  it('gets and deletes a single attachment by id', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const row = insertAttachment(store, {
      ticketId, kind: 'video', storedName: 'clip.mp4', originalName: 'repro.mov', byteSize: 77,
    });
    expect(getAttachment(store, row.id)).toEqual(row);
    deleteAttachment(store, row.id);
    expect(getAttachment(store, row.id)).toBeNull();
    expect(listAttachments(store, ticketId)).toEqual([]);
  });

  it('deletes a ticket\'s attachment rows with the ticket', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'gone.png', originalName: 'gone.png', byteSize: 3,
    });
    deleteTicket(store, ticketId);
    expect(listAttachments(store, ticketId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/attachments.test.ts`
Expected: FAIL — `Failed to resolve import "./attachments.js"`.

- [ ] **Step 3: Add the table to `schema.sql`**

Append to `src/store/schema.sql`:

```sql

-- Images and video attached to a ticket's prompt. An INDEX of bytes that live on
-- disk under <globalStorage>/attachments/<ticket_id>/<stored_name>, never the
-- bytes themselves: a 200 MB mp4 in a row would be read by every query that
-- selects *, and the agent needs a real file path regardless.
--
-- `kind` is resolved ONCE at ingest, against the whitelist in
-- attachments/kinds.ts, and stored. Nothing re-derives it from a filename later,
-- so a row's kind cannot drift from the value that was actually validated.
--
-- `stored_name` is content-addressed (<sha256[0..16]>.<ext>) and is the ONLY
-- name that touches the filesystem. `original_name` is what the user called the
-- file; it is display-only and is never joined into a path, which is what makes
-- a crafted name like '../../../.ssh/id_rsa' inert rather than dangerous.
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  kind          TEXT NOT NULL,        -- image | video
  stored_name   TEXT NOT NULL,        -- <sha256[0..16]>.<ext>; the on-disk name
  original_name TEXT NOT NULL,        -- display only; never a path component
  byte_size     INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket
  ON ticket_attachments(ticket_id, id);
```

- [ ] **Step 4: Add the v17 migration**

In `src/store/migrations.ts`, change line 9:

```typescript
export const SCHEMA_VERSION = 17;
```

Then insert this block immediately before the final `db.pragma(...)` line:

```typescript
  if (current < 17) {
    // v17 adds prompt attachments (images/video). Purely additive and a
    // CREATE TABLE IF NOT EXISTS, so a fresh DB (already carrying it from
    // schema.sql) skips it and a re-open is a no-op.
    //
    // Nothing is backfilled — there are no pre-v17 attachments to derive. The
    // bytes live on disk under <globalStorage>/attachments/, which a migration
    // has no business reaching into; the table indexes them, and the host owns
    // the directory's lifecycle.
    db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        stored_name   TEXT NOT NULL,
        original_name TEXT NOT NULL,
        byte_size     INTEGER NOT NULL,
        created_at    TEXT NOT NULL
      )
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket ON ticket_attachments(ticket_id, id)',
    );
  }
```

- [ ] **Step 5: Update `db.test.ts`**

In `src/store/db.test.ts`:
1. Add `'ticket_attachments',` to the end of `EXPECTED_TABLES`.
2. Change the test title on line 38 from `'creates all 12 registry tables'` to `'creates all 13 registry tables'`.
3. Replace every `user_version` expectation of `16` with `17`. Run this to find them all, then edit each:

```bash
grep -n "toBe(16)" src/store/db.test.ts
```

Do **not** change the `legacy.pragma('user_version = N')` seed values — those are the starting versions of the legacy-DB scenarios and must stay as they are. Only the `expect(...).toBe(16)` assertions become `17`.

- [ ] **Step 6: Add the cascade**

In `src/store/tickets.ts`, add `'ticket_attachments'` to `TICKET_CHILD_TABLES` (line 440):

```typescript
const TICKET_CHILD_TABLES = [
  'stages',
  'worktrees',
  'port_allocations',
  'baseline_refs',
  'servers',
  'prs',
  'ticket_attachments',
] as const;
```

- [ ] **Step 7: Write the store module**

Create `src/store/attachments.ts`:

```typescript
import type { Store } from './db.js';
import type { AttachmentKind } from '../attachments/kinds.js';

/**
 * The index of a ticket's prompt attachments. Rows only — the bytes live on disk
 * under `<globalStorage>/attachments/<ticketId>/<storedName>`.
 *
 * Driver-agnostic on purpose: the `karst context` CLI reads this table over
 * `node:sqlite`, so every statement here uses positional `?` placeholders and
 * `prepare().get/all/run` only. No named parameters, no `.pluck()`.
 */

export interface AttachmentRow {
  id: number;
  ticketId: number;
  kind: AttachmentKind;
  /** `<sha256[0..16]>.<ext>` — the on-disk filename. */
  storedName: string;
  /** What the user called it. Display only; never a path component. */
  originalName: string;
  byteSize: number;
  createdAt: string;
}

export interface AttachmentInput {
  ticketId: number;
  kind: AttachmentKind;
  storedName: string;
  originalName: string;
  byteSize: number;
}

interface AttachmentDbRow {
  id: number;
  ticket_id: number;
  kind: string;
  stored_name: string;
  original_name: string;
  byte_size: number;
  created_at: string;
}

/**
 * A stored `kind` that is not one of the two known values degrades to 'image'
 * rather than throwing. This is a read path that runs on every panel repaint and
 * every context build; one unrecognized row must not take the surface down. The
 * writer is the authority and only ever stores a validated kind, so this guards
 * the boundary, not the writer — the same rule `mergeChecks.parseFiles` follows.
 */
function toKind(raw: string): AttachmentKind {
  return raw === 'video' ? 'video' : 'image';
}

function rowToAttachment(r: AttachmentDbRow): AttachmentRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    kind: toKind(r.kind),
    storedName: r.stored_name,
    originalName: r.original_name,
    byteSize: r.byte_size,
    createdAt: r.created_at,
  };
}

const SELECT = 'SELECT * FROM ticket_attachments';

/** One ticket's attachments, oldest first (insertion order). */
export function listAttachments(store: Store, ticketId: number): AttachmentRow[] {
  const rows = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? ORDER BY id ASC`)
    .all(ticketId) as AttachmentDbRow[];
  return rows.map(rowToAttachment);
}

/** Insert one attachment and return the stored row. */
export function insertAttachment(store: Store, input: AttachmentInput): AttachmentRow {
  const createdAt = new Date().toISOString();
  const info = store.db
    .prepare(
      `INSERT INTO ticket_attachments
         (ticket_id, kind, stored_name, original_name, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.kind,
      input.storedName,
      input.originalName,
      input.byteSize,
      createdAt,
    );
  return {
    id: Number(info.lastInsertRowid),
    ticketId: input.ticketId,
    kind: input.kind,
    storedName: input.storedName,
    originalName: input.originalName,
    byteSize: input.byteSize,
    createdAt,
  };
}

/**
 * The row for `storedName` on this ticket, or null. Scoped to the ticket, not
 * global: the same bytes attached to two tickets are two files in two
 * directories, so a dedupe hit must never cross a ticket boundary.
 */
export function findAttachmentByStoredName(
  store: Store,
  ticketId: number,
  storedName: string,
): AttachmentRow | null {
  const row = store.db
    .prepare(`${SELECT} WHERE ticket_id = ? AND stored_name = ?`)
    .get(ticketId, storedName) as AttachmentDbRow | undefined;
  return row ? rowToAttachment(row) : null;
}

/** One attachment by id, or null when it does not exist. */
export function getAttachment(store: Store, id: number): AttachmentRow | null {
  const row = store.db.prepare(`${SELECT} WHERE id = ?`).get(id) as AttachmentDbRow | undefined;
  return row ? rowToAttachment(row) : null;
}

/** Delete one attachment row. The caller unlinks the file. */
export function deleteAttachment(store: Store, id: number): void {
  store.db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(id);
}
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/store/ && npm run typecheck`
Expected: PASS — `attachments.test.ts`, `db.test.ts`, and `tickets.test.ts` all green.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. If `cli/assertMigrated` tests reference a version literal, update them to 17 as well.

- [ ] **Step 10: Commit**

```bash
git add src/store/ src/attachments/
git commit -m "feat: ticket_attachments table (schema v17)

Indexes attachment bytes that live on disk; storing them as BLOBs would
put a video in every SELECT * and the agent needs a real path anyway.
kind is resolved once at ingest and stored, never re-derived from a
filename. Rows cascade with the ticket via TICKET_CHILD_TABLES."
```

---

### Task 4: Async ingest and reap

**Files:**
- Create: `src/attachments/ingest.ts`, `src/attachments/ingest.test.ts`, `src/attachments/reap.ts`, `src/attachments/reap.test.ts`

**Interfaces:**
- Consumes: `attachmentKind`, `attachmentExtension` (Task 1); `attachmentDir`, `attachmentPath` (Task 2); `AttachmentInput` (Task 3).
- Produces: `MAX_PASTE_BYTES: number`; `type IngestResult = { ok: true; input: AttachmentInput } | { ok: false; message: string }`; `ingestFile(storageDir, ticketId, sourcePath): Promise<IngestResult>`; `ingestBytes(storageDir, ticketId, originalName, bytes): Promise<IngestResult>`; `reapAttachments(storageDir, ticketId): Promise<void>`; `unlinkAttachment(storageDir, ticketId, storedName): Promise<void>`.

- [ ] **Step 1: Write the failing ingest test**

Create `src/attachments/ingest.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PASTE_BYTES, ingestFile, ingestBytes } from './ingest.js';
import { attachmentDir, attachmentPath } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshStorage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-attach-'));
  dirs.push(dir);
  return dir;
}

function sourceFile(name: string, contents: string): string {
  const dir = freshStorage();
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe('ingestBytes', () => {
  it('writes the bytes under a content-addressed name and returns the row input', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'login-error.png', Buffer.from('PNGDATA'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      ticketId: 12,
      kind: 'image',
      originalName: 'login-error.png',
      byteSize: 7,
    });
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.png$/);
    const written = attachmentPath(storage, 12, result.input.storedName);
    expect(readFileSync(written, 'utf8')).toBe('PNGDATA');
  });

  it('creates the ticket directory when it does not exist yet', async () => {
    const storage = freshStorage();
    expect(existsSync(attachmentDir(storage, 3))).toBe(false);
    const result = await ingestBytes(storage, 3, 'a.png', Buffer.from('x'));
    expect(result.ok).toBe(true);
    expect(existsSync(attachmentDir(storage, 3))).toBe(true);
  });

  it('gives identical bytes the same stored name', async () => {
    const storage = freshStorage();
    const a = await ingestBytes(storage, 12, 'one.png', Buffer.from('SAME'));
    const b = await ingestBytes(storage, 12, 'two.png', Buffer.from('SAME'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.input.storedName).toBe(b.input.storedName);
  });

  it('gives different bytes different stored names', async () => {
    const storage = freshStorage();
    const a = await ingestBytes(storage, 12, 'x.png', Buffer.from('ONE'));
    const b = await ingestBytes(storage, 12, 'x.png', Buffer.from('TWO'));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.input.storedName).not.toBe(b.input.storedName);
  });

  it('rejects a non-whitelisted type with a named reason', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'notes.pdf', Buffer.from('%PDF'));
    expect(result).toEqual({
      ok: false,
      message: 'notes.pdf is not a supported attachment (images: png, jpg, jpeg, gif, webp; video: mp4, webm, mov)',
    });
  });

  it('rejects bytes over the paste cap with a named reason', async () => {
    const storage = freshStorage();
    const tooBig = Buffer.alloc(MAX_PASTE_BYTES + 1);
    const result = await ingestBytes(storage, 12, 'huge.png', tooBig);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('too large to paste');
    expect(result.message).toContain('Attach');
  });

  it('accepts bytes exactly at the cap', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'edge.png', Buffer.alloc(MAX_PASTE_BYTES));
    expect(result.ok).toBe(true);
  });

  // The stored name comes from the hash and the whitelist, never from the user's
  // filename, so a traversal-shaped name cannot escape the ticket directory.
  it('never lets a traversal-shaped original name reach the path', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, '../../../evil.png', Buffer.from('x'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.png$/);
    expect(result.input.originalName).toBe('../../../evil.png');
    expect(existsSync(attachmentPath(storage, 12, result.input.storedName))).toBe(true);
    expect(existsSync(join(storage, '..', '..', '..', 'evil.png'))).toBe(false);
  });
});

describe('ingestFile', () => {
  it('copies the file under a content-addressed name', async () => {
    const storage = freshStorage();
    const src = sourceFile('repro.mov', 'MOVDATA');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({
      ticketId: 5,
      kind: 'video',
      originalName: 'repro.mov',
      byteSize: 7,
    });
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.mov$/);
    expect(readFileSync(attachmentPath(storage, 5, result.input.storedName), 'utf8')).toBe('MOVDATA');
  });

  it('leaves the source file in place', async () => {
    const storage = freshStorage();
    const src = sourceFile('keep.png', 'DATA');
    await ingestFile(storage, 5, src);
    expect(existsSync(src)).toBe(true);
  });

  it('rejects a non-whitelisted type with a named reason', async () => {
    const storage = freshStorage();
    const src = sourceFile('notes.pdf', '%PDF');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not a supported attachment');
  });

  // No cap here: the dialog path never moves bytes through postMessage, so a
  // large video is a file-to-file copy and is fine.
  it('accepts a file larger than the paste cap', async () => {
    const storage = freshStorage();
    const dir = freshStorage();
    const src = join(dir, 'big.mp4');
    writeFileSync(src, Buffer.alloc(MAX_PASTE_BYTES + 1024));
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
  });

  it('reports a missing source file as a reason, not a throw', async () => {
    const storage = freshStorage();
    const result = await ingestFile(storage, 5, join(storage, 'nope.png'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('could not be read');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/attachments/ingest.test.ts`
Expected: FAIL — `Failed to resolve import "./ingest.js"`.

- [ ] **Step 3: Write the ingest implementation**

Create `src/attachments/ingest.ts`:

```typescript
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { attachmentDir, attachmentPath } from './paths.js';
import {
  attachmentKind,
  attachmentExtension,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from './kinds.js';
import type { AttachmentInput } from '../store/attachments.js';

/**
 * Getting attachment bytes onto disk. Two ingress paths, one output shape:
 * the `AttachmentInput` the caller inserts into `ticket_attachments`.
 *
 * EVERY fs call here is async. This is not stylistic — a several-hundred-megabyte
 * video hashed and copied synchronously would block the extension host's event
 * loop, which the hook endpoint, every webview, and the whole UI share. Same
 * invariant that bans `spawnSync` on the gate path.
 *
 * Failure is a REASON, not a throw: the onboarding page shows it inline beside
 * the prompt and stays open, rather than the user watching an attach do nothing.
 */

/**
 * The paste path serializes bytes through `postMessage` as base64, so it needs a
 * ceiling. The dialog path copies file-to-file and has none — that is the whole
 * reason both ingress paths exist.
 */
export const MAX_PASTE_BYTES = 10 * 1024 * 1024;

export type IngestResult =
  | { ok: true; input: AttachmentInput }
  | { ok: false; message: string };

const SUPPORTED = `images: ${IMAGE_EXTENSIONS.join(', ')}; video: ${VIDEO_EXTENSIONS.join(', ')}`;

function unsupported(name: string): IngestResult {
  return { ok: false, message: `${name} is not a supported attachment (${SUPPORTED})` };
}

/** First 16 hex chars of the sha256 — the content address in the stored name. */
function shortHash(digest: string): string {
  return digest.slice(0, 16);
}

/** Hash a file by streaming it, so memory stays bounded regardless of size. */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return shortHash(hash.digest('hex'));
}

function hashBytes(bytes: Buffer): string {
  return shortHash(createHash('sha256').update(bytes).digest('hex'));
}

/**
 * Copy a file the user picked in the native dialog. `originalName` is its
 * basename — kept for display only. The stored name is `<hash>.<ext>` with the
 * extension taken from the whitelist, never from the user's string, which is
 * what makes a traversal-shaped name inert.
 */
export async function ingestFile(
  storageDir: string,
  ticketId: number,
  sourcePath: string,
): Promise<IngestResult> {
  const originalName = basename(sourcePath);
  const kind = attachmentKind(originalName);
  const ext = attachmentExtension(originalName);
  if (kind === null || ext === null) return unsupported(originalName);

  try {
    const { size } = await stat(sourcePath);
    const storedName = `${await hashFile(sourcePath)}.${ext}`;
    await mkdir(attachmentDir(storageDir, ticketId), { recursive: true });
    await copyFile(sourcePath, attachmentPath(storageDir, ticketId, storedName));
    return { ok: true, input: { ticketId, kind, storedName, originalName, byteSize: size } };
  } catch {
    // The path came from a native picker, so the interesting failures are a file
    // deleted between pick and copy, or a permission denial. Either way the user
    // needs to know the attach did not happen, not a stack trace.
    return { ok: false, message: `${originalName} could not be read` };
  }
}

/**
 * Write bytes pasted from the clipboard. The cap is enforced here as well as in
 * the webview and at the message boundary: this is the last gate before a write,
 * and argv is never trusted on the grounds that an earlier layer checked it.
 */
export async function ingestBytes(
  storageDir: string,
  ticketId: number,
  originalName: string,
  bytes: Buffer,
): Promise<IngestResult> {
  const kind = attachmentKind(originalName);
  const ext = attachmentExtension(originalName);
  if (kind === null || ext === null) return unsupported(originalName);

  if (bytes.byteLength > MAX_PASTE_BYTES) {
    const mb = Math.round(MAX_PASTE_BYTES / (1024 * 1024));
    return {
      ok: false,
      message: `${originalName} is too large to paste (limit ${mb} MB). Use Attach to add it from disk.`,
    };
  }

  try {
    const storedName = `${hashBytes(bytes)}.${ext}`;
    await mkdir(attachmentDir(storageDir, ticketId), { recursive: true });
    await writeFile(attachmentPath(storageDir, ticketId, storedName), bytes);
    return {
      ok: true,
      input: { ticketId, kind, storedName, originalName, byteSize: bytes.byteLength },
    };
  } catch {
    return { ok: false, message: `${originalName} could not be saved` };
  }
}
```

- [ ] **Step 4: Run the ingest test**

Run: `npx vitest run src/attachments/ingest.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Write the failing reap test**

Create `src/attachments/reap.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapAttachments, unlinkAttachment } from './reap.js';
import { attachmentDir, attachmentPath } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storageWithFile(ticketId: number, storedName: string): string {
  const storage = mkdtempSync(join(tmpdir(), 'karst-reap-'));
  dirs.push(storage);
  mkdirSync(attachmentDir(storage, ticketId), { recursive: true });
  writeFileSync(attachmentPath(storage, ticketId, storedName), 'DATA');
  return storage;
}

describe('reapAttachments', () => {
  it('removes the ticket directory and everything in it', async () => {
    const storage = storageWithFile(12, 'a.png');
    await reapAttachments(storage, 12);
    expect(existsSync(attachmentDir(storage, 12))).toBe(false);
  });

  it('leaves other tickets\' directories alone', async () => {
    const storage = storageWithFile(12, 'a.png');
    mkdirSync(attachmentDir(storage, 13), { recursive: true });
    await reapAttachments(storage, 12);
    expect(existsSync(attachmentDir(storage, 13))).toBe(true);
  });

  // Ticket delete calls this unconditionally; a ticket that never had an
  // attachment has no directory, and that is a normal state, not a fault.
  it('is a no-op when the directory does not exist', async () => {
    const storage = mkdtempSync(join(tmpdir(), 'karst-reap-'));
    dirs.push(storage);
    await expect(reapAttachments(storage, 99)).resolves.toBeUndefined();
  });
});

describe('unlinkAttachment', () => {
  it('removes one stored file', async () => {
    const storage = storageWithFile(12, 'a.png');
    await unlinkAttachment(storage, 12, 'a.png');
    expect(existsSync(attachmentPath(storage, 12, 'a.png'))).toBe(false);
    expect(existsSync(attachmentDir(storage, 12))).toBe(true);
  });

  it('is a no-op when the file is already gone', async () => {
    const storage = storageWithFile(12, 'a.png');
    await expect(unlinkAttachment(storage, 12, 'missing.png')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/attachments/reap.test.ts`
Expected: FAIL — `Failed to resolve import "./reap.js"`.

- [ ] **Step 7: Write the reap implementation**

Create `src/attachments/reap.ts`:

```typescript
import { rm } from 'node:fs/promises';
import { attachmentDir, attachmentPath } from './paths.js';

/**
 * Removing attachment bytes. Split from `ingest.ts` because the callers are
 * different lifecycles — ticket delete and detach — and neither needs the
 * hashing machinery.
 *
 * Both are `force: true`, so an already-absent path is a no-op rather than a
 * throw. A ticket that never carried an attachment has no directory at all, and
 * that is a normal state: ticket delete calls this unconditionally.
 *
 * Async for the same reason ingest is: this runs in the extension host, and a
 * recursive remove of a directory of videos must not hold the event loop.
 */

/** Remove one ticket's entire attachment directory. Called on ticket delete. */
export async function reapAttachments(storageDir: string, ticketId: number): Promise<void> {
  await rm(attachmentDir(storageDir, ticketId), { recursive: true, force: true });
}

/**
 * Remove one stored file, leaving the ticket's directory in place. The caller
 * must first confirm no other row references the same content-addressed name —
 * identical bytes attached twice share one file.
 */
export async function unlinkAttachment(
  storageDir: string,
  ticketId: number,
  storedName: string,
): Promise<void> {
  await rm(attachmentPath(storageDir, ticketId, storedName), { force: true });
}
```

- [ ] **Step 8: Run both tests**

Run: `npx vitest run src/attachments/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/attachments/
git commit -m "feat: async attachment ingest and reap

Every fs call is async: hashing and copying a large video synchronously
would block the extension host event loop that the hook endpoint and
every webview share.

The stored name is <sha256[0..16]>.<ext> with the extension taken from
the whitelist, never from the user's string, so a traversal-shaped
filename is inert. Failure is a reason, not a throw, so the page can show
it inline and stay open."
```

---

### Task 5: Attachments in the ticket context

**Files:**
- Modify: `src/context/ticketContext.ts`, `src/context/ticketContext.test.ts`, `src/cli/context.ts:72`, `src/extension.ts:1751`
- Test: `src/context/ticketContext.test.ts`

**Interfaces:**
- Consumes: `listAttachments`, `AttachmentRow` (Task 3); `attachmentPath` (Task 2).
- Produces: `interface TicketContextAttachment { kind: AttachmentKind; path: string; name: string }`; `TicketContext.attachments: TicketContextAttachment[]`; `buildTicketContext(store, manifest, ticketId, storageDir?)`.

- [ ] **Step 1: Write the failing test**

Append to `src/context/ticketContext.test.ts` (adapt the store/ticket setup helpers to the ones already in that file):

```typescript
describe('attachments', () => {
  it('omits the section when the ticket has none', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    const ctx = buildTicketContext(store, undefined, ticketId, '/storage');
    expect(ctx.attachments).toEqual([]);
    expect(renderTicketContext(ctx)).not.toContain('## Attachments');
  });

  it('renders each attachment with its kind, absolute path, and original name', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'a3f9e1b2c3d4e5f6.png',
      originalName: 'login-error.png', byteSize: 10,
    });
    const ctx = buildTicketContext(store, undefined, ticketId, '/storage');
    expect(ctx.attachments).toEqual([
      {
        kind: 'image',
        path: join('/storage', 'attachments', String(ticketId), 'a3f9e1b2c3d4e5f6.png'),
        name: 'login-error.png',
      },
    ]);
    const md = renderTicketContext(ctx);
    expect(md).toContain('## Attachments');
    expect(md).toContain(
      `- image: ${join('/storage', 'attachments', String(ticketId), 'a3f9e1b2c3d4e5f6.png')} — "login-error.png"`,
    );
  });

  // Without this marker an agent reports on a video it never opened. Same rule
  // as nonRunnable repos: state the fact, never leave it to be inferred.
  it('marks a video as not agent-readable', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'video', storedName: 'b1c4d2e3f4a5b6c7.mp4',
      originalName: 'repro.mov', byteSize: 20,
    });
    const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
    expect(md).toContain('- video: ');
    expect(md).toContain('— "repro.mov" (not agent-readable)');
  });

  it('does not mark an image as not agent-readable', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'aaaa.png', originalName: 'a.png', byteSize: 1,
    });
    const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
    expect(md).not.toContain('not agent-readable');
  });

  // No storage root means no absolute path can be formed. Emitting a relative or
  // half-built path would hand the agent something it cannot open and cannot
  // tell is broken, so the section is omitted instead.
  it('omits attachments entirely when no storage dir is supplied', () => {
    const store = freshStore();
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'aaaa.png', originalName: 'a.png', byteSize: 1,
    });
    const ctx = buildTicketContext(store, undefined, ticketId);
    expect(ctx.attachments).toEqual([]);
    expect(renderTicketContext(ctx)).not.toContain('## Attachments');
  });
});
```

Add the imports this block needs at the top of the file: `import { join } from 'node:path';` and `import { insertAttachment } from '../store/attachments.js';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: FAIL — `ctx.attachments` is undefined.

- [ ] **Step 3: Add the type and the build step**

In `src/context/ticketContext.ts`, add these imports:

```typescript
import { join } from 'node:path';
import { listAttachments } from '../store/attachments.js';
import type { AttachmentKind } from '../attachments/kinds.js';
import { attachmentPath } from '../attachments/paths.js';
```

Add the interface next to `TicketContextPr`:

```typescript
/**
 * One image or video attached to the ticket's prompt, as the agent sees it.
 *
 * `path` is absolute — the agent opens it directly, so a relative path would be
 * resolved against whatever cwd the session happens to have. `name` is what the
 * user called the file, which is frequently the only clue what a screenshot
 * shows; the stored name is a hash and says nothing.
 */
export interface TicketContextAttachment {
  kind: AttachmentKind;
  path: string;
  name: string;
}
```

Add the field to the `TicketContext` interface, beside `prs`:

```typescript
  /** Images and video attached to the prompt. Empty when there are none. */
  attachments: TicketContextAttachment[];
```

Change the `buildTicketContext` signature (line 105) and add the mapping to its returned object:

```typescript
export function buildTicketContext(
  store: Store,
  manifest: Manifest | undefined,
  ticketId: number,
  /**
   * The global-storage root attachment paths are built from. Optional because
   * an absolute path cannot be formed without it: with no root, `attachments`
   * is empty and the section is omitted, rather than emitting a half-built path
   * the agent would fail to open with no way to tell why. Both real callers
   * supply it — the extension from `globalStorageUri`, the CLI from the DB
   * file's own directory.
   */
  storageDir?: string,
): TicketContext {
```

In the returned object, beside `prs`, add:

```typescript
    attachments:
      storageDir === undefined
        ? []
        : listAttachments(store, ticketId).map((a) => ({
            kind: a.kind,
            path: attachmentPath(storageDir, ticketId, a.storedName),
            name: a.originalName,
          })),
```

- [ ] **Step 4: Add the render section**

In `renderTicketContext`, insert this block immediately after the `## Context brief` block (attachments belong with the prompt they were attached to, ahead of the repo/worktree machinery):

```typescript
  if (ctx.attachments.length > 0) {
    const rows = ctx.attachments.map((a) => {
      // Video is stated as unreadable rather than omitted. Omitting it would let
      // an agent conclude nothing was attached; listing it bare would let one
      // report on footage it never opened.
      const note = a.kind === 'video' ? ' (not agent-readable)' : '';
      return `- ${a.kind}: ${a.path} — "${a.name}"${note}`;
    });
    parts.push(`## Attachments\n${rows.join('\n')}`);
  }
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/context/ticketContext.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Wire the CLI caller**

`runContextCommand(store, manifest, parsed)` has no DB path in scope, so thread one in. In `src/cli/context.ts`:

```typescript
export function runContextCommand(
  store: Store,
  manifest: Manifest | undefined,
  parsed: ParsedContext,
  /**
   * The registry file's own path. Its directory IS the global-storage root that
   * attachments are rooted in, and the CLI is never told that root directly — it
   * only ever receives `--db`. Optional so the existing call shape in tests keeps
   * compiling; `main.ts` always supplies it.
   */
  dbPath?: string,
): string {
  const ticket = resolveTicketByKey(store, parsed.key, manifest?.id);
  if (!ticket) {
    throw new Error(`no ticket found for key '${parsed.key}'`);
  }
  const storageDir = dbPath === undefined ? undefined : dirname(dbPath);
  const ctx = buildTicketContext(store, manifest, ticket.id, storageDir);
  return parsed.format === 'md' ? renderTicketContext(ctx) : JSON.stringify(ctx, null, 2);
}
```

with `import { dirname } from 'node:path';` at the top.

In `src/cli/main.ts:115`, pass it:

```typescript
      return runContextCommand(store, manifest, parsed, db);
```

Add this test to `src/cli/context.test.ts` (reuse that file's existing store/ticket helpers):

```typescript
it('renders attachments with paths rooted beside the registry file', () => {
  const store = freshStore();
  const ticketId = createTicket(store, { key: 'K-1', title: 'has media' }).id;
  insertAttachment(store, {
    ticketId, kind: 'image', storedName: 'aaaa1111bbbb2222.png',
    originalName: 'shot.png', byteSize: 12,
  });
  const md = runContextCommand(
    store, undefined, { key: 'K-1', format: 'md' }, '/storage/karst.db',
  );
  expect(md).toContain('## Attachments');
  expect(md).toContain(
    join('/storage', 'attachments', String(ticketId), 'aaaa1111bbbb2222.png'),
  );
});

it('omits attachments when no db path is supplied', () => {
  const store = freshStore();
  const ticketId = createTicket(store, { key: 'K-2', title: 'has media' }).id;
  insertAttachment(store, {
    ticketId, kind: 'image', storedName: 'aaaa.png', originalName: 'a.png', byteSize: 1,
  });
  expect(runContextCommand(store, undefined, { key: 'K-2', format: 'md' }))
    .not.toContain('## Attachments');
});
```

- [ ] **Step 7: Wire the extension caller**

In `src/extension.ts:1751`:

```typescript
        buildTicketContext(localStore, currentManifest(), ticketId, context.globalStorageUri.fsPath),
```

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/context/ src/cli/ src/extension.ts
git commit -m "feat: emit prompt attachments into the ticket context

One renderer, so the launch seed and the karst context CLI both get the
section with no second code path. Video is listed and marked
not-agent-readable: omitting it lets an agent conclude nothing was
attached, listing it bare lets one report on footage it never opened."
```

---

### Task 6: CSP media source

**Files:**
- Modify: `src/model/csp.ts`, `src/ui/webviewCsp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `injectCsp(html: string, nonce: string, mediaSource?: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/webviewCsp.test.ts`:

```typescript
describe('media source', () => {
  const SOURCE = 'vscode-resource://karst';

  it('omits img-src and media-src when no media source is given', () => {
    const html = injectCsp(read('onboarding'), newNonce());
    expect(html).not.toContain('img-src');
    expect(html).not.toContain('media-src');
  });

  it('grants img-src and media-src to exactly the given source', () => {
    const html = injectCsp(read('onboarding'), newNonce(), SOURCE);
    expect(html).toContain(`img-src ${SOURCE};`);
    expect(html).toContain(`media-src ${SOURCE};`);
  });

  // Widening for attachments must not weaken anything else. default-src stays
  // 'none' and script-src stays nonce-only — an img-src grant is not a reason to
  // let a script in.
  it('leaves the rest of the policy untouched when widened', () => {
    const nonce = newNonce();
    const html = injectCsp(read('onboarding'), nonce, SOURCE);
    expect(html).toContain("default-src 'none';");
    expect(html).toContain(`script-src 'nonce-${nonce}';`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toContain("default-src 'self'");
  });

  it('never widens a webview that was not given a source', () => {
    for (const name of WEBVIEWS) {
      const html = injectCsp(read(name), newNonce());
      expect(html, name).not.toContain('img-src');
      expect(html, name).not.toContain('media-src');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/webviewCsp.test.ts`
Expected: FAIL — `injectCsp` takes 2 arguments; `img-src` never appears.

- [ ] **Step 3: Write the implementation**

In `src/model/csp.ts`, replace `POLICY` and `injectCsp`, and correct the module docblock — its claim that nothing legitimately loads from anywhere stops being true:

```typescript
const POLICY = (nonce: string, mediaSource?: string): string => {
  const parts = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ];
  if (mediaSource) {
    parts.push(`img-src ${mediaSource}`, `media-src ${mediaSource}`);
  }
  return `${parts.join('; ')};`;
};
```

```typescript
export function injectCsp(html: string, nonce: string, mediaSource?: string): string {
  if (!html.includes(CSP_MARKER)) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY(nonce, mediaSource)}" />`;
  return html.replace(CSP_MARKER, meta).replaceAll('<script>', `<script nonce="${nonce}">`);
}
```

Replace the second paragraph of the module docblock with:

```
 * The policy is as tight as it is because a webview is otherwise entirely
 * self-contained: no `<link>`, no `url()`, no `@font-face`, no `fetch()`. One
 * exception exists — the onboarding page renders prompt attachments off disk, so
 * it alone is handed a `mediaSource` (the panel's `webview.cspSource`) and gets
 * `img-src`/`media-src` for it. Every other webview passes no source and keeps
 * `default-src 'none'` covering everything, because nothing they load comes from
 * anywhere. The grant is per-panel for that reason: a widened policy applied
 * globally would loosen five documents to buy nothing.
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/ui/webviewCsp.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/csp.ts src/ui/webviewCsp.test.ts
git commit -m "feat: optional img-src/media-src grant in the webview CSP

Per-panel, not global: only onboarding renders attachments off disk, and
widening the other five documents would buy nothing. default-src stays
'none' and script-src stays nonce-only in both shapes."
```

---

### Task 7: Attachments on the onboarding state and the `toWebviewUri` seam

**Files:**
- Modify: `src/ui/onboarding/state.ts`, `src/ui/onboarding/state.test.ts`, `src/ui/onboarding/panel.ts`, `src/ui/onboarding/panel.test.ts`

**Interfaces:**
- Consumes: `listAttachments` (Task 3), `attachmentPath` (Task 2), `AttachmentKind` (Task 1).
- Produces: `interface AttachmentView { id: number; kind: AttachmentKind; name: string; byteSize: number; src: string }`; `OnboardingState.attachments: AttachmentView[]`; `buildOnboardingState(..., storageDir?: string)`; `OnboardingPanel.toWebviewUri(path: string): string`.

- [ ] **Step 1: Write the failing state test**

Append to `src/ui/onboarding/state.test.ts` (reuse the file's existing store/manifest helpers):

```typescript
describe('attachments', () => {
  it('is empty in create mode', () => {
    const state = buildOnboardingState(store, manifest, () => [], () => []);
    expect(state.attachments).toEqual([]);
  });

  it('carries each attachment with an absolute src path in edit mode', () => {
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'aaaa1111bbbb2222.png',
      originalName: 'login-error.png', byteSize: 4096,
    });
    const state = buildOnboardingState(
      store, manifest, () => [], () => [], ticketId, () => false, undefined, '/storage',
    );
    expect(state.attachments).toEqual([
      {
        id: expect.any(Number),
        kind: 'image',
        name: 'login-error.png',
        byteSize: 4096,
        src: join('/storage', 'attachments', String(ticketId), 'aaaa1111bbbb2222.png'),
      },
    ]);
  });

  // The src is a filesystem path here. Only the panel can mint a webview URI, so
  // this stays host-agnostic and the mapping happens at postMessage time.
  it('is empty when no storage dir is supplied', () => {
    const ticketId = seedTicket(store);
    insertAttachment(store, {
      ticketId, kind: 'image', storedName: 'aaaa.png', originalName: 'a.png', byteSize: 1,
    });
    const state = buildOnboardingState(store, manifest, () => [], () => [], ticketId);
    expect(state.attachments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/onboarding/state.test.ts`
Expected: FAIL — `state.attachments` is undefined.

- [ ] **Step 3: Implement the state field**

In `src/ui/onboarding/state.ts` add imports:

```typescript
import { listAttachments } from '../../store/attachments.js';
import { attachmentPath } from '../../attachments/paths.js';
import type { AttachmentKind } from '../../attachments/kinds.js';
```

Add the interface above `OnboardingState`:

```typescript
/**
 * One attachment as the prompt strip renders it.
 *
 * `src` leaves this module as an absolute FILESYSTEM path, not a webview URI —
 * only a real `vscode.Webview` can mint one of those, and this module is
 * host-agnostic. The panel manager maps it at postMessage time via
 * `OnboardingPanel.toWebviewUri`. `id` is what the detach/open messages carry;
 * the stored name never crosses to the webview, because nothing there needs it.
 */
export interface AttachmentView {
  id: number;
  kind: AttachmentKind;
  /** The user's filename — often the only clue what a screenshot shows. */
  name: string;
  byteSize: number;
  src: string;
}
```

Add to the `OnboardingState` interface, after `stepper`:

```typescript
  /** Prompt attachments, oldest first. Empty in create mode (no ticket yet). */
  attachments: AttachmentView[];
```

Add a `storageDir` parameter to `buildOnboardingState`, after `modelCatalog`:

```typescript
  /**
   * Global-storage root for attachment paths. Optional for the same reason
   * `buildTicketContext`'s is: with no root there is no absolute path to build,
   * so the strip renders nothing rather than a broken tile.
   */
  storageDir?: string,
```

Add `attachments: [],` to the create-mode return object, and to the edit-mode return object:

```typescript
    attachments:
      storageDir === undefined
        ? []
        : listAttachments(store, ticketId).map((a) => ({
            id: a.id,
            kind: a.kind,
            name: a.originalName,
            byteSize: a.byteSize,
            src: attachmentPath(storageDir, ticketId, a.storedName),
          })),
```

- [ ] **Step 4: Run the state test**

Run: `npx vitest run src/ui/onboarding/state.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Write the failing panel test**

Two edits to `src/ui/onboarding/panel.test.ts`. First, add the method to the `FakePanel` literal inside `fakeHost()`, beside `setIcon`:

```typescript
        toWebviewUri: (p: string) => `webview://${p}`,
```

Then append:

```typescript
describe('attachment uri mapping', () => {
  /**
   * Open a panel through the manager and return the attachments on the first
   * `{type:'state'}` message the fake panel received. `stateFor` seeds the state
   * builder so the manager has something with a filesystem path to map.
   */
  function postedAttachments(attachments: AttachmentView[]): AttachmentView[] {
    const { host, panels } = fakeHost();
    const manager = makeManager(host, {
      buildState: (): OnboardingState => ({ ...blankCreateState(), attachments }),
    });
    manager.open();
    const state = panels[0]!.posted.find(
      (m): m is { type: 'state'; state: OnboardingState } =>
        (m as { type?: string }).type === 'state',
    );
    return state!.state.attachments;
  }

  it('maps every attachment src through the panel before posting state', () => {
    expect(
      postedAttachments([
        { id: 1, kind: 'image', name: 'a.png', byteSize: 4, src: '/storage/attachments/7/aaaa.png' },
        { id: 2, kind: 'video', name: 'b.mov', byteSize: 8, src: '/storage/attachments/7/bbbb.mp4' },
      ]),
    ).toEqual([
      { id: 1, kind: 'image', name: 'a.png', byteSize: 4, src: 'webview:///storage/attachments/7/aaaa.png' },
      { id: 2, kind: 'video', name: 'b.mov', byteSize: 8, src: 'webview:///storage/attachments/7/bbbb.mp4' },
    ]);
  });

  it('posts an empty list unchanged', () => {
    expect(postedAttachments([])).toEqual([]);
  });
});
```

Adapt `makeManager`, `blankCreateState`, and `manager.open()` to whatever the file already calls them — this suite already opens panels through the manager, so reuse that existing setup rather than adding a second one. If the manager takes its state from a real `buildOnboardingState` rather than an injectable, seed a store with `insertAttachment` and pass a `storageDir` instead of stubbing.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/ui/onboarding/panel.test.ts`
Expected: FAIL — `toWebviewUri` is not on the interface / src is unmapped.

- [ ] **Step 7: Add the seam and the mapping**

In `src/ui/onboarding/panel.ts`, add to the `OnboardingPanel` interface:

```typescript
  /**
   * Convert an absolute filesystem path into a URI this webview may load.
   *
   * Required because only a real `vscode.Webview` can mint one (`asWebviewUri`),
   * while `state.ts` — which produces the paths — is host-agnostic and imports no
   * `vscode`. Same shape as `setIcon(path)`: the manager hands over a path, the
   * adapter knows what to do with it. Test fakes return the path unchanged.
   */
  toWebviewUri(path: string): string;
```

Find where the manager posts state (`postMessage({ type: 'state', state })`) and map first:

```typescript
  // The state builder emits filesystem paths; only the panel can turn one into a
  // URI the webview is allowed to load. Mapped here, at the last moment before
  // the message leaves, so everything upstream stays host-agnostic.
  const withWebviewUris = (state: OnboardingState): OnboardingState => ({
    ...state,
    attachments: state.attachments.map((a) => ({ ...a, src: panel.toWebviewUri(a.src) })),
  });
```

Use `panel.postMessage({ type: 'state', state: withWebviewUris(state) })` at every state push.

- [ ] **Step 8: Update every existing fake panel**

Run this to find them, and add `toWebviewUri: (p: string) => p,` to each object literal that implements `OnboardingPanel`:

```bash
grep -rn "setIcon:" src/ui/onboarding/ src/extension
```

- [ ] **Step 9: Run the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ui/onboarding/state.ts src/ui/onboarding/state.test.ts src/ui/onboarding/panel.ts src/ui/onboarding/panel.test.ts
git commit -m "feat: attachments on onboarding state via a toWebviewUri seam

state.ts emits filesystem paths and stays host-agnostic; only a real
vscode.Webview can mint a loadable URI, so the panel maps them at
postMessage time. Same shape as the existing setIcon(path) seam."
```

---

### Task 8: Attachment messages at the trust boundary

**Files:**
- Modify: `src/ui/onboarding/messages.ts`, `src/ui/onboarding/messages.test.ts`

**Interfaces:**
- Consumes: `MAX_PASTE_BYTES` (Task 4).
- Produces: four `OnboardingMessage` variants — `{type:'attach-pick'}`, `{type:'attach-bytes'; name: string; base64: string}`, `{type:'detach-attachment'; id: number}`, `{type:'open-attachment'; id: number}` — and the matching `OnboardingActions` methods `attachPick()`, `attachBytes(name, base64)`, `detachAttachment(id)`, `openAttachment(id)`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/onboarding/messages.test.ts` (reuse the file's existing `routeOnboardingAction` + spy-actions helper):

```typescript
describe('attachment messages', () => {
  it('routes attach-pick', () => {
    const { actions, calls } = spyActions();
    routeOnboardingAction({ type: 'attach-pick' }, actions);
    expect(calls).toContainEqual(['attachPick']);
  });

  it('routes a well-formed attach-bytes', () => {
    const { actions, calls } = spyActions();
    routeOnboardingAction(
      { type: 'attach-bytes', name: 'shot.png', base64: 'AAAA' }, actions,
    );
    expect(calls).toContainEqual(['attachBytes', 'shot.png', 'AAAA']);
  });

  it('ignores attach-bytes with a non-string name or payload', () => {
    const { actions, calls } = spyActions();
    routeOnboardingAction({ type: 'attach-bytes', name: 1, base64: 'AAAA' }, actions);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png', base64: null }, actions);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png' }, actions);
    expect(calls).toEqual([]);
  });

  it('ignores attach-bytes with an empty name', () => {
    const { actions, calls } = spyActions();
    routeOnboardingAction({ type: 'attach-bytes', name: '', base64: 'AAAA' }, actions);
    expect(calls).toEqual([]);
  });

  // The webview caps this too. Re-checked here because argv from a webview is
  // never trusted on the grounds that the webview already checked it — the same
  // rule the CLI's stage/phase split exists for.
  it('ignores attach-bytes whose payload exceeds the paste cap', () => {
    const { actions, calls } = spyActions();
    // 4 base64 chars per 3 bytes, so this decodes to just over the cap.
    const oversize = 'A'.repeat(Math.ceil((MAX_PASTE_BYTES + 1024) / 3) * 4);
    routeOnboardingAction({ type: 'attach-bytes', name: 'a.png', base64: oversize }, actions);
    expect(calls).toEqual([]);
  });

  it('routes detach-attachment and open-attachment with a numeric id', () => {
    const { actions, calls } = spyActions();
    routeOnboardingAction({ type: 'detach-attachment', id: 7 }, actions);
    routeOnboardingAction({ type: 'open-attachment', id: 7 }, actions);
    expect(calls).toContainEqual(['detachAttachment', 7]);
    expect(calls).toContainEqual(['openAttachment', 7]);
  });

  it('ignores a detach/open whose id is not a positive integer', () => {
    const { actions, calls } = spyActions();
    for (const id of ['7', 0, -1, 1.5, NaN, null, undefined]) {
      routeOnboardingAction({ type: 'detach-attachment', id }, actions);
      routeOnboardingAction({ type: 'open-attachment', id }, actions);
    }
    expect(calls).toEqual([]);
  });
});
```

Add `import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';` to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/onboarding/messages.test.ts`
Expected: FAIL — the new actions do not exist.

- [ ] **Step 3: Fix the pre-existing fall-through**

`routeOnboardingAction`'s `case 'set-provider':` is missing its `return`, so setting a provider also calls `setType` with the provider's id. Add the `return`:

```typescript
    case 'set-provider':
      actions.setProvider(msg.id);
      return;
```

- [ ] **Step 4: Add the message variants**

In `src/ui/onboarding/messages.ts`, add to `OnboardingMessage`:

```typescript
  // Open the native file picker. Carries nothing — the host owns the dialog, so
  // a crafted message can neither choose a path nor pre-fill one.
  | { type: 'attach-pick' }
  // Bytes pasted from the clipboard, base64-encoded (postMessage is JSON, so a
  // Buffer cannot cross it). Capped at both ends; see the parse guard.
  | { type: 'attach-bytes'; name: string; base64: string }
  | { type: 'detach-attachment'; id: number }
  | { type: 'open-attachment'; id: number }
```

Add to `OnboardingActions`:

```typescript
  attachPick: () => void;
  attachBytes: (name: string, base64: string) => void;
  detachAttachment: (id: number) => void;
  openAttachment: (id: number) => void;
```

Add the import and helper:

```typescript
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';

/**
 * A positive integer row id. `typeof x === 'number'` is not enough: `1.5`, `NaN`
 * and `-1` all pass it and none is a row this store can hold.
 */
function isRowId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Base64 expands 3 bytes to 4 characters, so a payload longer than this cannot
 * decode to something under the cap. Checking the ENCODED length means an
 * oversize paste is rejected before anything decodes it — the decode itself is
 * the allocation worth avoiding.
 */
const MAX_BASE64_CHARS = Math.ceil(MAX_PASTE_BYTES / 3) * 4;
```

Add the parse cases beside `case 'analyze':`:

```typescript
    case 'attach-pick':
      return { type: 'attach-pick' };
    case 'attach-bytes': {
      // The name drives the whitelist check and the stored extension; the
      // payload is capped here as well as in the webview, because a webview
      // having checked something is not a reason for the host to skip it.
      if (typeof m.name !== 'string' || m.name.length === 0) return null;
      if (typeof m.base64 !== 'string' || m.base64.length === 0) return null;
      if (m.base64.length > MAX_BASE64_CHARS) return null;
      return { type: 'attach-bytes', name: m.name, base64: m.base64 };
    }
    case 'detach-attachment':
      return isRowId(m.id) ? { type: 'detach-attachment', id: m.id } : null;
    case 'open-attachment':
      return isRowId(m.id) ? { type: 'open-attachment', id: m.id } : null;
```

Add the route cases:

```typescript
    case 'attach-pick':
      actions.attachPick();
      return;
    case 'attach-bytes':
      actions.attachBytes(msg.name, msg.base64);
      return;
    case 'detach-attachment':
      actions.detachAttachment(msg.id);
      return;
    case 'open-attachment':
      actions.openAttachment(msg.id);
      return;
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/ui/onboarding/messages.test.ts && npm run typecheck`
Expected: PASS. Typecheck will now fail in `actions.ts` (the four methods are missing) — that is Task 9. If the repo's typecheck must stay green per-commit, do Steps 1–5 of Task 9 before committing this task.

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/messages.ts src/ui/onboarding/messages.test.ts
git commit -m "feat: attachment messages at the onboarding trust boundary

attach-pick carries nothing, so a crafted message can neither choose a
path nor pre-fill one. attach-bytes is capped on the ENCODED length, so
an oversize paste is rejected before it is decoded.

Also fixes a missing return on set-provider, which was falling through
into set-type and setting a ticket's type to a provider id."
```

---

### Task 9: The attachment actions

**Files:**
- Modify: `src/ui/onboarding/actions.ts`, `src/ui/onboarding/actions.test.ts`

**Interfaces:**
- Consumes: `ingestFile`, `ingestBytes` (Task 4); `unlinkAttachment` (Task 4); `listAttachments`, `insertAttachment`, `getAttachment`, `deleteAttachment`, `findAttachmentByStoredName` (Task 3); `attachmentPath` (Task 2); `createTicketFlow`, `ctx.bindTicket` (existing).
- Produces: implementations of `attachPick`, `attachBytes`, `detachAttachment`, `openAttachment`; new `OnboardingActionsDeps` fields `storageDir: string`, `pickAttachment: () => Promise<string[]>`, `openFile: (path: string) => void`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/onboarding/actions.test.ts` (reuse the file's existing deps/ctx builders; add `storageDir`, `pickAttachment`, and `openFile` to them):

```typescript
describe('attachments', () => {
  it('persists a draft ticket on the first attach in create mode', async () => {
    const { actions, ctx, deps } = makeActions({ mode: 'create' });
    deps.pickAttachment = async () => [sourceImage('shot.png')];
    await actions.attachPick();
    expect(ctx.boundTicketId).toBeGreaterThan(0);
    expect(listAttachments(deps.store, ctx.boundTicketId!)).toHaveLength(1);
  });

  it('does not create a second draft on the next attach', async () => {
    const { actions, ctx, deps } = makeActions({ mode: 'create' });
    deps.pickAttachment = async () => [sourceImage('one.png')];
    await actions.attachPick();
    const first = ctx.boundTicketId;
    deps.pickAttachment = async () => [sourceImage('two.png')];
    await actions.attachPick();
    expect(ctx.boundTicketId).toBe(first);
    expect(listAttachments(deps.store, first!)).toHaveLength(2);
  });

  it('does nothing when the picker is cancelled', async () => {
    const { actions, ctx, deps } = makeActions({ mode: 'create' });
    deps.pickAttachment = async () => [];
    await actions.attachPick();
    expect(ctx.boundTicketId).toBeUndefined();
    expect(ctx.posted.filter((m) => m.type === 'error')).toEqual([]);
  });

  it('ingests every file the picker returns', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    deps.pickAttachment = async () => [sourceImage('a.png'), sourceImage('b.png')];
    await actions.attachPick();
    expect(listAttachments(deps.store, ticketId!)).toHaveLength(2);
  });

  it('reports an unsupported file as an inline error and attaches nothing', async () => {
    const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
    deps.pickAttachment = async () => [sourceFile('notes.pdf', '%PDF')];
    await actions.attachPick();
    expect(listAttachments(deps.store, ticketId!)).toEqual([]);
    expect(ctx.posted).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('not a supported attachment') }),
    );
  });

  it('stores pasted bytes and pushes fresh state', async () => {
    const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
    await actions.attachBytes('shot.png', Buffer.from('PNGDATA').toString('base64'));
    const rows = listAttachments(deps.store, ticketId!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.originalName).toBe('shot.png');
    expect(ctx.statePushes).toBeGreaterThan(0);
  });

  it('rejects invalid base64 as an inline error, not a throw', async () => {
    const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
    await actions.attachBytes('shot.png', '!!!not-base64!!!');
    expect(listAttachments(deps.store, ticketId!)).toEqual([]);
    expect(ctx.posted).toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  // Identical bytes are one file, so a second attach must not add a second tile
  // pointing at it — and must certainly not leave a row whose file a later
  // detach would unlink out from under the first.
  it('does not add a second row for identical bytes', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    const b64 = Buffer.from('SAME').toString('base64');
    await actions.attachBytes('one.png', b64);
    await actions.attachBytes('two.png', b64);
    expect(listAttachments(deps.store, ticketId!)).toHaveLength(1);
  });

  it('detaches an attachment and unlinks its file', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
    const row = listAttachments(deps.store, ticketId!)[0]!;
    const path = attachmentPath(deps.storageDir, ticketId!, row.storedName);
    expect(existsSync(path)).toBe(true);
    await actions.detachAttachment(row.id);
    expect(listAttachments(deps.store, ticketId!)).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('ignores a detach for an unknown id', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    await expect(actions.detachAttachment(9999)).resolves.toBeUndefined();
    expect(listAttachments(deps.store, ticketId!)).toEqual([]);
  });

  // An id belonging to another ticket must not let this panel delete its file.
  it('ignores a detach for an attachment on another ticket', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    const other = createTicket(deps.store, { key: 'OTHER-1', title: 'other' }).id;
    const foreign = insertAttachment(deps.store, {
      ticketId: other, kind: 'image', storedName: 'x.png', originalName: 'x.png', byteSize: 1,
    });
    await actions.detachAttachment(foreign.id);
    expect(getAttachment(deps.store, foreign.id)).not.toBeNull();
    expect(ticketId).not.toBe(other);
  });

  it('opens an attachment by its absolute path', async () => {
    const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
    const opened: string[] = [];
    deps.openFile = (p: string) => opened.push(p);
    await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
    const row = listAttachments(deps.store, ticketId!)[0]!;
    await actions.openAttachment(row.id);
    expect(opened).toEqual([attachmentPath(deps.storageDir, ticketId!, row.storedName)]);
  });

  it('does not open an attachment belonging to another ticket', async () => {
    const { actions, deps } = makeActions({ mode: 'edit' });
    const opened: string[] = [];
    deps.openFile = (p: string) => opened.push(p);
    const other = createTicket(deps.store, { key: 'OTHER-2', title: 'other' }).id;
    const foreign = insertAttachment(deps.store, {
      ticketId: other, kind: 'image', storedName: 'x.png', originalName: 'x.png', byteSize: 1,
    });
    await actions.openAttachment(foreign.id);
    expect(opened).toEqual([]);
  });
});
```

Add local helpers `sourceImage(name)` and `sourceFile(name, contents)` to the test file that write into a tmpdir (same pattern as `ingest.test.ts`) and return the path, plus the tmpdir cleanup in `afterEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/onboarding/actions.test.ts`
Expected: FAIL — `actions.attachPick is not a function`.

- [ ] **Step 3: Add the deps**

In `src/ui/onboarding/actions.ts`, add to `OnboardingActionsDeps`:

```typescript
  /**
   * Global-storage root that attachment bytes are written under. Injected rather
   * than derived so this module stays free of `vscode` and testable against a
   * tmpdir.
   */
  storageDir: string;
  /**
   * Show the native file picker and resolve the chosen absolute paths (empty on
   * cancel). Injected because it needs `vscode.window.showOpenDialog`. The HOST
   * owns the dialog: the webview only asks for one, so a crafted message can
   * neither choose a path nor pre-fill one.
   */
  pickAttachment: () => Promise<string[]>;
  /** Reveal a file in the editor (real: `vscode.env.openExternal` / `vscode.open`). */
  openFile: (path: string) => void;
```

- [ ] **Step 4: Implement the actions**

Add these imports:

```typescript
import { ingestFile, ingestBytes, type IngestResult } from '../../attachments/ingest.js';
import { unlinkAttachment } from '../../attachments/reap.js';
import { attachmentPath } from '../../attachments/paths.js';
import {
  listAttachments,
  insertAttachment,
  getAttachment,
  deleteAttachment,
  findAttachmentByStoredName,
} from '../../store/attachments.js';
```

Add these two helpers in the factory function body, **above** the returned actions object literal (they are `const` declarations, not object properties):

```typescript
    /**
     * Ensure this panel is bound to a persisted ticket, minting a draft if it is
     * not. There is no attachment without a `ticket_id` — the directory is named
     * by one. Reuses the exact persist-on-bind path `fetchSource` already walks,
     * rather than inventing a staging area that would need its own move-on-submit
     * lifecycle to get wrong.
     */
    const ensureTicket = (): number => {
      if (ctx.ticketId !== undefined) return ctx.ticketId;
      const draft = createTicketFlow(deps.store, {
        key: '',
        title: 'Untitled ticket',
        projectId: deps.projectId,
      });
      ctx.bindTicket(draft.id);
      deps.onChange(); // sidebar shows the new draft
      return draft.id;
    };

    /**
     * File the ingest result. A dedupe hit returns the EXISTING row rather than
     * inserting a second one: identical bytes are one file, and a duplicate row
     * would put two tiles over it — the second detach then unlinking the file the
     * first still points at.
     */
    const record = (ticketId: number, result: IngestResult): boolean => {
      if (!result.ok) {
        ctx.post({ type: 'error', message: result.message });
        return false;
      }
      const existing = findAttachmentByStoredName(
        deps.store, ticketId, result.input.storedName,
      );
      if (!existing) insertAttachment(deps.store, result.input);
      return true;
    };
```

Then add these four to the returned actions object:

```typescript
    attachPick: async (): Promise<void> => {
      const paths = await deps.pickAttachment();
      if (paths.length === 0) return; // cancelled — not an error, say nothing
      const ticketId = ensureTicket();
      let changed = false;
      for (const path of paths) {
        // Sequential, not Promise.all: each ingest hashes and copies, and a
        // multi-select of large videos should not run N copies at once.
        if (record(ticketId, await ingestFile(deps.storageDir, ticketId, path))) changed = true;
      }
      if (changed) ctx.pushState();
    },

    attachBytes: async (name: string, base64: string): Promise<void> => {
      const ticketId = ensureTicket();
      // Buffer.from silently DROPS invalid base64 characters rather than
      // throwing, so a corrupt payload would otherwise be written as a
      // truncated file that renders as a broken tile. Re-encoding and comparing
      // is the check: a payload that does not round-trip was not valid base64.
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) {
        ctx.post({ type: 'error', message: `${name} could not be decoded` });
        return;
      }
      if (record(ticketId, await ingestBytes(deps.storageDir, ticketId, name, bytes))) {
        ctx.pushState();
      }
    },

    detachAttachment: async (id: number): Promise<void> => {
      // Scoped to THIS panel's ticket. The id crosses an untrusted boundary, so
      // an id belonging to another ticket must not let this panel unlink that
      // ticket's file.
      const row = getAttachment(deps.store, id);
      if (!row || row.ticketId !== ctx.ticketId) return;
      deleteAttachment(deps.store, id);
      await unlinkAttachment(deps.storageDir, row.ticketId, row.storedName);
      ctx.pushState();
    },

    openAttachment: async (id: number): Promise<void> => {
      const row = getAttachment(deps.store, id);
      if (!row || row.ticketId !== ctx.ticketId) return;
      deps.openFile(attachmentPath(deps.storageDir, row.ticketId, row.storedName));
    },
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run src/ui/onboarding/actions.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/onboarding/actions.ts src/ui/onboarding/actions.test.ts
git commit -m "feat: attachment actions with create-mode draft binding

First attach mints a draft ticket the same way first fetch does — there
is no attachment without a ticket_id, and a staging area would be a
second lifecycle to get wrong.

A dedupe hit returns the existing row: a duplicate row over one
content-addressed file would let the second detach unlink the file the
first still points at. Detach and open are scoped to the panel's own
ticket, because the id crosses an untrusted boundary."
```

---

### Task 10: The prompt strip in the webview

**Files:**
- Modify: `src/ui/onboarding/webview.html`, `src/ui/onboarding/webview.test.ts`

**Interfaces:**
- Consumes: `AttachmentView` shape from Task 7 (`{id, kind, name, byteSize, src}`), posted as `state.attachments`.
- Produces: page functions `renderAttachments(list)` and `formatBytes(n)`, and the page constant `MAX_PASTE_BYTES`.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/onboarding/webview.test.ts`:

```typescript
describe('attachment strip', () => {
  const render = (list: unknown): string =>
    loadFunction('renderAttachments', {
      formatBytes: loadFunction('formatBytes'),
    })(list) as string;

  it('renders nothing when there are no attachments', () => {
    expect(render([]).trim()).toBe('');
  });

  it('renders an image tile with an img element pointing at the src', () => {
    const html = render([
      { id: 1, kind: 'image', name: 'login-error.png', byteSize: 4096, src: 'webview://a.png' },
    ]);
    expect(html).toContain('<img');
    expect(html).toContain('src="webview://a.png"');
    expect(html).toContain('login-error.png');
  });

  it('renders a video tile with a controllable video element', () => {
    const html = render([
      { id: 2, kind: 'video', name: 'repro.mov', byteSize: 1048576, src: 'webview://b.mp4' },
    ]);
    expect(html).toContain('<video');
    expect(html).toContain('controls');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('src="webview://b.mp4"');
  });

  it('carries the row id on the detach and open controls', () => {
    const html = render([
      { id: 7, kind: 'image', name: 'a.png', byteSize: 1, src: 'webview://a.png' },
    ]);
    expect(html).toContain('data-attach-id="7"');
  });

  // The strip renders values that came from a ticket the user did not author.
  // esc() is the primary defense; the CSP is only the backstop under it.
  it('escapes the original filename', () => {
    const html = render([
      {
        id: 1, kind: 'image', byteSize: 1, src: 'webview://a.png',
        name: '<img src=x onerror="alert(1)">.png',
      },
    ]);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes the src', () => {
    const html = render([
      { id: 1, kind: 'image', name: 'a.png', byteSize: 1, src: 'x" onerror="alert(1)' },
    ]);
    expect(html).not.toContain('onerror="alert(1)"');
  });
});

describe('formatBytes', () => {
  const formatBytes = loadFunction('formatBytes') as (n: number) => string;

  it('renders bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
  });
});

// The host re-checks this. The page's copy exists so the user is told BEFORE a
// large paste crosses postMessage, not after the host silently drops it — so the
// two values must be the same number.
describe('paste cap mirror', () => {
  it('matches the host cap exactly', () => {
    expect(htmlConstNumber('MAX_PASTE_BYTES')).toBe(MAX_PASTE_BYTES);
  });
});
```

Add `import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';` to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/onboarding/webview.test.ts`
Expected: FAIL — `renderAttachments() not found`.

- [ ] **Step 3: Add markup and styles**

In `src/ui/onboarding/webview.html`, immediately after the prompt `<textarea id="desc">` (line ~256), add:

```html
  <div class="attachrow">
    <button type="button" id="attachBtn" class="ghost"
            title="Attach an image or video from disk">Attach…</button>
    <span class="hint">or paste a screenshot into the prompt</span>
  </div>
  <div id="attachments" class="attachstrip"></div>
```

In the `<style>` block add:

```css
  .attachrow{display:flex;align-items:center;gap:8px;margin-top:6px}
  .attachstrip{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
  .attachstrip:empty{display:none}
  .attachtile{position:relative;width:132px;border-radius:4px;overflow:hidden;
    border:1px solid var(--vscode-panel-border,rgba(128,128,128,.35))}
  .attachtile img,.attachtile video{display:block;width:100%;height:82px;object-fit:cover;
    background:var(--vscode-editor-background,#1e1e1e);cursor:pointer}
  .attachmeta{padding:4px 6px;font-size:11px;line-height:1.3;
    color:var(--vscode-descriptionForeground,var(--vscode-foreground));opacity:.85}
  .attachname{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .attachdetach{position:absolute;top:2px;right:2px;width:18px;height:18px;padding:0;
    line-height:16px;border:none;border-radius:3px;cursor:pointer;
    background:var(--vscode-editor-background,#1e1e1e);
    color:var(--vscode-foreground);opacity:.75}
  .attachdetach:hover{opacity:1}
```

- [ ] **Step 4: Add the page functions**

In the page's `<script>` block, near the other render helpers:

```javascript
  // Mirrors MAX_PASTE_BYTES in attachments/ingest.ts. The host re-checks it —
  // this copy exists so the user is told before a large paste crosses
  // postMessage, not after the host silently drops it. webview.test.ts pins the
  // two together, because a drift means a paste that vanishes with no message.
  const MAX_PASTE_BYTES = 10485760;

  function formatBytes(n) {
    if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // Renders the strip under the prompt. Every interpolated value came from a
  // ticket the user may not have authored, so all of them go through esc(); the
  // widened CSP is the backstop under that, not a replacement for it.
  function renderAttachments(list) {
    if (!list || list.length === 0) return '';
    return list.map(function (a) {
      const media = a.kind === 'video'
        ? '<video src="' + esc(a.src) + '" preload="metadata" controls '
          + 'data-attach-id="' + esc(a.id) + '"></video>'
        : '<img src="' + esc(a.src) + '" alt="' + esc(a.name) + '" '
          + 'data-attach-id="' + esc(a.id) + '">';
      return '<div class="attachtile">'
        + media
        + '<button type="button" class="attachdetach" data-attach-id="' + esc(a.id) + '" '
        + 'title="Remove attachment">&times;</button>'
        + '<span class="attachmeta"><span class="attachname" title="' + esc(a.name) + '">'
        + esc(a.name) + '</span>' + esc(formatBytes(a.byteSize)) + '</span>'
        + '</div>';
    }).join('');
  }
```

- [ ] **Step 5: Wire the events**

In the state-apply function (where `el('desc').value` is set, ~line 403) add:

```javascript
    el('attachments').innerHTML = renderAttachments(state.attachments || []);
```

Near the other listener registrations add:

```javascript
  el('attachBtn').addEventListener('click', function () {
    post({ type: 'attach-pick' });
  });

  // Delegated: the strip is re-rendered on every state push, so per-tile
  // listeners would be re-bound each time and leak.
  el('attachments').addEventListener('click', function (e) {
    const detach = e.target.closest('.attachdetach');
    if (detach) {
      post({ type: 'detach-attachment', id: Number(detach.dataset.attachId) });
      return;
    }
    const media = e.target.closest('img[data-attach-id]');
    if (media) post({ type: 'open-attachment', id: Number(media.dataset.attachId) });
  });

  // Clipboard images have no path, so bytes are the only thing available — this
  // is why the paste path exists at all. Text pastes fall through untouched:
  // preventDefault only fires once a file is actually found.
  el('desc').addEventListener('paste', function (e) {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (file.size > MAX_PASTE_BYTES) {
        // showErr is the page's existing inline-error display (webview.html:1149,
        // where the host's {type:'error'} message lands). Told here rather than
        // after the host drops it, so the user learns why nothing appeared.
        showErr(file.name + ' is too large to paste (limit 10 MB). Use Attach… to add it from disk.');
        continue;
      }
      const reader = new FileReader();
      reader.onload = function () {
        // reader.result is a data: URL; the payload is after the comma.
        const comma = String(reader.result).indexOf(',');
        if (comma < 0) return;
        post({
          type: 'attach-bytes',
          name: file.name || ('pasted-' + Date.now() + '.png'),
          base64: String(reader.result).slice(comma + 1),
        });
      };
      reader.readAsDataURL(file);
    }
  });
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run src/ui/onboarding/webview.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/onboarding/webview.html src/ui/onboarding/webview.test.ts
git commit -m "feat: attachment strip under the ticket prompt

Image and video tiles with detach and click-to-open, delegated listeners
so a state repaint does not leak handlers. The page's paste cap mirrors
the host constant and is pinned by a test: a drift means a paste that
vanishes with no message."
```

---

### Task 11: Host wiring

**Files:**
- Modify: `src/ui/onboarding/host.ts`, `src/extension.ts`
- Test: manual verification via F5 (this task is the `vscode` binding layer, which does not load under vitest)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new — this is the activation-layer binding.

- [ ] **Step 1: Grant the resource root and the media source**

In `src/ui/onboarding/host.ts`, add imports and rewrite `createPanel`:

```typescript
import { attachmentsRoot } from '../../attachments/paths.js';
```

```typescript
    createPanel(title: string): OnboardingPanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.onboarding',
        title,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          /**
           * Exactly one directory: where prompt attachments live. This is
           * NARROWER than VS Code's default (the extension root plus every
           * workspace folder), so granting it tightens the panel while enabling
           * the strip. Nothing else this page loads comes off disk — the HTML
           * itself is read with `readFileSync` and inlined.
           */
          localResourceRoots: [
            vscode.Uri.file(attachmentsRoot(context.globalStorageUri.fsPath)),
          ],
        },
      );
      // Nonce per panel, not per host (the html above is built once and reused).
      // The media source is this panel's own cspSource — the only origin the
      // attachment URIs minted below will ever have.
      panel.webview.html = injectCsp(html, newNonce(), panel.webview.cspSource);
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
        dispose: () => panel.dispose(),
        setIcon: (p: string) => {
          panel.iconPath = vscode.Uri.file(p);
        },
        toWebviewUri: (p: string) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
      };
    },
```

- [ ] **Step 2: Supply the state builder's storage dir**

Find where `buildOnboardingState` is called from the onboarding manager and thread `context.globalStorageUri.fsPath` through as the new final argument. The manager itself must not import `vscode` — pass it in as a field on the manager's construction options, set at the `extension.ts` call site.

- [ ] **Step 3: Supply the new action deps**

At the `extension.ts` site that builds `OnboardingActionsDeps`, add:

```typescript
      storageDir: context.globalStorageUri.fsPath,
      pickAttachment: async (): Promise<string[]> => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
          filters: {
            Media: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS],
          },
        });
        return (picked ?? []).map((uri) => uri.fsPath);
      },
      openFile: (path: string) => {
        void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path));
      },
```

with `import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './attachments/kinds.js';` at the top.

- [ ] **Step 4: Reap on ticket delete**

Find the `deleteTicket` call site in `src/extension.ts` and follow it with the directory removal:

```typescript
        deleteTicket(localStore, ticketId);
        // The rows go with the ticket via TICKET_CHILD_TABLES; the bytes are on
        // disk and are the host's to remove. Deliberately outside the store
        // transaction — `store/` has no fs dependency and keeps none. Awaited so
        // a failure is logged rather than becoming an unhandled rejection.
        void reapAttachments(context.globalStorageUri.fsPath, ticketId).catch((err: unknown) =>
          logger.warn(`could not remove attachments for ticket ${ticketId}: ${String(err)}`),
        );
```

with `import { reapAttachments } from './attachments/reap.js';` at the top. Match `logger.warn`'s actual name in that file.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build && npm test`
Expected: all green.

- [ ] **Step 6: Manual verification (F5)**

Launch the Extension Dev Host and check each:
1. Open Create Ticket. The strip is absent (nothing renders when empty).
2. Click **Attach…**, pick a PNG. It appears as a tile with its filename and size. The sidebar shows a new draft ticket (create mode bound one).
3. Take a screenshot (Cmd+Shift+4), click into the Prompt, paste. A second tile appears. Typing text and pasting text still works normally.
4. Click **Attach…**, pick a `.mov`. The tile shows a video element that plays on click.
5. Click **Attach…**, pick a `.pdf`. An inline error names the supported types; no tile appears.
6. Click the `×` on a tile. It disappears and does not return after a reload of the panel.
7. Submit the ticket, then run the `karst context` command from the generated `/karst:<id>` — the output carries an `## Attachments` section with absolute paths, and the video line says `(not agent-readable)`.
8. Delete the ticket from the sidebar, then confirm `<globalStorage>/attachments/<id>/` is gone.

- [ ] **Step 7: Commit**

```bash
git add src/ui/onboarding/host.ts src/extension.ts
git commit -m "feat: wire attachments into the activation layer

localResourceRoots is granted on the attachments directory alone, which
is narrower than VS Code's default of the extension root plus every
workspace folder. The bytes are reaped host-side on ticket delete rather
than inside the store transaction, because store/ has no fs dependency."
```

---

## Notes for the implementer

**A pre-existing bug is fixed in Task 8, Step 3.** `routeOnboardingAction`'s `case 'set-provider':` has no `return`, so it falls through into `case 'set-type':` and sets the ticket's type to the provider's id. It is unrelated to attachments but sits inside a function this plan edits, and leaving a known fall-through in place while editing the switch around it is worse than the one-line fix. It gets its own line in that task's commit message.

**Where the design lives:** `docs/superpowers/specs/2026-08-01-ticket-attachments-design.md`. If an implementation detail here contradicts the spec, the spec wins — raise it rather than silently diverging.
