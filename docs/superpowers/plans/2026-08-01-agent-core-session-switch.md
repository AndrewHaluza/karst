# Agent-Core Session Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user replace a live implementation/fix terminal with a selected agent core and compatible model directly from the ticket dashboard without losing worktree or workflow state.

**Architecture:** Add one VS Code-free agent-switch module that builds provider/model choices, renders the resolved dashboard identity, and coordinates the mutation/dispose/launch order through injected operations. Extend the existing dashboard's host-built state and payload-free message boundary, then keep `extension.ts` as a thin native Quick Pick/modal binding that delegates state changes to the tested coordinator and relaunches through the existing `karst.openSession` command.

**Tech Stack:** TypeScript 5 ESM (`.js` import suffixes), Vitest, VS Code Webview/Quick Pick API, SQLite ticket store, existing `SessionManager` and agent adapter registry.

## Global Constraints

- Show `Switch agent…` only when `stage_current` is `impl` or `fix` and `SessionManager.isOpen(ticketId)` is true.
- The UX order is replacement core → compatible model → modal confirmation.
- Probe the selected core's `sessions` dependency before writing the ticket or disposing the current terminal.
- Persist `agent_provider` and `model` together through one `updateTicketOnboarding` call.
- Dispose the old terminal before invoking the existing `karst.openSession` command.
- Never pass a session id across providers; keep `shouldResumeSession` and its `session_provider` check as the single safety rule.
- The dashboard webview posts only `{ type: 'switch-agent' }`; provider, model, ticket id, path, command, and confirmation remain host-owned.
- Use only semantic `--vscode-*` theme tokens and native VS Code UI; add no literal black, white, or provider-brand colors.
- No schema migration, new runtime dependency, conversation translation, concurrent session, or project-default change.
- Keep VS Code imports out of testable modules and production files reasonably below 400 lines.

## File Structure

- Create `src/agent/sessionSwitch.ts`: provider/model labels and choices, dashboard session view, switchability predicate, and injected switch-flow coordinator.
- Create `src/agent/sessionSwitch.test.ts`: choice, precedence, cancellation, readiness, stale-state, ordering, and launch-failure tests.
- Modify `src/ui/dashboard/state.ts`: add the host-rendered agent-session view and injected model/live-session context.
- Modify `src/ui/dashboard/state.test.ts`: verify resolved labels and exact `canSwitch` conditions.
- Modify `src/ui/dashboard/panel.ts` and `src/ui/dashboard/panel.test.ts`: thread the live agent context into each state push.
- Modify `src/ui/dashboard/messages.ts` and `src/ui/dashboard/messages.test.ts`: add the payload-free switch action and routing.
- Modify `src/ui/dashboard/webview.html` and `src/ui/dashboard/webview.test.ts`: render current core/model and the secondary switch action with semantic theme tokens.
- Modify `src/extension.ts`: bind native provider/model pickers, selected-provider dependency probing, modal confirmation, persistence, disposal, relaunch, and refresh.
- Modify `src/extensionActivation.test.ts`: guard the thin VS Code binding's native and security-critical calls without importing `vscode` under Vitest.

---

### Task 1: Pure Agent-Switch Model and Coordinator

**Files:**
- Create: `src/agent/sessionSwitch.ts`
- Create: `src/agent/sessionSwitch.test.ts`

**Interfaces:**
- Consumes: `AgentProvider`, `ModelCatalog`, `modelsForProvider`, `resolveModelForProvider`, `isModelCompatibleWithProvider`, and `IMPLEMENTED_PROVIDERS`.
- Produces:
  - `PROVIDER_LABELS: Readonly<Record<AgentProvider, string>>`
  - `canSwitchAgentSession(stageCurrent: string | null, sessionOpen: boolean): boolean`
  - `buildAgentSessionView(input: AgentSessionViewInput): AgentSessionView`
  - `agentSwitchProviderChoices(current: AgentProvider): AgentSwitchProviderChoice[]`
  - `agentSwitchModelChoices(input: AgentSwitchModelChoicesInput): AgentSwitchModelChoice[]`
  - `runAgentSwitchFlow(deps: AgentSwitchFlowDeps, catalog: ModelCatalog): Promise<AgentSwitchOutcome>`

