# Unique Manual Ticket Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that a manually-created Karst ticket whose key was not pasted from a ticketing provider gets a generated key that is unique within its project, even when the ticket form's title-derived key preview is non-empty.

**Architecture:** The store already owns the unique-resolution authority (`generateTicketKey` in `src/store/tickets.ts`), but the ticket-form webview pre-fills the Key field with a title-derived preview, and on submit that previewed (non-empty) key is sent as the draft `key`. Because `persistDraft` only runs `generateTicketKey` when `key` is blank, a second same-titled manual ticket persists a duplicate key. Fix: the webview signals whether the key is auto-derived (`keyAutoDerived: !refTouched`), and `persistDraft` routes auto-derived keys through `generateTicketKey` so the existing collision-resolution logic (suffix `-2`, `-3`…) actually runs.

**Tech Stack:** TypeScript, better-sqlite3, vitest, plain-HTML webview (standalone, cannot import TS).

## Global Constraints

- Host-agnostic: `vscode` is NOT a runtime dep. All changed logic lives in vscode-free modules (`src/ui/ticketForm/*` imports no `vscode`).
- The webview is standalone HTML that CANNOT import TS. It mirrors `slugifyTitleKey` in plain JS (`deriveKey`), pinned by `webview.test.ts` — do not change that mirror.
- The webview↔host message boundary is a trust boundary: `parseTicketFormMessage` must validate any new field before it reaches an action.
- TDD (RED→GREEN), conventional commits, keep files <400 lines.
- Run a single test with `npx vitest run src/path/to.test.ts`; typecheck with `npm run typecheck`.
- The store's `generateTicketKey(store, scope, seedTitle)` and `slugifyTitleKey(title)` are unchanged — this plan only wires them into the auto-derived webview path.

---

### Task 1: Carry `keyAutoDerived` through the ticket-form message protocol

**Files:**
- Modify: `src/ui/ticketForm/messages.ts` — add the field to `TicketDraftFields`, parse it, thread it into `routeTicketFormAction` (submit + save)
- Test: `src/ui/ticketForm/messages.test.ts` — parse keeps `keyAutoDerived`, route passes it

**Interfaces:**
- Consumes: the existing `TicketDraftFields`, `parseDraftFields`, `routeTicketFormAction`.
- Produces: `TicketDraftFields.keyAutoDerived?: boolean` (optional on the TS interface so existing call sites without it still typecheck), always present as a boolean in the object returned by `parseDraftFields`, threaded into the `submit` and `save` actions. `keyAutoDerived === true` means "the key field content is the title-derived preview, not user-owned".

- [ ] **Step 1: Write the failing test**

Add to `describe('parseTicketFormMessage')` in `src/ui/ticketForm/messages.test.ts`:

```ts
it('records keyAutoDerived (auto-derived key) on submit and save', () => {
  const auto = { key: 'FIX-LOGIN-REDIRECT', title: 'Fix login redirect', description: 'd' };
  const submit = parseTicketFormMessage({ type: 'submit', ...auto, keyAutoDerived: true });
  expect(submit && 'keyAutoDerived' in submit).toBe(true);
  expect(submit && submit.keyAutoDerived).toBe(true);
  const save = parseTicketFormMessage({ type: 'save', ...auto, keyAutoDerived: true });
  expect(save && 'keyAutoDerived' in save).toBe(true);
  expect(save && save.keyAutoDerived).toBe(true);
  // Absent/malformed reads as false — a stale or crafted page must not claim auto-derivation.
  const absent = parseTicketFormMessage({ type: 'submit', ...auto });
  expect(absent && 'keyAutoDerived' in absent).toBe(true);
  expect(absent && absent.keyAutoDerived).toBe(false);
});

it('routes keyAutoDerived through to the submit and save actions', () => {
  const seen: string[] = [];
  const actions: TicketFormActions = {
    submit: (i) => { seen.push(`submit:${i.keyAutoDerived}`); },
    save: (i) => { seen.push(`save:${i.keyAutoDerived}`); },
    fetchSource: () => {}, searchTickets: () => {}, searchStatuses: () => {},
    suggestSignals: () => {}, saveSignals: () => {}, setRepos: () => {},
    setApproach: () => {}, setAgent: () => {}, setModel: () => {}, setEffort: () => {},
    setProvider: () => {}, setType: () => {}, analyze: () => {}, attachPick: () => {},
    attachBytes: () => {}, detachAttachment: () => {}, openAttachment: () => {},
    openTicketLink: () => {}, createProviderTicket: () => {}, requestState: () => {},
    closeForm: () => {},
  };
  routeTicketFormAction({ type: 'submit', key: 'K', title: 't', description: '', keyAutoDerived: true }, actions);
  routeTicketFormAction({ type: 'save', key: 'K', title: 't', description: '', keyAutoDerived: false }, actions);
  expect(seen).toEqual(['submit:true', 'save:false']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/ticketForm/messages.test.ts`
