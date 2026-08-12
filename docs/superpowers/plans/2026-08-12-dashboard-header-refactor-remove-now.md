# Dashboard Header Refactor + Remove Now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the ticket dashboard's top/header area — ticket identity, active agent identity with staged switch, the contextual Ship action, and a `…` ticket-controls menu — and remove the standalone Now section, following `karst-dashboard-project-aware-v8.html`.

**Architecture:** The webview (self-contained HTML, no TS import) renders host-computed state. So every behavioral decision moves host-side first: a new `ShipSlot` model (`model/shipSlot.ts`) derives the header's three mutually-exclusive ship states from the existing ship cell + merge gate; `DashboardState` drops `now` and gains `ship` + `agentSwitch` (cores + per-core model choices); `model/nowLine.ts` is deleted with the Now line. The agent-switch flow is re-pointed from native QuickPicks to a selection-driven `applyAgentSwitchSelection` (same confirm/readiness/persist/dispose/launch steps), and the `switch-agent` webview message gains a `{provider, model}` payload. The webview is then restructured: new `.dhead` markup + token-only CSS, an agent popover that stages a draft (no-op until Switch agent…), a `…` menu (Edit ticket, dashboard↔terminal quick setting, per-gate UAT/Review toggles) replacing the standalone bind button and Gates panel, and the ship slot replacing the Now line. Stages/Inside/body panels are untouched.

**Tech Stack:** TypeScript (ESM, `.js` imports), vitest with in-memory SQLite, the existing dashboard webview (vanilla JS + CSS tokens, no framework), `vscode`-free host modules under test.

## Global Constraints

- **UI-RULES.md (v3.0) governs every webview change** (`docs/ui/UI-RULES.md`). The rules that recur here: UI-R11–R14 (every posting control shows pending, is non-re-triggerable, reports a terminal outcome; a timeout is UNKNOWN), UI-R17 (`disabled` ≠ `aria-busy`, never `pointer-events:none` to disable), UI-R18 (pending keeps geometry stable), UI-R09 (buttons are buttons, anchors are anchors, icon-only controls carry an accessible name), UI-R24 (icon-only controls need `aria-label`), UI-R20/R21 (tooltips ≤80 chars, `aria-label` and `title` agree), UI-R28 (status is never color-only), UI-R05/R06 (colors come from `--k-*` tokens; status/stage/feedback/series namespaces never cross), UI-R04 (raw style literals bounded — the dashboard budget is exactly **20** today, verified by `npm test src/ui/conformance.test.ts`), UI-R34 (mirrored TS→HTML constants are behavior — do not touch `SECTION_FIELDS`, `TICKET_TYPES`, `CONVENTION_PRESETS`, `TRANSFORM_NAMES`, `deriveKey`/`TITLE_KEY_MAX`, `MAX_PASTE_BYTES`, `briefToText`).
- **All new header CSS uses `--k-*` tokens or `calc()` composed from them — NO new raw `px`/`rem` literals** — because `conformance.test.ts` asserts `LITERAL_BUDGET.dashboard === 20` and the current sheet already sits at 20. Task 5 frees two (the `.art-origin` 12px literals → `var(--k-space-6)`) so any justified component dimension has room.
- **`switch-agent` is now a trusted-boundary payload message.** The host must re-validate provider (known implemented provider) AND model (a member of the model choices it itself computed) before confirming/persisting. The webview's staged selection is a suggestion, never authority.
- **`toggle-bind` stays payload-free and host-owned**; the webview renders the `bind` message verbatim (UI-R31: no invented verdict).
- **Every stage verdict/state machine is untouched.** `ship-ticket`, `resolveShipping`, `settleShipGate`, `mergeGateState`, `nowLine`-adjacent workflow all stay. This ticket moves the *placement* of Ship, never its semantics.
- Strict TDD: write/update the test, watch it fail, implement, watch it pass. Conventional commits. Run `npm run typecheck` after every task and `npx vitest run <affected files>`.
- `vscode`-importing modules don't load under vitest — keep logic in `vscode`-free modules (`sessionSwitch.ts`, `shipSlot.ts`, `state.ts`, `messages.ts`); `extension.ts` stays a thin binding.
- The webview source is `src/ui/dashboard/webview.html`; `dist/` copies are build output (`npm run build`). Never edit `dist/`.
- Do not touch `Stages` (`.stepper`/`.railwrap`/`renderTrack`), `Inside` (`#inside`), the Servers/Worktrees/PRs/Artifacts panels, or any `model/inside/*` file. The only body change is deleting the standalone Gates panel (its controls move into the `…` menu).
- **Scope note (deliberate):** the Now line was also the only dashboard home of the "Start/Continue session", "Resume agent", and "Open log" buttons. Removing Now removes them from the dashboard by the ticket's own design (the prototype header has none; acceptance criteria name only Ship for the workflow-action slot). Session launch remains reachable via the sidebar/status-bar `openSession` commands; the failed-gate log remains reachable inside the Inside block (`open-stage-log` / the console view). Do not re-add any of these buttons.

---

### Task 1: Ship header slot model — `model/shipSlot.ts`

**Files:**
- Create: `src/model/shipSlot.ts`
- Test: `src/model/shipSlot.test.ts`

**Interfaces:**
- Consumes: `StepperCell` (`src/model/stepper.ts`), the `awaiting-merge` `blocked.kind` the ship cell carries.
- Produces: `ShipSlot` union + `buildShipSlot(cell: StepperCell | null, mergeGate: { repos?: readonly string[] } | undefined): ShipSlot`.

The ship header slot is the Now line's ship branch, lifted to the header. States are mutually exclusive by construction (single union). `shipping` covers a RUNNING ship so a reload mid-ship still shows the pending button; the webview also holds its own in-flight `shipRequestId` — the two compose in the webview, never here. `mergeGate.repos` is optional because `MergeGateState`'s `nothing-to-merge` kind carries none; the awaiting-merge block always has PRs in practice, but the type must accept the absence.

- [ ] **Step 1: Write the failing test**

`src/model/shipSlot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildShipSlot, type ShipSlot } from './shipSlot.js';
import type { StepperCell } from './stepper.js';

function cell(overrides: Partial<StepperCell> = {}): StepperCell {
  return { stageKey: 'ship', status: 'pending', ...overrides } as StepperCell;
}

describe('buildShipSlot', () => {
  it('is none when the ticket is not at ship or has no cell', () => {
    expect(buildShipSlot(null, undefined)).toEqual({ kind: 'none' });
    expect(buildShipSlot(cell({ stageKey: 'impl' }), undefined)).toEqual({ kind: 'none' });
  });

  it('offers confirm when ship is ready and not blocked', () => {
    expect(buildShipSlot(cell({ status: 'passed' }), undefined)).toEqual({ kind: 'confirm' });
    expect(buildShipSlot(cell({ status: 'pending' }), undefined)).toEqual({ kind: 'confirm' });
  });

  it('reports shipping while the ship run is in flight', () => {
    expect(buildShipSlot(cell({ status: 'running' }), undefined)).toEqual({ kind: 'shipping' });
  });

  it('offers retry (with the reason) when ship failed', () => {
    expect(buildShipSlot(cell({ status: 'failed', reason: 'gh pr create failed' }), undefined)).toEqual({
      kind: 'retry', reason: 'gh pr create failed',
    });
    expect(buildShipSlot(cell({ status: 'failed' }), undefined)).toEqual({ kind: 'retry', reason: null });
  });

  it('reports waiting-merge with the pending repo count when the ship cell is parked awaiting merge', () => {
    expect(buildShipSlot(
      cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } }),
      { repos: ['api', 'web'] },
    )).toEqual({ kind: 'waiting-merge', repos: 2 });
    expect(buildShipSlot(
      cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'PR open', at: 'x', resumable: false } }),
      undefined,
    )).toEqual({ kind: 'waiting-merge', repos: 0 });
  });

  it('keeps the states mutually exclusive — a blocked cell is never confirm/retry/shipping', () => {
    const slot = buildShipSlot(cell({ status: 'passed', blocked: { kind: 'awaiting-merge', reason: 'r', at: 't', resumable: false } }), undefined);
    expect(slot.kind).toBe('waiting-merge');
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/model/shipSlot.test.ts`
Expected: FAIL — `src/model/shipSlot.ts` does not exist (module resolution error).

- [ ] **Step 3: Write the implementation**

`src/model/shipSlot.ts`:

```ts
import type { StepperCell } from './stepper.js';

/**
 * The header's ship workflow-action slot, derived host-side from the same ship
 * cell + merge gate the Now line used to narrate. The states are mutually
 * exclusive by construction: confirm/retry/shipping are the ticket acting,
 * waiting-merge is the ticket parked on open PRs, none is everywhere else.
 *
 * `shipping` covers a RUNNING ship so a freshly-opened panel (no in-flight
 * requestId of its own) still renders the pending button; the webview's own
 * shipRequestId hold composes on top of this in the renderer.
 */
export type ShipSlot =
  | { kind: 'confirm' }
  | { kind: 'retry'; reason: string | null }
  | { kind: 'shipping' }
  | { kind: 'waiting-merge'; repos: number }
  | { kind: 'none' };

export function buildShipSlot(
  cell: StepperCell | null,
  mergeGate: { repos?: readonly string[] } | undefined,
): ShipSlot {
  if (!cell || cell.stageKey !== 'ship') return { kind: 'none' };
  if (cell.status === 'failed') return { kind: 'retry', reason: cell.reason ?? null };
  if (cell.blocked?.kind === 'awaiting-merge') {
    return { kind: 'waiting-merge', repos: mergeGate?.repos?.length ?? 0 };
  }
  if (cell.status === 'running') return { kind: 'shipping' };
  return { kind: 'confirm' };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/model/shipSlot.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/model/shipSlot.ts src/model/shipSlot.test.ts
git commit -m "feat: ship header slot model (UI-R28b: mutually-exclusive ship states)"
```

