# Save Ticket Without a Run — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution decision for this session:** inline execution (superpowers:executing-plans), single self-contained feature, research already loaded in-context — spawning fresh subagents would force re-deriving the same investigation.

**Goal:** Let a user persist a new (or edited) ticket from the onboarding page without triggering worktree creation + agent launch (`startTicket`).

**Architecture:** The `tickets` table already has no run/launch column — a ticket freshly created by `createTicket` sits at `stage_current='scope'`, `agent_state='none'`, zero `worktrees` rows until `startTicket` (extension.ts:508) runs `confirmScope` + `transition(...'scope'...)` + opens a session. So "run-less" is already a representable, already-read-tolerant state (verified: `scopeInside`, `buildDashboardState`, `listTickets` all handle zero worktrees / stage `scope` today via the existing "select a repo" failure path). The only missing piece is a UI/action path that persists a draft WITHOUT calling `startTicket`. Add a sibling `save` message/action next to the existing `submit`, sharing the persist logic via an extracted `persistDraft` helper. Also fix a copy bug in `buildNowLine` where the `scope` stage claims "the agent is gathering context" even when the stage never started (status `pending`) — this becomes visible far more often once run-less tickets are a first-class path.

**Tech Stack:** TypeScript, vitest, vscode webview (plain HTML/JS, no framework), better-sqlite3.

## Global Constraints

