# Ticket Form: Paste Long Text as a File Attachment + Attach Arbitrary Files

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a long text is pasted into the ticket form's Prompt field it becomes a `.txt` file attachment instead of bloating the prompt, and the ticket form can attach arbitrary files (not only images/videos).

**Architecture:** Two halves. (1) `attachments/kinds.ts` learns a generic `file` kind — any filename whose final extension is a plain alphanumeric suffix (safe as an on-disk stored-name suffix) is classified `file` instead of being rejected; the existing image/video whitelist is unchanged. (2) The ticket-form webview's `#desc` paste handler grows a text branch: a paste whose text exceeds `LONG_TEXT_PASTE_CHARS` is `preventDefault`ed and sent over the existing `attach-bytes` channel as `pasted-<ts>.txt` (base64). The disk picker drops its media-only filter, and the tile strip renders a `file-text` glyph for `file` rows.

**Tech Stack:** TypeScript, ESM, vitest (in-memory SQLite), standalone webview HTML (no framework), Tabler Icons.

## Global Constraints

- Strict TDD: write the failing test first, run it (RED), implement (GREEN), commit per task.
- `AttachmentKind` lives in `src/attachments/kinds.ts` — the single authority. Nothing downstream re-derives a kind from a filename.
- The stored filename is built as `<sha256[0..16]>.` + the normalized extension (`store/attachments.ts`), so a `file`-kind extension MUST be alphanumeric and separator-free. The value is validated, never taken from the user's name verbatim.
- `MAX_PASTE_BYTES = 10 * 1024 * 1024` (10 MB) stays the paste transport cap for BOTH images and pasted text files. Disk-picked files keep having no size cap.
- Webview constants are mirrored and pinned: `MAX_PASTE_BYTES` is already pinned by `webview.test.ts`; the new `LONG_TEXT_PASTE_CHARS` gets the same treatment (UI-R34).
- The webview is a trust boundary: the host re-validates every `attach-bytes` name and payload (`validateAttachment`, `MAX_BASE64_CHARS` in `messages.ts`). The webview copy of the constant is a UX courtesy only.
- UI changes are judged against `docs/ui/UI-RULES.md`: every control that posts shows pending (UI-R11), labels stay stable while pending (UI-R18), unknown results are UNKNOWN not failure (UI-R14). Reuse the `.k-icon` primitive and existing tile layout; do not introduce a second icon mechanism.
- Icon additions must be VERBATIM upstream Tabler path data in `src/model/tablerIcons.ts` (docs/ui/ICONS.md §7).
- `noUncheckedIndexedAccess` is on; ESM imports carry `.js`.
- Conventional commits; keep files small.

---

### Task 1: Add a generic `file` attachment kind

**Files:**
- Modify: `src/attachments/kinds.ts`
- Test: `src/attachments/kinds.test.ts`

**Interfaces:**
- Consumes: nothing (existing `finalExtension`, `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS`).
- Produces: `AttachmentKind = 'image' | 'video' | 'file'`; `attachmentKind(name): AttachmentKind | null`; `attachmentExtension(name): string | null`. A generic extension — any final extension matching `^[a-z0-9]{1,10}$` that is not image/video — classifies as `file` and is returned as the stored extension. Everything else stays `null`.

- [ ] **Step 1: Write the failing tests**

Replace `src/attachments/kinds.test.ts`'s "rejects a non-whitelisted extension" and "classifies by the final extension only" blocks so PDF/sh/exe classify as `file`, and add rejections for unsafe extensions:

```ts
  it('classifies any plain-alphanumeric extension as a file', () => {
    expect(attachmentKind('notes.pdf')).toBe('file');
    expect(attachmentKind('script.sh')).toBe('file');
    expect(attachmentKind('SPEC.md')).toBe('file');
    expect(attachmentKind('archive.zip')).toBe('file');
    expect(attachmentKind('report.docx')).toBe('file');
  });

  it('rejects an extension that is not plain alphanumeric', () => {
    expect(attachmentKind('x.txt!')).toBeNull();
    expect(attachmentKind('x.txt v2')).toBeNull();
    expect(attachmentKind('x.ta\nr')).toBeNull();
  });

  // The double extension is the interesting case: only the LAST segment counts,
  // so a file dressed up as an image is classified by what it actually is.
  it('classifies by the final extension only', () => {
    expect(attachmentKind('payload.png.exe')).toBe('file');
    expect(attachmentKind('archive.tar.png')).toBe('image');
  });
```