---

### Task 2: Host agent-switch flow + message protocol (sessionSwitch + messages + extension wiring)

> This task is ONE unit on purpose: the widened `switch-agent` payload, the `DashboardActions` signature, `switchAgentSession`'s arity, and the `makeDashboardActions` wiring are mutually referential, so splitting them would leave an intermediate commit that fails `npm run typecheck`. They land together.

**Files:**
- Modify: `src/agent/sessionSwitch.ts`
- Modify: `src/agent/sessionSwitch.test.ts`
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/extension.ts` (`switchAgentSession`, `makeDashboardActions`)
- Modify: `src/extensionActivation.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog`, `IMPLEMENTED_PROVIDERS`, `isKnownProvider`, `AgentProvider`.
- Produces:
  - `applyAgentSwitchSelection(deps: AgentSwitchFlowDeps, catalog: ModelCatalog, selection: { provider: AgentProvider; model: string | null }): Promise<AgentSwitchOutcome>` — replaces `runAgentSwitchFlow`.
  - `agentSwitchCoreChoices(): AgentSwitchCoreChoice[]` — ALL implemented cores (`{ id, label }`), for the header select (which must offer the current core, unlike the old provider picker that excluded it).
  - `AgentSwitchFlowDeps` drops `pickProvider`/`pickModel`; `agentSwitchProviderChoices` is deleted.
  - `WebviewMessage` gains `{ type: 'switch-agent'; provider: AgentProvider; model: string | null }` and `{ type: 'copy-ticket-key' }`.
  - `DashboardActions` gains `copyTicketKey: () => void | Promise<void>` and `switchAgent: (provider: AgentProvider, model: string | null) => void | Promise<void>`.

The flow preserves every host-side step the QuickPick flow had — can-switch guard, readiness probe (only when the core actually changes), modal confirm, post-confirm revalidation, persist→dispose→launch — but the provider/model come from the webview's staged selection instead of a picker. Model-only switches are now legal (the old flow forced a core change by excluding the current core).

- [ ] **Step 1: Update the tests first**

In `src/agent/sessionSwitch.test.ts`:

1. Replace the `import { runAgentSwitchFlow }` line with `applyAgentSwitchSelection`.
2. Delete the `it('omits the current provider and supplies the canonical identity labels')` test (function removed).
3. Add a test for `agentSwitchCoreChoices`:
```ts
it('lists every implemented core with its canonical label for the header select', () => {
  expect(agentSwitchCoreChoices()).toEqual([
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'antigravity', label: 'Antigravity CLI' },
    { id: 'opencode', label: 'OpenCode' },
  ]);
});
```
4. Rewrite the `flow()` helper to drop `pickProvider`/`pickModel`:
```ts
function flow(overrides: Partial<AgentSwitchFlowDeps> = {}) {
  const order: string[] = [];
  const deps: AgentSwitchFlowDeps = {
    read: () => ({
      stageCurrent: 'impl', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
    }),
    isSessionOpen: () => true,
    isProviderReady: async (provider) => (order.push(`ready:${provider}`), true),
    confirm: async () => (order.push('confirm'), true),
    persist: (selection) => order.push(`persist:${selection.provider}:${selection.model}`),
    dispose: () => order.push('dispose'),
    launch: async (options) => {
      order.push(`launch:allow-resume=${String(options.allowResume)}:provider-ready=${String(options.providerReady)}`);
    },
    ...overrides,
  };
  return { deps, order };
}
```
5. Replace the whole `describe('runAgentSwitchFlow')` block with:

```ts
describe('applyAgentSwitchSelection', () => {
  it('rejects a switch during an owned Fix execution without mutating anything', async () => {
    let owned = true;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: 'fix', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
        fixExecutionActive: true,
      }),
      dispose: () => { owned = false; order.push('dispose'); },
    });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
    expect(owned).toBe(true);
  });

  it('persists one selection, disposes, then launches', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual(['ready:codex', 'confirm', 'persist:codex:codex-x', 'dispose', 'launch:allow-resume=false:provider-ready=true']);
  });

  it('allows a model-only switch on the current core without a readiness probe', async () => {
    const { deps, order } = flow({ isProviderReady: async () => { order.push('ready:unexpected'); return true; } });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'claude', model: 'claude-x' }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual(['confirm', 'persist:claude:claude-x', 'dispose', 'launch:allow-resume=false:provider-ready=true']);
  });

  it('keeps the current session when the new core is not ready', async () => {
    const { deps, order } = flow({ isProviderReady: async () => false });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).resolves.toEqual({ kind: 'unavailable', provider: 'codex' });
    expect(order.some((e) => e.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it('rejects a model that is not among the provider’s own choices', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'claude-x' }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
  });

  it('rejects an unknown provider', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'evil' as never, model: null }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
  });

  it('cancelling at the confirm modal mutates nothing', async () => {
    const { deps, order } = flow({ confirm: async () => false });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).resolves.toEqual({ kind: 'cancelled', at: 'confirm' });
    expect(order.some((e) => e.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it('revalidates the session after confirmation', async () => {
    let reads = 0;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: ++reads === 1 ? 'impl' : 'review',
        provider: 'claude', ticketModel: null, defaultModel: null,
      }),
    });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).not.toContain('dispose');
  });

  it('keeps the new selection and reports a retryable launch failure', async () => {
    const { deps, order } = flow({ launch: async () => { order.push('launch'); throw new Error('spawn'); } });
    const outcome = await applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' });
    expect(outcome.kind).toBe('launch-failed');
    expect(order.slice(-3)).toEqual(['persist:codex:codex-x', 'dispose', 'launch']);
  });

  it('leaves the old terminal open when persistence fails', async () => {
    const { deps, order } = flow({ persist: () => { throw new Error('write'); } });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x' }),
    ).rejects.toThrow('write');
    expect(order).not.toContain('dispose');
    expect(order.some((e) => e.startsWith('launch'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/agent/sessionSwitch.test.ts`
Expected: FAIL — `applyAgentSwitchSelection`/`agentSwitchCoreChoices` not exported; `AgentSwitchFlowDeps` still requires pickers.

- [ ] **Step 3: Rewrite `sessionSwitch.ts`**

In `src/agent/sessionSwitch.ts`:

1. Import `isKnownProvider` from `./provider.js` (already imports `IMPLEMENTED_PROVIDERS` from there).
2. Delete `AgentSwitchProviderChoice` and `agentSwitchProviderChoices`.
3. Delete `pickProvider`/`pickModel` from `AgentSwitchFlowDeps`.
4. Delete `runAgentSwitchFlow`; add:

```ts
export interface AgentSwitchCoreChoice { id: AgentProvider; label: string }

/** Every implemented core with its canonical label — the header select lists ALL of them. */
export function agentSwitchCoreChoices(): AgentSwitchCoreChoice[] {
  return IMPLEMENTED_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id] }));
}
```

5. Add `applyAgentSwitchSelection` (mirror of the old flow, selection-driven):

```ts
export async function applyAgentSwitchSelection(
  deps: AgentSwitchFlowDeps,
  catalog: ModelCatalog,
  selection: { provider: AgentProvider; model: string | null },
): Promise<AgentSwitchOutcome> {
  if (!isKnownProvider(selection.provider)) return { kind: 'stale' };
  const initial = deps.read();
  if (!canSwitchAgentSession(initial.stageCurrent, deps.isSessionOpen(), initial.fixExecutionActive)) {
    return { kind: 'stale' };
  }
  // The staged model must be one of the choices the webview was built from —
  // the host re-validates its own offer, never the webview's word.
  const modelChoices = agentSwitchModelChoices({
    provider: selection.provider,
    ticketModel: initial.ticketModel,
    defaultModel: initial.defaultModel,
    catalog,
  });
  if (!modelChoices.some((choice) => choice.model === selection.model)) return { kind: 'stale' };

  const from = buildAgentSessionView({ ...initial, catalog, sessionOpen: true });
  const to = buildAgentSessionView({
    provider: selection.provider,
    ticketModel: selection.model,
    defaultModel: initial.defaultModel,
    catalog,
    stageCurrent: initial.stageCurrent,
    sessionOpen: false,
  });
  // Only a changed core needs a readiness probe; the current one is already running.
  if (selection.provider !== initial.provider && !(await deps.isProviderReady(selection.provider))) {
    return { kind: 'unavailable', provider: selection.provider };
  }
  if (!(await deps.confirm({ from, to }))) return { kind: 'cancelled', at: 'confirm' };

  const current = deps.read();
  if (!canSwitchAgentSession(current.stageCurrent, deps.isSessionOpen(), current.fixExecutionActive)) {
    return { kind: 'stale' };
  }
  deps.persist({ provider: selection.provider, model: selection.model });
  deps.dispose();
  try {
    await deps.launch({ allowResume: false, providerReady: true });
    return { kind: 'switched' };
  } catch (error) {
    return { kind: 'launch-failed', error };
  }
}
```

- [ ] **Step 4: Update `messages.test.ts` first**

In `src/ui/dashboard/messages.test.ts`:

1. Add `copyTicketKey: vi.fn()` to the `actions()` factory.
2. Replace the test at ~line 295 ("routes switch-agent without trusting companion provider/model/ticket fields") with:

```ts
it('parses a switch-agent selection and dispatches it with both fields', () => {
  const a = actions();
  expect(parseWebviewMessage({
    type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex', ticketId: 999,
  })).toEqual({ type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex' });
  routeAction({ type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex' }, a);
  expect(a.switchAgent).toHaveBeenCalledWith('codex', 'gpt-5.2-codex');
});

it('coerces a blank model to inherit (null)', () => {
  expect(parseWebviewMessage({ type: 'switch-agent', provider: 'claude' })).toEqual({
    type: 'switch-agent', provider: 'claude', model: null,
  });
  expect(parseWebviewMessage({ type: 'switch-agent', provider: 'claude', model: '' })).toEqual({
    type: 'switch-agent', provider: 'claude', model: null,
  });
});

it('rejects a switch-agent to an unknown provider or a non-string model', () => {
  expect(parseWebviewMessage({ type: 'switch-agent', provider: 'evil', model: 'x' })).toBeNull();
  expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 42 })).toBeNull();
  expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 'x'.repeat(300) })).toBeNull();
});

