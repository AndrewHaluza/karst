# Fresh-install Initialization & Welcome Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a fresh install (per-workspace: no `karst.yml`, not dismissed), auto-open a welcome webview showing a setup checklist (manifest, git, agent CLI) plus a short how-to tutorial, driven by an extendable dependency registry.

**Architecture:** New host-agnostic `src/ui/welcome/` module mirroring the `settings` manager pattern (single panel + pure state builder + validated message protocol + actions factory), a pure `src/init/status.ts`, and a generalized agent-CLI dependency registry added to the existing `src/runtime/deps.ts`. Real `vscode` bindings stay isolated to `host.ts` and `extension.ts`.

**Tech Stack:** TypeScript (ESM, `moduleResolution:Bundler`, `.js` import suffixes), vitest, VS Code webview API, vanilla postMessage webview.

## Global Constraints

- ESM: every relative import needs a `.js` suffix.
- `noUncheckedIndexedAccess` on: array/record access needs `!` or a guard.
- `vscode`-importing modules do NOT load under vitest — keep all testable logic in `vscode`-free modules; the only `vscode` imports are `host.ts` and `extension.ts`.
- Immutability: never mutate inputs; return new objects.
- Files small (<400 lines typical). Conventional commits. Strict TDD (RED→GREEN).
- Webview HTML source is edited in `src/`, never `dist/`; `scripts/copy-assets.mjs` mirrors it.
- Message protocol is a trust boundary: `parseWelcomeMessage` validates every discriminant + companion field, returns `null` on anything malformed.
- Provider default before a manifest is resolved: `'claude'`.
- `AgentProvider` union today: `'claude' | 'codex'` (`src/manifest/types.ts:110`).

---

## File Structure

- Create `src/init/status.ts` — pure `buildSetupStatus`.
- Create `src/init/status.test.ts`.
- Modify `src/runtime/deps.ts` — add `AGENT_CLI_DEPENDENCIES` + `agentDependency`.
- Modify `src/runtime/deps.test.ts` — cover `agentDependency` (create if absent).
- Modify `src/extension/manifestResolve.ts` — extract `scaffoldManifest`.
- Create `src/ui/welcome/state.ts` — `WelcomeState`, `TutorialStep`, `TUTORIAL_STEPS`, `buildWelcomeState`.
- Create `src/ui/welcome/state.test.ts`.
- Create `src/ui/welcome/messages.ts` — protocol + `parseWelcomeMessage` + `routeWelcomeAction`.
- Create `src/ui/welcome/messages.test.ts`.
- Create `src/ui/welcome/actions.ts` — `buildWelcomeActions`.
- Create `src/ui/welcome/actions.test.ts`.
- Create `src/ui/welcome/panel.ts` — `WelcomeManager`.
- Create `src/ui/welcome/panel.test.ts`.
- Create `src/ui/welcome/host.ts` — real webview binding (untested).
- Create `src/ui/welcome/webview.html` — checklist + tutorial UI.
- Modify `scripts/copy-assets.mjs` — add welcome HTML to the copied list.
- Modify `package.json` — contribute `karst.openGettingStarted` command.
- Modify `src/extension.ts` — wire `WelcomeManager`, register command, auto-open logic, generalize dep toast.

---

## Task 1: Agent-CLI dependency registry

**Files:**
- Modify: `src/runtime/deps.ts`
- Test: `src/runtime/deps.test.ts` (create if absent)

**Interfaces:**
- Consumes: existing `RequiredDependency` (`{ binary; label; install }`), `GIT_DEPENDENCY`, `checkDependencies`, `binaryExists` from `src/runtime/deps.ts`; `AgentProvider` from `src/manifest/types.ts`.
- Produces:
  - `AGENT_CLI_DEPENDENCIES: Partial<Record<AgentProvider, RequiredDependency>>` (real entry for `claude` only).
  - `agentDependency(provider: AgentProvider): RequiredDependency` — mapped entry or a generic honest fallback.

- [ ] **Step 1: Write the failing test**

Append to `src/runtime/deps.test.ts` (create the file with this content if it does not exist):

```typescript
import { describe, it, expect } from 'vitest';
import { agentDependency, AGENT_CLI_DEPENDENCIES } from './deps.js';

describe('agentDependency', () => {
  it('returns the confirmed claude entry', () => {
    const dep = agentDependency('claude');
    expect(dep.binary).toBe('claude');
    expect(dep.label).toBe('the Claude Code CLI');
    expect(dep.install).toMatch(/claude\.com\/claude-code/);
    expect(AGENT_CLI_DEPENDENCIES.claude).toEqual(dep);
  });

  it('falls back to a generic entry for a provider without confirmed docs', () => {
    const dep = agentDependency('codex');
    expect(dep.binary).toBe('codex');
    expect(dep.label).toBe('the codex CLI');
    expect(dep.install).toContain("'codex' is on your PATH");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/deps.test.ts`
Expected: FAIL — `agentDependency` / `AGENT_CLI_DEPENDENCIES` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/runtime/deps.ts` (after `binaryExists`), and add the import at the top:

```typescript
import type { AgentProvider } from '../manifest/types.js';
```

```typescript
/**
 * Per-provider agent-CLI dependency entries. Decoupled from agent/registry.ts:
 * a provider can be dependency-checked and given install guidance before it has
 * a working adapter. Only providers with confirmed install docs get a real
 * entry; others resolve through the generic fallback in `agentDependency`.
 */
export const AGENT_CLI_DEPENDENCIES: Partial<Record<AgentProvider, RequiredDependency>> = {
  claude: {
    binary: 'claude',
    label: 'the Claude Code CLI',
    install:
      "Install Claude Code (https://docs.claude.com/claude-code) so the 'claude' command is on your PATH, then reload the window.",
  },
};

/**
 * Resolve the dependency entry for an agent provider: the confirmed mapping, or
 * a generic honest fallback (binary = provider name) until real docs are added.
 */