- [ ] **Step 1: Write failing tests for provider/model choices and the dashboard view**

Create `src/agent/sessionSwitch.test.ts` with a small explicit catalog and these assertions:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalog } from './modelCatalog.js';
import {
  agentSwitchModelChoices,
  agentSwitchProviderChoices,
  buildAgentSessionView,
  canSwitchAgentSession,
  runAgentSwitchFlow,
  type AgentSwitchFlowDeps,
} from './sessionSwitch.js';

const CATALOG: ModelCatalog = {
  claude: [{ id: 'claude-x', label: 'Claude X', providers: ['claude'] }],
  codex: [{ id: 'codex-x', label: 'Codex X', providers: ['codex'] }],
  antigravity: [{ id: 'agy-x', label: 'Agy X', providers: ['antigravity'] }],
};

describe('agent switch presentation', () => {
  it.each([
    ['impl', true, true],
    ['fix', true, true],
    ['impl', false, false],
    ['review', true, false],
  ] as const)('switchability at %s/open=%s is %s', (stage, open, expected) => {
    expect(canSwitchAgentSession(stage, open)).toBe(expected);
  });

  it('omits the current provider and supplies human labels', () => {
    expect(agentSwitchProviderChoices('claude')).toEqual([
      { provider: 'codex', label: 'Codex' },
      { provider: 'antigravity', label: 'Antigravity' },
    ]);
  });

  it('offers only compatible models plus an accurately labeled inherit choice', () => {
    expect(agentSwitchModelChoices({
      provider: 'codex', ticketModel: 'claude-x', defaultModel: 'codex-x', catalog: CATALOG,
    })).toEqual([
      { model: null, label: 'Inherit (settings: Codex X)', description: 'codex-x', picked: true },
      { model: 'codex-x', label: 'Codex X', description: 'codex-x', picked: false },
    ]);
    expect(agentSwitchModelChoices({
      provider: 'codex', ticketModel: 'claude-x', defaultModel: 'claude-x', catalog: CATALOG,
    })[0]!.label).toBe('Agent default');
  });

  it('renders the resolved provider/model and switch availability', () => {
    expect(buildAgentSessionView({
      provider: 'codex', ticketModel: null, defaultModel: 'codex-x',
      catalog: CATALOG, stageCurrent: 'impl', sessionOpen: true,
    })).toEqual({
      provider: 'codex', providerLabel: 'Codex',
      modelId: 'codex-x', modelLabel: 'Codex X', canSwitch: true,
    });
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npx vitest run src/agent/sessionSwitch.test.ts`

Expected: FAIL because `src/agent/sessionSwitch.ts` does not exist.

- [ ] **Step 3: Add coordinator ordering and failure tests before production code**

Append tests that drive real injected functions instead of asserting only mock counts:

```ts
function flow(overrides: Partial<AgentSwitchFlowDeps> = {}) {
  const order: string[] = [];
  const deps: AgentSwitchFlowDeps = {
    read: () => ({
      stageCurrent: 'impl', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
    }),
    isSessionOpen: () => true,
    pickProvider: async () => (order.push('pick-provider'), 'codex'),
    isProviderReady: (provider) => (order.push(`ready:${provider}`), true),
    pickModel: async (_provider, choices) => (order.push('pick-model'), choices[1]),
    confirm: async () => (order.push('confirm'), true),
    persist: (selection) => order.push(`persist:${selection.provider}:${selection.model}`),
    dispose: () => order.push('dispose'),
    launch: async () => { order.push('launch'); },
    ...overrides,
  };
  return { deps, order };
}

describe('runAgentSwitchFlow', () => {
  it('persists one selection, disposes, then launches', async () => {
    const { deps, order } = flow();
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual([
      'pick-provider', 'ready:codex', 'pick-model', 'confirm',
      'persist:codex:codex-x', 'dispose', 'launch',
    ]);
  });

  it.each(['provider', 'model', 'confirm'] as const)(
    'cancelling at %s mutates nothing', async (at) => {
      const { deps, order } = flow({
        ...(at === 'provider' ? { pickProvider: async () => undefined } : {}),
        ...(at === 'model' ? { pickModel: async () => undefined } : {}),
        ...(at === 'confirm' ? { confirm: async () => false } : {}),
      });
      await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'cancelled', at });
      expect(order.some((entry) => entry.startsWith('persist'))).toBe(false);
      expect(order).not.toContain('dispose');
      expect(order).not.toContain('launch');
    },
  );

  it('keeps the current session when the selected CLI is unavailable', async () => {
    const { deps, order } = flow({ isProviderReady: () => false });
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({
      kind: 'unavailable', provider: 'codex',
    });
    expect(order).not.toContain('dispose');
  });

  it('revalidates stage, provider, and live terminal after confirmation', async () => {
    let reads = 0;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: ++reads === 1 ? 'impl' : 'review',
        provider: 'claude', ticketModel: null, defaultModel: null,
      }),
    });
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'stale' });
    expect(order).not.toContain('dispose');
  });

  it('keeps the new selection and reports a retryable launch failure', async () => {
    const { deps, order } = flow({ launch: async () => { order.push('launch'); throw new Error('spawn'); } });
    const outcome = await runAgentSwitchFlow(deps, CATALOG);
    expect(outcome.kind).toBe('launch-failed');
    expect(order.slice(-3)).toEqual(['persist:codex:codex-x', 'dispose', 'launch']);
  });

  it('leaves the old terminal open when persistence fails', async () => {
    const { deps, order } = flow({ persist: () => { throw new Error('write'); } });
    await expect(runAgentSwitchFlow(deps, CATALOG)).rejects.toThrow('write');
    expect(order).not.toContain('dispose');
    expect(order).not.toContain('launch');
  });
});
```

- [ ] **Step 4: Implement the minimal pure module**

Create `src/agent/sessionSwitch.ts` with these public types and behavior:

```ts
import type { AgentProvider } from '../manifest/types.js';
import type { ModelCatalog } from './modelCatalog.js';
import {
  isModelCompatibleWithProvider,
  modelsForProvider,
  resolveModelForProvider,
} from './models.js';
import { IMPLEMENTED_PROVIDERS } from './provider.js';