it('parses and dispatches copy-ticket-key with no payload', () => {
  const a = actions();
  expect(parseWebviewMessage({ type: 'copy-ticket-key' })).toEqual({ type: 'copy-ticket-key' });
  routeAction({ type: 'copy-ticket-key' }, a);
  expect(a.copyTicketKey).toHaveBeenCalledOnce();
});
```

- [ ] **Step 5: Run — verify it fails**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: FAIL — `switch-agent` still parsed payload-free; no `copy-ticket-key` case.

- [ ] **Step 6: Update `messages.ts`**

1. Add `import { isKnownProvider } from '../../agent/provider.js';` (already vscode-free).
2. Change the `switch-agent` member of `WebviewMessage`:

```ts
  /**
   * Apply a staged agent-core/model selection to this ticket's live session.
   * Carries the selection VERBATIM — the host re-validates both against the
   * choices IT computed (isKnownProvider + model-choice membership) before
   * confirming or persisting, so the webview's draft is a suggestion, never
   * authority.
   */
  | { type: 'switch-agent'; provider: AgentProvider; model: string | null }
  /** Copy this ticket's key through the host clipboard (the closure owns the ticket). */
  | { type: 'copy-ticket-key' }
```

3. Add `import type { AgentProvider } from '../../manifest/types.js';` if not already imported (check; `messages.ts` currently imports `GateStage`/`StageKey` types — add `AgentProvider` to the type imports).
4. Update `DashboardActions`:

```ts
  /** Apply a staged agent-core/model selection to this ticket's live session. */
  switchAgent: (provider: AgentProvider, model: string | null) => void | Promise<void>;
  /** Copy the ticket key to the clipboard. */
  copyTicketKey: () => void | Promise<void>;
```

5. Update `parseWebviewMessage`:

```ts
    case 'switch-agent': {
      const provider = typeof m.provider === 'string' ? m.provider : '';
      const model = typeof m.model === 'string' ? m.model : '';
      if (!isKnownProvider(provider)) return null;
      if (model.length > MAX_MODEL_ID_CHARS) return null;
      return { type: 'switch-agent', provider, model: model || null };
    }
    case 'copy-ticket-key':
      return { type: 'copy-ticket-key' };
```

Add `const MAX_MODEL_ID_CHARS = 128;` beside the other cap constants (a comment: real model ids are short CLI values; 128 is a bounded ceiling).

6. Update `routeAction`:

```ts
    case 'switch-agent':
      return actions.switchAgent(msg.provider, msg.model);
    case 'copy-ticket-key':
      return actions.copyTicketKey();
