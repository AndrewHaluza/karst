# Ticket attachments — images & video on the prompt field

Ticket: 869echg1t — `[FEAT] improve prompt field on create ticket`

> There text only currently, but sometimes need to attach images, videos.
> It should be possible. And it should be displayable from the prompt area.

## Goal

The Prompt field on the create/edit ticket panel accepts image and video
attachments. They render inline in the prompt area, and their paths reach the
agent through the ticket context so a screenshot of a bug is something the
session can actually open.

## Decisions

1. **Attachments serve both the human and the agent.** They render as
   thumbnails in the panel *and* are emitted into the ticket-context markdown.
   The limit is stated rather than hidden: images are agent-readable, video is
   not — no adapter in the set consumes video.
2. **Bytes are copied into karst global storage**, never referenced in place.
   Clipboard paste has no source path, so at least one ingress must copy;
   having exactly one storage path avoids a second lifecycle. A "link, don't
   copy" mode is explicitly out of scope.
3. **Two ingress paths: a native file dialog and clipboard paste.** Drag & drop
   shares paste's plumbing and can be added later; it is not in this scope.
4. **Rendering uses real `<img>`/`<video>` off disk**, via a widened CSP and a
   `localResourceRoots` scoped to the attachments directory. This is the only
   option under which video is genuinely "displayable".

## Data model

New table `ticket_attachments`, schema **v17**.

| column | type | note |
| --- | --- | --- |
| `id` | INTEGER PK | Surrogate. |
| `ticket_id` | INTEGER | Added to `TICKET_CHILD_TABLES` in `deleteTicket`. |
| `kind` | TEXT | `'image'` or `'video'`. Resolved once at ingest and stored; never re-derived from the extension at read time. |
| `stored_name` | TEXT | `<sha256[0..16]>.<ext>`. The only name that ever touches the filesystem. |
| `original_name` | TEXT | Display only. Never a path component. |
| `byte_size` | INTEGER | Drives the strip label and the cap check. |
| `created_at` | TEXT | Ordering. |

Schema checklist (per CLAUDE.md): add to `schema.sql` for fresh DBs, add a
guarded `CREATE TABLE IF NOT EXISTS` step in `migrations.ts`, bump
`SCHEMA_VERSION` to 17, and update `db.test.ts`'s `user_version` and
table-count assertions.

Content-addressed storage names mean the same bytes are written once. Attaching
the same screenshot twice to one ticket is a no-op that returns the existing
row — not a second row sharing a file — so the strip never shows a duplicate
tile. A crafted `original_name` such as `../../../.ssh/id_rsa` is inert: it is a
display column and is never joined into a path.

## Storage layout

```
<globalStorage>/attachments/<ticketId>/<stored_name>
```

This mirrors the existing `<globalStorage>/artifacts/<ticketId>/` layout
(`extension.ts:1309`), so it is a pattern the codebase already carries. Global
storage is shared across IDE windows, which is correct here: any window's panel
must resolve the same attachment.

## New modules

`src/attachments/` — kept small and with the fs-touching parts isolated:

- **`kinds.ts`** — the extension→kind whitelist, pure. The single place
  `png/jpg/jpeg/gif/webp` and `mp4/webm/mov` are listed. Anything else is
  rejected with a named reason.
- **`paths.ts`** — `attachmentDir(storageDir, ticketId)` and
  `attachmentPath(...)`, pure.
- **`ingest.ts`** — `ingestFile(path)` (copy path, used by the dialog) and
  `ingestBytes(buf, name)` (paste path). Both whitelist-check, hash, mkdir,
  write, and return the row to insert. Failures are named, never silent.
- **`reap.ts`** — recursive removal of a ticket's attachment directory.

`src/store/attachments.ts` holds the SQL — `listAttachments`,
`insertAttachment`, `deleteAttachment`. Driver-agnostic: positional `?` only,
no named params, no `.pluck()`, because the `karst context` CLI reads this table
over `node:sqlite`.

## Ingress

**Attach button.** The webview posts `attach-pick`. The host runs
`showOpenDialog` with filters derived from `kinds.ts`, then `ingestFile` copies
file→file. No bytes cross `postMessage`, so a large video costs one
`copyFileSync`.

**Paste.** A `paste` handler on the prompt area reads
`e.clipboardData.files`, converts to base64, and posts
`attach-bytes {name, base64}`.

A **10 MB cap** applies to the paste path only (the dialog path never moves
bytes through the message channel). It is enforced twice — in the webview so
the user is told before a large post, and again in `routeOnboardingAction`,
because argv from a webview is never trusted on the grounds that the webview
already checked it.