export const PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = {
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity',
};

export interface AgentSessionView {
  provider: AgentProvider;
  providerLabel: string;
  modelId: string | null;
  modelLabel: string;
  canSwitch: boolean;
}

export interface AgentSessionViewInput {
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
  catalog: ModelCatalog;
  stageCurrent: string | null;
  sessionOpen: boolean;
}

export interface AgentSwitchProviderChoice { provider: AgentProvider; label: string }
export interface AgentSwitchModelChoicesInput {
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
  catalog: ModelCatalog;
}
export interface AgentSwitchModelChoice {
  model: string | null;
  label: string;
  description: string;
  picked: boolean;
}
export interface AgentSwitchSelection { provider: AgentProvider; model: string | null }
export interface AgentSwitchSnapshot {
  stageCurrent: string | null;
  provider: AgentProvider;
  ticketModel: string | null;
  defaultModel: string | null;
}
export interface AgentSwitchFlowDeps {
  read(): AgentSwitchSnapshot;
  isSessionOpen(): boolean;
  pickProvider(
    choices: readonly AgentSwitchProviderChoice[],
    current: AgentSessionView,
  ): Promise<AgentProvider | undefined>;
  isProviderReady(provider: AgentProvider): boolean;
  pickModel(
    provider: AgentProvider,
    choices: readonly AgentSwitchModelChoice[],
  ): Promise<AgentSwitchModelChoice | undefined>;
  confirm(input: { from: AgentSessionView; to: AgentSessionView }): Promise<boolean>;
  persist(selection: AgentSwitchSelection): void;
  dispose(): void;
  launch(): Promise<void>;
}
export type AgentSwitchOutcome =
  | { kind: 'switched' }
  | { kind: 'cancelled'; at: 'provider' | 'model' | 'confirm' }
  | { kind: 'unavailable'; provider: AgentProvider }
  | { kind: 'stale' }
  | { kind: 'launch-failed'; error: unknown };