And extend the `attachmentExtension` describe:

```ts
  it('returns the normalized lowercase extension for a generic file name', () => {
    expect(attachmentExtension('REPORT.PDF')).toBe('pdf');
    expect(attachmentExtension('script.Sh')).toBe('sh');
  });

  it('returns null for a name with no plain extension', () => {
    expect(attachmentExtension('README')).toBeNull();
    expect(attachmentExtension('x.txt!')).toBeNull();
    expect(attachmentExtension('.pdf')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/attachments/kinds.test.ts`
Expected: FAIL — `notes.pdf`/`script.sh`/`payload.png.exe` currently classify `null`, not `file`.

- [ ] **Step 3: Implement the `file` kind**

In `src/attachments/kinds.ts`, change the type union and add the safe-extension rule:

```ts
export type AttachmentKind = 'image' | 'video' | 'file';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'] as const;

/**
 * A generic file is accepted when its extension is a plain alphanumeric suffix —
 * it becomes part of the on-disk stored name (`<hash>.<ext>`), so the charset is
 * the security boundary. Anything else (separators, whitespace, symbols, an
 * absurd length) is rejected rather than sanitized into a name that lies about
 * its contents.
 */
const SAFE_FILE_EXTENSION = /^[a-z0-9]{1,10}$/;

const KIND_BY_EXTENSION = new Map<string, AttachmentKind>([
  ...IMAGE_EXTENSIONS.map((e) => [e, 'image'] as const),
  ...VIDEO_EXTENSIONS.map((e) => [e, 'video'] as const),
]);

/** The media kind for `name`, or null when the extension is not accepted. */
export function attachmentKind(name: string): AttachmentKind | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.get(ext) ?? (SAFE_FILE_EXTENSION.test(ext) ? 'file' : null);
}

/**
 * The normalized extension to use in the stored filename, or null when `name`
 * is not accepted. Callers must treat null as a rejection, never as "use the
 * user's suffix anyway".
 */
export function attachmentExtension(name: string): string | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  if (KIND_BY_EXTENSION.has(ext)) return ext;
  return SAFE_FILE_EXTENSION.test(ext) ? ext : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/attachments/kinds.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachments/kinds.ts src/attachments/kinds.test.ts
git commit -m "feat(attachments): accept any plain-extension file as a file attachment"
```

---

### Task 2: Store + ingest accept the `file` kind

**Files:**
- Modify: `src/store/attachments.ts:47-67`
- Modify: `src/attachments/ingest.ts:25-29`
- Modify: `src/store/attachments.test.ts`
- Modify: `src/attachments/ingest.test.ts`
- Test: `src/store/attachments.test.ts`, `src/attachments/ingest.test.ts`

**Interfaces:**
- Consumes: `AttachmentKind` from Task 1.
- Produces: `validateAttachment(originalName, pastedByteSize?)` now returns `kind: 'file'` for generic names and an updated rejection message; `toKind(raw)` maps `'file'`; a stored `file` row round-trips through `listAttachments` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/store/attachments.test.ts` (inside the existing describe — place after the video row test around line 305):

```ts
  it('round-trips a generic file kind', () => {
    const ticketId = seedTicket(store, 'F-1');
    insertAttachment(store, {
      ticketId,
      kind: 'file',
      storedName: 'aaaa1111bbbb2222.pdf',
      originalName: 'notes.pdf',
      byteSize: 5,
    });
    expect(listAttachments(store, ticketId)).toEqual([
      expect.objectContaining({ kind: 'file', originalName: 'notes.pdf' }),
    ]);
  });
```

In `src/attachments/ingest.test.ts`, change the two "rejects a non-whitelisted type" tests (they currently use `notes.pdf`, which is now a `file`):

```ts
  it('rejects a name with no accepted extension', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'README', Buffer.from('data'));
    expect(result).toEqual({
      ok: false,
      message: 'README is not a supported attachment (images: png, jpg, jpeg, gif, webp; video: mp4, webm, mov; any other file)',
    });
  });