Expected: FAIL — `keyAutoDerived` is neither parsed nor routed (the parsed object has no such property; `i.keyAutoDerived` is `undefined`).

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/ticketForm/messages.ts`:

Add to the `TicketDraftFields` interface (after the `createInProvider` field, keeping its doc comment):

```ts
  createInProvider: boolean;
  /**
   * True when the Key field content is the title-derived preview, not text the
   * user typed or pasted (§ manual ticket creation). The webview computes this
   * as `!refTouched`. When true, the host re-resolves the key through
   * `generateTicketKey` at persist time so a same-titled manual ticket gets a
   * unique (suffixed) key instead of the previewed duplicate. Absent/false =
   * the key is user-owned and kept verbatim.
   */
  keyAutoDerived?: boolean;
```

In `parseDraftFields`, add `keyAutoDerived` to the returned object (after `createInProvider`):

```ts
    createInProvider,
    // Only an explicit `true` claims auto-derivation; absent or malformed reads
    // as "user-owned key" (a stale page must never be silently re-keyed).
    keyAutoDerived: m.keyAutoDerived === true,
```

In `routeTicketFormAction`, add `keyAutoDerived: msg.keyAutoDerived` to BOTH the `submit` and `save` action calls (alongside the existing `createInProvider: msg.createInProvider` lines).

- [ ] **Step 4: Update the two existing exact-match assertions**

The `submit` parse assertion (currently lines ~92-102) and the `save` parse assertion (lines ~106-110) use `toEqual`, which now needs the added `keyAutoDerived` member. Add `keyAutoDerived: false` to each expected object (e.g. `... ticketType: null, createInProvider: false, keyAutoDerived: false, pullBase: true`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/ui/ticketForm/messages.test.ts`
Expected: PASS (both new tests and the two updated exact-match assertions).

- [ ] **Step 6: Commit**

```bash
git add src/ui/ticketForm/messages.ts src/ui/ticketForm/messages.test.ts
git commit -m "feat: carry keyAutoDerived through the ticket-form message protocol"
```

---

### Task 2: Send `keyAutoDerived` from the webview

**Files:**
- Modify: `src/ui/ticketForm/webview.html` — include `keyAutoDerived: !refTouched` in the `submit` and `save` `post` payloads
- Test: `src/ui/ticketForm/webview.test.ts` — pin that both handlers send the flag

**Interfaces:**
- Consumes: the existing webview `refTouched` boolean and the two `post({ type: 'submit' | 'save', ... })` calls. Produces the `keyAutoDerived` field the host's `parseDraftFields` now expects.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/ticketForm/webview.test.ts` (it already loads the HTML and asserts on the inline `<script>`):

```ts
it('sends keyAutoDerived on submit and save, mirroring refTouched', () => {
  const submit = HTML.match(/post\(\{ type: 'submit',([\s\S]*?)\n  \}\);/);
  expect(submit, "submit post not found").toBeTruthy();
  expect(submit![1]).toContain('keyAutoDerived: !refTouched');
  const save = HTML.match(/post\(\{ type: 'save',([\s\S]*?)\n  \}\);/);
  expect(save, "save post not found").toBeTruthy();
  expect(save![1]).toContain('keyAutoDerived: !refTouched');
});
```

(Adjust the regexes to match the actual `post({...})` formatting in the file — the submit/save calls are the two at the current `submitBtn`/`saveBtn` click handlers. The key assertion is that `keyAutoDerived: !refTouched` appears in both payloads.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: FAIL — neither payload contains `keyAutoDerived`.

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/ticketForm/webview.html`, the `submitBtn` click handler's `post` (currently `post({ type: 'submit', key, title, description: ..., ..., createInProvider: createInOn, pullBase: pullBaseOn });`) — add `keyAutoDerived: !refTouched` before `pullBase`:

```js
post({ type: 'submit', key, title, description: el('desc').value, repos, approach, agent, model, effort, agentProvider, ticketType, createInProvider: createInOn, keyAutoDerived: !refTouched, pullBase: pullBaseOn });
```

In the `saveBtn` click handler's `post` (currently ends `..., createInProvider: createInOn });`) — add the same flag:

```js
post({ type: 'save', key, title, description: el('desc').value, repos, approach, agent, model, effort, agentProvider, ticketType, createInProvider: createInOn, keyAutoDerived: !refTouched });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "feat: send keyAutoDerived from the ticket-form webview"
```

---

### Task 3: Resolve a unique key for auto-derived keys at persist time

**Files:**
- Modify: `src/ui/ticketForm/actions.ts` — `persistDraft` routes auto-derived keys through `generateTicketKey`
- Test: `src/ui/ticketForm/actions.test.ts` — same-titled auto-derived submissions get distinct keys

**Interfaces:**
- Consumes: `TicketDraftFields.keyAutoDerived` (Task 1), `generateTicketKey(store, scope, seedTitle)` (already exported from `src/store/tickets.ts`), the existing `deps.store` / `deps.projectId` in `persistDraft`.
- Produces: `persistDraft` guarantees a unique key for a manual ticket whether the Key field is blank OR auto-derived (non-blank preview). A user-owned key is still kept verbatim.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/ticketForm/actions.test.ts` (same fixture style as the existing `'two blank-key submissions of the SAME title still get distinct keys'` test at ~line 524):