```

Implementation rules:

- Resolve display models with `resolveModelForProvider`; find labels from `modelsForProvider`, falling back to the raw id for a valid custom model and `Agent default` for `undefined`.
- The inherit row's resolved default is computed with `resolveModelForProvider(provider, null, defaultModel, catalog)`.
- A compatible ticket model marks its catalog row picked; otherwise the inherit row is picked.
- `runAgentSwitchFlow` performs the tested order, then re-reads and refuses when the provider, stage, or live-session fact changed.
- Catch only `launch`; let a persistence exception escape before `dispose` so the host's existing dashboard error boundary reports it while the current session stays open.

Use these concrete implementations for the decision functions and coordinator:

```ts
function labelForModel(id: string | undefined, catalog: ModelCatalog): string {
  if (!id) return 'Agent default';
  return Object.values(catalog).flat().find((model) => model.id === id)?.label ?? id;
}

export function canSwitchAgentSession(stageCurrent: string | null, sessionOpen: boolean): boolean {
  return sessionOpen && (stageCurrent === 'impl' || stageCurrent === 'fix');
}

export function agentSwitchProviderChoices(current: AgentProvider): AgentSwitchProviderChoice[] {
  return IMPLEMENTED_PROVIDERS
    .filter((provider) => provider !== current)
    .map((provider) => ({ provider, label: PROVIDER_LABELS[provider] }));
}

export function agentSwitchModelChoices(input: AgentSwitchModelChoicesInput): AgentSwitchModelChoice[] {
  const { provider, ticketModel, defaultModel, catalog } = input;
  const compatibleTicket = ticketModel
    && isModelCompatibleWithProvider(provider, ticketModel, catalog)
    && modelsForProvider(provider, catalog).some((model) => model.id === ticketModel)
      ? ticketModel
      : null;
  const inherited = resolveModelForProvider(provider, null, defaultModel, catalog);
  return [
    {
      model: null,
      label: inherited ? `Inherit (settings: ${labelForModel(inherited, catalog)})` : 'Agent default',
      description: inherited ?? 'Let the agent choose',
      picked: compatibleTicket === null,
    },
    ...modelsForProvider(provider, catalog).map((model) => ({
      model: model.id,
      label: model.label,
      description: model.id,
      picked: model.id === compatibleTicket,
    })),
  ];
}

export function buildAgentSessionView(input: AgentSessionViewInput): AgentSessionView {
  const modelId = resolveModelForProvider(
    input.provider, input.ticketModel, input.defaultModel, input.catalog,
  );
  return {
    provider: input.provider,
    providerLabel: PROVIDER_LABELS[input.provider],
    modelId: modelId ?? null,
    modelLabel: labelForModel(modelId, input.catalog),
    canSwitch: canSwitchAgentSession(input.stageCurrent, input.sessionOpen),
  };
}