export function agentDependency(provider: AgentProvider): RequiredDependency {
  return (
    AGENT_CLI_DEPENDENCIES[provider] ?? {
      binary: provider,
      label: `the ${provider} CLI`,
      install: `Install the ${provider} CLI and ensure '${provider}' is on your PATH, then reload the window.`,
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/runtime/deps.ts src/runtime/deps.test.ts
git commit -m "feat(init): extendable agent-CLI dependency registry"
```

---

## Task 2: Pure setup-status builder

**Files:**
- Create: `src/init/status.ts`
- Test: `src/init/status.test.ts`

**Interfaces:**
- Consumes: `RequiredDependency`, `GIT_DEPENDENCY` from `src/runtime/deps.ts`; `AgentProvider` from `src/manifest/types.ts`.
- Produces:
  - `interface SetupItem { id: 'manifest' | 'git' | 'agent-cli'; label: string; done: boolean; detail: string | null }`
  - `interface SetupStatusInput { manifestExists: boolean; missingDeps: readonly RequiredDependency[]; provider: AgentProvider }`
  - `function buildSetupStatus(input: SetupStatusInput): SetupItem[]`
  - `const AGENT_AUTH_REMINDER: string`

- [ ] **Step 1: Write the failing test**

Create `src/init/status.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSetupStatus, AGENT_AUTH_REMINDER } from './status.js';
import { GIT_DEPENDENCY, agentDependency } from '../runtime/deps.js';

describe('buildSetupStatus', () => {
  it('marks all items done when nothing is missing', () => {
    const items = buildSetupStatus({ manifestExists: true, missingDeps: [], provider: 'claude' });
    expect(items.map((i) => i.id)).toEqual(['manifest', 'git', 'agent-cli']);
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('marks the manifest item undone when the manifest is missing', () => {
    const items = buildSetupStatus({ manifestExists: false, missingDeps: [], provider: 'claude' });
    expect(items.find((i) => i.id === 'manifest')!.done).toBe(false);
  });

  it('marks git undone when git is in missingDeps', () => {
    const items = buildSetupStatus({
      manifestExists: true,
      missingDeps: [GIT_DEPENDENCY],
      provider: 'claude',
    });
    const git = items.find((i) => i.id === 'git')!;
    expect(git.done).toBe(false);
    expect(git.detail).toBe(GIT_DEPENDENCY.install);
  });

  it('marks the agent CLI undone when its binary is in missingDeps and carries install detail', () => {
    const claudeDep = agentDependency('claude');
    const items = buildSetupStatus({
      manifestExists: true,
      missingDeps: [claudeDep],
      provider: 'claude',
    });
    const cli = items.find((i) => i.id === 'agent-cli')!;
    expect(cli.done).toBe(false);
    expect(cli.detail).toContain(claudeDep.install);
    expect(cli.detail).toContain(AGENT_AUTH_REMINDER);
  });

  it('always includes the auth reminder in the agent-cli detail even when done', () => {
    const items = buildSetupStatus({ manifestExists: true, missingDeps: [], provider: 'claude' });
    const cli = items.find((i) => i.id === 'agent-cli')!;
    expect(cli.done).toBe(true);
    expect(cli.detail).toBe(AGENT_AUTH_REMINDER);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/init/status.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/init/status.ts`:

```typescript
import type { AgentProvider } from '../manifest/types.js';
import { GIT_DEPENDENCY, agentDependency, type RequiredDependency } from '../runtime/deps.js';

/**
 * Pure setup-status model for the welcome page. No vscode, no fs — every input
 * is injected so this is directly unit-testable. The host reads live disk/PATH
 * truth and passes it in; this composes the 3-item checklist.
 */

export interface SetupItem {
  id: 'manifest' | 'git' | 'agent-cli';
  label: string;
  done: boolean;
  /** Actionable guidance shown under an undone item (or the auth note). */
  detail: string | null;
}

export interface SetupStatusInput {
  manifestExists: boolean;
  missingDeps: readonly RequiredDependency[];
  provider: AgentProvider;
}

/** Karst can verify the CLI is installed, not authenticated — remind the user. */
export const AGENT_AUTH_REMINDER =
  'Karst can only check the CLI is installed, not logged in — run its login command once before starting a session.';

export function buildSetupStatus(input: SetupStatusInput): SetupItem[] {
  const missing = new Set(input.missingDeps.map((d) => d.binary));
  const agentDep = agentDependency(input.provider);
  const gitDone = !missing.has(GIT_DEPENDENCY.binary);
  const agentDone = !missing.has(agentDep.binary);

  return [
    {
      id: 'manifest',
      label: 'Create your karst.yml manifest',
      done: input.manifestExists,
      detail: input.manifestExists ? null : 'Karst needs a manifest describing your services.',
    },
    {
      id: 'git',
      label: 'Git is installed',
      done: gitDone,
      detail: gitDone ? null : GIT_DEPENDENCY.install,
    },
    {
      id: 'agent-cli',
      label: `${agentDep.label} is installed`,
      done: agentDone,
      // The auth reminder is always present; install guidance is prepended when missing.
      detail: agentDone ? AGENT_AUTH_REMINDER : `${agentDep.install}\n\n${AGENT_AUTH_REMINDER}`,
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/init/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/init/status.ts src/init/status.test.ts
git commit -m "feat(init): pure setup-status checklist builder"
```

---

## Task 3: Welcome state + tutorial

**Files:**
- Create: `src/ui/welcome/state.ts`
- Test: `src/ui/welcome/state.test.ts`

**Interfaces:**
- Consumes: `SetupItem` from `src/init/status.ts`.
- Produces:
  - `interface TutorialStep { id: string; label: string; description: string; action: 'settings' | 'create-ticket' | null }`
  - `const TUTORIAL_STEPS: readonly TutorialStep[]`
  - `interface WelcomeState { checklist: SetupItem[]; tutorial: readonly TutorialStep[] }`
  - `function buildWelcomeState(checklist: SetupItem[]): WelcomeState`

- [ ] **Step 1: Write the failing test**

Create `src/ui/welcome/state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildWelcomeState, TUTORIAL_STEPS } from './state.js';
import type { SetupItem } from '../../init/status.js';

const checklist: SetupItem[] = [
  { id: 'manifest', label: 'm', done: false, detail: null },
  { id: 'git', label: 'g', done: true, detail: null },
  { id: 'agent-cli', label: 'a', done: true, detail: 'note' },
];

describe('buildWelcomeState', () => {
  it('carries the checklist through unchanged', () => {
    expect(buildWelcomeState(checklist).checklist).toEqual(checklist);
  });

  it('attaches the fixed tutorial steps', () => {
    expect(buildWelcomeState(checklist).tutorial).toEqual(TUTORIAL_STEPS);
  });

  it('has five tutorial steps with unique ids', () => {
    expect(TUTORIAL_STEPS).toHaveLength(5);
    expect(new Set(TUTORIAL_STEPS.map((s) => s.id)).size).toBe(5);
  });

  it('only uses known action values', () => {
    for (const s of TUTORIAL_STEPS) {
      expect(['settings', 'create-ticket', null]).toContain(s.action);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/welcome/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/welcome/state.ts`:

```typescript
import type { SetupItem } from '../../init/status.js';

/**
 * Serializable state for the welcome page. A live setup checklist plus a fixed
 * how-to tutorial. Plain values so it crosses the postMessage boundary.
 */

export interface TutorialStep {
  id: string;
  label: string;
  description: string;
  /** Which jump button to render, or null for an informational step. */
  action: 'settings' | 'create-ticket' | null;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: 'configure',
    label: 'Configure services & agent provider',
    description: 'Open Settings to point each service at its repo and pick your agent CLI.',
    action: 'settings',
  },
  {
    id: 'create',
    label: 'Create your first ticket',
    description: 'Describe the work; Karst fetches or drafts the context brief.',
    action: 'create-ticket',
  },
  {
    id: 'launch',
    label: 'Pick repos + approach and launch the session',
    description: 'Choose which services are in scope and how the agent should work, then start.',
    action: null,
  },
  {
    id: 'watch',
    label: 'Watch stage progress on the ticket dashboard',
    description: 'Open a ticket to follow it through scope → impl → uat as the agent runs.',
    action: null,
  },
  {
    id: 'approaches',
    label: 'Optional: install an approach package',
    description: 'Add a curated method (agents, commands, skills) from Settings → Approaches.',
    action: 'settings',
  },
];

export interface WelcomeState {
  checklist: SetupItem[];
  tutorial: readonly TutorialStep[];
}

export function buildWelcomeState(checklist: SetupItem[]): WelcomeState {
  return { checklist, tutorial: TUTORIAL_STEPS };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/welcome/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/ui/welcome/state.ts src/ui/welcome/state.test.ts
git commit -m "feat(welcome): state + fixed tutorial steps"
```

---

## Task 4: Message protocol (trust boundary)

**Files:**
- Create: `src/ui/welcome/messages.ts`
- Test: `src/ui/welcome/messages.test.ts`

**Interfaces:**
- Consumes: `WelcomeState` from `./state.js`.
- Produces:
  - `type WelcomeMessage` (webview→host): `{type:'create-manifest'} | {type:'recheck-deps'} | {type:'open-settings'} | {type:'create-ticket'} | {type:'dismiss'} | {type:'request-state'}`
  - `type WelcomeHostMessage` (host→webview): `{type:'state';state:WelcomeState} | {type:'error';message:string}`
  - `interface WelcomeActions { createManifest():void; recheckDeps():void; openSettings():void; createTicket():void; dismiss():void; requestState():void }`
  - `function parseWelcomeMessage(raw: unknown): WelcomeMessage | null`
  - `function routeWelcomeAction(raw: unknown, actions: WelcomeActions): void`

- [ ] **Step 1: Write the failing test**

Create `src/ui/welcome/messages.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { parseWelcomeMessage, routeWelcomeAction, type WelcomeActions } from './messages.js';

describe('parseWelcomeMessage', () => {
  it('accepts every known discriminant', () => {
    for (const type of [
      'create-manifest',
      'recheck-deps',
      'open-settings',
      'create-ticket',
      'dismiss',
      'request-state',
    ]) {
      expect(parseWelcomeMessage({ type })).toEqual({ type });
    }
  });

  it('rejects unknown or malformed shapes', () => {
    expect(parseWelcomeMessage(null)).toBeNull();
    expect(parseWelcomeMessage('nope')).toBeNull();
    expect(parseWelcomeMessage({ type: 'evil' })).toBeNull();
    expect(parseWelcomeMessage({})).toBeNull();
  });
});

describe('routeWelcomeAction', () => {
  it('dispatches each message to its action', () => {
    const actions: WelcomeActions = {
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    routeWelcomeAction({ type: 'create-manifest' }, actions);
    routeWelcomeAction({ type: 'recheck-deps' }, actions);
    routeWelcomeAction({ type: 'open-settings' }, actions);
    routeWelcomeAction({ type: 'create-ticket' }, actions);
    routeWelcomeAction({ type: 'dismiss' }, actions);
    routeWelcomeAction({ type: 'request-state' }, actions);
    expect(actions.createManifest).toHaveBeenCalledOnce();
    expect(actions.recheckDeps).toHaveBeenCalledOnce();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.createTicket).toHaveBeenCalledOnce();
    expect(actions.dismiss).toHaveBeenCalledOnce();
    expect(actions.requestState).toHaveBeenCalledOnce();
  });

  it('ignores malformed messages', () => {
    const actions: WelcomeActions = {
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    routeWelcomeAction({ type: 'evil' }, actions);
    expect(actions.createManifest).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/welcome/messages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/welcome/messages.ts`:

```typescript
import type { WelcomeState } from './state.js';

/**
 * Welcome webview ↔ host message protocol. The webview is a trust boundary:
 * `parseWelcomeMessage` validates every discriminant before a host action runs
 * (which may touch the filesystem or run a command). All messages are bare tags
 * (no payloads), so validation is a discriminant whitelist. Mirrors
 * onboarding/messages.ts.
 */

export type WelcomeMessage =
  | { type: 'create-manifest' }
  | { type: 'recheck-deps' }
  | { type: 'open-settings' }
  | { type: 'create-ticket' }
  | { type: 'dismiss' }
  | { type: 'request-state' };

export type WelcomeHostMessage =
  | { type: 'state'; state: WelcomeState }
  | { type: 'error'; message: string };

/** Host-side side-effects the welcome page can trigger. */
export interface WelcomeActions {
  createManifest: () => void;
  recheckDeps: () => void;
  openSettings: () => void;
  createTicket: () => void;
  dismiss: () => void;
  requestState: () => void;
}

const KNOWN: ReadonlySet<WelcomeMessage['type']> = new Set([
  'create-manifest',
  'recheck-deps',
  'open-settings',
  'create-ticket',
  'dismiss',
  'request-state',
]);

export function parseWelcomeMessage(raw: unknown): WelcomeMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as Record<string, unknown>).type;
  if (typeof type !== 'string' || !KNOWN.has(type as WelcomeMessage['type'])) return null;
  return { type: type as WelcomeMessage['type'] };
}

export function routeWelcomeAction(raw: unknown, actions: WelcomeActions): void {
  const msg = parseWelcomeMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'create-manifest':
      actions.createManifest();
      return;
    case 'recheck-deps':
      actions.recheckDeps();
      return;
    case 'open-settings':
      actions.openSettings();
      return;
    case 'create-ticket':
      actions.createTicket();
      return;
    case 'dismiss':
      actions.dismiss();
      return;
    case 'request-state':
      actions.requestState();
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/welcome/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/ui/welcome/messages.ts src/ui/welcome/messages.test.ts
git commit -m "feat(welcome): validated webview message protocol"
```

---

## Task 5: Actions factory

**Files:**
- Create: `src/ui/welcome/actions.ts`
- Test: `src/ui/welcome/actions.test.ts`

**Interfaces:**
- Consumes: `WelcomeActions`, `WelcomeHostMessage` from `./messages.js`; `WelcomeState` from `./state.js`.
- Produces:
  - `interface WelcomeActionsCtx { post(m: WelcomeHostMessage): void; pushState(): void }`
  - `type WelcomeActionsFactory = (ctx: WelcomeActionsCtx) => WelcomeActions`
  - `interface WelcomeActionsDeps { scaffoldManifest(): Promise<void>; setDismissed(): void; runCommand(command: string): void }`
  - `function buildWelcomeActions(deps: WelcomeActionsDeps): WelcomeActionsFactory`

Notes: `runCommand` is the injected `vscode.commands.executeCommand` seam (kept host-agnostic). Command ids used: `'karst.openSettings'`, `'karst.createTicket'`. `createManifest` awaits the scaffold, re-pushes state, and posts an `error` host message on failure. `pushState` is provided by the ctx (the panel binds it to a fresh `loadState`).

- [ ] **Step 1: Write the failing test**

Create `src/ui/welcome/actions.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildWelcomeActions, type WelcomeActionsCtx } from './actions.js';
import type { WelcomeHostMessage } from './messages.js';

function makeCtx() {
  const posted: WelcomeHostMessage[] = [];
  const pushState = vi.fn();
  const ctx: WelcomeActionsCtx = { post: (m) => posted.push(m), pushState };
  return { ctx, posted, pushState };
}

describe('buildWelcomeActions', () => {
  it('createManifest scaffolds then re-pushes state', async () => {
    const scaffoldManifest = vi.fn().mockResolvedValue(undefined);
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await actions.createManifest();
    expect(scaffoldManifest).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('createManifest posts an error when the scaffold throws', async () => {
    const scaffoldManifest = vi.fn().mockRejectedValue(new Error('disk full'));
    const { ctx, posted } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest, setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    await actions.createManifest();
    expect(posted).toContainEqual({ type: 'error', message: 'disk full' });
  });

  it('recheckDeps re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.recheckDeps();
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('openSettings and createTicket run the matching commands', () => {
    const runCommand = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand })(ctx);
    actions.openSettings();
    actions.createTicket();
    expect(runCommand).toHaveBeenCalledWith('karst.openSettings');
    expect(runCommand).toHaveBeenCalledWith('karst.createTicket');
  });

  it('dismiss sets the dismissed flag', () => {
    const setDismissed = vi.fn();
    const { ctx } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed, runCommand: vi.fn() })(ctx);
    actions.dismiss();
    expect(setDismissed).toHaveBeenCalledOnce();
  });

  it('requestState re-pushes state', () => {
    const { ctx, pushState } = makeCtx();
    const actions = buildWelcomeActions({ scaffoldManifest: vi.fn(), setDismissed: vi.fn(), runCommand: vi.fn() })(ctx);
    actions.requestState();
    expect(pushState).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/welcome/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/welcome/actions.ts`:

```typescript
import type { WelcomeActions, WelcomeHostMessage } from './messages.js';

/**
 * Host-side welcome logic, independent of `vscode`. Ties the manifest scaffold,
 * the dismiss flag, and command passthroughs into the actions the webview drives.
 * Kept out of the panel manager so it is unit-testable with fakes; the activation
 * layer supplies the real deps.
 */

export interface WelcomeActionsCtx {
  post(message: WelcomeHostMessage): void;
  /** Rebuild + push fresh state (the panel binds this to a fresh loadState). */
  pushState(): void;
}

export type WelcomeActionsFactory = (ctx: WelcomeActionsCtx) => WelcomeActions;

export interface WelcomeActionsDeps {
  /** Create karst.yml from the bundled template and open it (real: scaffoldManifest). */
  scaffoldManifest: () => Promise<void>;
  /** Persist the per-workspace dismiss flag (real: workspaceState.update). */
  setDismissed: () => void;
  /** Run a registered command (real: vscode.commands.executeCommand). */
  runCommand: (command: string) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildWelcomeActions(deps: WelcomeActionsDeps): WelcomeActionsFactory {
  return (ctx: WelcomeActionsCtx): WelcomeActions => ({
    async createManifest(): Promise<void> {
      try {
        await deps.scaffoldManifest();
        ctx.pushState(); // manifest item flips to done without closing the panel
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },
    recheckDeps(): void {
      ctx.pushState();
    },
    openSettings(): void {
      deps.runCommand('karst.openSettings');
    },
    createTicket(): void {
      deps.runCommand('karst.createTicket');
    },
    dismiss(): void {
      deps.setDismissed();
    },
    requestState(): void {
      ctx.pushState();
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/welcome/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/ui/welcome/actions.ts src/ui/welcome/actions.test.ts
git commit -m "feat(welcome): host-side actions factory"
```

---

## Task 6: Panel manager

**Files:**
- Create: `src/ui/welcome/panel.ts`
- Test: `src/ui/welcome/panel.test.ts`

**Interfaces:**
- Consumes: `WelcomeActions`, `WelcomeHostMessage`, `routeWelcomeAction` from `./messages.js`; `WelcomeState` from `./state.js`; `WelcomeActionsFactory`, `WelcomeActionsCtx` from `./actions.js`; `LogError` from `../../logging/logger.js`.
- Produces:
  - `interface WelcomePanel { reveal(): void; postMessage(m: WelcomeHostMessage): void; onDidReceiveMessage(h: (m: unknown) => void): void; onDidDispose(h: () => void): void }`
  - `interface WelcomePanelHost { createPanel(title: string): WelcomePanel }`
  - `class WelcomeManager` with `constructor(loadState: () => WelcomeState, host: WelcomePanelHost, actionsFactory: WelcomeActionsFactory, logError?: LogError)`, `open(): void`, `isOpen(): boolean`.

Notes: single panel (like `SettingsManager`). `open` reveals an existing panel or creates one; disposal clears it. `pushState` (bound into the ctx) calls `loadState()` fresh and posts `{type:'state', state}`. Pump wraps `routeWelcomeAction` in try/catch + `logError`. State is pushed once on open.

- [ ] **Step 1: Write the failing test**

Create `src/ui/welcome/panel.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { WelcomeManager, type WelcomePanel, type WelcomePanelHost } from './panel.js';
import type { WelcomeHostMessage } from './messages.js';
import type { WelcomeState } from './state.js';
import type { WelcomeActionsCtx } from './actions.js';

function fakeState(): WelcomeState {
  return { checklist: [], tutorial: [] };
}

class FakePanel implements WelcomePanel {
  revealed = 0;
  posted: WelcomeHostMessage[] = [];
  private msgHandler?: (m: unknown) => void;
  private disposeHandler?: () => void;
  reveal(): void {
    this.revealed += 1;
  }
  postMessage(m: WelcomeHostMessage): void {
    this.posted.push(m);
  }
  onDidReceiveMessage(h: (m: unknown) => void): void {
    this.msgHandler = h;
  }
  onDidDispose(h: () => void): void {
    this.disposeHandler = h;
  }
  send(m: unknown): void {
    this.msgHandler?.(m);
  }
  dispose(): void {
    this.disposeHandler?.();
  }
}

function makeHost() {
  const panels: FakePanel[] = [];
  const host: WelcomePanelHost = {
    createPanel: () => {
      const p = new FakePanel();
      panels.push(p);
      return p;
    },
  };
  return { host, panels };
}

describe('WelcomeManager', () => {
  it('pushes state on open', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.posted[0]).toEqual({ type: 'state', state: fakeState() });
  });

  it('reveals the existing panel instead of duplicating', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    mgr.open();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealed).toBe(1);
  });

  it('routes messages to actions and survives a bad message', () => {
    const { host, panels } = makeHost();
    const recheckDeps = vi.fn();
    const logError = vi.fn();
    const mgr = new WelcomeManager(
      fakeState,
      host,
      () => ({
        createManifest: vi.fn(),
        recheckDeps,
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        dismiss: vi.fn(),
        requestState: vi.fn(),
      }),
      logError,
    );
    mgr.open();
    panels[0]!.send({ type: 'recheck-deps' });
    panels[0]!.send({ type: 'evil' }); // ignored, no throw
    expect(recheckDeps).toHaveBeenCalledOnce();
    expect(logError).not.toHaveBeenCalled();
  });

  it('recreates the panel after disposal', () => {
    const { host, panels } = makeHost();
    const mgr = new WelcomeManager(fakeState, host, () => ({
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    }));
    mgr.open();
    panels[0]!.dispose();
    expect(mgr.isOpen()).toBe(false);
    mgr.open();
    expect(panels).toHaveLength(2);
  });

  it('binds pushState so an action re-reads loadState', () => {
    const { host, panels } = makeHost();
    let capturedCtx: WelcomeActionsCtx | undefined;
    const loadState = vi.fn(fakeState);
    const mgr = new WelcomeManager(loadState, host, (ctx) => {
      capturedCtx = ctx;
      return {
        createManifest: vi.fn(),
        recheckDeps: () => ctx.pushState(),
        openSettings: vi.fn(),
        createTicket: vi.fn(),
        dismiss: vi.fn(),
        requestState: vi.fn(),
      };
    });
    mgr.open();
    expect(loadState).toHaveBeenCalledTimes(1); // initial push
    capturedCtx!.pushState();
    expect(loadState).toHaveBeenCalledTimes(2);
    expect(panels[0]!.posted).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/welcome/panel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/welcome/panel.ts`:

```typescript
import type { LogError } from '../../logging/logger.js';
import { routeWelcomeAction, type WelcomeActions, type WelcomeHostMessage } from './messages.js';
import type { WelcomeState } from './state.js';
import type { WelcomeActionsCtx, WelcomeActionsFactory } from './actions.js';

/** The subset of a `vscode.WebviewPanel` the welcome manager touches. */
export interface WelcomePanel {
  reveal(): void;
  postMessage(message: WelcomeHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager uses to mint the panel (real: `createWebviewPanel`). */
export interface WelcomePanelHost {
  createPanel(title: string): WelcomePanel;
}

/**
 * Single welcome panel. `open` reveals an existing panel rather than spawning a
 * duplicate; disposal drops it so a later open recreates it. `loadState` is
 * called fresh on open and on every `pushState` (recheck / post-scaffold) so the
 * checklist always reflects live disk/PATH truth.
 */
export class WelcomeManager {
  private panel: WelcomePanel | undefined;

  constructor(
    private readonly loadState: () => WelcomeState,
    private readonly host: WelcomePanelHost,
    private readonly actionsFactory: WelcomeActionsFactory,
    private readonly logError: LogError = (m, e) => console.error(m, e),
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = this.host.createPanel('Karst — Getting Started');
    this.panel = panel;

    const pushState = (): void => {
      panel.postMessage({ type: 'state', state: this.loadState() });
    };
    const ctx: WelcomeActionsCtx = {
      post: (message) => panel.postMessage(message),
      pushState,
    };
    const actions: WelcomeActions = this.actionsFactory(ctx);

    panel.onDidReceiveMessage((raw) => {
      try {
        routeWelcomeAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        this.logError('karst: welcome action failed', err);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));

    pushState();
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/welcome/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck & commit**

Run: `npm run typecheck`

```bash
git add src/ui/welcome/panel.ts src/ui/welcome/panel.test.ts
git commit -m "feat(welcome): single-panel manager"
```

---

## Task 7: Extract `scaffoldManifest`

**Files:**
- Modify: `src/extension/manifestResolve.ts`

**Interfaces:**
- Produces: `export async function scaffoldManifest(): Promise<void>` — reads the bundled template, mkdirs, writes `manifestPathOrThrow()`, opens it in an editor, shows the info toast. Throws on write failure (callers handle).
- `resolveManifest` calls `scaffoldManifest()` on the "Create karst.yml" confirmation instead of inlining the block.

Notes: this module imports `vscode`, so it is not unit-tested (matches convention — `manifestResolve.ts` has no test today). Verified via `npm run typecheck` and the existing onboarding/spin flows. Behavior of the toast path is unchanged (same steps, same messages).

- [ ] **Step 1: Add `scaffoldManifest` and delegate**

In `src/extension/manifestResolve.ts`, add this exported function (place it above `resolveManifest`):

```typescript
/**
 * Create `karst.yml` from the bundled template: mkdir the parent, write the
 * file, open it in an editor, and confirm with an info toast. Throws on failure
 * so callers can surface it. Shared by `resolveManifest`'s prompt flow and the
 * welcome page's "Create karst.yml" button (which is itself the confirmation, so
 * it calls this directly without a second prompt).
 */
export async function scaffoldManifest(): Promise<void> {
  const manifestPath = manifestPathOrThrow();
  const template = readFileSync(EXAMPLE_YML, 'utf8');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, template);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifestPath));
  void vscode.window.showInformationMessage(
    "Created karst.yml — set each service's repoPath, then try again.",
  );
}
```

Then replace the body of the `if (pick === 'Create karst.yml')` block in `resolveManifest` (the current try/catch that reads the template, mkdirs, writes, opens the doc, and shows the info toast) with:

```typescript
    if (pick === 'Create karst.yml') {
      try {
        await scaffoldManifest();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Could not create karst.yml: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full test suite (no regressions)**

Run: `npm test`
Expected: PASS — no test references the inlined block; behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/extension/manifestResolve.ts
git commit -m "refactor(init): extract scaffoldManifest for reuse"
```

---

## Task 8: Webview HTML + copy-assets

**Files:**
- Create: `src/ui/welcome/webview.html`
- Modify: `scripts/copy-assets.mjs`

**Interfaces:**
- Consumes (at runtime, via postMessage): `{type:'state', state: WelcomeState}` and `{type:'error', message}`.
- Produces (posts to host): the bare-tag `WelcomeMessage` shapes.

Notes: vanilla HTML/JS, no framework, matching `src/ui/settings/webview.html`. Uses `acquireVsCodeApi()`, renders `checklist` (each item: ✓/✗ + label + `detail` + an action button for undone `manifest`/`agent-cli`/`git` where relevant) and `tutorial` (numbered, each with an optional jump button by `action`). Posts `request-state` on load. Buttons: manifest → `create-manifest`; a "Re-check" button → `recheck-deps`; tutorial `settings` → `open-settings`; tutorial `create-ticket` → `create-ticket`; a footer "Don't show this again" → `dismiss`.

- [ ] **Step 1: Create the webview HTML**

Create `src/ui/welcome/webview.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        padding: 1.25rem 1.5rem;
        max-width: 760px;
        line-height: 1.5;
      }
      h1 { font-size: 1.35rem; margin: 0 0 0.25rem; }
      p.lede { margin: 0 0 1.25rem; opacity: 0.85; }
      section { margin-bottom: 1.75rem; }
      h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
      ul { list-style: none; padding: 0; margin: 0; }
      li { padding: 0.6rem 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
      .item-head { display: flex; align-items: center; gap: 0.5rem; }
      .mark { font-weight: 700; width: 1.2rem; display: inline-block; text-align: center; }
      .mark.done { color: var(--vscode-testing-iconPassed, #3fb950); }
      .mark.todo { color: var(--vscode-testing-iconFailed, #f85149); }
      .detail { margin: 0.3rem 0 0 1.7rem; font-size: 0.9rem; opacity: 0.8; white-space: pre-wrap; }
      .steps { counter-reset: step; }
      .steps li { display: flex; gap: 0.75rem; align-items: baseline; }
      .steps li::before {
        counter-increment: step;
        content: counter(step);
        font-weight: 700;
        min-width: 1.4rem;
        color: var(--vscode-textLink-foreground);
      }
      .step-body { flex: 1; }
      .step-desc { font-size: 0.9rem; opacity: 0.8; }
      button {
        margin-top: 0.4rem;
        font: inherit;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: none;
        padding: 0.3rem 0.75rem;
        border-radius: 3px;
        cursor: pointer;
      }
      button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button:hover { opacity: 0.9; }
      .toolbar { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
      .error { color: var(--vscode-errorForeground); margin-top: 0.5rem; }
      footer { margin-top: 1.5rem; opacity: 0.7; }
    </style>
  </head>
  <body>
    <h1>Welcome to Karst</h1>
    <p class="lede">Orchestrate AI-agent ticket workflows across your repos. Finish setup below.</p>

    <section>
      <h2>Setup checklist</h2>
      <ul id="checklist"></ul>
      <div class="toolbar">
        <button class="secondary" id="recheck">Re-check</button>
      </div>
      <div class="error" id="error" hidden></div>
    </section>

    <section>
      <h2>How Karst works</h2>
      <ul class="steps" id="tutorial"></ul>
    </section>

    <footer>
      <button class="secondary" id="dismiss">Don't show this again</button>
    </footer>

    <script>
      const vscode = acquireVsCodeApi();
      const post = (type) => vscode.postMessage({ type });

      function renderChecklist(items) {
        const ul = document.getElementById('checklist');
        ul.innerHTML = '';
        for (const it of items) {
          const li = document.createElement('li');
          const head = document.createElement('div');
          head.className = 'item-head';
          const mark = document.createElement('span');
          mark.className = 'mark ' + (it.done ? 'done' : 'todo');
          mark.textContent = it.done ? '✓' : '✗';
          const label = document.createElement('span');
          label.textContent = it.label;
          head.append(mark, label);
          li.append(head);
          if (it.detail) {
            const d = document.createElement('div');
            d.className = 'detail';
            d.textContent = it.detail;
            li.append(d);
          }
          if (it.id === 'manifest' && !it.done) {
            const b = document.createElement('button');
            b.textContent = 'Create karst.yml';
            b.onclick = () => post('create-manifest');
            li.append(b);
          }
          ul.append(li);
        }
      }

      function renderTutorial(steps) {
        const ul = document.getElementById('tutorial');
        ul.innerHTML = '';
        for (const s of steps) {
          const li = document.createElement('li');
          const body = document.createElement('div');
          body.className = 'step-body';
          const label = document.createElement('div');
          label.textContent = s.label;
          const desc = document.createElement('div');
          desc.className = 'step-desc';
          desc.textContent = s.description;
          body.append(label, desc);
          if (s.action === 'settings' || s.action === 'create-ticket') {
            const b = document.createElement('button');
            b.textContent = s.action === 'settings' ? 'Open Settings' : 'Create Ticket';
            b.onclick = () => post(s.action === 'settings' ? 'open-settings' : 'create-ticket');
            body.append(b);
          }
          li.append(body);
          ul.append(li);
        }
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'state') {
          document.getElementById('error').hidden = true;
          renderChecklist(msg.state.checklist);
          renderTutorial(msg.state.tutorial);
        } else if (msg.type === 'error') {
          const e = document.getElementById('error');
          e.textContent = msg.message;
          e.hidden = false;
        }
      });

      document.getElementById('recheck').onclick = () => post('recheck-deps');
      document.getElementById('dismiss').onclick = () => post('dismiss');
      post('request-state');
    </script>
  </body>
</html>
```

- [ ] **Step 2: Add the asset to copy-assets**

In `scripts/copy-assets.mjs`, add `'ui/welcome/webview.html',` to the `assets` array (next to the other three webview entries).

- [ ] **Step 3: Verify the build copies it**

Run: `npm run build`
Expected: build succeeds and logs `copied ui/welcome/webview.html`; confirm `dist/ui/welcome/webview.html` exists.

- [ ] **Step 4: Commit**

```bash
git add src/ui/welcome/webview.html scripts/copy-assets.mjs
git commit -m "feat(welcome): checklist + tutorial webview"
```

---

## Task 9: Host binding

**Files:**
- Create: `src/ui/welcome/host.ts`

**Interfaces:**
- Consumes: `WelcomePanel`, `WelcomePanelHost` from `./panel.js`; `injectPalette` from `../../model/palette.js`.
- Produces: `function makeWelcomePanelHost(context: vscode.ExtensionContext): WelcomePanelHost`.

Notes: imports `vscode` → untested (matches `host.ts` convention across onboarding/settings/dashboard). Mirrors `makeOnboardingPanelHost` exactly, with view type `'karst.welcome'`.

- [ ] **Step 1: Create the host**

Create `src/ui/welcome/host.ts`:

```typescript
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WelcomePanel, WelcomePanelHost } from './panel.js';
import { injectPalette } from '../../model/palette.js';

/**
 * Activation-layer adapter: real webview panels wrapped in the host-agnostic
 * `WelcomePanelHost` interface. The one place `vscode` webview APIs bind to the
 * welcome manager; everything below it is tested with fakes. The HTML resolves
 * relative to the compiled module (copy-assets mirrors it into dist/).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export function makeWelcomePanelHost(context: vscode.ExtensionContext): WelcomePanelHost {
  const html = injectPalette(readFileSync(join(HERE, 'webview.html'), 'utf8'));
  return {
    createPanel(title: string): WelcomePanel {
      const panel = vscode.window.createWebviewPanel(
        'karst.welcome',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = html;
      return {
        reveal: () => panel.reveal(),
        postMessage: (message) => void panel.webview.postMessage(message),
        onDidReceiveMessage: (handler) =>
          panel.webview.onDidReceiveMessage(handler, undefined, context.subscriptions),
        onDidDispose: (handler) => panel.onDidDispose(handler, undefined, context.subscriptions),
      };
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/welcome/host.ts
git commit -m "feat(welcome): real webview host binding"
```

---

## Task 10: Wire into activation + command + auto-open

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `WelcomeManager` (`./ui/welcome/panel.js`), `buildWelcomeActions` (`./ui/welcome/actions.js`), `makeWelcomePanelHost` (`./ui/welcome/host.js`), `buildSetupStatus` (`./init/status.js`), `buildWelcomeState` (`./ui/welcome/state.js`), `scaffoldManifest` (`./extension/manifestResolve.js`), `agentDependency` (`./runtime/deps.js`), existing `checkDependencies`, `binaryExists`, `GIT_DEPENDENCY`, `manifestPathOrThrow`, `loadManifest`.

Notes on wiring:
- `loadState` for the manager builds live status: resolve `manifestExists` via `existsSync(manifestPathOrThrow())` (guarded — no folder → `false`); resolve the provider from the current/loaded manifest (`agentProvider ?? 'claude'`); compute `missingDeps` via `checkDependencies([GIT_DEPENDENCY, agentDependency(provider)], binaryExists)`; then `buildWelcomeState(buildSetupStatus({ manifestExists, missingDeps, provider }))`.
- The existing dep toast (Task-touched lines ~465–485) keeps working but sources its agent entry from `agentDependency(agentAdapter provider)` rather than the hardcoded literal, and is suppressed when the welcome panel auto-opens.
- Constant: `const WELCOME_DISMISSED_KEY = 'karst.welcomeDismissed';`

- [ ] **Step 1: Add imports**

Add to the import block in `src/extension.ts`:

```typescript
import { WelcomeManager } from './ui/welcome/panel.js';
import { buildWelcomeActions } from './ui/welcome/actions.js';
import { makeWelcomePanelHost } from './ui/welcome/host.js';
import { buildSetupStatus } from './init/status.js';
import { buildWelcomeState } from './ui/welcome/state.js';
import { scaffoldManifest } from './extension/manifestResolve.js';
import { agentDependency } from './runtime/deps.js';
```

Change the existing deps import (currently `import { checkDependencies, binaryExists, GIT_DEPENDENCY, type RequiredDependency } from './runtime/deps.js';`) to also pull `agentDependency` (either merge into that line or keep the separate import above — do not import `agentDependency` twice).

- [ ] **Step 2: Add the dismissed-key constant**

Near the top of the module (after `const HERE = ...`):

```typescript
const WELCOME_DISMISSED_KEY = 'karst.welcomeDismissed';
```

- [ ] **Step 3: Build the welcome loadState + manager**

Inside `activate`, after `currentManifest`/`currentManifestPath` are declared and `reloadManifest` is defined (around line 169), add:

```typescript
  // Live setup status for the welcome page. Reads disk/PATH fresh on every call
  // (no caching) so re-check and post-scaffold pushes reflect reality. Guarded:
  // no workspace folder → manifest counts as missing, provider defaults to claude.
  const loadWelcomeState = () => {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const provider = (currentManifest?.agentProvider ?? 'claude');
    const missingDeps = checkDependencies(
      [GIT_DEPENDENCY, agentDependency(provider)],
      binaryExists,
    );
    return buildWelcomeState(buildSetupStatus({ manifestExists, missingDeps, provider }));
  };

  const welcome = new WelcomeManager(
    loadWelcomeState,
    makeWelcomePanelHost(context),
    buildWelcomeActions({
      scaffoldManifest,
      setDismissed: () => void context.workspaceState.update(WELCOME_DISMISSED_KEY, true),
      runCommand: (command) => void vscode.commands.executeCommand(command),
    }),
    logError,
  );
```

- [ ] **Step 4: Generalize the existing dep toast + suppress on auto-open**

Replace the existing dependency-preflight block (the `const requiredDeps: RequiredDependency[] = [...]` through the `showWarningMessage(...).then(...)`, ~lines 465–485) with:

```typescript
  // Startup dependency preflight (§ todo-5): karst shells out to git + the agent
  // CLI it doesn't bundle. Warn up front (non-blocking) with install guidance.
  const preflightProvider = currentManifest?.agentProvider ?? 'claude';
  const requiredDeps: RequiredDependency[] = [GIT_DEPENDENCY, agentDependency(preflightProvider)];
  const missingDeps = checkDependencies(requiredDeps, binaryExists);

  // Fresh-install welcome: auto-open the getting-started panel when this
  // workspace has no manifest yet and the user hasn't dismissed it. Per-workspace
  // (workspaceState) so a new project re-triggers even if dismissed elsewhere.
  let autoOpenedWelcome = false;
  if (vscode.workspace.workspaceFolders?.[0]) {
    let manifestExists = false;
    try {
      manifestExists = existsSync(manifestPathOrThrow());
    } catch {
      manifestExists = false;
    }
    const dismissed = context.workspaceState.get<boolean>(WELCOME_DISMISSED_KEY) === true;
    if (!manifestExists && !dismissed) {
      welcome.open();
      autoOpenedWelcome = true;
    }
  }

  // Suppress the toast when the panel already shows the same dependency status.
  if (missingDeps.length > 0 && !autoOpenedWelcome) {
    for (const d of missingDeps) logger.warn(`missing dependency '${d.binary}' — ${d.install}`);
    const names = missingDeps.map((d) => d.label).join(' and ');
    void vscode.window
      .showWarningMessage(
        `Karst needs ${names} installed to run sessions. ${missingDeps.map((d) => d.install).join(' ')}`,
        'Show Logs',
      )
      .then((choice) => {
        if (choice === 'Show Logs') channel.show();
      });
  }
```

(The `agentAdapter.requiredBinary` reference is dropped from the toast — the provider registry is now the single source. `agentAdapter` is still used elsewhere for the session manager; leave that as-is.)

- [ ] **Step 5: Register the manual re-open command**

Add to the `context.subscriptions.push(...)` command list (near `karst.openSettings`):

```typescript
    vscode.commands.registerCommand('karst.openGettingStarted', () => welcome.open()),
```

- [ ] **Step 6: Contribute the command in package.json**

In `package.json` `contributes.commands`, add:

```json
      {
        "command": "karst.openGettingStarted",
        "title": "Karst: Getting Started"
      }
```

- [ ] **Step 7: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: succeeds; `dist/ui/welcome/webview.html` present.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat(init): auto-open welcome on fresh install + getting-started command"
```

---

## Task 11: Manual verification (Extension Dev Host)

**Files:** none (manual smoke test).

- [ ] **Step 1: Launch the dev host**

Press F5 in VS Code (runs `dev:extension` then launches the Extension Development Host).

- [ ] **Step 2: Fresh-install path**

Open a folder with NO `.karst/karst.yml`. Expected: the "Karst — Getting Started" panel auto-opens; the manifest item shows ✗ with a "Create karst.yml" button; git/agent-CLI reflect your machine; the agent-CLI item shows the auth reminder. No duplicate dependency toast appears.

- [ ] **Step 3: Create manifest in place**

Click "Create karst.yml". Expected: the file is created and opened in an editor; back in the panel, "Re-check" (or the automatic re-push) flips the manifest item to ✓ without closing the panel.

- [ ] **Step 4: Dismiss + no re-trigger**

Click "Don't show this again", close the panel, reload the window (Cmd-R in the dev host). Expected: with a manifest now present (or the dismiss flag set), the panel does NOT auto-open.

- [ ] **Step 5: Manual re-open**

Run "Karst: Getting Started" from the Command Palette. Expected: the panel opens regardless of the dismiss flag.

- [ ] **Step 6: Tutorial jumps**

Click "Open Settings" and "Create Ticket" in the tutorial. Expected: the respective panels open.

- [ ] **Step 7: Commit (if any doc/screenshot notes were added)**

No code change expected; if verification surfaced a fix, address it in its own task/commit.

---

## Self-Review

**Spec coverage:**
- Fresh-install auto-open (per-workspace, no manifest, not dismissed) → Task 10 (Fix 1 workspaceState, Fix 2 no-folder guard).
- Dependency check, extendable to future providers → Task 1 (registry) + Task 2 (status) + Task 10 (wiring).
- Navigate to config modules → Task 3 (tutorial actions) + Task 5 (command passthroughs) + Task 8 (buttons).
- Tutorial (short numbered steps + jump buttons) → Task 3 + Task 8.
- Checklist scope (manifest + git + agent CLI + auth reminder) → Task 2.
- Reuse scaffold fn → Task 7 + Task 5/10 wiring.
- Manual re-open command → Task 10 (`karst.openGettingStarted`).
- No double surface (Fix 3) → Task 10 Step 4.
- codex/generic honest install text (Fix 4) → Task 1.
- Non-blocking philosophy → nothing gates; only shown. Confirmed across tasks.
- Native walkthrough NOT used → custom webview (Tasks 4–9).

**Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps. Every code step shows full code; every command has expected output.

**Type consistency:** `SetupItem` (status.ts) consumed unchanged by `WelcomeState` (state.ts) and the webview. `WelcomeMessage` bare-tag shapes match `parseWelcomeMessage`, `routeWelcomeAction`, `WelcomeActions`, and the webview's `post(type)` calls. `WelcomeActionsCtx { post, pushState }` matches panel's ctx and actions' usage. `agentDependency(provider)` signature identical in Tasks 1, 2, 10. `scaffoldManifest(): Promise<void>` identical in Tasks 7, 5, 10. `WELCOME_DISMISSED_KEY` used consistently in Task 10. Command ids `karst.openSettings` / `karst.createTicket` / `karst.openGettingStarted` match existing registrations + the new one.