```ts
it('auto-derived (non-blank preview) submissions of the SAME title still get distinct keys', async () => {
  const mk = () => buildTicketFormActions(deps)({
    post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
  });
  // Simulates the webview: the Key field holds the derived preview (non-empty),
  // and keyAutoDerived tells the host it is NOT user-owned.
  const fields = { key: 'FIX-LOGIN-REDIRECT', title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null, createInProvider: false, keyAutoDerived: true };

  await mk().submit({ ...fields });
  await mk().submit({ ...fields });
  const keys = listTickets(store).map((t) => t.key).sort();
  expect(keys).toEqual(['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT-2']);
});

it('a user-owned key is kept verbatim even when it matches another ticket (no auto re-key)', async () => {
  const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
  const mk = () => buildTicketFormActions(deps)(ctx);
  const base = { title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null, createInProvider: false };

  await mk().submit({ ...base, key: 'FIX-LOGIN-REDIRECT', keyAutoDerived: false });
  await mk().submit({ ...base, key: 'FIX-LOGIN-REDIRECT', keyAutoDerived: false });
  const keys = listTickets(store).map((t) => t.key);
  expect(keys).toEqual(['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/ticketForm/actions.test.ts`
Expected: FAIL — the first test persists `['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT']` (the previewed duplicate) because `persistDraft` sees a truthy `input.key` and skips `generateTicketKey`. The second test currently passes and must keep passing.

- [ ] **Step 3: Write the minimal implementation**

In `src/ui/ticketForm/actions.ts`, in `persistDraft`, change the key resolution line (currently ~line 230) from:

```ts
  const key = input.key
    || generateTicketKey(deps.store, { projectId: deps.projectId }, input.title);
```

to:

```ts
  // A blank key, or a key the webview auto-derived from the title (not user
  // owned), is resolved here so the store's collision logic (`-2`, `-3`…)
  // actually runs. A user-typed/pasted key is kept verbatim.
  const key = input.keyAutoDerived || !input.key
    ? generateTicketKey(deps.store, { projectId: deps.projectId }, input.title)
    : input.key;
```

Add a debug line immediately before the resolution (the ticket-form actions are host-side, so use `deps.debug` if the deps object exposes it; otherwise match the surrounding module's logging pattern — verify whether `TicketFormActionsDeps` carries a `debug` callback before adding one, and inject it through `TicketFormActionsDeps` if it is missing):

```ts
  deps.debug?.(`[ticketForm] persistDraft keyAutoDerived=${input.keyAutoDerived ?? false} key=${(input.key ?? '').length ? '<present>' : '<blank>'}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/ticketForm/actions.test.ts`
Expected: PASS — the new first test yields `['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT-2']`; the existing blank-key and user-owned tests still pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/ticketForm/actions.ts src/ui/ticketForm/actions.test.ts
git commit -m "feat: resolve a unique key for auto-derived manual ticket keys"
```

---

### Task 4: Verify the full suite

**Files:**
- No new files. Verification only.

- [ ] **Step 1: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS (all store, ticket-form, webview, and CLI tests). Note this recompiles better-sqlite3 for the Node ABI via `pretest:unit`.

- [ ] **Step 2: Manual sanity check (optional, requires the Extension Dev Host via F5)**

1. F5 to launch the Extension Dev Host.
2. Open the ticket form, type a title (Key auto-fills with the derived preview).
3. Create the ticket once, then create a second with the SAME title.
4. Confirm the second ticket's key is `...-2`, not a duplicate.

- [ ] **Step 3: Commit any stragglers**

Run: `git status` — expect a clean tree (all changes committed in Tasks 1-3).

---

## Self-Review

**1. Spec coverage.** The ticket requires: "If ticket created manually, so key is not pasted as a source from ticketing provider, then key should be generated unique." Task 3 is the core fix (unique resolution in `persistDraft`). Task 1 (message protocol) and Task 2 (webview flag) supply the signal that distinguishes "auto-derived key" from "user-pasted key," which is the precise condition in the prompt. The store-level `generateTicketKey` already existed with full collision tests, so no new generation logic was needed. The CLI (`createTicket.ts`) and hook (`ticketApi.ts`) creation paths already derive-on-blank and are unaffected.

**2. Placeholder scan.** No TBD/TODO. All code steps contain concrete edits. The debug-line step is the one place that notes "match the surrounding module's logging pattern / verify whether `TicketFormActionsDeps` carries a `debug` callback" — this is an explicit conditional because the actual deps shape must be read before writing, not a hand-waved "add error handling." If `TicketFormActionsDeps` has no `debug`, use the injected-logging convention (`InstrumentOptions`-style) or drop the line rather than importing a global logger (the vscode-free rule).

**3. Type consistency.** `keyAutoDerived` is named identically in `TicketDraftFields` (Task 1), the parse return (Task 1), the webview payloads (Task 2), and `persistDraft`'s read (Task 3). `refTouched` already exists in the webview. `generateTicketKey(store, scope, seedTitle)` matches the existing exported signature in `src/store/tickets.ts`. The existing exact-match `messages.test.ts` assertions are explicitly updated in Task 1 Step 4 so the suite stays green.