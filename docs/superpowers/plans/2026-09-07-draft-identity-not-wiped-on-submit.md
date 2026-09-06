# Saved-Draft Agent/Model Survives Submit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ticket form from wiping a saved draft's agent core / model / effort when the user reopens that draft and presses "Create & run" (or "Save") without re-touching the identity picker.

**Architecture:** The ticket-form webview owns a `draft` object for create mode. The unified agent picker writes `draft.selectedAgentProvider / selectedModel / selectedEffort` **only on an explicit user change**. The submit/save payload reads those draft fields with `||`, so on a reopened (edit-mode) draft they are still `null` and the payload carries `model: null, effort: null, agentProvider: null`. The host's `persistDraft` treats those as "Inherit" and writes `''` into the ticket row — clearing the user's saved pick. The launch path then resolves from the manifest default, which is exactly the reported symptom. Fix: mirror the pattern already used for `approach` (`draft.approach ?? lastSelectedApproach`) — cache the last host-pushed identity values in `lastSelectedAgentProvider / lastSelectedModel / lastSelectedEffort`, and make the picker's `onChange` store `''` (explicit "Inherit") rather than `null`, so an untouched picker (`null`) is distinguishable from a deliberate clear (`''`).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), plain-HTML webview (`src/ui/ticketForm/webview.html`), vitest. Webview logic is tested by `src/ui/ticketForm/webview.test.ts` via regex text-guards and `node:vm` (`loadFunction`) — there is no DOM harness.

**Spec:** This plan is its own spec — the ticket is `SELECTED-AGENT-AND-MODEL-IGNORED` ("Sometimes I have created task with save as draft with some specified model eg Claude + Opus. It shows proper preselected model in the create ticket form, but after create & run session it starts with global general agent + model").

## Global Constraints

- Commit style: Conventional Commits (`fix: …`), no attribution trailer beyond the repo's configured one.
- `npm run test:unit` and `npm run typecheck` must pass.
- Edit the SOURCE `src/ui/ticketForm/webview.html`; NEVER the `dist/` copy (`scripts/copy-assets.mjs` mirrors it).
- The webview is plain browser JS inside `<script>` — no imports, no TypeScript syntax there.
- Host-agnostic rule unchanged: no `vscode` import is added anywhere.
- TDD: write the failing test first, watch it fail, then implement.

## Root Cause (verified, read before touching anything)

- `src/ui/ticketForm/webview.html:1174-1176` — picker `onChange` stores `core || null`, `m || null`, `e || null`.
- `src/ui/ticketForm/webview.html:1449-1451` (submit) and `:1471,1480-1481` (save) — payload reads `draft.selectedModel || null` etc. An untouched reopened draft yields `null`.
- `src/ui/ticketForm/actions.ts:283-289` (`persistDraft`) — writes `model: input.model ?? ''`, `effort: input.effort ?? ''`, `agentProvider: input.agentProvider ?? ''`; `''` clears the column to NULL. This host behavior is CORRECT (`null` legitimately means "Inherit") and must not change.
- `src/ui/ticketForm/state.ts:410-415` — the host DOES push `selectedModel`, `selectedEffort`, `selectedAgentProvider` from the ticket row, which is why the reopened form displays the right values. Only the submit payload loses them.

The `approach` field does not have this bug because `src/ui/ticketForm/webview.html:1437` reads `draft.approach ?? lastSelectedApproach`. `agent` and `ticketType` do not have it because they read the live `<select>` DOM value. Only core/model/effort are affected.

## File Structure

- Modify `src/ui/ticketForm/webview.html` — three new module-scope `let`s, three assignments in `renderAgentIdentityPicker`, changed `onChange` semantics, changed submit/save payload reads.
- Modify `src/ui/ticketForm/webview.test.ts` — two new tests (one behavioral via `loadFunction`, one text-guard on both payloads).

No other file changes. No store/schema/manifest change.

---

### Task 1: The picker caches the pushed identity and marks an explicit clear as `''`