export async function runAgentSwitchFlow(
  deps: AgentSwitchFlowDeps,
  catalog: ModelCatalog,
): Promise<AgentSwitchOutcome> {
  const initial = deps.read();
  if (!canSwitchAgentSession(initial.stageCurrent, deps.isSessionOpen())) return { kind: 'stale' };

  const from = buildAgentSessionView({ ...initial, catalog, sessionOpen: true });
  const provider = await deps.pickProvider(agentSwitchProviderChoices(initial.provider), from);
  if (provider === undefined) return { kind: 'cancelled', at: 'provider' };
  if (provider === initial.provider) return { kind: 'stale' };
  if (!deps.isProviderReady(provider)) return { kind: 'unavailable', provider };

  const modelChoices = agentSwitchModelChoices({
    provider,
    ticketModel: initial.ticketModel,
    defaultModel: initial.defaultModel,
    catalog,
  });
  const modelChoice = await deps.pickModel(provider, modelChoices);
  if (modelChoice === undefined) return { kind: 'cancelled', at: 'model' };
  if (!modelChoices.some((choice) => choice.model === modelChoice.model)) return { kind: 'stale' };

  const to = buildAgentSessionView({
    provider,
    ticketModel: modelChoice.model,
    defaultModel: initial.defaultModel,
    catalog,
    stageCurrent: initial.stageCurrent,
    sessionOpen: false,
  });
  if (!await deps.confirm({ from, to })) return { kind: 'cancelled', at: 'confirm' };

  const current = deps.read();
  if (
    current.provider !== initial.provider
    || !canSwitchAgentSession(current.stageCurrent, deps.isSessionOpen())
  ) return { kind: 'stale' };

  deps.persist({ provider, model: modelChoice.model });
  deps.dispose();
  try {
    await deps.launch();
    return { kind: 'switched' };
  } catch (error) {
    return { kind: 'launch-failed', error };
  }
}
```

- [ ] **Step 5: Run the focused suite and verify GREEN**

Run: `npx vitest run src/agent/sessionSwitch.test.ts src/agent/models.test.ts src/agent/resumeDecision.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the pure behavior**

```bash
git add src/agent/sessionSwitch.ts src/agent/sessionSwitch.test.ts
git commit -m "feat: coordinate live agent session switches"
```

---

### Task 2: Dashboard State, Trusted Message, and Theme-Safe Control

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/state.test.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `buildAgentSessionView` and `AgentSessionView` from Task 1.
- Produces:
  - `DashboardState.agentSession: AgentSessionView`
  - `DashboardAgentContext { defaultModel?: string | null; modelCatalog?: ModelCatalog; isSessionOpen?: (ticketId: number) => boolean }`
  - `WebviewMessage` variant `{ type: 'switch-agent' }`
  - `DashboardActions.switchAgent(): void`

- [ ] **Step 1: Write failing dashboard-state tests**

Append to `src/ui/dashboard/state.test.ts`:

```ts
it('shows the resolved agent core/model and enables switching only for a live impl session', () => {
  const t = createTicket(store, { key: 'SW-1', title: 'switch' });
  updateTicketOnboarding(store, t.id, { agentProvider: 'codex', model: 'gpt-5.6-sol' });
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);

  const state = buildDashboardState(
    store, t.id, undefined, undefined, undefined, undefined, 'claude',
    { defaultModel: null, isSessionOpen: (id) => id === t.id },
  );

  expect(state.agentSession).toMatchObject({
    provider: 'codex', providerLabel: 'Codex',
    modelId: 'gpt-5.6-sol', modelLabel: 'GPT-5.6 Sol', canSwitch: true,
  });
});

it.each([
  ['impl', false], ['fix', false], ['review', true],
] as const)('does not offer switching at %s/open=%s', (stage, open) => {
  const t = createTicket(store, { key: `SW-${stage}-${open}`, title: 'switch' });
  store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
  const state = buildDashboardState(
    store, t.id, undefined, undefined, undefined, undefined, 'claude',
    { isSessionOpen: () => open },
  );
  expect(state.agentSession.canSwitch).toBe(false);
});
```

- [ ] **Step 2: Write failing message-boundary tests**

Add `switchAgent: vi.fn()` to the `actions()` fixture in `messages.test.ts`, then add:

```ts
it('routes switch-agent without trusting companion provider/model/ticket fields', () => {
  const a = actions();
  expect(parseWebviewMessage({
    type: 'switch-agent', provider: 'evil', model: 'evil', ticketId: 999,
  })).toEqual({ type: 'switch-agent' });
  routeAction({ type: 'switch-agent', provider: 'evil' }, a);
  expect(a.switchAgent).toHaveBeenCalledOnce();
});
```

- [ ] **Step 3: Write failing webview/theme tests**

Append to `src/ui/dashboard/webview.test.ts`:

```ts
it('shows the live core/model and a payload-free switch action beside Now', () => {
  expect(HTML).toContain('agentSession.providerLabel');
  expect(HTML).toContain('agentSession.modelLabel');
  expect(HTML).toContain('data-act="switch-agent"');
  expect(HTML).toMatch(/agentSession\.canSwitch[\s\S]*switch-agent/);
  expect(HTML).not.toMatch(/data-act="switch-agent"[^>]*data-(?:provider|model|ticket)/);
});

it('styles the switch action only with semantic VS Code theme tokens', () => {
  const rule = HTML.match(/\.switch-agent\{[^}]*\}/)?.[0] ?? '';
  expect(rule).toContain('var(--vscode-button-secondaryBackground');
  expect(rule).toContain('var(--vscode-button-secondaryForeground');
  expect(rule).not.toMatch(/#[0-9a-f]{3,8}|\b(?:black|white)\b/i);
});
```

- [ ] **Step 4: Run focused tests and verify RED**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts`

Expected: FAIL because `agentSession`, `switch-agent`, `switchAgent`, and the control do not exist.

- [ ] **Step 5: Add agent-session state and context injection**

In `src/ui/dashboard/state.ts`:

```ts
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import { buildAgentSessionView, type AgentSessionView } from '../../agent/sessionSwitch.js';

export interface DashboardAgentContext {
  defaultModel?: string | null;
  modelCatalog?: ModelCatalog;
  isSessionOpen?: (ticketId: number) => boolean;
}
```

Add `agentSession: AgentSessionView` to `DashboardState`. Add a final optional
`agentContext: DashboardAgentContext = {}` parameter after the existing
`defaultProvider` parameter. Build the view once from the resolved provider,
ticket model, `agentContext.defaultModel`, `agentContext.modelCatalog ??
bundledModelCatalog()`, current stage, and
`agentContext.isSessionOpen?.(ticketId) ?? false`.

In `src/ui/dashboard/panel.ts`, add a final constructor getter
`agentContext?: () => DashboardAgentContext` and pass
`this.agentContext?.()` into `buildDashboardState`. Add a panel test that opens a
ticket at `impl`, injects `isSessionOpen: () => true`, and reads the posted state
to assert `agentSession.canSwitch === true`.

- [ ] **Step 6: Add the trusted message and action**

In `messages.ts`:

```ts
// WebviewMessage union
| { type: 'switch-agent' }

// DashboardActions
switchAgent: () => void;

// parseWebviewMessage switch
case 'switch-agent':
  return { type: 'switch-agent' };

// routeAction switch
case 'switch-agent':
  actions.switchAgent();
  return;
```

The parser deliberately ignores every companion field.

- [ ] **Step 7: Render the secondary action without hard-coded colors**

In `webview.html`, add only semantic CSS:

```css
.now .switch-agent{
  color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));
  background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));
}
.now .switch-agent:hover{
  background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-hoverBackground));
}
```

Change `renderNow(now)` to `renderNow(now, agentSession)`. Preserve the existing
primary action, append this only when `agentSession.canSwitch`, and compose the
subtitle from the existing session detail plus
`${agentSession.providerLabel} · ${agentSession.modelLabel}`:

```js
const switchAction = agentSession && agentSession.canSwitch
  ? '<button class="switch-agent" data-act="switch-agent">Switch agent…</button>'
  : '';
const identity = agentSession
  ? `${agentSession.providerLabel} · ${agentSession.modelLabel}`
  : '';
```

Call `renderNow(state.now, state.agentSession)`. Keep text escaped and do not add
provider/model data attributes.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `npx vitest run src/agent/sessionSwitch.test.ts src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the dashboard contract**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: expose agent switching on ticket dashboards"
```

---

### Task 3: Native VS Code Picker, Confirmation, and Relaunch Wiring

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extensionActivation.test.ts`

**Interfaces:**
- Consumes: `runAgentSwitchFlow`, provider/model choice types, `DashboardActions.switchAgent`, `DashboardAgentContext`, `dependencyRegistry`, `ensureCapability`, `updateTicketOnboarding`, `SessionManager.disposeSession`, and command `karst.openSession`.
- Produces: a thin host binding that selects and verifies the replacement, confirms interruption, invokes the tested coordinator, and refreshes all visible ticket state.