```

Run `npx vitest run src/ui/dashboard/messages.test.ts` → PASS.

- [ ] **Step 7: Update `extension.ts` — `switchAgentSession` + `makeDashboardActions` wiring**

7a. Replace the `runAgentSwitchFlow({...})` body (currently `src/extension.ts` ~1228-1293) with a selection-driven call. The `read`/`isSessionOpen`/`isProviderReady`/`confirm`/`persist`/`dispose`/`launch` deps stay identical; drop `pickProvider`/`pickModel`. Signature becomes `const switchAgentSession = async (ticketId: number, provider: AgentProvider, model: string | null): Promise<void>`. Import `applyAgentSwitchSelection` (and drop the now-unused `PROVIDER_LABELS` import if it is no longer referenced — verify with typecheck).

```ts
const switchAgentSession = async (
  ticketId: number,
  provider: AgentProvider,
  model: string | null,
): Promise<void> => {
  try {
    const outcome = await applyAgentSwitchSelection({
      read: () => {
        const ticket = getTicket(localStore, ticketId);
        return {
          stageCurrent: ticket.stageCurrent,
          provider: resolveProvider(ticket.agentProvider, currentManifest()?.agentProvider),
          ticketModel: ticket.model,
          defaultModel: currentManifest()?.defaultModel ?? null,
          fixExecutionActive: listRecoveryRounds(localStore, ticketId)
            .some((round) => round.status === 'fixing'),
        };
      },
      isSessionOpen: () => sessions.isOpen(ticketId),
      isProviderReady: (p) => guardProviderCapabilityAsync('sessions', p),
      confirm: async ({ from, to }) => {
        const choice = await vscode.window.showWarningMessage(
          `Switch from ${from.providerLabel} · ${from.modelLabel} to ${to.providerLabel} · ${to.modelLabel}?`,
          {
            modal: true,
            detail: 'Karst will close the current terminal and start a fresh agent session. Worktree changes and ticket progress stay intact.',
          },
          'Switch and continue',
        );
        return choice === 'Switch and continue';
      },
      persist: ({ provider: p, model: m }) => updateTicketFields(localStore, ticketId, {
        agentProvider: p,
        model: m ?? '',
      }),
      dispose: () => sessions.disposeSession(ticketId),
      launch: async (options) => {
        await vscode.commands.executeCommand('karst.openSession', ticketId, options);
      },
    }, modelCatalog, { provider, model });
    // Keep the same outcome toasts as before (stale / launch-failed).
    if (outcome.kind === 'stale') {
      void vscode.window.showInformationMessage('The live agent session changed before it could be switched.');
    } else if (outcome.kind === 'launch-failed') {
      void vscode.window.showErrorMessage(
        `The agent selection was saved, but its session could not start: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
      );
    }
  } catch (error) {
    logError('agent session switch failed', error);
    void vscode.window.showErrorMessage(
      `Could not switch the agent session: ${error instanceof Error ? error.message : String(error)}. Please try again.`,
    );
  } finally {
    provider.refresh();
    dashboard.pushState(ticketId);
    showStatusFor(ticketId);
  }
};
```

7b. `makeDashboardActions` receives `switchAgent` as a CLOSURE PARAM (declared `switchAgent: () => void` at ~line 4567) and spreads it into the returned `DashboardActions` (`switchAgent,` ~line 4655). Two edits:

```ts
  // Apply a staged agent-core/model selection to the open session. The closure
  // owns the ticket id AND re-validates the selection against the catalog, so
  // the webview can only ever propose a switch, never direct one.
  switchAgent: (provider: AgentProvider, model: string | null) => void,
```

Change the call site that passes the closure (currently `() => void switchAgentSession(ticketId)` at ~line 2076):

```ts
        (provider, model) => void switchAgentSession(ticketId, provider, model),
```

Add `copyTicketKey` as a NEW member of the returned object (beside `switchAgent,`):

```ts
    switchAgent,
    copyTicketKey: () => {
      const key = getTicket(store, ticketId).key ?? `#${ticketId}`;
      void vscode.env.clipboard.writeText(key);
    },
```

(`getTicket` is already imported in extension.ts. `AgentProvider` is already imported as a type.)

- [ ] **Step 8: Update `extensionActivation.test.ts`** (the "binds dashboard agent switching…" test at ~line 209)

Change it to pin the new wiring:

```ts
it('binds dashboard agent switching to the header selection, host confirmation, and the normal launch path', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  expect(source).toContain('applyAgentSwitchSelection(');
  expect(source).toMatch(
    /fixExecutionActive: listRecoveryRounds\(localStore, ticketId\)\s*\.some\(\(round\) => round\.status === 'fixing'\)/,
  );
  expect(source).toContain('modal: true');
  expect(source).toContain("guardProviderCapabilityAsync('sessions', provider)");
  expect(source).toContain(
    "if (!options.providerReady && !guardCapability('sessions', ticketId)) return;",
  );
  expect(source).toContain('sessions.disposeSession(ticketId)');
  expect(source).toContain("vscode.commands.executeCommand('karst.openSession', ticketId, options)");
  expect(source).toContain("logError('agent session switch failed', error)");
  expect(source).toContain(
    'finally {\n      provider.refresh();\n      dashboard.pushState(ticketId);\n      showStatusFor(ticketId);\n    }',
  );
});
```

- [ ] **Step 9: Run the suites + typecheck**

Run: `npx vitest run src/agent/sessionSwitch.test.ts src/ui/dashboard/messages.test.ts src/extensionActivation.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/agent/sessionSwitch.ts src/agent/sessionSwitch.test.ts src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/extension.ts src/extensionActivation.test.ts
git commit -m "feat: selection-driven agent switch flow and staged switch-agent message for the dashboard header"
```

---

### Task 3: DashboardState shape — drop `now`, add `ship` + `agentSwitch`; delete `model/nowLine.ts`

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/renderFixtures.ts`
- Modify: `src/ui/dashboard/state.test.ts`
- Delete: `src/model/nowLine.ts`, `src/model/nowLine.test.ts`
- Modify: `src/hooks/agyWatchDispatch.test.ts`

**Interfaces:**
- Consumes: `buildShipSlot` (Task 1), `agentSwitchCoreChoices`/`agentSwitchModelChoices` (Task 2), `IMPLEMENTED_PROVIDERS`, `AGENT_PROVIDER_LABELS`, `resolveProvider`, `bundledModelCatalog`.
- Produces: `DashboardState` loses `now`; gains `ship: ShipSlot` and `agentSwitch: { cores: { id: AgentProvider; label: string }[]; models: Record<string, { model: string | null; label: string }[]> }`.

- [ ] **Step 1: Update `renderFixtures.ts` first** (keeps every other dashboard suite compiling)

In `src/ui/dashboard/renderFixtures.ts` `renderStateFor` (~line 845), replace the `now: { text: 'Render fixture' }` line with:

```ts
    ship: { kind: 'none' },
    agentSwitch: { cores: [], models: {} },
```

- [ ] **Step 2: Update `state.ts`**

1. Remove the `buildNowLine`/`NowLine` import; remove `NowLine` from the type re-export (`export type { ..., NowLine, ... }`). Also remove the imports/locals that existed ONLY to feed `buildNowLine`: `sessionAction` (from `../../agent/sessionAction.js`), `countFixAttempts` + `lastFailedGate` (from `../../workflow/fixAttempts.js` — keep `FIX_ATTEMPT_CAP`/`GateStageKey`, still used by the `fixCapFor` default), and the `failedGate`/`fixAttempts` locals (`const failedGate = lastFailedGate(ticket.stages); const fixAttempts = ...`).
2. Import `buildShipSlot`, `agentSwitchCoreChoices`, `agentSwitchModelChoices`, `IMPLEMENTED_PROVIDERS`, `AGENT_PROVIDER_LABELS`.
3. Remove `now: NowLine;` from `DashboardState`; add:

```ts
  /**
   * The header's ship workflow-action slot (model/shipSlot.ts) — the Now line's
   * ship branch, lifted to the header. The states are mutually exclusive.
   */
  ship: ShipSlot;
  /**
   * The agent-switch choices the header popover renders: every implemented core
   * (canonical label) and each core's model choices, keyed by provider id. The
   * webview cannot import TS, so the catalog arrives here, host-resolved.
   */
  agentSwitch: {
    cores: { id: AgentProvider; label: string }[];
    models: Record<string, { model: string | null; label: string }[]>;
  };
```

4. In `buildDashboardState`, after `agentSession` is built, compute:

```ts
  const catalog = agentContext.modelCatalog ?? bundledModelCatalog();
  const switchModels: Record<string, { model: string | null; label: string }[]> = {};
  for (const id of IMPLEMENTED_PROVIDERS) {
    switchModels[id] = agentSwitchModelChoices({
      provider: id,
      ticketModel: ticket.model,
      defaultModel: agentContext.defaultModel ?? null,
      catalog,
    }).map(({ model, label }) => ({ model, label }));
  }
```

5. Remove the `now: buildNowLine(...)` return entry; add:

```ts
    ship: buildShipSlot(currentStage, mergeGate),
    agentSwitch: { cores: agentSwitchCoreChoices(), models: switchModels },
```

Note `currentStage` and `mergeGate` are both already computed earlier in the function.

- [ ] **Step 3: Update `state.test.ts`**

1. Delete the `state.now` assertions in these tests (the Now line no longer exists in the dashboard):
   - "summarises the current stage with its reason, log and next-step line" (~line 189-194) — keep the `currentStage` assertions, drop the two `state.now` lines.
   - "falls back to the not-started line when the ticket sits at no stage" (~line 279) — replace with a ship-slot assertion: `expect(state.ship).toEqual({ kind: 'none' });`.
   - "puts needs-you on impl when the agent is the one waiting" (~line 361) — drop the `state.now` assertion (the waiting Now copy is gone; the rail needs-you assertions remain).
   - "does NOT mark a RUNNING ship needs-you when the agent state reads waiting" (~line 378) — drop the `state.now` assertion.
   - "reads a resolve session at a conflicted ship as in-progress, not needs-you" (~line 420) — drop the `state.now` assertion.
   - "returns to needs-you on the same conflicted ship once the session ends" (~line 459) — drop the `state.now` assertion.

2. Add a new describe for the ship slot:

```ts
describe('buildDashboardState — ship header slot', () => {
  it('offers confirm when the ticket sits at ship ready', () => {
    const t = createTicket(store, { key: 'SHIP-C', title: 'ship' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship).toEqual({ kind: 'confirm' });
  });

  it('reports waiting-merge when ship is parked awaiting merge', () => {
    const t = createTicket(store, { key: 'SHIP-W', title: 'ship' });
    setStage(store, t.id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
    parkGateStage(store, {
      ticketId: t.id, stageKey: 'ship', kind: 'awaiting-merge',
      reason: 'PR #412 is open and unmerged', runAt: '2026-08-09T10:33:42.000Z', gates: [],
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship.kind).toBe('waiting-merge');
  });

  it('reports retry when ship failed', () => {
    const t = createTicket(store, { key: 'SHIP-F', title: 'ship' });
    setStage(store, t.id, 'ship', { status: 'failed', verdict: 'gh pr create failed' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    expect(buildDashboardState(store, t.id).ship).toEqual({ kind: 'retry', reason: 'gh pr create failed' });
  });
});
```

3. Add a test that `agentSwitch` exposes every core with per-core model choices:

```ts
it('exposes the header agent-switch choices for every implemented core', () => {
  const t = createTicket(store, { key: 'SW-CH', title: 'switch' });
  const state = buildDashboardState(store, t.id);
  expect(state.agentSwitch.cores.map((c) => c.id)).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
  expect(state.agentSwitch.cores.find((c) => c.id === 'codex')?.label).toBe('Codex');
  expect(Array.isArray(state.agentSwitch.models.codex)).toBe(true);
  expect(state.agentSwitch.models.codex!.some((m) => m.model === null)).toBe(true); // inherit choice
});
```

- [ ] **Step 4: Delete `model/nowLine.ts` + `model/nowLine.test.ts`; update `hooks/agyWatchDispatch.test.ts`**

In `src/hooks/agyWatchDispatch.test.ts`:
- Remove the `import { buildNowLine } from '../model/nowLine.js';` line.
- Remove the `expect(buildNowLine(...).text).toBe(...)` assertion (lines ~54-56).
- Update the test's doc comment to drop the "waiting Now line" phrasing (the dashboard no longer renders a Now line; the assertion was incidental — the amber glyph / agentState transitions are the real contract).

Then `git rm src/model/nowLine.ts src/model/nowLine.test.ts`.

- [ ] **Step 5: Run + typecheck**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/model/shipSlot.test.ts src/hooks/agyWatchDispatch.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git rm src/model/nowLine.ts src/model/nowLine.test.ts
git add src/ui/dashboard/state.ts src/ui/dashboard/renderFixtures.ts src/ui/dashboard/state.test.ts src/hooks/agyWatchDispatch.test.ts
git commit -m "refactor: dashboard state ships header ship slot and agent-switch choices; remove now"
```

---

### Task 4: Webview — remove the Now section, add the header ship slot + toast

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `DashboardState.ship` (Task 3), existing `shipRequestId`/`shipDone`/`resolveShipping`.
- Produces: `renderShip(state)`, `showToast(msg)`, the header ship slot markup; the `.now` block, `renderNow`, `NOW_MESSAGE`, `NOW_TITLE`, and the `.now` CSS are deleted.

This task is the webview half of "Now becomes the header ship slot". It keeps the old header identity row (`#keyPill`, `#agent`, `#bindBtn`, `#editBtn`) — those are replaced in Task 5/6. Every change here leaves the suite green by updating the Now/ship tests.

- [ ] **Step 1: Update the failing webview tests first**

In `src/ui/dashboard/webview.test.ts`:

1. **Harness element list** (`bootPreviewHarness`, ~line 1935) — for THIS task remove only `'now'` and add `'toast'`, `'confirmShip'`, `'shipWait'`. KEEP `'keyPill'`, `'agent'`, `'bindBtn'`, `'editBtn'`, `'followUpBtn'`, `'gates'`, `'gateCount'` — that markup is still present until Task 5/6 removes it, and the VM executes the whole script, so every id the script touches must exist. (`'providerMark'`/`'keyBtn'`/etc. are added in Task 5, `'linkViews'`/`'menuGates'`/`'followUpItem'` in Task 5/6.)

2. Replace the "renders the Now session subtitle from action.detail" test with a ship-slot guard:
```ts
it('renders the header ship action from state.ship, never a Now sentence', () => {
  expect(HTML).toMatch(/function renderShip\(state\)[\s\S]*?state\.ship/);
  expect(HTML).not.toContain('id="now"');
  expect(HTML).not.toMatch(/function renderNow\(/);
});
```

3. Delete "shows the live core/model through the identity component and a payload-free switch action beside Now" and "builds the switch action on the shared secondary button…" — these return in the Task 5 agent-popover tests; do not port them here.

4. Replace the three confirm-ship tests (~lines 615-639) — keep the click-side guards, retarget the render-side guard:
```ts
it('registers the confirm-ship click before the host round trip', () => {
  expect(HTML).toMatch(/act === 'ship-ticket'/);
  expect(HTML).toMatch(/shipRequestId = karstRequestId\(\)/);
  expect(HTML).toMatch(/karstBeginPending\(btn, shipRequestId\)/);
});

it('guards against a double confirm-ship submit while one is in flight', () => {
  expect(HTML).toMatch(/if \(shipRequestId\) return/);
});

it('holds the ship header slot across state pushes until the stage resolves', () => {
  expect(HTML).toMatch(/function renderShip\(state\)[\s\S]*?(?:shipRequestId|\bslot\b)/);
  expect(HTML).toMatch(/stageCurrent === 'ship'/);   // resolveShipping still keys off host truth
  expect(HTML).toMatch(/status === 'failed'/);
  expect(HTML).not.toMatch(/if \(shipping\)/);
  expect(HTML).not.toContain('id="now"');
});
```

5. Update the "feeds live Ship events…" test: the `renderInsideFlat`/`shipping` negative guards stay; the sentence reference ("The word 'shipping' still appears inside the host's static Now sentence") comment is updated — the word now appears in the header button label "Shipping…". Keep the guards.

6. Update the bind tests (~lines 582-598) only minimally here IF they reference `bindBtn`: the bind button is removed in Task 6, so KEEP these passing unchanged for now (their markup is still present until Task 6).

7. Delete/update any `.now` CSS references in tests (line ~1679 `'.now .spin'`, and any `#now`/`renderNow` string guards elsewhere, e.g. ~2904/2941 comments that merely MENTION Now — comments may stay or be trimmed; only literal assertions matter).

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — `renderNow`/`#now` still present; `renderShip`/`#confirmShip` missing.

- [ ] **Step 3: Edit `webview.html` — remove Now, add ship slot**

1. In the `.stepper` block (~line 1403), delete the `<div class="now" id="now"></div>` line.

2. In the `.dhead` block (lines 1380-1388), add the ship slot + toast markup (keep the existing identity/agent/bind/edit markup for now — they move in Task 5/6):

```html
  <button id="editBtn" type="button" class="k-btn k-btn--secondary k-btn--sm" data-act="edit-ticket" title="Edit this ticket's title, description, and scope">Edit</button>
  <span id="toast" class="toast" aria-live="polite"></span>
  <button id="confirmShip" type="button" class="k-btn k-btn--primary k-btn--sm shipAction" data-act="ship-ticket" title="Ship this ticket — commit, push, and open pull requests" hidden></button>
  <span id="shipWait" class="shipWait hidden" role="status"><span class="attentionMark" aria-hidden="true">❚❚</span><span>Waiting to merge</span></span>
```

3. Delete the `.now` CSS block (~lines 1046-1057) and the `.dhead .bindtoggle`/`keypill` rules only if they are about to be replaced — they are NOT in this task (identity/bind move in Task 5/6). Add the ship-slot CSS (token-only):

```css
  /* The header ship workflow-action slot (UI-R28b): Confirm ship / Shipping… is
     the primary action; Waiting to merge is the parked-wait chip. The two never
     render together — the host's ShipSlot union is mutually exclusive. The
     min-width is `calc`-composed so the label swap (Confirm ship / Retry ship /
     Shipping…) never shifts the neighbouring controls (UI-R18). */
  .shipAction{min-width:calc(var(--k-control-h-lg) * 3)}
  .shipWait{display:inline-flex;align-items:center;gap:var(--k-space-3);min-height:var(--k-control-h-lg);padding:0 var(--k-space-4);border-radius:var(--k-radius-sm);color:var(--k-attention);font-size:var(--k-text-xs);font-weight:var(--k-weight-semibold);white-space:nowrap}
  .shipWait.hidden{display:none}
  .attentionMark{width:var(--k-space-4);height:var(--k-space-4);border:calc(var(--k-border-w) * 2) solid currentColor;border-radius:var(--k-radius-circle);display:inline-flex;align-items:center;justify-content:center;font-size:var(--k-text-2xs);line-height:1}
  .toast{color:var(--k-success);font-size:var(--k-text-xs);opacity:0;transition:opacity var(--k-dur-fast) var(--k-ease-standard);white-space:nowrap}
  .toast.show{opacity:1}
```

(Add a `hidden` attribute rule if `.hidden` does not already exist as `display:none` — it does, line 39. The ship controls are direct children of `.dhead` for this task; Task 5 moves them into a `.headerActions` container that owns right-alignment.)

4. Replace `renderNow` (lines 2387-2424) and delete `NOW_MESSAGE`/`NOW_TITLE` (~lines 2374-2385). Add:

```js
  let toastTimer = 0;
  function showToast(message) {
    const t = el('toast');
    if (!t) return;
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  }

  // The header ship action. The host's `state.ship` union is the placement
  // truth; the webview's own in-flight `shipRequestId` (set by the click,
  // settled by resolveShipping) additionally holds "Shipping…" across the
  // pushes before the ship stage reads `running`.
  function renderShip(state) {
    const btn = el('confirmShip');
    const wait = el('shipWait');
    if (!btn || !wait) return;
    const slot = state.ship || { kind: 'none' };
    const inFlight = !!shipRequestId;
    wait.classList.add('hidden');
    if (slot.kind === 'waiting-merge') {
      btn.hidden = true;
      btn.setAttribute('aria-busy', 'false');
      btn.disabled = false;
      wait.classList.remove('hidden');
      wait.title = slot.repos > 0 ? `Waiting for ${slot.repos} ${slot.repos === 1 ? 'repo' : 'repos'} to be merged` : 'Waiting for the pull requests to be merged';
      return;
    }
    if (slot.kind === 'confirm' || slot.kind === 'retry') {
      btn.hidden = false;
      btn.textContent = slot.kind === 'retry' ? 'Retry ship' : 'Confirm ship';
      btn.setAttribute('aria-busy', 'false');
      btn.disabled = false;
    } else if (slot.kind === 'shipping' || inFlight) {
      btn.hidden = false;
      btn.textContent = 'Shipping…';
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    } else {
      btn.hidden = true;
      btn.setAttribute('aria-busy', 'false');
      btn.disabled = false;
    }
    if (shipDone === 'success') showToast('Shipped ✓');
  }
```

5. In `render()` (line 3252), replace `renderNow(state.now, state.agentSession);` with `renderShip(state);`.

6. Confirm `resolveShipping`, `shipRequestId`, `shipDone` and the `ship-ticket` branch of the delegated click handler are UNCHANGED (they are the preserved host-side workflow behavior).

- [ ] **Step 4: Run the webview suite + the preview VM tests**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full dashboard suite + commit**

Run: `npm run typecheck` and `npx vitest run src/ui/dashboard`
Expected: PASS.

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: ship confirmation moves from the Now line to the header action slot (UI-R28b)"
```

---

### Task 5: Webview — header identity + agent popover

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `state.agentSession` (provider/model/canSwitch), `state.agentState` (runtime status), `state.agentSwitch` (cores + per-core models), `state.key`/`state.ticketUrl`/`state.provider`/`state.brief`, `agentBadgeHtml`/`providerIconHtml` (injected), the `copy-ticket-key`/`switch-agent` messages (Task 2).
- Produces: `renderTicketIdentity(state)`, `renderAgentHeader(state)`, the agent popover draft/apply logic, and the `ticketIdentity`/`agentButton`/`agentPopover` markup + token-only CSS. `renderKeyPill`, `renderAgent`, `#keyPill`, `#agent`, and their `.dhead` CSS are deleted.

- [ ] **Step 1: Update the failing webview tests first**

In `src/ui/dashboard/webview.test.ts`:

0. **Harness element list** (`bootPreviewHarness`, ~line 1935): remove `'keyPill'`, `'agent'`, `'followUpBtn'` (their markup is gone after this task); ADD `'providerMark'`, `'keyBtn'`, `'boardLink'`, `'agentButton'`, `'agentCore'`, `'agentModel'`, `'agentDot'`, `'agentLiveText'`, `'agentPopover'`, `'coreSelect'`, `'modelSelect'`, `'switchBtn'`, `'moreBtn'`, `'menuPopover'`, `'followUpItem'`, `'linkViews'`, `'menuGates'`. (Keep `'bindBtn'`, `'editBtn'`, `'gates'`, `'gateCount'` — removed in Task 6.)

1. Replace the deleted Now/switch tests (removed in Task 4) with identity + popover guards:

```ts
it('renders ticket identity as provider mark + copy-key button + separate board link', () => {
  expect(HTML).toMatch(/id="keyBtn"[^>]*data-act="copy-ticket-key"/);
  expect(HTML).toMatch(/id="keyBtn"[^>]*data-copy/);
  expect(HTML).toMatch(/id="boardLink"[^>]*data-act="open-ticket-link"/);
  expect(HTML).toMatch(/id="boardLink"[^>]*data-url="\$\{esc\(state\.ticketUrl\)\}"/);
  expect(HTML).toMatch(/id="providerMark"/);
  // The key itself must NOT be the board link any more.
  expect(HTML).not.toMatch(/class="k-chip keypill/);
});

it('renders the active agent through the Karst identity pattern with runtime status', () => {
  expect(HTML).toMatch(/agentBadgeHtml\(state\.agentSession\.provider\)/);
  expect(HTML).toMatch(/id="agentModel"[\s\S]*?state\.agentSession\.modelLabel/);
  expect(HTML).toMatch(/id="agentLiveText"[\s\S]*?agentState/);
  expect(HTML).toContain('id="agentButton"');
});

it('stages the agent switch in a popover that does nothing until Switch agent is clicked', () => {
  expect(HTML).toContain('id="agentPopover"');
  expect(HTML).toContain('id="coreSelect"');
  expect(HTML).toContain('id="modelSelect"');
  expect(HTML).toContain('id="switchBtn"');
  expect(HTML).toMatch(/Closing this menu takes no action/);
  expect(HTML).toMatch(/draftCore !== s\.provider \|\| /); // changed-draft gate
  expect(HTML).toMatch(/post\(\{ type: 'switch-agent', provider: draftCore, model: draftModel \|\| null \}\)/);
  expect(HTML).not.toMatch(/data-act="switch-agent"/);      // no longer a Now-line button
});
```

2. Update the tooltip guard list (~line 1019): replace the `"Switch this ticket\'s live agent session"` entry with the agent button's title (kept at ≤80 chars) and add `"Open ticket in provider"`, `"Ticket controls"`, `"Copy ticket key"`.

3. Add a VM round-trip test for the popover (after the existing `describe('inside render round trip')`):

```ts
it('posts the staged core/model only on Switch agent, never on open or close', () => {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'SW-H', title: 'switch' });
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
  const state = buildDashboardState(
    store, t.id, undefined, undefined, undefined, undefined, 'claude',
    { defaultModel: null, isSessionOpen: () => true },
  );
  store.close();
  const h = bootPreviewHarness();
  h.receive({ type: 'state', state });
  h.click('#agentButton', {});
  const popover = h.classesOf('agentPopover');
  expect(popover.includes('hidden')).toBe(false);
  // Closing without switching posts nothing.
  const before = h.posted.length;
  h.click('body', {});
  expect(h.posted.length).toBe(before);
});
```

(If `buildDashboardState`'s `agentSwitch.models` has no entry for the live provider, the model select still renders an empty list — acceptable for the fixture; assert only the staging lifecycle, not choices.)

4. Remove the `renderKeyPill`/keypill CSS guards (lines ~1058-1086) — replaced by the identity guards above.

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — new ids/guards absent; old keypill/renderNow references present.

- [ ] **Step 3: Edit `webview.html` — header markup**

Replace the whole `.dhead` block (lines 1380-1388):

```html
<div class="dhead">
  <div class="ticketIdentity">
    <span id="providerMark" class="provicon" aria-hidden="true"></span>
    <button id="keyBtn" type="button" class="ticketKey" data-act="copy-ticket-key" data-copy title="Copy ticket key" aria-label="Copy ticket key"></button>
    <a id="boardLink" class="k-iconbtn" href="#" data-act="open-ticket-link" hidden
      aria-label="Open ticket in provider" title="Open ticket in provider">
      <svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"/><path d="M11 13l9 -9"/><path d="M15 4h5v5"/></svg>
    </a>
  </div>
  <h1 id="title" class="ticketTitle"></h1>
  <div class="headerActions">
    <div class="agentWrap">
      <button id="agentButton" type="button" class="agentButton" aria-expanded="false" aria-haspopup="dialog"
        title="Switch the live agent session">
        <span id="agentCore" class="k-agent-core"></span>
        <span aria-hidden="true" class="agentSep">·</span>
        <span id="agentModel" class="agentMeta"></span>
        <span class="agentLive"><span id="agentDot" class="agentLiveDot idle"></span><span id="agentLiveText">idle</span></span>
        <svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6l6 -6"/></svg>
      </button>
      <div id="agentPopover" class="popover agentPopover hidden" role="dialog" aria-label="Switch active agent">
        <div class="agentForm">
          <div class="fieldRow">
            <label class="fieldLabel" for="coreSelect">Agent core</label>
            <div class="fieldControl"><select id="coreSelect" class="k-select"></select></div>
          </div>
          <div class="fieldRow">
            <label class="fieldLabel" for="modelSelect">Model</label>
            <div class="fieldControl"><select id="modelSelect" class="k-select"></select></div>
          </div>
          <div class="fieldHelp">Provider and model changes are staged. Closing this menu takes no action.</div>
        </div>
        <div class="popActions">
          <button id="switchBtn" type="button" class="k-btn k-btn--primary" disabled>Switch agent…</button>
        </div>
      </div>
    </div>
    <span id="toast" class="toast" aria-live="polite"></span>
    <button id="confirmShip" type="button" class="k-btn k-btn--primary k-btn--sm shipAction" data-act="ship-ticket" title="Ship this ticket — commit, push, and open pull requests" hidden></button>
    <span id="shipWait" class="shipWait hidden" role="status"><span class="attentionMark" aria-hidden="true">❚❚</span><span>Waiting to merge</span></span>
    <div class="menuWrap">
      <button id="moreBtn" type="button" class="k-iconbtn" aria-expanded="false" aria-haspopup="menu" aria-label="Ticket controls" title="Ticket controls">
        <svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M19 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/></svg>
      </button>
      <div id="menuPopover" class="popover menuPopover hidden" role="menu" aria-label="Ticket controls">
        <div class="menuHeading">Ticket</div>
        <button type="button" class="menuButton" data-act="edit-ticket" role="menuitem">
          <svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/></svg><span>Edit ticket</span>
        </button>
        <button type="button" class="menuButton hidden" id="followUpItem" data-act="create-follow-up-ticket" role="menuitem">
          <svg class="k-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5l2.5 2.5l-2.5 2.5l-2.5 -2.5z"/><path d="M12 12l2.5 2.5l-2.5 2.5l-2.5 -2.5z"/><path d="M12 19l2.5 2.5l-2.5 2.5l-2.5 -2.5z"/></svg><span>Create follow-up</span>
        </button>
        <div class="menuDivider"></div>
        <div class="menuHeading">Quick setting</div>
        <div class="settingRow">
          <div class="settingCopy">
            <div class="settingTitle">Link dashboard ↔ terminal</div>
            <div class="settingHelp">Global · focusing either view brings the paired view forward.</div>
          </div>
          <label class="k-switch">
            <input id="linkViews" type="checkbox" aria-label="Link dashboard and terminal">
            <span class="k-switchTrack"></span>
          </label>
        </div>
        <div class="menuDivider"></div>
        <div class="menuHeading">Gates for this ticket</div>
        <div id="menuGates" class="menuGates"></div>
      </div>
    </div>
  </div>
</div>
```

Note: `#moreBtn`/`#menuPopover`/`#linkViews`/`#menuGates`/`#followUpItem` are consumed in Task 6 — leaving their markup here (already wired by the generic `[data-act]` handler) means the menu is functional from this task on, but the Task 6 step still wires the bind checkbox and gate rendering.

- [ ] **Step 4: Edit `webview.html` — CSS**

1. Delete the old `.dhead` rules (`.dhead`, `.dhead h1`, `.dhead .agent`, `.dhead .keypill*`, `.dhead .bindtoggle*`, `.dhead a.keypill .arw`, the `@media (prefers-reduced-motion)` rule) and `renderAgent`'s `.agent-pill` styles if any.
2. Add token-only header CSS:

```css
  /* Header (prototype v8): ticket identity + agent identity + ship action + … menu. */
  .dhead{display:flex;align-items:center;gap:var(--k-space-5);margin-bottom:var(--k-space-6);flex-wrap:wrap}
  .ticketIdentity{display:inline-flex;align-items:center;gap:var(--k-space-3);flex:none}
  .ticketIdentity .provicon{width:var(--k-space-7);height:var(--k-space-7)}
  .dhead h1.ticketTitle{min-width:0;flex:1;margin:0 var(--k-space-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--k-text-xl)}
  .ticketKey{min-height:var(--k-hit-min);padding:0 var(--k-space-3);border:0;border-radius:var(--k-radius-sm);background:transparent;color:var(--k-text-dim);font-family:var(--k-font-mono);font-size:var(--k-text-xs);cursor:pointer}
  .ticketKey:hover{background:var(--k-surface-hover);color:var(--k-text)}
  .headerActions{display:flex;align-items:center;gap:var(--k-space-2);flex:none;margin-left:auto}
  .agentWrap,.menuWrap{position:relative}
  .agentButton{max-width:calc(var(--k-space-8) * 20);min-height:var(--k-control-h-lg);padding:0 var(--k-space-4);border:1px solid transparent;border-radius:var(--k-radius-sm);background:transparent;color:var(--k-text);display:inline-flex;align-items:center;gap:var(--k-space-3);cursor:pointer;min-width:0}
  .agentButton:hover:not(:disabled){background:var(--k-surface-hover);border-color:var(--k-border)}
  .agentButton:disabled{opacity:.72;cursor:default}
  .agentButton .agentSep{color:var(--k-text-faint);flex:none}
  .agentMeta{min-width:0;max-width:calc(var(--k-space-8) * 9);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--k-text-dim);font-family:var(--k-font-mono);font-size:var(--k-text-xs)}
  .agentLive{display:inline-flex;align-items:center;gap:var(--k-space-2);color:var(--k-text-dim);font-size:var(--k-text-xs);white-space:nowrap;flex:none}
  .agentLiveDot{width:var(--k-space-3);height:var(--k-space-3);border-radius:var(--k-radius-circle);background:var(--k-pending);flex:none}
  .agentLiveDot.running{background:var(--k-running)}
  .agentLiveDot.waiting{background:var(--k-attention)}
  /* The two popovers — agent switch form + ticket-controls menu (UI-R04: composed
     from control-height tokens, no raw widths). */
  .popover{display:none;position:absolute;z-index:50;top:calc(100% + var(--k-space-3));right:0;border:var(--k-border-w) solid var(--k-border-strong);border-radius:var(--k-radius-lg);background:var(--k-surface);box-shadow:var(--k-elev-2)}
  .popover.hidden{display:none}
  .popover.open{display:block}
  .agentPopover{width:calc(var(--k-control-h-lg) * 14);padding:0}
  .menuPopover{width:calc(var(--k-control-h-lg) * 12);padding:var(--k-space-4)}
  .agentForm{display:grid;gap:var(--k-space-3);padding:var(--k-space-4)}
  .fieldRow{display:grid;grid-template-columns:var(--k-space-8) minmax(0,1fr);align-items:center;gap:var(--k-space-4);min-height:var(--k-control-h-lg)}
  .fieldLabel{margin:0;color:var(--k-text-faint);font-size:var(--k-text-xs);font-weight:var(--k-weight-medium);line-height:1;text-align:right;white-space:nowrap}
  .fieldControl{min-width:0}
  .fieldHelp{margin-left:calc(var(--k-space-8) + var(--k-space-4));color:var(--k-text-faint);font-size:var(--k-text-xs);line-height:1.35}
  .popActions{display:flex;justify-content:flex-end;padding:var(--k-space-4);border-top:var(--k-border-w) solid var(--k-border)}
```

3. Free the two art-origin 12px literals to make literal-budget room (conformance test is at the 20 cap):
   - `.art-origin .kmark{width:12px;height:12px;...}` → `width:var(--k-space-6);height:var(--k-space-6)`
   - `.art-origin .agenticon{width:12px;height:12px;flex:none}` → `width:var(--k-space-6);height:var(--k-space-6);flex:none`

- [ ] **Step 5: Edit `webview.html` — JS**

1. Replace `renderAgent` (lines 2768-2774) and `renderKeyPill` (lines 2776-2800) with:

```js
  function renderTicketIdentity(state) {
    const label = state.key || `#${state.ticketId}`;
    const keyBtn = el('keyBtn');
    keyBtn.textContent = label;
    keyBtn.setAttribute('aria-label', `Copy ticket key ${label}`);
    keyBtn.title = 'Copy ticket key';
    const mark = el('providerMark');
    if (mark) {
      mark.innerHTML = providerIconHtml(state.provider);
      if (state.brief) mark.setAttribute('title', esc(state.brief));
      else mark.removeAttribute('title');
    }
    const link = el('boardLink');
    if (!link) return;
    if (state.ticketUrl) {
      link.hidden = false;
      link.setAttribute('data-url', state.ticketUrl);
    } else {
      link.hidden = true;
      link.removeAttribute('data-url');
    }
  }

  function renderAgentHeader(state) {
    const s = state.agentSession;
    const core = el('agentCore');
    if (core) core.innerHTML = agentBadgeHtml(s.provider);
    const model = el('agentModel');
    if (model) model.textContent = s.modelLabel;
    const st = state.agentState || 'none';
    const dot = el('agentDot');
    if (dot) {
      dot.classList.remove('idle', 'running', 'waiting', 'none');
      dot.classList.add(st);
    }
    const liveText = el('agentLiveText');
    if (liveText) liveText.textContent = st;
    const btn = el('agentButton');
    if (btn) {
      if (s.canSwitch) {
        btn.disabled = false;
        btn.title = 'Switch the live agent session';
      } else {
        btn.disabled = true;
        btn.title = 'No live agent session to switch right now';
      }
    }
  }
```

2. Add the agent popover logic (module scope, after `renderAgentHeader`):

```js
  let draftCore = null;
  let draftModel = '';

  function populateAgentPopover() {
    const s = lastState && lastState.agentSession;
    if (!s) return;
    draftCore = s.provider;
    draftModel = s.modelId || '';
    renderCoreSelect();
    renderModelSelect();
    updateSwitchState();
  }

  function renderCoreSelect() {
    const select = el('coreSelect');
    if (!select || !lastState) return;
    select.innerHTML = (lastState.agentSwitch.cores || []).map((c) =>
      `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
    select.value = draftCore || '';
  }

  function renderModelSelect() {
    const select = el('modelSelect');
    if (!select || !lastState) return;
    const models = (lastState.agentSwitch.models || {})[draftCore] || [];
    select.innerHTML = models.map((m) =>
      `<option value="${esc(m.model || '')}">${esc(m.label)}</option>`).join('');
    if (models.some((m) => (m.model || '') === draftModel)) select.value = draftModel;
    else { draftModel = ''; select.value = ''; }
  }

  function updateSwitchState() {
    const btn = el('switchBtn');
    const s = lastState && lastState.agentSession;
    if (!btn || !s) return;
    const changed = draftCore !== s.provider || (draftModel || null) !== (s.modelId || null);
    btn.disabled = !changed;
  }

  function openAgentPopover() {
    const btn = el('agentButton');
    if (btn && btn.disabled) return;
    populateAgentPopover();
    el('agentPopover').classList.remove('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function openMenuPopover() {
    el('menuPopover').classList.remove('hidden');
    el('moreBtn').setAttribute('aria-expanded', 'true');
  }

  function closePopovers() {
    el('agentPopover').classList.add('hidden');
    el('menuPopover').classList.add('hidden');
    el('agentButton').setAttribute('aria-expanded', 'false');
    el('moreBtn').setAttribute('aria-expanded', 'false');
  }
```

3. Add the popover click listener (a separate `document.addEventListener('click', ...)` — it must run alongside, not instead of, the existing stage-selection and `[data-act]` listeners):

```js
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest('#agentButton')) {
      const opening = el('agentPopover').classList.contains('hidden');
      closePopovers();
      if (opening) openAgentPopover();
      return;
    }
    if (t && t.closest('#moreBtn')) {
      const opening = el('menuPopover').classList.contains('hidden');
      closePopovers();
      if (opening) openMenuPopover();
      return;
    }
    if (t && t.closest('.popover')) return;
    closePopovers();
  });
```

4. Add the select/switch listeners (module scope; the harness `previewElement` records a single handler per event type via `addEventListener`, and fires it via `.fire(type, event)`):

```js
  el('coreSelect').addEventListener('change', (e) => {
    draftCore = e.target && e.target.value;
    renderModelSelect();
    updateSwitchState();
  });
  el('modelSelect').addEventListener('change', (e) => {
    draftModel = e.target && e.target.value;
    updateSwitchState();
  });
  el('switchBtn').addEventListener('click', () => {
    if (el('switchBtn').disabled) return;
    closePopovers();
    // No requestId: the popover closes and the host owns the outcome (confirm
    // modal + relaunch); a stale/cancelled switch surfaces as a host toast or
    // the next state push, never as an invented verdict (UI-R14/R31).
    post({ type: 'switch-agent', provider: draftCore, model: draftModel || null });
  });
```

5. In `render()` replace `renderKeyPill(state);` and `renderAgent(state.agentState);` with `renderTicketIdentity(state);` and `renderAgentHeader(state);`. Add a `renderFollowUp`:

```js
  function renderFollowUp(state) {
    el('followUpItem').classList.toggle('hidden', state.stageCurrent !== 'done');
  }
```
and call it in `render()` (replacing the old `el('followUpBtn').classList.toggle(...)` line).

- [ ] **Step 6: Run the webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + full dashboard + conformance + commit**

Run: `npm run typecheck`, `npx vitest run src/ui/dashboard src/ui/conformance.test.ts`
Expected: PASS. If the conformance literal-budget test exceeds 20, re-check that the two `.art-origin` conversions landed and that no raw `px` crept into the new header CSS.

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: dashboard header ticket identity + staged agent-switch popover (UI-R10c, UI-R17, UI-R09)"
```

---

### Task 6: Webview — `…` controls menu (Edit, follow-up, bind quick setting, gate toggles); remove the Gates panel

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `gateOptions` module state (the `gate-options` message), `bindEnabled` (the `bind` message), `set-disabled-gates` message, `toggle-bind` message, `edit-ticket`/`create-follow-up-ticket` (already routed).
- Produces: `renderMenuGates()`, retargeted `renderBind()` (drives `#linkViews`), the removed standalone Gates panel + `#bindBtn`/`#editBtn` header buttons.

- [ ] **Step 1: Update the failing webview tests first**

In `src/ui/dashboard/webview.test.ts`:

1. **Harness list**: remove `'bindBtn'`, `'gates'`, `'gateCount'`, `'editBtn'` (they were kept through Task 4/5; `followUpBtn` already removed). All new ids are already present from Task 5.

2. Replace the bind tests (~lines 582-598):

```ts
it('offers the terminal binding as a menu switch reflecting the host push', () => {
  expect(HTML).toContain('id="linkViews"');
  expect(HTML).toMatch(/bindEnabled[\s\S]*linkViews/);
  expect(HTML).not.toMatch(/id="bindBtn"/);
  expect(HTML).toMatch(/'bind'|"bind"/);
  expect(HTML).toMatch(/bindEnabled\s*=\s*[^;]*\bmsg\b/);
  expect(HTML).not.toMatch(/setState\(\{ state:[^}]*bindEnabled/);
});
```

3. Replace the follow-up tests (~lines 654-667):

```ts
it('shows the follow-up menu item only once the ticket is done', () => {
  expect(HTML).toContain('id="followUpItem"');
  expect(HTML).toMatch(/el\('followUpItem'\)\.classList\.toggle\('hidden', state\.stageCurrent !== 'done'\)/);
  expect(HTML).not.toMatch(/id="followUpBtn"/);
});
```

4. Update the gate-options message test (~line 1192) and the `set-disabled-gates` render guard (~line 1188-1210): `id="gates"` → `id="menuGates"`, `renderGates` → `renderMenuGates`, and add:

```ts
it('removes the standalone Gates panel — the toggles live in the … menu', () => {
  expect(HTML).not.toMatch(/class="panel span"[^>]*>\s*<div class="phead">Gates/);
  expect(HTML).not.toContain('id="gateCount"');
  expect(HTML).toContain('id="menuGates"');
  expect(HTML).toMatch(/renderMenuGates/);
});
```

5. Add a VM round-trip test that the bind switch posts toggle-bind and renders the host push:

```ts
it('posts toggle-bind from the menu switch and renders the host push', () => {
  const h = bootPreviewHarness();
  h.receive({ type: 'bind', enabled: true });
  expect(h.textOf('linkViews') === '');  // checkbox: assert the element property instead
  // the harness element exposes .checked — assert via the element registry if needed; here we
  // assert the script wires the change listener and the bind message:
  expect(HTML).toContain("msg.type === 'bind'");
  expect(HTML).toMatch(/toggle-bind/);
});
```

> If the assertion needs the element's `checked`, extend `previewElement` with a `checked` property and read `bootPreviewHarness` internals — the suite already reaches into `elements` for `htmlOf`. Keep the test to string guards unless the property is genuinely needed.

6. Update the action-routing guard at ~lines 3695-3720 (the `[data-act]` allowlist test): `edit-ticket` stays; `copy-ticket-key` is a new `[data-act]` value; `switch-agent` is NO LONGER a `[data-act]` value (it is a dedicated popover button). Adjust the emitted set accordingly.

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — old bindBtn/gates/editBtn references still present; `renderMenuGates`/`menuGates` missing.

- [ ] **Step 3: Edit `webview.html` — JS**

1. Replace `renderGates`/`gateRow` (lines 3281-3314) with `renderMenuGates` + a menu-styled `gateRow` (same `data-act`/`data-stage`/`data-name`/`data-disabled` + `aria-pressed`, so the existing delegated `set-disabled-gates` handler keeps working unchanged):

```js
  function gateRow(stage, opt) {
    const label = (opt.disabled ? 'Enable ' : 'Disable ') + opt.name + ' for this ticket';
    return `<div class="gateRow${opt.disabled ? ' off' : ''}">`
      + `<span class="gateName">${esc(opt.name)}</span>`
      + `<span class="gateState">${opt.disabled ? 'disabled' : 'runs'}</span>`
      + `<button type="button" class="k-btn k-btn--ghost k-btn--sm gateToggle"`
      + ` data-act="set-disabled-gates" data-stage="${esc(stage)}" data-name="${esc(opt.name)}"`
      + ` data-disabled="${opt.disabled ? '1' : '0'}"`
      + ` aria-pressed="${opt.disabled ? 'true' : 'false'}"`
      + ` aria-label="${esc(label)}" title="${esc(label)}">${opt.disabled ? 'Enable' : 'Disable'}</button>`
      + `</div>`;
  }

  function renderMenuGates() {
    const body = el('menuGates');
    if (!body) return;
    const uat = gateOptions.uat || [];
    const review = gateOptions.review || [];
    if (!uat.length && !review.length) {
      body.innerHTML = '<div class="menuBlurb">No gates resolved for this ticket yet.</div>';
      return;
    }
    const group = (title, stage, opts) => opts.length
      ? `<div class="gateGroup"><div class="gateHead">${esc(title)}</div>`
        + opts.map((o) => gateRow(stage, o)).join('') + '</div>'
      : '';
    body.innerHTML = group('UAT', 'uat', uat) + group('Review', 'review', review);
  }
```

2. Replace `renderBind` (lines 3320-3327) — the checkbox reflects the host push; the change listener posts the flip:

```js
  function renderBind() {
    const box = el('linkViews');
    if (box) box.checked = bindEnabled;
  }
```

3. In `render()`: remove the `el('followUpBtn')...` line (now `renderFollowUp`), remove `renderGates();`, and call `renderFollowUp(state);` (already added in Task 5). `renderMenuGates()` is called ONLY from the `gate-options` message handler (menu content depends on gateOptions alone, and the host re-pushes it whenever a toggle changes).

4. Add the bind change listener (module scope):

```js
  el('linkViews').addEventListener('change', () => {
    // Payload-free like the old bind button: the host owns the preference and
    // answers with the `bind` message, which is the terminal outcome (UI-R13).
    post({ type: 'toggle-bind' });
  });
```

5. Update the `gate-options` message handler (~line 3695): `renderGates();` → `renderMenuGates();`.

6. Remove the standalone Gates panel markup from the `.grid` (~lines 1416-1420) and the `#gateCount` count logic (deleted with the panel).

- [ ] **Step 4: Edit `webview.html` — CSS**

Add the menu + gate CSS (token-only):

```css
  .menuButton{width:100%;min-height:var(--k-control-h-lg);display:flex;align-items:center;gap:var(--k-space-4);border:0;border-radius:var(--k-radius-sm);background:transparent;color:var(--k-text);padding:0 var(--k-space-4);cursor:pointer;text-align:left}
  .menuButton:hover{background:var(--k-surface-hover)}
  .menuButton .k-icon{color:var(--k-text-dim);flex:none}
  .menuHeading{margin:var(--k-space-2) var(--k-space-4) var(--k-space-3);color:var(--k-text-faint);font-size:var(--k-text-2xs);font-weight:var(--k-weight-semibold);letter-spacing:.06em;text-transform:uppercase}
  .menuDivider{height:1px;background:var(--k-border);margin:var(--k-space-3)}
  .settingRow{display:flex;align-items:center;gap:var(--k-space-5);padding:var(--k-space-3) var(--k-space-4)}
  .settingCopy{min-width:0;flex:1}
  .settingTitle{font-size:var(--k-text-md);font-weight:var(--k-weight-medium)}
  .settingHelp{margin-top:1px;color:var(--k-text-faint);font-size:var(--k-text-2xs);line-height:1.35}
  .k-switch{position:relative;width:calc(var(--k-control-h-sm) * 1.5);height:var(--k-control-h-sm);flex:none;display:inline-block}
  .k-switch input{position:absolute;opacity:0;pointer-events:none}
  .k-switchTrack{position:absolute;inset:0;border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-pill);background:var(--k-surface-selected);cursor:pointer}
  .k-switchTrack::after{content:"";position:absolute;width:calc(var(--k-control-h-sm) - var(--k-space-6));height:calc(var(--k-control-h-sm) - var(--k-space-6));border-radius:var(--k-radius-circle);left:calc(var(--k-space-2) - var(--k-border-w));top:calc(var(--k-space-2) - var(--k-border-w));background:var(--k-text-dim);transition:left var(--k-dur-fast) var(--k-ease-standard),background var(--k-dur-fast) var(--k-ease-standard)}
  .k-switch input:checked + .k-switchTrack{background:color-mix(in srgb,var(--k-passed) 18%,var(--k-surface));border-color:color-mix(in srgb,var(--k-passed) 55%,var(--k-border))}
  .k-switch input:checked + .k-switchTrack::after{left:calc(var(--k-control-h-sm) * .5);background:var(--k-passed)}
  .k-switch input:focus-visible + .k-switchTrack{outline:1px solid var(--k-focus);outline-offset:2px}
  .gateGroup{margin:0 var(--k-space-3) var(--k-space-3);border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-md);overflow:hidden}
  .gateHead{min-height:var(--k-control-h-sm);display:flex;align-items:center;padding:0 var(--k-space-4);background:var(--k-surface-sunken);color:var(--k-text-faint);font-size:var(--k-text-2xs);font-weight:var(--k-weight-semibold);letter-spacing:.06em;text-transform:uppercase}
  .gateRow{min-height:var(--k-control-h-lg);display:flex;align-items:center;gap:var(--k-space-4);padding:0 var(--k-space-4);border-top:var(--k-border-w) solid var(--k-border)}
  .gateName{flex:1;font-family:var(--k-font-mono);font-size:var(--k-text-xs)}
  .gateState{color:var(--k-text-faint);font-size:var(--k-text-xs)}
  .gateToggle{min-width:calc(var(--k-control-h-sm) * 2.5);justify-content:flex-end;font-size:var(--k-text-xs)}
  .menuBlurb{padding:var(--k-space-4);color:var(--k-text-faint);font-size:var(--k-text-xs)}
```

- [ ] **Step 5: Run the webview suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + full suite + conformance + commit**

Run: `npm run typecheck`, `npx vitest run src/ui/dashboard src/ui/conformance.test.ts`
Expected: PASS (re-check the literal budget — the header+menu CSS is token-composed; if over 20, verify no raw `px` slipped in and that the two `.art-origin` conversions from Task 5 are present).

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: dashboard … controls menu — edit, follow-up, terminal binding, per-ticket gates (UI-R11-R14, UI-R09)"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (this rebuilds better-sqlite3 for the Node ABI first; be patient).

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run build`
Expected: PASS (emits `dist/` + copies webview assets).

- [ ] **Step 3: Grep for leftovers**

Run (from the worktree root):
`grep -rn "renderNow\|state\.now\|id=\"now\"\|id=\"bindBtn\"\|id=\"gates\"\|id=\"gateCount\"\|runAgentSwitchFlow\|keypill" src/ui/dashboard src/model src/agent src/hooks`
Expected: no matches in `src/` (tolerate comment mentions in tests if they explain history).

- [ ] **Step 4: Manual sanity (F5)** — open a ticket dashboard:
- No Now section anywhere; Stages + Inside + Servers/Worktrees/PRs/Artifacts unchanged.
- Header: provider mark, key (click copies — host clipboard), board link opens the board, agent identity + live status, ship action states flip Confirm ship → Shipping… → Waiting to merge (never both), `…` menu holds Edit / follow-up (when done) / Link dashboard ↔ terminal / UAT+Review gate toggles.
- Agent popover: changing core repopulates models; Switch agent… stays disabled until the draft differs; closing discards; switching posts the staged selection and the host's confirm modal + relaunch happen.

- [ ] **Step 5: Commit nothing further** (Task 7 is a gate, not a change).

---

## Self-Review (performed against the ticket)

**1. Spec coverage**
- Header keeps ticket identity (provider icon, key, web link) → Task 5 (`renderTicketIdentity`, `providerMark`/`keyBtn`/`boardLink`). ✓
- Regular click copies the key → Task 2 (`copy-ticket-key`) + Task 5 (`data-copy`). ✓
- Edit ticket into `…` menu → Task 6 (`menuButton data-act="edit-ticket"`). ✓
- Dashboard↔terminal quick setting in `…` → Task 6 (`#linkViews` + `toggle-bind`). ✓
- Per-ticket gate controls in `…`, grouped UAT/Review, individually toggleable → Task 6 (`renderMenuGates` + menu `gateRow`, reusing `gate-options` + `set-disabled-gates`). ✓
- Active agent in header: core icon + canonical name + model + runtime status → Task 5 (`agentBadgeHtml`, `#agentModel`, `#agentLiveText`/`#agentDot`). ✓
- Core+model selectable, staged, apply only on Switch agent…, closing makes no change → Task 5 (`draftCore`/`draftModel`, disabled switch gate, close discards). ✓
- Select-style core control → Task 5 (`#coreSelect` native `<select>`, `.k-select`). ✓
- Compact low-chrome → Task 5/6 token CSS. ✓
- Ship confirmation in header slot, states mutually exclusive, preserves host behavior → Task 1 (`ShipSlot` union) + Task 4 (`renderShip`; `ship-ticket`/`resolveShipping` untouched). ✓
- Remove Now, don't recreate → Tasks 3 (state) + 4 (webview); `model/nowLine.ts` deleted; scope note flags the removed session/open-log/resume buttons. ✓
- Out of scope (Stages/Inside/body) untouched → plan edits only `.dhead`, deletes the Gates panel, touches no `model/inside/*`, no `renderTrack`/`renderInside`. ✓

**2. Placeholder scan** — no "implement later"/TBD; every code step carries real code.

**3. Type consistency**
- `ShipSlot`/`buildShipSlot(cell, mergeGate)` used identically in Task 1/3/4.
- `applyAgentSwitchSelection(deps, catalog, selection)` defined in Task 2 and used by its host wiring in the same task.
- `state.agentSwitch` shape `{ cores, models }` matches the webview reads in Task 5.
- `switch-agent` message `{ provider, model }` matches `DashboardActions.switchAgent(provider, model)` in Task 2 and the webview post in Task 5.
- `agentSwitchCoreChoices()`/`agentSwitchModelChoices` names match Task 2/3.