**Create mode** has no `ticket_id` yet. The first attach calls `bindTicket`,
exactly as the first fetch already does, so the panel flips to edit mode
against a persisted draft. There is no attachment without a ticket, and reusing
the existing persist-on-bind path avoids inventing a staging lifecycle.

## Content-Security-Policy

`injectCsp(html, nonce)` becomes
`injectCsp(html, nonce, mediaSource?: string)`. When `mediaSource` is supplied,
the policy becomes:

```
default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>';
img-src <cspSource>; media-src <cspSource>;
```

Only the onboarding panel passes it. The other four webviews keep today's exact
policy. `'unsafe-inline'` stays out of `script-src` — nothing here needs it.

The `csp.ts` docblock currently asserts that no webview loads anything from
anywhere and that granting `cspSource` would widen the policy to sources no
asset uses. That stops being true, so the docblock is rewritten rather than
left standing as a false claim.

`localResourceRoots` is set explicitly to `[<globalStorage>/attachments]`.
This is *narrower* than VS Code's default (the extension root plus every
workspace folder), so the change tightens the panel while enabling the feature.
An attachment becomes readable by the webview — which is the point — and the
root grants nothing outside that directory.

## The `toWebviewUri` seam

Webview URIs can only be minted by a real `vscode.Webview`, and `state.ts` is
host-agnostic. So `OnboardingState.attachments` carries absolute filesystem
paths, and `OnboardingPanel` gains `toWebviewUri(path)`. The panel manager maps
the paths in `pushState`, immediately before `postMessage`.

Test fakes return the path unchanged, so existing onboarding tests are
unaffected. This has the same shape as the `setIcon(path)` seam already on the
interface.

## The strip

Below the textarea in `onboarding/webview.html`:

- image tiles render `<img>`; video tiles render
  `<video preload="metadata" controls>`
- each tile shows the original filename and size, with a `×` to detach
- clicking a tile posts `open-attachment`, which the host opens with
  `vscode.open`
- when there are no attachments the strip renders nothing — no placeholder
  chrome

## Agent-facing render

`TicketContext` gains `attachments: TicketContextAttachment[]`
(`kind`, `path`, `name`). `buildTicketContext` reads them via
`listAttachments`; `renderTicketContext` emits:

```markdown
## Attachments
- image: /…/attachments/12/a3f9e1.png — "login-error.png"
- video: /…/attachments/12/b1c4d2.mp4 — "repro.mov" (not agent-readable)
```

The section is omitted entirely when there are no attachments.

Because ticket-context shaping lives once, the launch seed and the
`karst context` CLI both get this with no second code path.

The `(not agent-readable)` marker is load-bearing: without it, an agent will
report on a video it never opened. This follows the same rule as `nonRunnable`
repositories — state the fact, do not leave it to be inferred from an absence.

## Lifecycle

- **Delete ticket** — rows purged via `TICKET_CHILD_TABLES`, directory removed
  via `reap.ts`. The directory removal happens host-side in `extension.ts`, not
  inside the store transaction: `store/` has no fs dependency and keeps none.
- **Archive ticket** — attachments are kept. Archive is reversible; destroying
  the evidence is not.
- **Detach** — the row is deleted, and the file is unlinked only when no other
  row for that ticket references the same `stored_name` (content-addressed
  names dedupe).

## Testing

Strict TDD, RED first.

- `attachments/kinds.test.ts` — whitelist accepts and rejects, including
  `.png.exe` and an extension-less name.
- `attachments/ingest.test.ts` — against a tmpdir: dedupe on identical bytes; a
  traversal-shaped `original_name` never reaches a path; over-cap bytes are
  rejected with a named reason.
- `store/attachments.test.ts` — CRUD, ticket scoping, cascade on
  `deleteTicket`.
- `context/ticketContext.test.ts` — the rendered section, the video marker, and
  the omit-when-empty case.
- `ui/onboarding/messages.test.ts` — malformed `attach-bytes` is rejected
  (non-string base64, missing name, over-cap) rather than thrown on.
- `ui/onboarding/webview.test.ts` — the strip renders both kinds.
- `ui/webviewCsp.test.ts` — onboarding's policy carries `img-src`/`media-src`;
  the other four webviews' policies are byte-identical to today's.
- `ui/onboarding/actions.test.ts` — a create-mode attach binds a draft ticket.

## Out of scope

- Drag & drop onto the prompt area.
- Attachments on the dashboard or sidebar ticket cards.
- A "link, don't copy" mode for large files already on disk.