```

and

```ts
  it('rejects a name with no accepted extension', async () => {
    const storage = freshStorage();
    const src = sourceFile('README', 'data');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('not a supported attachment');
  });
```

and add positive `file`-kind ingests:

```ts
  it('stores pasted text bytes as a file attachment', async () => {
    const storage = freshStorage();
    const result = await ingestBytes(storage, 12, 'pasted.txt', Buffer.from('hello'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.kind).toBe('file');
    expect(result.input.storedName).toMatch(/^[0-9a-f]{16}\.txt$/);
  });
```

```ts
  it('stores a picked pdf as a file attachment', async () => {
    const storage = freshStorage();
    const src = sourceFile('notes.pdf', '%PDF');
    const result = await ingestFile(storage, 5, src);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toMatchObject({ kind: 'file', originalName: 'notes.pdf' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/attachments.test.ts src/attachments/ingest.test.ts`
Expected: FAIL — `toKind` degrades `'file'` to `'image'`; `validateAttachment('README')` returns an error whose message does not match; `notes.pdf` no longer rejected.

- [ ] **Step 3: Implement**

In `src/store/attachments.ts`, update `toKind`:

```ts
function toKind(raw: string): AttachmentKind {
  return raw === 'video' ? 'video' : raw === 'file' ? 'file' : 'image';
}
```

In `src/attachments/ingest.ts`, update the message:

```ts
const SUPPORTED =
  `images: ${IMAGE_EXTENSIONS.join(', ')}; video: ${VIDEO_EXTENSIONS.join(', ')}; any other file`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/store/attachments.test.ts src/attachments/ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/attachments.ts src/store/attachments.test.ts src/attachments/ingest.ts src/attachments/ingest.test.ts
git commit -m "feat(attachments): store and ingest generic file attachments"
```

---

### Task 3: Render a `file` attachment tile in the ticket form

**Files:**
- Modify: `src/model/tablerIcons.ts:57-106`
- Modify: `src/ui/ticketForm/webview.html` (`renderAttachments`, CSS, attach-row copy)
- Test: `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: `AttachmentKind` including `'file'` (Task 1) on `AttachmentView.kind` (`state.ts:59-66`).
- Produces: `karstIcon('file-text', size)` renders a Tabler `file-text` glyph; `renderAttachments` renders a non-media tile for `kind === 'file'`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/ticketForm/webview.test.ts`, update the `attachment strip` harness to inject `karstIcon` (the file branch calls it):

```ts
describe('attachment strip', () => {
  const render = (list: unknown): string =>
    loadFunction('renderAttachments', {
      formatBytes: loadFunction('formatBytes'),
      karstIcon: (name: string) => `<svg class="k-icon" data-icon="${name}"></svg>`,
    })(list) as string;
```

Add a file-tile test after the video-tile test:

```ts
  it('renders a file tile with a file-text glyph and no media element', () => {
    const html = render([
      { id: 3, kind: 'file', name: 'notes.pdf', byteSize: 2048, src: 'webview://c.pdf' },
    ]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
    expect(html).toContain('data-icon="file-text"');
    expect(html).toContain('notes.pdf');
    expect(html).toContain('2 KB');
    expect(html).toMatch(/<button[^>]*class="[^"]*\battachopen\b[^"]*"[^>]*data-attach-id="3"/);
  });
```

Add a copy guard for the attach-row (place near the `.hint` test):

```ts
  it('says the prompt accepts pasted screenshots AND long text', () => {
    const row = HTML.slice(HTML.indexOf('id="attachBtn"'), HTML.indexOf('<div id="attachments"'));
    expect(row).toMatch(/paste a screenshot/i);
    expect(row).toMatch(/long text/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: FAIL — no `file-text` branch in `renderAttachments`, no `file-text` glyph in `TABLER_ICONS`, attach-row copy lacks "long text".

- [ ] **Step 3: Implement**

Add the `file-text` glyph to `src/model/tablerIcons.ts`'s `TABLER_ICONS` (verbatim upstream path data, docs/ui/ICONS.md §7). Place it alphabetically after `external-link`:

```ts
  'file-text':
    '<path d="M14 3v4a1 1 0 0 0 1 1h4"/>' +
    '<path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2"/>' +
    '<path d="M9 9l1 0"/><path d="M9 13l6 0"/><path d="M9 17l6 0"/>',
```

In `src/ui/ticketForm/webview.html`, extend `renderAttachments` so `file` rows render a fixed-height glyph tile instead of a media element:

```js
  function renderAttachments(list) {
    if (!list || list.length === 0) return '';
    return list.map(function (a) {
      const media = a.kind === 'video'
        ? '<video src="' + esc(a.src) + '" preload="metadata" controls '
          + 'data-attach-id="' + esc(a.id) + '"></video>'
        : a.kind === 'file'
        ? '<span class="attachfile" aria-hidden="true">' + karstIcon('file-text', 26) + '</span>'
        : '<img src="' + esc(a.src) + '" alt="' + esc(a.name) + '" '
          + 'data-attach-id="' + esc(a.id) + '">';
      return '<div class="attachtile">'
        + media
        + '<button type="button" class="k-iconbtn k-iconbtn--danger attachdetach" data-attach-id="' + esc(a.id) + '" '
        + 'aria-label="Remove attachment" title="Remove attachment">'
        + '<span aria-hidden="true">&times;</span></button>'
        + '<span class="attachmeta"><span class="attachname" title="' + esc(a.name) + '">'
        + esc(a.name) + '</span>' + esc(formatBytes(a.byteSize)) + '</span>'
        + '<button type="button" class="k-btn k-btn--ghost k-btn--sm attachopen" data-attach-id="' + esc(a.id) + '" '
        + 'title="Open attachment" aria-label="Open ' + esc(a.name) + '">Open</button>'
        + '</div>';
    }).join('');
  }
```

Add the `.attachfile` rule next to the existing `.attachtile img,.attachtile video` rule (same fixed media height, icon centred):

```css
  .attachfile{display:flex;align-items:center;justify-content:center;height:calc(var(--k-space-8) * 4.1);
    color:var(--k-text-dim)}
```

Update the attach-row copy in the markup so the long-text behavior is discoverable (the button title names the broader capability, the caption names both paste kinds):

```html
  <div class="attachrow">
    <button type="button" id="attachBtn" class="k-btn k-btn--ghost"
            title="Attach any file from disk">Attach…</button>
    <span class="hint">or paste a screenshot — a long text becomes a file attachment</span>
  </div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/tablerIcons.ts src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "feat(ticket-form): render generic file attachments as a file tile"
```

---

### Task 4: Paste long text into the prompt → attach it as a file

**Files:**
- Modify: `src/attachments/ingest.ts:14-15`
- Modify: `src/ui/ticketForm/webview.html` (paste handler, `postPastedText`, mirror constant)
- Test: `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: `MAX_PASTE_BYTES` (existing); the `attach-bytes` channel (`messages.ts`) — unchanged, the host re-validates name/base64/size.
- Produces: `LONG_TEXT_PASTE_CHARS = 4000` exported from `src/attachments/ingest.ts` (the pinning anchor; the webview mirrors it as `const LONG_TEXT_PASTE_CHARS = 4000;`); `postPastedText(text)` posts an `attach-bytes` message named `pasted-<ts>.txt`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/ticketForm/webview.test.ts`, add a mirror pin next to the existing "paste cap mirror" describe:

```ts
// The webview decides WHEN a pasted text becomes a file instead of inline text.
// That decision is a host-visible policy only via this mirror — pin it so a
// drift never silently changes what counts as a "long" paste (UI-R34).
describe('long-text paste threshold mirror', () => {
  it('matches the host constant exactly', () => {
    expect(htmlConstNumber('LONG_TEXT_PASTE_CHARS')).toBe(LONG_TEXT_PASTE_CHARS);
  });
});
```

And a `postPastedText` harness describe after the "pasted file reader" describe:

```ts
describe('pasted text writer', () => {
  function writerHarness() {
    const posted: unknown[] = [];
    const errors: string[] = [];
    let pending = false;
    const read = loadFunction('postPastedText', {
      TextEncoder: globalThis.TextEncoder,
      btoa: globalThis.btoa,
      MAX_PASTE_BYTES,
      post: (message: unknown) => posted.push(message),
      showErr: (message: string) => errors.push(message),
      el: (id: string) => (id === 'attachBtn' ? { } : null),
      karstIsPending: () => pending,
      karstRequestId: () => 'req-1',
      karstBeginPending: () => { pending = true; },
    }) as (text: string) => void;
    return { read, posted, errors };
  }

  it('posts the text as a base64 attach-bytes with a timestamped .txt name', () => {
    const harness = writerHarness();
    harness.read('line one\nline two');

    expect(harness.posted).toHaveLength(1);
    const msg = harness.posted[0] as { type: string; name: string; base64: string };
    expect(msg.type).toBe('attach-bytes');
    expect(msg.name).toMatch(/^pasted-\d+\.txt$/);
    expect(Buffer.from(msg.base64, 'base64').toString('utf8')).toBe('line one\nline two');
    expect(harness.errors).toEqual([]);
  });

  it('round-trips a multi-megabyte text through the chunked encoder', () => {
    const harness = writerHarness();
    const big = 'x'.repeat(200_000);
    harness.read(big);

    const msg = harness.posted[0] as { base64: string };
    expect(Buffer.from(msg.base64, 'base64').byteLength).toBe(200_000);
  });

  it('declines text over the paste cap with an inline error and no post', () => {
    const harness = writerHarness();
    harness.read('x'.repeat(MAX_PASTE_BYTES + 1));

    expect(harness.posted).toEqual([]);
    expect(harness.errors[0]).toContain('too long to attach');
  });
});
```

Add a source-level guard that the paste handler routes long text away from the textarea:

```ts
  it('intercepts a long text paste into the prompt as a file attachment', () => {
    const at = HTML.indexOf("el('desc').addEventListener('paste'");
    const handler = HTML.slice(at, HTML.indexOf("// Auto-improve switch"));
    expect(handler).toContain("getData('text/plain')");
    expect(handler).toContain('text.length > LONG_TEXT_PASTE_CHARS');
    expect(handler).toContain('preventDefault()');
    expect(handler).toContain('postPastedText(text)');
    // Files still win: the text branch must only run when no clipboard file exists.
    expect(handler.indexOf('clipboardData.files')).toBeLessThan(handler.indexOf('getData'));
  });
```

Update the import at the top of `webview.test.ts`:

```ts
import { MAX_PASTE_BYTES, LONG_TEXT_PASTE_CHARS } from '../../attachments/ingest.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: FAIL — `LONG_TEXT_PASTE_CHARS` not exported; `postPastedText` not found; the paste handler has no text branch.

- [ ] **Step 3: Implement**

In `src/attachments/ingest.ts`, next to `MAX_PASTE_BYTES`:

```ts
/**
 * The minimum character count for a text paste into the ticket-form prompt to be
 * attached as a file rather than inlined. Below this, a paste keeps the default
 * browser behavior (text lands in the field); at or above it, the webview turns
 * the paste into a `pasted-<ts>.txt` attachment and the host stores it.
 */
export const LONG_TEXT_PASTE_CHARS = 4000;
```

In `src/ui/ticketForm/webview.html`, add the mirror constant beside `MAX_PASTE_BYTES` (line ~500):

```js
  // Mirrors LONG_TEXT_PASTE_CHARS in attachments/ingest.ts. The webview makes the
  // inline-vs-attach decision for a text paste; this copy is pinned by
  // webview.test.ts so the two can never drift (UI-R34).
  const LONG_TEXT_PASTE_CHARS = 4000;
```

Add `postPastedText` right after `postPastedFile`:

```js
  // A long text pasted into the prompt becomes a .txt attachment: the prompt stays
  // concise and the agent reads the full content from the attachment file. Short
  // pastes keep the default behavior (text lands in the field). base64 is built in
  // chunks because btoa() throws on inputs around 64 KB in some engines, and the
  // paste cap is 10 MB.
  function postPastedText(text) {
    const name = 'pasted-' + Date.now() + '.txt';
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_PASTE_BYTES) {
      showErr(name + ' is too long to attach (limit 10 MB). Paste it in smaller parts.');
      return;
    }
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);
    // Shares the Attach… button's pending state, same as postPastedFile.
    if (!karstIsPending(el('attachBtn'))) {
      const requestId = karstRequestId();
      karstBeginPending(el('attachBtn'), requestId);
      post({ type: 'attach-bytes', name, base64, requestId });
    }
  }
```

Replace the paste handler:

```js
  // Clipboard images have no path, so bytes are the only thing available — this
  // is why the paste path exists at all. A LONG text paste is attached as a
  // file instead of inlined (see postPastedText). Short text pastes fall
  // through untouched: preventDefault only fires once a file is actually found
  // or a text actually meets the length threshold.
  el('desc').addEventListener('paste', function (e) {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length > 0) {
      e.preventDefault();
      for (let i = 0; i < files.length; i += 1) {
        postPastedFile(files[i]);
      }
      return;
    }
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (typeof text === 'string' && text.length > LONG_TEXT_PASTE_CHARS) {
      e.preventDefault();
      postPastedText(text);
    }
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/attachments/ingest.ts src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "feat(ticket-form): attach a pasted long text as a txt file instead of inlining it"
```

---

### Task 5: Let the disk picker select any file

**Files:**
- Modify: `src/extension.ts:1505-1514`

**Interfaces:**
- Consumes: `IMAGE_EXTENSIONS`, `VIDEO_EXTENSIONS` (imports unchanged).
- Produces: `pickAttachment` returns any file the user picks (the `All Files` filter entry), not just media.

- [ ] **Step 1: Change the filter (RED is N/A — the host binding has no unit test; the change is verified by typecheck/build + the Task 2 ingest tests that accept a picked pdf)**

Edit `src/extension.ts`:

```ts
      pickAttachment: async (): Promise<string[]> => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
          filters: {
            Media: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS],
            'All Files': ['*'],
          },
        });
        return (picked ?? []).map((uri) => uri.fsPath);
      },
```

- [ ] **Step 2: Verify the module still typechecks and the ingest path accepts the widened input**

Run: `npm run typecheck`
Expected: PASS. The Task 2 test "stores a picked pdf as a file attachment" is the functional proof that a non-media pick lands as a `file` row.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat(ticket-form): allow the attach picker to select any file, not only media"
```

---

### Task 6: `file` attachments read agent-readable in the launch context

**Files:**
- Test: `src/context/ticketContext.test.ts`

**Interfaces:**
- Consumes: `buildTicketContext`/`renderTicketContext` (unchanged — a `file` row already falls through the `a.kind === 'video'` note branch).

- [ ] **Step 1: Write the failing test**

In `src/context/ticketContext.test.ts`, in the `attachments` describe, add:

```ts
    it('renders a file attachment as agent-readable, unlike video', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'file',
        storedName: 'c2d3e4f5a6b7c8d9.txt',
        originalName: 'notes.txt',
        byteSize: 30,
      });

      const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
      expect(md).toContain('- file: ');
      expect(md).toContain('— "notes.txt"');
      expect(md).not.toContain('not agent-readable');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: FAIL — `insertAttachment` is typed with `AttachmentKind` which does not yet admit `'file'` (compile error), or the row round-trips as `image`.

- [ ] **Step 3: Verify the implementation (already landed in Tasks 1–2)**

Confirm `src/context/ticketContext.ts:521` reads `a.kind === 'video' ? ' (not agent-readable)' : ''` — a `file` row needs no change and no note. Run the suite.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/context/ticketContext.test.ts src/cli/context.test.ts src/cli/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/ticketContext.test.ts
git commit -m "test(context): a file attachment is agent-readable in the launch brief"
```

---

### Task 7: Full-suite verification

**Files:**
- None.

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS (including the pinned webview mirrors, the `tablerIcons` discovery test that picks up `file-text`, and the CLI guide pin).

- [ ] **Step 2: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both PASS (build emits the webview asset into `dist/`).

- [ ] **Step 3: Manual smoke (optional, F5 Extension Dev Host)**

Open the ticket form, paste a >4000-char blob into the Prompt, confirm a `pasted-*.txt` tile appears and the prompt field stays unchanged; click Attach… and pick a `.pdf`, confirm a file tile appears; verify the agent's launch context lists `- file: <path> — "notes.pdf"`.