- [ ] **Step 1: Write a failing host-binding guard**

Append to `src/extensionActivation.test.ts`:

```ts
it('binds dashboard agent switching to native pickers, confirmation, and the normal launch path', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
  expect(source).toContain('runAgentSwitchFlow(');
  expect(source).toContain('vscode.window.showQuickPick');
  expect(source).toContain("modal: true");
  expect(source).toContain("guardProviderCapability('sessions', provider)");
  expect(source).toContain('sessions.disposeSession(ticketId)');
  expect(source).toContain("vscode.commands.executeCommand('karst.openSession', ticketId)");
});
```

This is intentionally a thin-source guard: importing `extension.ts` would load
the unavailable runtime `vscode` module. All decision/order behavior is already
covered through the real pure coordinator in Task 1.

- [ ] **Step 2: Run the guard and verify RED**

Run: `npx vitest run src/extensionActivation.test.ts`

Expected: FAIL because the switch flow is not wired.

- [ ] **Step 3: Extract a provider-explicit capability guard**

In `extension.ts`, refactor the current ticket-aware guard without changing its
behavior:

```ts
const guardProviderCapability = (
  capability: Capability,
  agentProvider: AgentProvider,
  silent = false,
): boolean => {
  const faults = ensureCapability(
    capability,
    dependencyRegistry(agentProvider),
    binaryExists,
    commandSucceeds,
  );
  if (faults.length === 0) return true;
  refreshDepsStatus();
  for (const fault of faults) {
    logger.warn(`blocked: '${fault.dep.binary}' is ${fault.state}`);
  }
  if (!silent) {
    const text = faults
      .map((fault) => renderDependencyFault(fault.dep, fault.state))
      .filter((message): message is string => message !== null)
      .join(' ');
    void vscode.window.showErrorMessage(text, 'Open setup checklist').then((choice) => {
      if (choice === 'Open setup checklist') welcome.open();
    });
  }
  return false;
};

const guardCapability = (capability: Capability, ticketId?: number, silent = false): boolean => {
  const ticketProvider = ticketId === undefined
    ? undefined
    : getTicket(localStore, ticketId).agentProvider;
  return guardProviderCapability(
    capability,
    resolveProvider(ticketProvider, currentManifest()?.agentProvider),
    silent,
  );
};
```

This is necessary because the ticket still resolves to the old provider while
the replacement is being probed.

- [ ] **Step 4: Bind native provider/model selection and confirmation**

Import the Task 1 APIs. Add an async closure in `activate` that delegates to
`runAgentSwitchFlow`:

```ts
const switchAgentSession = async (ticketId: number): Promise<void> => {
  const outcome = await runAgentSwitchFlow({
    read: () => {
      const ticket = getTicket(localStore, ticketId);
      return {
        stageCurrent: ticket.stageCurrent,
        provider: resolveProvider(ticket.agentProvider, currentManifest()?.agentProvider),
        ticketModel: ticket.model,
        defaultModel: currentManifest()?.defaultModel ?? null,
      };
    },
    isSessionOpen: () => sessions.isOpen(ticketId),
    pickProvider: async (choices, current) => {
      const picked = await vscode.window.showQuickPick(
        choices.map((choice) => ({ label: choice.label, provider: choice.provider })),
        { title: `Switch from ${current.providerLabel} for ${ticketLabel(getTicket(localStore, ticketId))}` },
      );
      return picked?.provider;
    },
    isProviderReady: (provider) => guardProviderCapability('sessions', provider),
    pickModel: async (provider, choices) => vscode.window.showQuickPick(
      choices.map((choice) => ({ ...choice, label: choice.label })),
      { title: `Choose a model for ${PROVIDER_LABELS[provider]}` },
    ),
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
    persist: ({ provider, model }) => updateTicketOnboarding(localStore, ticketId, {
      agentProvider: provider,
      model: model ?? '',
    }),
    dispose: () => sessions.disposeSession(ticketId),
    launch: async () => {
      await vscode.commands.executeCommand('karst.openSession', ticketId);
    },
  }, modelCatalog);

  if (outcome.kind === 'stale') {
    void vscode.window.showInformationMessage('The live agent session changed before it could be switched.');
  } else if (outcome.kind === 'launch-failed') {
    void vscode.window.showErrorMessage(
      `The agent selection was saved, but its session could not start: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
    );
  }
  provider.refresh();
  dashboard.pushState(ticketId);
  showStatusFor(ticketId);
};
```

Quick Pick items must carry the original choice object or its `model` field so
selecting the null/inherit row is distinct from cancelling the picker.

- [ ] **Step 5: Wire the dashboard action and live state getter**

Add `switchAgent: () => void switchAgentSession(ticketId)` to
`makeDashboardActions`, threading one `switchAgent` callback into that factory
instead of importing switch-flow dependencies into `ui/dashboard/messages.ts`.

Pass the new final `DashboardAgentContext` getter to `DashboardManager`:

```ts
() => ({
  defaultModel: currentManifest()?.defaultModel ?? null,
  modelCatalog,
  isSessionOpen: (ticketId) => sessions.isOpen(ticketId),
})
```

Because this is a getter, later dynamic model-catalog loads and terminal changes
are reflected in every state push without restarting the extension.

- [ ] **Step 6: Run focused suites and verify GREEN**

Run:

```bash
npx vitest run src/agent/sessionSwitch.test.ts src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts src/extensionActivation.test.ts src/agent/resumeDecision.test.ts src/ui/session.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck before committing**

Run: `npm run typecheck`

Expected: PASS with no `noUncheckedIndexedAccess`, Quick Pick item, or ESM import errors.

- [ ] **Step 8: Commit the host wiring**

```bash
git add src/extension.ts src/extensionActivation.test.ts
git commit -m "feat: replace live sessions with another agent core"
```

---

### Task 4: Full Regression and Build Verification

**Files:**
- Verify only; change production/test files only if a failing gate reveals a regression caused by Tasks 1–3.

**Interfaces:**
- Consumes: the complete switch flow from Tasks 1–3.
- Produces: evidence that the implementation satisfies repository-wide tests, compilation, asset copying, formatting, and branch hygiene.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all Vitest suites PASS. The `pretest` script may rebuild
`better-sqlite3` for the current Node ABI; this is expected.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Build the extension and copied webview asset**

Run: `npm run build`

Expected: PASS; `scripts/copy-assets.mjs` copies the edited source dashboard
HTML into `dist/`. Do not edit the `dist/` copy directly.

- [ ] **Step 4: Check whitespace and changed-file scope**

Run:

```bash
git diff --check
git status --short
git diff --stat origin/develop...HEAD
```

Expected: no whitespace errors; only the planned source/test/docs files, the
user's pre-existing untracked `.agents/skills/karst-superpowers:writing-plans-writing-plans/`,
and local `.superpowers/brainstorm/` visual-companion artifacts are present.

- [ ] **Step 5: Review the acceptance matrix against the implementation**

Confirm from tests/code:

- live `impl` and `fix` dashboards show current core/model and `Switch agent…`;
- other stages and closed sessions do not;
- core choice filters model choice;
- selected CLI readiness is checked before mutation;
- cancellation and stale-state paths retain the old session;
- confirmation persists both fields, retires the old terminal, and launches fresh;
- the foreign session id is excluded by `shouldResumeSession`;
- a launch failure leaves a retryable selected-core state;
- the webview carries no switch payload and adds no literal color.

- [ ] **Step 6: Request required code review and address blockers**

Use the repository-required code-review agent on all changed code. If it reports
`NEEDS REVISION`, add a failing regression test for each behavior defect, fix it
minimally, rerun Tasks 4.1–4.4, and request review again. Do not mark the ticket
complete with an unresolved blocker.

- [ ] **Step 7: Record the Karst implementation marker**

Only after tests, typecheck, build, diff check, and code review pass, run:

```bash
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket 869eck5hn
```

Expected: the implementation marker is recorded and the ticket advances to its
next stage.