**Files:**
- Modify: `src/ui/ticketForm/webview.html:1126-1134` (add the three caches), `:1147-1180` (`renderAgentIdentityPicker`)
- Test: `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: three module-scope webview variables — `lastSelectedAgentProvider` (string | null), `lastSelectedModel` (string | null), `lastSelectedEffort` (string | null), each set on every `renderAgentIdentityPicker(...)` call from its `selectedProvider` / `selectedModel` / `selectedEffort` argument (`?? null`). `draft.selectedAgentProvider / selectedModel / selectedEffort` become `string` (possibly `''` = explicit Inherit) once the user touches the picker, and stay `null` while untouched. Task 2 reads all six.

- [ ] **Step 1: Write the failing test**

Append this test inside the existing `describe('ticket-form webview.html', ...)` block in `src/ui/ticketForm/webview.test.ts`, immediately before the `it('carries baseRefs on submit and save', ...)` test:

```ts
  // The reported bug (SELECTED-AGENT-AND-MODEL-IGNORED): a draft saved with an
  // explicit core/model reopened in edit mode showed the right pick, but submit
  // sent null for it (the picker only writes `draft` on an explicit change),
  // and the host's persistDraft turned that null into '' — clearing the column.
  // The render caches what the host pushed so the payload can fall back to it,
  // exactly like `approach` does through lastSelectedApproach.
  it('caches the host-pushed identity, and an explicit Inherit pick is "" not null', () => {
    const sandbox: Record<string, unknown> = {
      lastSelectedAgentProvider: undefined,
      lastSelectedModel: undefined,
      lastSelectedEffort: undefined,
      lastDefaultProvider: 'claude',
      lastModelCatalog: { claude: [], codex: [], antigravity: [], opencode: [] },
      lastRecentModels: {},
      draft: { selectedAgentProvider: null, selectedModel: null, selectedEffort: null },
      AGENT_PROVIDER_LABELS: { claude: 'Claude' },
      post: () => {},
      mountAgentPicker: (_root: unknown, opts: { onChange: (v: unknown) => void }) => {
        (sandbox as { capturedOnChange?: (v: unknown) => void }).capturedOnChange = opts.onChange;
        return { setDisabled: () => {} };
      },
      el: (id: string) =>
        id === 'agentIdentityPicker'
          ? {}
          : { classList: { toggle: () => {} } },
    };
    const render = loadFunction('renderAgentIdentityPicker', sandbox);
    render(['claude'], 'claude', 'claude', 'opus', 'sonnet', null, null, false);

    // What the host pushed is cached, so an untouched submit can fall back to it.
    expect(sandbox.lastSelectedAgentProvider).toBe('claude');
    expect(sandbox.lastSelectedModel).toBe('opus');
    expect(sandbox.lastSelectedEffort).toBe(null);

    // An explicit "Inherit" pick writes '' — falsy for the payload, but NOT
    // null, so it out-ranks the cache instead of being mistaken for untouched.
    const onChange = (sandbox as { capturedOnChange: (v: unknown) => void }).capturedOnChange;
    onChange({ core: '', model: '', effort: '' });
    const draft = sandbox.draft as Record<string, unknown>;
    expect(draft.selectedAgentProvider).toBe('');
    expect(draft.selectedModel).toBe('');
    expect(draft.selectedEffort).toBe('');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts -t 'caches the host-pushed identity'`
Expected: FAIL — `expected undefined to be 'claude'` (the caches do not exist yet) and, once past that, `expected null to be ''`.

- [ ] **Step 3: Add the three caches**

In `src/ui/ticketForm/webview.html`, directly after the existing `let lastDefaultProvider = 'claude';` line (~1126), insert:

```js
  // Last identity the HOST pushed for this ticket (state.selectedAgentProvider /
  // selectedModel / selectedEffort), mirroring lastSelectedApproach. A reopened
  // saved draft renders its persisted core/model/effort but leaves `draft.*`
  // null until the user actually touches the picker; without this cache the
  // submit payload would send null and persistDraft would clear the column —
  // the ticket would start on the settings default instead of the saved pick
  // (SELECTED-AGENT-AND-MODEL-IGNORED).
  let lastSelectedAgentProvider = null;
  let lastSelectedModel = null;
  let lastSelectedEffort = null;
```

- [ ] **Step 4: Fill the caches on every render**

In `renderAgentIdentityPicker` (~1152), directly after `lastDefaultProvider = defaultProvider || 'claude';`, insert:

```js
    lastSelectedAgentProvider = selectedProvider ?? null;
    lastSelectedModel = selectedModel ?? null;
    lastSelectedEffort = selectedEffort ?? null;
```

- [ ] **Step 5: Make an explicit Inherit pick `''` rather than `null`**

In the same function's `onChange` (~1174-1176), replace:

```js
        draft.selectedAgentProvider = core || null;
        draft.selectedModel = m || null;
        draft.selectedEffort = e || null;
```

with:

```js
        // '' (not null) is the EXPLICIT "Inherit" pick: null means "the user
        // never touched this picker", and the submit payload falls back to the
        // host-pushed cache for that case. Collapsing both to null is what made
        // a reopened draft lose its saved core/model.
        draft.selectedAgentProvider = core || '';
        draft.selectedModel = m || '';
        draft.selectedEffort = e || '';
```

(The reads at ~1153-1156 — `draft.selectedAgentProvider ?? selectedProvider ?? ''` — already treat `''` correctly, so the rendered picker is unchanged.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts -t 'caches the host-pushed identity'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "fix: cache the host-pushed agent identity in the ticket form"
```

---

### Task 2: Submit and Save fall back to the cached identity

**Files:**
- Modify: `src/ui/ticketForm/webview.html:1446-1451` (submit handler), `:1471,1480-1481` (save handler)
- Test: `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: `lastSelectedAgentProvider`, `lastSelectedModel`, `lastSelectedEffort` and the `''`-means-explicit-Inherit convention from Task 1.
- Produces: nothing later tasks depend on (final task).

- [ ] **Step 1: Write the failing test**

Append this test inside `describe('ticket-form webview.html', ...)` in `src/ui/ticketForm/webview.test.ts`, immediately after the test added in Task 1:

```ts
  // Both persist paths must fall back to the host-pushed identity when the
  // picker was never touched, or reopening a saved draft and pressing
  // "Create & run" clears the saved core/model/effort (persistDraft writes ''
  // for a null). `?? cache` then `|| null` keeps an explicit '' pick as null.
  it('falls back to the cached identity on submit and save when the picker is untouched', () => {
    for (const [kind, re] of [
      ['submit', /const model = \(draft\.selectedModel \?\? lastSelectedModel\) \|\| null;/],
      ['effort', /const effort = \(draft\.selectedEffort \?\? lastSelectedEffort\) \|\| null;/],
      [
        'provider',
        /const agentProvider = \(draft\.selectedAgentProvider \?\? lastSelectedAgentProvider\) \|\| null;/,
      ],
    ] as const) {
      const hits = HTML.match(new RegExp(re.source, 'g')) ?? [];
      // One occurrence in the submit handler, one in the save handler.
      expect(hits.length, `${kind} fallback should appear in both submit and save`).toBe(2);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts -t 'falls back to the cached identity'`
Expected: FAIL — `expected 0 to be 2` (the payload still reads `draft.selectedModel || null`).

- [ ] **Step 3: Update the submit handler**

In `src/ui/ticketForm/webview.html`, in the `el('submitBtn')` click handler (~1446-1451), replace:

```js
    // The UNIFIED picker writes the draft directly (draft.selectedModel /
    // draft.selectedEffort), so create-mode picks persist onto the new ticket
    // at submit. Empty = inherit.
    const model = draft.selectedModel || null;
    const effort = draft.selectedEffort || null;
    const agentProvider = draft.selectedAgentProvider || null;
```

with:

```js
    // The UNIFIED picker writes the draft directly (draft.selectedModel /
    // draft.selectedEffort) on an explicit change, so create-mode picks persist
    // onto the new ticket at submit. An UNTOUCHED picker leaves those null, so
    // fall back to what the host pushed (a reopened saved draft) exactly like
    // `approach` falls back to lastSelectedApproach — without it, persistDraft
    // would read null as "Inherit" and clear the saved pick. '' is the explicit
    // Inherit pick and correctly survives `??` to become null here.
    const model = (draft.selectedModel ?? lastSelectedModel) || null;
    const effort = (draft.selectedEffort ?? lastSelectedEffort) || null;
    const agentProvider = (draft.selectedAgentProvider ?? lastSelectedAgentProvider) || null;
```

- [ ] **Step 4: Update the save handler**

In the `el('saveBtn')` click handler, delete the early standalone line (~1471):

```js
    const agentProvider = draft.selectedAgentProvider || null;
```

and replace the later pair (~1480-1481):

```js
    const model = draft.selectedModel || null;
    const effort = draft.selectedEffort || null;
```

with:

```js
    // Same fallback as submit: an untouched picker must not clear the saved
    // core/model/effort of a reopened draft.
    const model = (draft.selectedModel ?? lastSelectedModel) || null;
    const effort = (draft.selectedEffort ?? lastSelectedEffort) || null;
    const agentProvider = (draft.selectedAgentProvider ?? lastSelectedAgentProvider) || null;
```

(`agentProvider` is only read in the `post({ type: 'save', ... })` call at the end of the handler, so moving its declaration down is safe — verify by reading the whole handler before editing.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts -t 'falls back to the cached identity'`
Expected: PASS

- [ ] **Step 6: Run the full webview + form suites and the typecheck**

Run:
```bash
npx vitest run src/ui/ticketForm/
npm run typecheck
```
Expected: all tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "fix: keep a saved draft's agent core and model on create & run"
```

---

### Task 3: Full verification

**Files:** none modified.

**Interfaces:** Consumes the behavior from Tasks 1-2. Produces nothing.

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:unit`
Expected: PASS (no failures). If `better-sqlite3` complains about the Node ABI, `pretest:unit` rebuilds it automatically — re-run once.

- [ ] **Step 2: Manual check in the Extension Dev Host (F5)**

1. F5 → Extension Dev Host.
2. Open the ticket form, pick core **Claude** + model **Opus**, press **Save** (draft, no run).
3. Reopen that draft from the sidebar — the picker shows Claude + Opus.
4. Press **Create & run** WITHOUT touching the picker.
5. The launched terminal must carry `--model` for Opus, and the dashboard's session card must show Claude/Opus — not the settings default.
6. Repeat once picking **Inherit (settings)** explicitly: that must still clear the ticket's pick and launch on the settings default.

- [ ] **Step 3: Record the result**

If step 2 shows the settings default, STOP and re-open the investigation — do not paper over it with a host-side change; `persistDraft`'s `?? ''` is deliberate.

---

## Self-Review

**Spec coverage:** The ticket's single symptom (saved draft's core/model ignored at "Create & run") is caused by the submit/save payload sending `null` for an untouched picker; Task 1 makes the untouched-vs-explicit distinction representable, Task 2 uses it in both payloads, Task 3 verifies end to end. The "Inherit" path (clearing a pick must still clear it) is covered by Task 1's `''` assertion and Task 3 step 2.6.

**Placeholder scan:** No TBDs, no "handle edge cases", every code step carries the literal code.

**Type consistency:** `lastSelectedAgentProvider` / `lastSelectedModel` / `lastSelectedEffort` are named identically in Tasks 1 and 2; `renderAgentIdentityPicker`'s parameter names (`selectedProvider`, `selectedModel`, `selectedEffort`) match the existing signature at `webview.html:1147`; `draft.selectedAgentProvider / selectedModel / selectedEffort` match the existing draft keys.