- No schema/migration changes — the ticket table already supports a run-less ticket.
- `submit()`'s existing observable behavior (order of posts, tests in `actions.test.ts`) must not change — refactor by extraction, not by rewriting its logic.
- Webview messages are a trust boundary: `parseOnboardingMessage` must validate the new `save` message's fields the same way `submit`'s are validated (non-empty `key`/`title`, `description` typed).
- Follow existing file conventions exactly (no new abstractions beyond what's needed): `errorMessage()`, `ctx.post`, `ctx.pushState`, busy-bracket pattern (`{type:'busy', what, on}`).

---

### Task 1: `save` message type + parsing + routing

**Files:**
- Modify: `src/ui/onboarding/messages.ts`
- Test: `src/ui/onboarding/messages.test.ts`

**Interfaces:**
- Produces: `TicketDraftFields` type `{ key: string; title: string; description: string; repos: string[]; approach: string | null; agent: string | null; model: string | null }` — shared shape for both `submit` and `save` messages/actions.
- Produces: `OnboardingMessage` gains `{ type: 'save' } & TicketDraftFields`.
- Produces: `OnboardingActions.save: (input: TicketDraftFields) => void | Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/onboarding/messages.test.ts`, inside the `parseOnboardingMessage` describe block (after the existing submit assertions):

```ts
  it('accepts a well-formed save message, mirroring submit validation', () => {
    expect(
      parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null,
    });
    expect(
      parseOnboardingMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
    expect(parseOnboardingMessage({ type: 'save', title: 't', description: 'd' })).toBeNull(); // missing key
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', description: 'd' })).toBeNull(); // missing title
    expect(parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't' })).toBeNull(); // missing description
  });
```

Add to the `routeOnboardingAction` describe block's `spyActions()` helper, add `save: vi.fn(),` to the returned object (TypeScript will fail to compile otherwise once `save` is required on `OnboardingActions`). Then add a new test:

```ts
  it('routes a valid save message to the save action', () => {
    const actions = spyActions();
    routeOnboardingAction(
      { type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8' },
      actions,
    );
    expect(actions.save).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/messages.test.ts`
Expected: FAIL — `parseOnboardingMessage` returns `null` for `type: 'save'` (unknown type), `routeOnboardingAction` never calls `actions.save`, and TS fails to compile `spyActions()` missing `save` / the `OnboardingActions` type not yet declaring `save`.

- [ ] **Step 3: Implement**

In `src/ui/onboarding/messages.ts`, replace the `OnboardingMessage` submit variant and add `save`:

```ts
export interface TicketDraftFields {
  key: string;
  title: string;
  description: string;
  repos: string[];
  approach: string | null;
  agent: string | null;
  model: string | null;
}

export type OnboardingMessage =
  | { type: 'fetch-source'; ref: string }
  | { type: 'suggest-signals'; service: string }
  | { type: 'save-signals'; service: string; signals: string[] }
  | { type: 'set-repos'; repos: string[] }
  | { type: 'set-approach'; id: string }
  | { type: 'set-agent'; id: string }
  // id may be '' — the "Inherit (settings)" choice, which clears the model.
  | { type: 'set-model'; id: string }
  | { type: 'analyze'; prompt: string }
  | { type: 'open-ticket-link'; url: string }
  | ({ type: 'submit' } & TicketDraftFields)
  // Persists the ticket like `submit`, but never calls startTicket — no
  // worktrees, no agent launch. The "save without a run" path.
  | ({ type: 'save' } & TicketDraftFields)
  | { type: 'request-state' };
```

Update `OnboardingActions`:

```ts
export interface OnboardingActions {
  fetchSource: (ref: string) => void;
  suggestSignals: (service: string) => void;
  saveSignals: (service: string, signals: string[]) => void;
  setRepos: (repos: string[]) => void;
  setApproach: (id: string) => void;
  setAgent: (id: string) => void;
  setModel: (id: string) => void;
  analyze: (prompt: string) => void;
  openTicketLink: (url: string) => void;
  submit: (input: TicketDraftFields) => void | Promise<void>;
  save: (input: TicketDraftFields) => void | Promise<void>;
  requestState: () => void;
}
```

Extract the shared field-parsing (used by both `submit` and `save`) as a module-level function, placed above `parseOnboardingMessage`:

```ts
/** Validate the shared draft-persist fields (submit and save both carry these). */
function parseDraftFields(m: Record<string, unknown>): TicketDraftFields | null {
  const str = (k: string): boolean => typeof m[k] === 'string' && (m[k] as string).length > 0;
  // description may be empty; key + title must be present. repos defaults to
  // [] and approach/agent to null when absent/malformed, so an older webview
  // (or a crafted message) degrades to "no scope" rather than being rejected.
  if (!(str('key') && str('title') && typeof m.description === 'string')) return null;
  const repos = isStringArray(m.repos) ? m.repos : [];
  const approach = typeof m.approach === 'string' && m.approach.length > 0 ? m.approach : null;
  const agent = typeof m.agent === 'string' && m.agent.length > 0 ? m.agent : null;
  const model = typeof m.model === 'string' && m.model.length > 0 ? m.model : null;
  return {
    key: m.key as string,
    title: m.title as string,
    description: m.description as string,
    repos,
    approach,
    agent,
    model,
  };
}
```

Replace the `case 'submit':` block in `parseOnboardingMessage` with:

```ts
    case 'submit': {
      const fields = parseDraftFields(m);
      return fields ? { type: 'submit', ...fields } : null;
    }
    case 'save': {
      const fields = parseDraftFields(m);
      return fields ? { type: 'save', ...fields } : null;
    }
```

(Remove the old inline `str` local from `parseOnboardingMessage` only if nothing else in that function still uses it — check: `fetch-source`, `suggest-signals` cases also call `str(...)`. Keep the existing `str` closure as-is for those; `parseDraftFields` has its own independent `str`. Do not delete the outer one.)

In `routeOnboardingAction`, add a case after `submit`:

```ts
    case 'save':
      // Fire-and-forget, same as submit: `save` reports its own outcome via
      // busy/error posts.
      void actions.save({
        key: msg.key,
        title: msg.title,
        description: msg.description,
        repos: msg.repos,
        approach: msg.approach,
        agent: msg.agent,
        model: msg.model,
      });
      return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/messages.test.ts`
Expected: PASS (this will still show TS errors from `actions.test.ts` and `actions.ts` not yet implementing `save` — that's Task 2. If vitest's TS transpile fails the whole file over a cross-file type error, proceed to Task 2 before re-running; otherwise this file alone should be green since `messages.ts` no longer requires `actions.ts` to know about `save`.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/messages.ts src/ui/onboarding/messages.test.ts
git commit -m "feat: add save message type for run-less ticket persistence"
```

---

### Task 2: `save` host action (persist without `startTicket`)

**Files:**
- Modify: `src/ui/onboarding/actions.ts`
- Test: `src/ui/onboarding/actions.test.ts`

**Interfaces:**
- Consumes: `TicketDraftFields` from `./messages.js` (Task 1).
- Produces: `buildOnboardingActions(deps)(ctx).save(input: TicketDraftFields): Promise<void>` — persists (create-or-update) the ticket + onboarding fields, posts `{type:'busy',what:'save',on:true/false}` around it, posts `{type:'error',message}` on failure, calls `ctx.pushState()` on success, and — critically — never calls `deps.startTicket`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/onboarding/actions.test.ts`, after the existing `submit` tests (before the `analyze` tests):

```ts
  it('save in create mode persists a ticket WITHOUT starting it', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-1', title: 'a draft', description: 'no run yet', repos: [], approach: null, agent: null, model: null,
    });

    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    const t = tickets[0]!;
    expect(t.key).toBe('DRAFT-1');
    expect(t.title).toBe('a draft');
    expect(t.description).toBe('no run yet');
    // run-less: never advanced past the seed stage, no session, no worktrees
    expect(t.stageCurrent).toBe('scope');
    expect(t.agentState).toBe('none');
    expect(t.sessionId).toBeNull();
    expect(startTicket).not.toHaveBeenCalled();
    expect(openDashboard).not.toHaveBeenCalled();
    expect(ctx.closes).toBe(0); // panel stays open
    expect(onCreated).toHaveBeenCalled();
  });

  it('save persists repos/approach/agent/model exactly like submit does', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-2', title: 't', description: '', repos: ['fe', 'be'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });

    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.selectedRepos).toEqual(['fe', 'be']);
    expect(t.approach).toBe('rpi');
    expect(t.agent).toBe('reviewer');
    expect(t.model).toBe('claude-opus-4-8');
  });

  it('save binds the create panel to the new draft (retrievable afterward)', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-3', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    const id = listTickets(store)[0]!.id;
    expect(ctx.ticketId).toBe(id);
    expect(getTicketByKey(store, 'DRAFT-3')?.id).toBe(id);
  });

  it('save in edit mode updates the existing ticket WITHOUT starting it, no duplicate', async () => {
    const t = createTicket(store, { key: 'OLD-S', title: 'old' });
    const ctx = mkCtx(t.id);
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'NEW-S', title: 'new title', description: '', repos: [], approach: null, agent: null, model: null });

    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBe('NEW-S');
    expect(reloaded.title).toBe('new title');
    expect(listTickets(store)).toHaveLength(1);
    expect(startTicket).not.toHaveBeenCalled();
  });

  it('save posts busy on/off around the persist and pushes fresh state on success', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-4', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    expect(ctx.posted[0]).toEqual({ type: 'busy', what: 'save', on: true });
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
    expect(ctx.pushes).toBeGreaterThan(0);
  });

  it('save posts a user-facing error and persists nothing when the store rejects the write', async () => {
    store.close();
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-5', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    expect(ctx.posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
  });
```

Also add `getTicketByKey` to the existing import from `../../store/tickets.js` at the top of the file (it currently imports `createTicket, getTicket, listTickets, updateTicketOnboarding` — add `getTicketByKey`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/actions.test.ts`
Expected: FAIL — `actions.save` is not a function (TS compile error / undefined at runtime).

- [ ] **Step 3: Implement**

In `src/ui/onboarding/actions.ts`, add `TicketDraftFields` to the import from `./messages.js`:

```ts
import type { OnboardingActions, TicketDraftFields } from './messages.js';
```

Above `buildOnboardingActions`, add the extracted persist helper:

```ts
/**
 * Create-or-update the ticket from onboarding's draft fields, and persist the
 * repo/approach/agent/model selection — the part `submit` and `save` share.
 * Binds a create-mode panel to the new ticket. Does NOT touch startTicket;
 * callers decide whether a run follows.
 */
function persistDraft(
  ctx: OnboardingActionsCtx,
  deps: OnboardingActionsDeps,
  input: TicketDraftFields,
): number {
  let ticketId: number;
  if (ctx.ticketId !== undefined) {
    updateTicketCore(deps.store, ctx.ticketId, { key: input.key, title: input.title });
    if (input.description) {
      updateTicketOnboarding(deps.store, ctx.ticketId, { description: input.description });
    }
    ticketId = ctx.ticketId;
  } else {
    const t = createTicketFlow(deps.store, {
      key: input.key,
      title: input.title,
      description: input.description || undefined,
      projectId: deps.projectId,
    });
    ctx.bindTicket(t.id);
    ticketId = t.id;
  }
  // Finishing onboarding (submit) or saving a draft (save) is the only chance
  // to record repo/approach/agent/model in pure create mode — the ticket
  // didn't exist before now, so setRepos/setApproach/setAgent never ran.
  updateTicketOnboarding(deps.store, ticketId, {
    selectedRepos: input.repos,
    ...(input.approach !== null ? { approach: input.approach } : {}),
    ...(input.agent !== null ? { agent: input.agent } : {}),
    // null = "Inherit"; persist '' so the store clears any prior pick to NULL.
    model: input.model ?? '',
  });
  deps.onChange();
  return ticketId;
}
```

Replace the start of `submit` (the persist block) to call the helper, keeping everything after identical:

```ts
    async submit(input): Promise<void> {
      const ticketId = persistDraft(ctx, deps, input);

      // Finishing onboarding hands the ticket off to the workflow: scope its
      // selected repos (worktrees, no servers) and launch the agent session.
      // Awaited so the page stays put (busy) while the launch runs, and the
      // handoff only happens once the ticket is really running.
      ctx.post({ type: 'busy', what: 'submit', on: true });
      try {
        const result = await deps.startTicket(ticketId);
        if (!result.ok) {
          ctx.post({ type: 'error', message: result.message });
          ctx.pushState(); // the ticket exists now — re-seed the page for a retry
          return;
        }
        // Running tickets belong to the dashboard: open it, then close this
        // page so the create/edit tab is replaced rather than left stale.
        deps.openDashboard(ticketId);
        ctx.close();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      } finally {
        // Un-busies the button on every failure path. On success the panel is
        // already disposed, which drops the post.
        ctx.post({ type: 'busy', what: 'submit', on: false });
      }
    },

    // Save without a run: persist like submit, but never call startTicket —
    // no worktrees, no agent launch. Leaves the panel open (now in edit mode,
    // bound to the persisted ticket) so the user can keep editing or start it
    // later from the same page.
    async save(input): Promise<void> {
      ctx.post({ type: 'busy', what: 'save', on: true });
      try {
        persistDraft(ctx, deps, input);
        ctx.pushState();
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      } finally {
        ctx.post({ type: 'busy', what: 'save', on: false });
      }
    },
```

Remove the old inline persist block that used to precede `updateTicketOnboarding`/`deps.onChange()` inside `submit` (it's now inside `persistDraft`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/actions.test.ts`
Expected: PASS — all existing `submit` tests still pass unchanged (behavior identical, only extracted), plus the new `save` tests pass.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, no regressions elsewhere (e.g. `panel.test.ts` which builds `OnboardingActions` fakes — check it compiles; if it constructs an actions object literal matching the interface, add `save: () => {}` there too).

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/actions.ts src/ui/onboarding/actions.test.ts
git commit -m "feat: persist a ticket without starting it (save action)"
```

---

### Task 3: Fix misleading "Now" line for a never-started ticket

**Files:**
- Modify: `src/model/nowLine.ts`
- Test: `src/model/nowLine.test.ts`

**Context:** `buildNowLine`'s `scope` case unconditionally returns "Now: scoping the ticket — the agent is gathering context." even when the stage's `status` is `pending` (i.e. `startTicket` never ran — no worktrees, no agent). This was a rare/transient state before (only reachable via the "select a repo" `startTicket` failure retry); it becomes a common, expected state once `save` (Task 2) is a first-class path. A run-less ticket's dashboard would falsely claim an agent is active.

- [ ] **Step 1: Write the failing tests**

Add to `src/model/nowLine.test.ts`, after the `impl` test:

```ts
  it('says not-started for a saved-but-never-run ticket (scope still pending)', () => {
    expect(buildNowLine(cell({ stageKey: 'scope', status: 'pending' }))).toEqual({
      text: 'Now: not started. Launch a session to begin.',
    });
  });

  it('still names live scoping once the scope stage is actually running', () => {
    expect(buildNowLine(cell({ stageKey: 'scope', status: 'running' }))).toEqual({
      text: 'Now: scoping the ticket — the agent is gathering context.',
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/model/nowLine.test.ts`
Expected: FAIL on the first new test — current code returns the "scoping" text regardless of status.

- [ ] **Step 3: Implement**

In `src/model/nowLine.ts`, replace the `case 'scope':` line:

```ts
    case 'scope':
      // A ticket saved without a run (§ save-without-run) sits here at
      // `pending` forever until startTicket runs — reuse the same "not
      // started" copy the null-cell (§ no stage row at all) case uses, so the
      // dashboard never claims an agent is active when nothing was launched.
      return cell.status === 'pending'
        ? { text: 'Now: not started. Launch a session to begin.' }
        : { text: 'Now: scoping the ticket — the agent is gathering context.' };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/model/nowLine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/nowLine.ts src/model/nowLine.test.ts
git commit -m "fix: don't claim scoping is live for a never-started ticket"
```

---

### Task 4: "Save" button in the onboarding webview

**Files:**
- Modify: `src/ui/onboarding/webview.html`

**Context:** `webview.html` is plain HTML/JS with no vitest coverage (confirmed: no `webview.html.test.*` exists in this repo; `panel.test.ts`/`state.test.ts`/`actions.test.ts`/`messages.test.ts` cover the TS side only). This task is verified by static review + the app's dev server (`npm run dev:extension` / F5), not vitest. Follow the existing `submitBtn` click handler exactly (same field-gathering logic), so behavior is proven-equivalent by inspection.

- [ ] **Step 1: Add the button**

In `src/ui/onboarding/webview.html`, find (around line 309-314):

```html
    <div class="stepbody last">
      <div class="footer" style="justify-content:flex-start;margin-top:2px">
        <button id="submitBtn">Create ticket</button>
        <button class="secondary" id="cancelBtn">Cancel</button>
      </div>
    </div>
```

Replace with:

```html
    <div class="stepbody last">
      <div class="footer" style="justify-content:flex-start;margin-top:2px">
        <button id="submitBtn">Create ticket</button>
        <button class="secondary" id="saveBtn">Save</button>
        <button class="secondary" id="cancelBtn">Cancel</button>
      </div>
    </div>
```

- [ ] **Step 2: Add the busy-lock helper**

Find (around line 701-710):

```js
  // Submit button busy lock. `submitLabel` is the idle text render() computed
  // for the current mode, restored when the launch finishes (or fails).
  let submitBusy = false;
  let submitLabel = 'Create & Run session';
  function setSubmitBusy(on) {
    submitBusy = on;
    const btn = el('submitBtn');
    btn.disabled = on;
    btn.textContent = on ? 'Starting session…' : submitLabel;
  }
```

Add immediately after it:

```js
  // Save button busy lock — no mode-dependent label (unlike submit), since
  // save never launches anything.
  let saveBusy = false;
  function setSaveBusy(on) {
    saveBusy = on;
    const btn = el('saveBtn');
    btn.disabled = on;
    btn.textContent = on ? 'Saving…' : 'Save';
  }
```

- [ ] **Step 3: Add the click handler**

Find the `submitBtn` click handler (around line 718-741):

```js
  el('submitBtn').addEventListener('click', () => {
    if (submitBusy) return; // a launch is already in flight
    const key = el('ref').value.trim();
    const title = el('title').value.trim();
    if (!key || !title) { showErr('Key and title are required.'); return; }
    clearErr(); // a retry starts clean — the previous failure no longer applies
    // Effective repo set: a repo counts as selected if the user toggled it on,
    // or (untouched) it was scored-selected by default. Carry repos + approach
    // in the payload so create-mode picks persist onto the new ticket at submit.
    const repos = lastRepos.filter(repoSelected).map((r) => r.service);
    const approach = draft.approach ?? lastSelectedApproach;
    // Read the live <select> value when the picker is showing agents: in create
    // mode `draft.selectedAgent` stays null until an explicit change event, yet
    // the browser visually pre-selects the first <option>. Reading the DOM value
    // captures that default so the shown agent is actually persisted (not null).
    const agent =
      approach === 'single-subagent' && lastAgents.length
        ? (draft.selectedAgent ?? el('agentSelect').value ?? null) || null
        : null;
    // Read the live <select> so the shown model is persisted even in create mode
    // (draft.selectedModel stays null until an explicit change). Empty = inherit.
    const model = (draft.selectedModel ?? el('modelSelect').value ?? '') || null;
    post({ type: 'submit', key, title, description: el('desc').value, repos, approach, agent, model });
  });
```

Change its guard to also block while a save is in flight (first line: `if (submitBusy) return;` → `if (submitBusy || saveBusy) return;`), then add a sibling handler right after the closing `});` of that block:

```js
  el('saveBtn').addEventListener('click', () => {
    if (submitBusy || saveBusy) return; // a save or launch is already in flight
    const key = el('ref').value.trim();
    const title = el('title').value.trim();
    if (!key || !title) { showErr('Key and title are required.'); return; }
    clearErr();
    // Same field-gathering as submit — save persists the identical draft, it
    // just never calls startTicket.
    const repos = lastRepos.filter(repoSelected).map((r) => r.service);
    const approach = draft.approach ?? lastSelectedApproach;
    const agent =
      approach === 'single-subagent' && lastAgents.length
        ? (draft.selectedAgent ?? el('agentSelect').value ?? null) || null
        : null;
    const model = (draft.selectedModel ?? el('modelSelect').value ?? '') || null;
    post({ type: 'save', key, title, description: el('desc').value, repos, approach, agent, model });
  });
```

- [ ] **Step 4: Wire the busy dispatch**

Find `setBusy` (around line 858-871):

```js
  function setBusy(what, on) {
    // The fetch button carries its own busy state; a failed fetch (on→false with
    // no brief) resets it to idle so the user can retry.
    if (what === 'fetch' && !on && !briefText) setFetchState('idle');
    // Submit runs worktree creation + the session launch, which take a beat.
    // Lock the button for the duration so it can't be fired twice, and say what
    // is happening — on success the panel closes and the dashboard takes over.
    if (what === 'submit') setSubmitBusy(on);
    if (what === 'analyze') {
      el('analyzeBusy').classList.toggle('hidden', !on);
      approachBusy = on;
      syncAnalyzeBtn();
    }
  }
```

Add a `save` branch:

```js
    if (what === 'submit') setSubmitBusy(on);
    if (what === 'save') setSaveBusy(on);
```

- [ ] **Step 5: Manual verification**

Run: `npm run build` (compiles + copies `webview.html` into `dist/`), then F5 to launch the Extension Dev Host (per repo `CLAUDE.md`: F5 runs `dev:extension` which rebuilds + copies assets).

In the running extension:
1. Open "Add ticket" (create mode). Type a key + title only (no repos/approach touched). Click **Save**. Verify: no terminal/session opens, the page stays open, the heading switches to the ticket's key (now in edit mode), and the ticket appears in the sidebar board at whatever its default facet is.
2. Reopen the sidebar/board, confirm the ticket lists correctly with no error, click into it (edit) — fields round-trip.
3. Click "Create & Run session" (submit) on a fresh ticket with a repo selected — confirm the existing run-linked flow (worktrees + session) still works unchanged.
4. On the run-less ticket from step 1, select a repo/approach and click "Create & Run session" (edit-mode submit) — confirm it can still be started later (no data loss).
5. Try Save with an empty key/title — confirm the existing "Key and title are required." error shows and nothing is created.

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/webview.html
git commit -m "feat: add Save button to persist a ticket without launching a run"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** save action without run (Task 2/4) · run association optional (already true, no schema change, documented in Architecture) · persistence accepts null run (already true) · validation on save enforces only key/title, never repo/approach (Task 1/2, mirrors submit's existing non-requirement of repos) · read paths tolerate missing run (verified pre-existing via `scopeInside`/`buildDashboardState`/zero-worktree handling; the one real gap found and fixed is Task 3) · errors surface user-facing message (Task 2's catch→post `error`) · tests for run-less creation, run-linked creation (unchanged, already covered), validation failure, reading a run-less ticket (Task 1 + Task 2 tests).
- **Placeholder scan:** none — every step has literal code/tests.
- **Type consistency:** `TicketDraftFields` defined once in `messages.ts`, imported into `actions.ts`; `persistDraft`'s parameter type and `save`/`submit`'s action signatures all reference it — no drift.
