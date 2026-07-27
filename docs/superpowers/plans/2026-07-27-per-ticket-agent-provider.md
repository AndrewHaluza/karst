# Per-Ticket Agent Provider Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a ticket override which agent core (`claude` | `codex` | `antigravity`) it launches with, instead of always inheriting `manifest.agentProvider`, and expose that override on the onboarding edit page.

**Architecture:** Mirror the existing per-ticket **model** override end-to-end, one level up: a new nullable `tickets.agent_provider` column, a `resolveProvider` precedence helper (ticket wins, else manifest, else `'claude'`), and the same onboarding-webview picker pattern (`Inherit (settings: X)` + explicit choices, locked while a session is open). Every `extension.ts` site that currently hardcodes `currentManifest()?.agentProvider ?? 'claude'` for a specific ticket's action resolves through that ticket's override instead.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (test/dev) via the `Store` abstraction, hand-rolled webview HTML/JS (CSP forbids external scripts).

## Global Constraints

- ESM: every relative import needs a `.js` suffix (`moduleResolution: Bundler`).
- `noUncheckedIndexedAccess` is on — guard or `!` array access.
- New schema column checklist (CLAUDE.md): `schema.sql` (fresh DBs) + a guarded `ALTER` in `migrations.ts` + bump `SCHEMA_VERSION` + update `db.test.ts`'s hardcoded `user_version` assertions.
- All ticket-row mutation goes through the single-writer functions in `store/tickets.ts` (`updateTicketOnboarding` here) — never a raw `UPDATE` elsewhere.
- The onboarding webview is a trust boundary: every new message discriminant must be validated in `parseOnboardingMessage` before it reaches a host action.
- TDD: write the failing test, watch it fail, implement, watch it pass, then commit. Conventional commit messages (`feat:`, `test:`, etc.), no attribution trailer (disabled globally).
- Keep the two "mirrors X" comments (schema.sql ↔ migrations.ts, models.ts ↔ settings/onboarding webview HTML) honest — when you copy a pattern, copy the cross-reference comment too.

---

## Task 1: Schema + migration — `tickets.agent_provider` column

**Files:**
- Modify: `src/store/schema.sql` (tickets table definition)
- Modify: `src/store/migrations.ts` (`SCHEMA_VERSION`, new `if (current < 12)` block)
- Test: `src/store/db.test.ts`

**Interfaces:**
- Produces: a `tickets.agent_provider TEXT` column, `NULL` = inherit the manifest default. `SCHEMA_VERSION = 12`.

- [ ] **Step 1: Write the failing tests**

Add to `src/store/db.test.ts`, next to the existing `'tickets carries the v5 model column'` test (around line 120):

```ts
  it('tickets carries the v12 agent_provider column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('agent_provider');
  });

  it('migrates a legacy v11 DB to v12, adding the agent_provider column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, project_id INTEGER, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-11', 'v11 row');
    legacy.pragma('user_version = 11');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('agent_provider');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-11') as { title: string } | undefined;
    expect(row?.title).toBe('v11 row'); // data survived
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(12);
  });
```

Then, in that same file, bulk-replace every existing `.toBe(11)` (schema-version assertion) with `.toBe(12)` — there are 10 occurrences, all of the shape `expect(....pragma('user_version', { simple: true })).toBe(11)`. Do **not** touch any `legacy.pragma('user_version = N')` lines (those set a simulated starting version, not an assertion).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/db.test.ts`
Expected: FAIL — `agent_provider` column missing; every bumped `.toBe(12)` assertion fails because the real version is still 11.

- [ ] **Step 3: Add the column to schema.sql**

In `src/store/schema.sql`, inside the `tickets` table, right after the `model` column:

```sql
  -- v5 model column (kept in sync with migrations.ts v5 ALTER):
  model             TEXT,                 -- per-ticket launch model id; NULL = inherit default
  -- v6 project column (kept in sync with migrations.ts v6 ALTER):
  project_id        INTEGER,              -- -> projects.id; NULL = unassigned (pre-v6 ticket)
  -- v12 agent_provider column (kept in sync with migrations.ts v12 ALTER):
  agent_provider    TEXT,                 -- per-ticket agent core override; NULL = inherit manifest default
```

- [ ] **Step 4: Add the migration step and bump SCHEMA_VERSION**

In `src/store/migrations.ts`, change:

```ts
export const SCHEMA_VERSION = 11;
```

to:

```ts
export const SCHEMA_VERSION = 12;
```

And add, right after the `if (current < 11)` block (before `db.pragma(\`user_version = ${SCHEMA_VERSION}\`);`):

```ts
  if (current < 12) {
    // v12 adds the per-ticket agent-provider override (§ agent core selection).
    // Fresh DBs already carry it (schema.sql); guard so the ALTER only runs for
    // a legacy DB being upgraded. NULL = inherit manifest.agentProvider, same
    // "inherit" convention as the v5 model column.
    if (!ticketColumns(db).has('agent_provider')) {
      db.exec('ALTER TABLE tickets ADD COLUMN agent_provider TEXT');
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/db.test.ts
git commit -m "feat: add per-ticket agent_provider column (schema v12)"
```

---

## Task 2: Store layer — `Ticket.agentProvider` + `OnboardingPatch`

**Files:**
- Modify: `src/store/tickets.ts`
- Test: `src/store/tickets.test.ts`

**Interfaces:**
- Consumes: `AgentProvider` type from `../manifest/types.js`; `tickets.agent_provider` column (Task 1).
- Produces: `Ticket.agentProvider: AgentProvider | null`; `OnboardingPatch.agentProvider?: string` (empty string clears to inherit, same convention as `model`).

- [ ] **Step 1: Write the failing tests**

Add to `src/store/tickets.test.ts`, next to the existing model round-trip tests (around line 214):

```ts
  it('a new ticket has a null agentProvider (inherit) until one is chosen', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });

  it('updateTicketOnboarding round-trips the per-ticket agentProvider', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'codex' });
    expect(getTicket(store, t.id).agentProvider).toBe('codex');
  });

  it('an empty-string agentProvider clears the selection back to inherit (null)', () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    updateTicketOnboarding(store, t.id, { agentProvider: '' });
    expect(getTicket(store, t.id).agentProvider).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: FAIL — `Property 'agentProvider' does not exist` (TS) or `undefined` at runtime.

- [ ] **Step 3: Implement**

In `src/store/tickets.ts`, add the import:

```ts
import type { AgentProvider } from '../manifest/types.js';
```

Add to the `Ticket` interface, right after `model`:

```ts
  /** Per-ticket launch model id (§ model selection); `null` = inherit the manifest default. */
  model: string | null;
  /** Per-ticket agent-core override (§ agent core selection); `null` = inherit `manifest.agentProvider`. */
  agentProvider: AgentProvider | null;
```

Add to `TicketRow`, right after `model`:

```ts
  model: string | null;
  agent_provider: string | null;
```

In `rowToTicket`, right after `model: r.model,`:

```ts
    model: r.model,
    agentProvider: r.agent_provider as AgentProvider | null,
```

Add to `OnboardingPatch`, right after `model`:

```ts
  /** Per-ticket launch model id; empty string clears it back to inherit. */
  model?: string;
  /** Per-ticket agent-core override; empty string clears it back to inherit. */
  agentProvider?: string;
```

In `updateTicketOnboarding`, right after the `model` line:

```ts
  // An explicit empty string clears the per-ticket model back to "inherit" (NULL).
  if (patch.model !== undefined) columns.model = patch.model === '' ? null : patch.model;
  // Same "inherit" convention for the per-ticket agent-core override.
  if (patch.agentProvider !== undefined) {
    columns.agent_provider = patch.agentProvider === '' ? null : patch.agentProvider;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tickets.ts src/store/tickets.test.ts
git commit -m "feat: persist per-ticket agent-core override in the tickets store"
```

---

## Task 3: `resolveProvider` precedence helper

**Files:**
- Modify: `src/agent/registry.ts`
- Test: `src/agent/registry.test.ts`

**Interfaces:**
- Produces: `resolveProvider(ticketProvider: AgentProvider | null | undefined, manifestProvider: AgentProvider | null | undefined): AgentProvider` — ticket wins, else manifest, else `'claude'`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/registry.test.ts`, extend the existing import line:

```ts
import { resolveAdapter, resolveProvider, IMPLEMENTED_PROVIDERS } from './registry.js';
```

Then append this new `describe` block at the end of the file:

```ts
describe('resolveProvider', () => {
  it('prefers the ticket provider over the manifest default', () => {
    expect(resolveProvider('codex', 'claude')).toBe('codex');
  });

  it('falls back to the manifest default when the ticket has no override', () => {
    expect(resolveProvider(null, 'antigravity')).toBe('antigravity');
    expect(resolveProvider(undefined, 'antigravity')).toBe('antigravity');
  });

  it('falls back to claude when neither the ticket nor the manifest specify a provider', () => {
    expect(resolveProvider(null, null)).toBe('claude');
    expect(resolveProvider(undefined, undefined)).toBe('claude');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/registry.test.ts`
Expected: FAIL — `resolveProvider is not a function` (not exported yet).

- [ ] **Step 3: Implement**

In `src/agent/registry.ts`, add at the end of the file:

```ts
/**
 * Resolve the effective agent provider (§ agent core selection): the
 * ticket's own override wins, else the manifest default, else `'claude'`.
 * Mirrors `resolveModel`'s precedence in `agent/models.ts`.
 */
export function resolveProvider(
  ticketProvider: AgentProvider | null | undefined,
  manifestProvider: AgentProvider | null | undefined,
): AgentProvider {
  return ticketProvider ?? manifestProvider ?? 'claude';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/registry.ts src/agent/registry.test.ts
git commit -m "feat: add resolveProvider precedence helper for per-ticket agent core"
```

---

## Task 4: Onboarding state — provider fields

**Files:**
- Modify: `src/ui/onboarding/state.ts`
- Test: `src/ui/onboarding/state.test.ts`

**Interfaces:**
- Consumes: `resolveProvider` (Task 3), `IMPLEMENTED_PROVIDERS` (`agent/registry.js`), `Ticket.agentProvider` (Task 2).
- Produces: `OnboardingState.agentProviders: AgentProvider[]`, `OnboardingState.selectedAgentProvider: AgentProvider | null`, `OnboardingState.defaultAgentProvider: AgentProvider`. `OnboardingState.models` now reflects the ticket's *resolved* provider, not always the manifest's.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/onboarding/state.test.ts`, as a new top-level `describe` block. This file already has `createTicket`/`updateTicketOnboarding` imported (top of file) and a module-level `MANIFEST` fixture built via `buildManifest(...)` with `agentProvider` unset (so it defaults to `'claude'`); the real `buildOnboardingState` signature (confirmed from the neighboring `sessionOpen` tests) is `buildOnboardingState(store, manifest, listInstalledIds, listAgents, ticketId?, isSessionOpen?)`:

```ts
describe('buildOnboardingState — agent core (provider) fields', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('create mode offers every implemented provider, selects none, and defaults to the manifest provider', () => {
    const m: Manifest = { ...MANIFEST, agentProvider: 'codex' };
    const s = buildOnboardingState(store, m, () => [], () => []);
    expect(s.agentProviders).toEqual(['claude', 'codex', 'antigravity']);
    expect(s.selectedAgentProvider).toBeNull();
    expect(s.defaultAgentProvider).toBe('codex');
  });

  it("edit mode reflects the ticket's persisted agentProvider override", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.selectedAgentProvider).toBe('antigravity');
    expect(s.defaultAgentProvider).toBe('claude');
  });

  it("the model list is filtered by the ticket's resolved provider, not always the manifest default", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.models.map((m) => m.id)).toContain('gemini-3.6-flash-high');
    expect(s.models.map((m) => m.id)).not.toContain('claude-opus-4-8');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/state.test.ts`
Expected: FAIL — `agentProviders`/`selectedAgentProvider`/`defaultAgentProvider` are `undefined`; the model-list test fails because it's still filtered by the manifest's raw provider.

- [ ] **Step 3: Implement**

In `src/ui/onboarding/state.ts`, update the imports:

```ts
import { modelsForProvider, type ModelOption } from '../../agent/models.js';
import { IMPLEMENTED_PROVIDERS, resolveProvider } from '../../agent/registry.js';
import type { Manifest, ApproachDef, TicketProvider, AgentProvider } from '../../manifest/types.js';
```

Add to the `OnboardingState` interface, right after `defaultModel`:

```ts
  /** Manifest default model, for the "Inherit (settings: …)" label; null = none. */
  defaultModel: string | null;
  /** Implemented agent-core providers offered in the picker. */
  agentProviders: AgentProvider[];
  /** Per-ticket agent-core override; null = inherit the manifest default. */
  selectedAgentProvider: AgentProvider | null;
  /** Manifest's resolved default provider, for the "Inherit (settings: …)" label. */
  defaultAgentProvider: AgentProvider;
```

In the function that builds `OnboardingState` (the one already computing `models`/`selectedModel`), compute the resolved provider ONCE, before the `create`/`edit` branch (right where `provider` — the *ticketing* provider — is already computed, keep the two clearly apart by name):

```ts
  const defaultAgentProvider = manifest.agentProvider ?? 'claude';
```

Then in the create-mode return object, replace:

```ts
      models: [...modelsForProvider(manifest.agentProvider ?? 'claude')],
      selectedModel: null,
      defaultModel: manifest.defaultModel ?? null,
```

with:

```ts
      models: [...modelsForProvider(defaultAgentProvider)],
      selectedModel: null,
      defaultModel: manifest.defaultModel ?? null,
      agentProviders: [...IMPLEMENTED_PROVIDERS],
      selectedAgentProvider: null,
      defaultAgentProvider,
```

And in the edit-mode return object, replace:

```ts
    models: [...modelsForProvider(manifest.agentProvider ?? 'claude')],
    selectedModel: ticket.model ?? null,
    defaultModel: manifest.defaultModel ?? null,
```

with:

```ts
    models: [...modelsForProvider(resolveProvider(ticket.agentProvider, manifest.agentProvider))],
    selectedModel: ticket.model ?? null,
    defaultModel: manifest.defaultModel ?? null,
    agentProviders: [...IMPLEMENTED_PROVIDERS],
    selectedAgentProvider: ticket.agentProvider ?? null,
    defaultAgentProvider,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/state.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full onboarding test suite to catch anything relying on the old field shape**

Run: `npx vitest run src/ui/onboarding`
Expected: PASS (no other test asserts an exact/exhaustive `OnboardingState` shape that the three new fields would break — if one does, add the three fields to its expected object rather than changing the assertion's intent)

- [ ] **Step 6: Commit**

```bash
git add src/ui/onboarding/state.ts src/ui/onboarding/state.test.ts
git commit -m "feat: surface per-ticket agent-core fields in onboarding state"
```

---

## Task 5: Onboarding messages — `set-provider`

**Files:**
- Modify: `src/ui/onboarding/messages.ts`
- Test: `src/ui/onboarding/messages.test.ts`

**Interfaces:**
- Consumes: none beyond existing types.
- Produces: `OnboardingMessage` variant `{ type: 'set-provider'; id: string }`; `TicketDraftFields.agentProvider?: string | null` (optional — existing `submit`/`save` test fixtures that omit it keep compiling); `OnboardingActions.setProvider(id: string): void`.

- [ ] **Step 1: Update the existing full-shape assertions, then write the failing tests**

`parseDraftFields` will always populate `agentProvider` (defaulting to `null`, exactly like `model` already does), so every existing test that asserts the FULL parsed/dispatched object shape needs `agentProvider: null` (or the chosen value) added. In `src/ui/onboarding/messages.test.ts`, update these four `toEqual` blocks (lines ~48–58 and ~64–73):

```ts
    expect(
      parseOnboardingMessage({ type: 'submit', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null,
    });
    // repos + approach + agent + model + agentProvider carried through when present
    expect(
      parseOnboardingMessage({
        type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
      }),
    ).toEqual({
      type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
    });
  });

  it('accepts a well-formed save message, mirroring submit validation', () => {
    expect(
      parseOnboardingMessage({ type: 'save', key: 'P-1', title: 't', description: 'd' }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: [], approach: null, agent: null, model: null, agentProvider: null,
    });
    expect(
      parseOnboardingMessage({
        type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
      }),
    ).toEqual({
      type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
    });
```

And in the `routeOnboardingAction` describe block, update `spyActions()` to add `setProvider: vi.fn(),` right after `setModel: vi.fn(),`, then update its two full-object assertions (~lines 163–189):

```ts
    routeOnboardingAction(
      { type: 'submit', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    routeOnboardingAction({ type: 'analyze', prompt: 'go' }, actions);
    routeOnboardingAction({ type: 'set-agent', id: 'reviewer' }, actions);
    routeOnboardingAction({ type: 'set-model', id: 'claude-sonnet-5' }, actions);
    routeOnboardingAction({ type: 'set-provider', id: 'antigravity' }, actions);
    routeOnboardingAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/CU-1' }, actions);
    expect(actions.fetchSource).toHaveBeenCalledWith('CU-1');
    expect(actions.saveSignals).toHaveBeenCalledWith('be', ['api']);
    expect(actions.submit).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
    });
    expect(actions.analyze).toHaveBeenCalledWith('go');
    expect(actions.setAgent).toHaveBeenCalledWith('reviewer');
    expect(actions.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(actions.setProvider).toHaveBeenCalledWith('antigravity');
    expect(actions.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/CU-1');
  });

  it('routes a valid save message to the save action', () => {
    const actions = spyActions();
    routeOnboardingAction(
      { type: 'save', key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex' },
      actions,
    );
    expect(actions.save).toHaveBeenCalledWith({
      key: 'P-1', title: 't', description: 'd', repos: ['fe'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', agentProvider: 'codex',
    });
```

Then add the two new tests. Next to the existing `set-model` case in the `parseOnboardingMessage` describe block:

```ts
  it('accepts set-provider, including the empty "inherit" choice', () => {
    expect(parseOnboardingMessage({ type: 'set-provider', id: 'codex' })).toEqual({
      type: 'set-provider',
      id: 'codex',
    });
    expect(parseOnboardingMessage({ type: 'set-provider', id: '' })).toEqual({
      type: 'set-provider',
      id: '',
    });
  });
```

The `set-provider` routing case is already covered above (folded into the existing `'routes each valid message to its action'` test) rather than as a separate test — that mirrors how `set-model` itself is tested in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/messages.test.ts`
Expected: FAIL — the updated `toEqual`/`toHaveBeenCalledWith` assertions see no `agentProvider` key back yet; the new `set-provider` message parses to `null`; `actions.setProvider` doesn't exist on the real (not-yet-updated) `OnboardingActions` type.

- [ ] **Step 3: Implement**

In `src/ui/onboarding/messages.ts`:

Add `agentProvider` to `TicketDraftFields`, typed optional (`?:`) even though `parseDraftFields` always populates it with a value (never omits the key) — the optional marker is what keeps this a source-compatible addition: every existing `actions.submit({...})`/`actions.save({...})` object literal in `actions.test.ts` that predates this field (there are ~20) omits it, and a *required* field here would make every one of those a TypeScript error. `parseOnboardingMessage`'s own callers are unaffected either way since its input is `unknown`.

```ts
export interface TicketDraftFields {
  key: string;
  title: string;
  description: string;
  repos: string[];
  approach: string | null;
  agent: string | null;
  model: string | null;
  /** Per-ticket agent-core override; null = inherit the manifest default. */
  agentProvider?: string | null;
}
```

Add the message variant, right after `set-model`:

```ts
  // id may be '' — the "Inherit (settings)" choice, which clears the model.
  | { type: 'set-model'; id: string }
  // id may be '' — the "Inherit (settings)" choice, which clears the provider.
  | { type: 'set-provider'; id: string }
```

Add to `OnboardingActions`, right after `setModel`:

```ts
  setModel: (id: string) => void;
  setProvider: (id: string) => void;
```

In `parseDraftFields`, add after the `model` line:

```ts
  const model = typeof m.model === 'string' && m.model.length > 0 ? m.model : null;
  const agentProvider =
    typeof m.agentProvider === 'string' && m.agentProvider.length > 0 ? m.agentProvider : null;
```

and add `agentProvider,` to the returned object.

In `parseOnboardingMessage`'s switch, right after the `set-model` case:

```ts
    case 'set-model':
      // id may be '' ("Inherit"); require the field to be a string, not non-empty.
      return typeof m.id === 'string' ? { type: 'set-model', id: m.id } : null;
    case 'set-provider':
      // id may be '' ("Inherit"); require the field to be a string, not non-empty.
      return typeof m.id === 'string' ? { type: 'set-provider', id: m.id } : null;
```

In `routeOnboardingAction`'s switch, right after the `set-model` case:

```ts
    case 'set-model':
      actions.setModel(msg.id);
      return;
    case 'set-provider':
      actions.setProvider(msg.id);
      return;
```

And add `agentProvider: msg.agentProvider,` to both the `submit` and `save` case bodies, right after `model: msg.model,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/messages.ts src/ui/onboarding/messages.test.ts
git commit -m "feat: add set-provider onboarding message"
```

---

## Task 6: Onboarding actions — `setProvider` + draft persistence

**Files:**
- Modify: `src/ui/onboarding/actions.ts`
- Test: `src/ui/onboarding/actions.test.ts`

**Interfaces:**
- Consumes: `OnboardingActions.setProvider` (Task 5), `updateTicketOnboarding` with `agentProvider` (Task 2).
- Produces: `setProvider` persists onto an existing ticket and re-pushes state; `persistDraft` carries `agentProvider` through `submit`/`save` the same way it carries `model`.

- [ ] **Step 1: Write the failing tests**

This file has two established fixture styles for `OnboardingActionsCtx`: a hand-rolled inline literal (used by the neighboring `setModel`/`setAgent` tests, with `pushState: () => {}`), and a `mkCtx(ticketId?)` helper (defined near the top of the file) that additionally tracks a `.pushes` counter — use `mkCtx` here since this test needs to assert a push happened. `deps` is built fresh in the file's `beforeEach` (already in scope).

Add to `src/ui/onboarding/actions.test.ts`, next to the existing `'setModel persists onto an existing ticket, and empty clears it to inherit'` test:

```ts
  it('setProvider persists onto an existing ticket, re-pushes state, and empty clears it to inherit', () => {
    const t = createTicket(store, { key: 'P-PR', title: 't' });
    const ctx = mkCtx(t.id);
    const actions = buildOnboardingActions(deps)(ctx);

    actions.setProvider('codex');
    expect(getTicket(store, t.id).agentProvider).toBe('codex');
    expect(ctx.pushes).toBe(1);
    actions.setProvider('');
    expect(getTicket(store, t.id).agentProvider).toBeNull();
    expect(ctx.pushes).toBe(2);
  });
```

And, next to the existing `'submit persists the per-ticket model when chosen, and leaves it null on inherit'` test (same file, same `create`-mode inline-ctx style, same `listTickets(store)[0]!.id` lookup since the ticket doesn't exist until `submit` creates it):

```ts
  it('submit persists the chosen agentProvider on a newly created ticket', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-P', title: 't', description: '', repos: [], approach: null, agent: null,
      model: null, agentProvider: 'antigravity',
    });
    expect(getTicket(store, listTickets(store)[0]!.id).agentProvider).toBe('antigravity');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/actions.test.ts`
Expected: FAIL — `actions.setProvider is not a function`; `t?.agentProvider` is `undefined` because `persistDraft` never wrote it.

- [ ] **Step 3: Implement**

In `src/ui/onboarding/actions.ts`, update `persistDraft`'s `updateTicketOnboarding` call:

```ts
  updateTicketOnboarding(deps.store, ticketId, {
    selectedRepos: input.repos,
    ...(input.approach !== null ? { approach: input.approach } : {}),
    ...(input.agent !== null ? { agent: input.agent } : {}),
    // null = "Inherit"; persist '' so the store clears any prior pick to NULL.
    model: input.model ?? '',
    agentProvider: input.agentProvider ?? '',
  });
```

Add the action, right after `setModel`:

```ts
    setModel(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit the manifest default at launch).
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { model: id });
      }
    },

    setProvider(id: string): void {
      // An empty id is the "Inherit (settings)" choice — persisted as '' which
      // the store maps to NULL (inherit manifest.agentProvider at launch).
      // Unlike setModel, this re-pushes state: a provider change also
      // re-filters the model picker (§ model/provider compatibility), and the
      // next state push is what carries the re-filtered `models` list down.
      if (ctx.ticketId !== undefined) {
        updateTicketOnboarding(deps.store, ctx.ticketId, { agentProvider: id });
        ctx.pushState();
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/onboarding/actions.ts src/ui/onboarding/actions.test.ts
git commit -m "feat: persist per-ticket agent-core override from onboarding actions"
```

---

## Task 7: Onboarding webview — agent-core picker UI

**Files:**
- Modify: `src/ui/onboarding/webview.html`
- Test: `src/ui/onboarding/webview.test.ts`

**Interfaces:**
- Consumes: `state.agentProviders`, `state.selectedAgentProvider`, `state.defaultAgentProvider` (Task 4); posts `{ type: 'set-provider', id }` (Task 5).
- Produces: a new `<select id="providerSelect">` next to the model picker, locked while `sessionOpen`, feeding `agentProvider` into the `submit`/`save` payloads.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/onboarding/webview.test.ts`:

```ts
  it('renders an agent-core (provider) picker next to the model picker', () => {
    expect(HTML).toContain('id="providerSelect"');
    expect(HTML).toContain('id="providerLockHint"');
  });

  it('locks the provider picker while a session is open, mirroring the model picker', () => {
    const fnMatch = HTML.match(/function renderProviderPicker\([^)]*\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'renderProviderPicker() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("el('providerSelect').disabled = !!sessionOpen");
  });

  it('posts set-provider on change and carries agentProvider into submit/save', () => {
    expect(HTML).toContain("post({ type: 'set-provider', id });");
    const submitBlock = HTML.slice(
      HTML.indexOf("el('submitBtn').addEventListener"),
      HTML.indexOf("el('saveBtn').addEventListener"),
    );
    expect(submitBlock).toContain('agentProvider');
    const saveBlock = HTML.slice(HTML.indexOf("el('saveBtn').addEventListener"));
    expect(saveBlock.slice(0, 800)).toContain('agentProvider');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/onboarding/webview.test.ts`
Expected: FAIL — none of the new strings/functions exist yet.

- [ ] **Step 3: Add the picker markup**

In `src/ui/onboarding/webview.html`, right before the existing `<div id="modelPicker">` block:

```html
      <div id="providerPicker">
        <label for="providerSelect">Agent core</label>
        <select id="providerSelect"></select>
        <div class="sub hidden" id="providerLockHint">Locked while the session runs — close the terminal to change it.</div>
      </div>
      <div id="modelPicker">
        <label for="modelSelect">Model</label>
        <select id="modelSelect"></select>
        <div class="sub hidden" id="modelLockHint">Locked while the session runs — close the terminal to change it.</div>
      </div>
```

- [ ] **Step 4: Track the draft pick**

Change:

```js
  let draft = { mode: 'create', repos: {}, approach: null, selectedAgent: null, selectedModel: null };
```

to:

```js
  let draft = {
    mode: 'create', repos: {}, approach: null, selectedAgent: null, selectedModel: null,
    selectedAgentProvider: null,
  };
```

- [ ] **Step 5: Render it from state**

In `function render(state) { ... }`, right before the `renderModelPicker(...)` call:

```js
    renderProviderPicker(state.agentProviders, state.selectedAgentProvider, state.defaultAgentProvider, state.sessionOpen);
    renderModelPicker(state.models, state.selectedModel, state.defaultModel, state.sessionOpen);
```

- [ ] **Step 6: Write the render function**

Right before `function renderModelPicker(...)`:

```js
  // Agent-core (provider) picker: an "Inherit (settings)" option (empty value)
  // plus the implemented providers pushed in `state.agentProviders`. Mirrors
  // renderModelPicker exactly, including the session-open lock — the adapter is
  // baked into the terminal at spawn, same as the model.
  function renderProviderPicker(providers, selectedProvider, defaultProvider, sessionOpen) {
    const list = providers || [];
    const sel = draft.selectedAgentProvider ?? selectedProvider ?? '';
    const defLabel = `Inherit (settings: ${esc(defaultProvider)})`;
    const opts = [`<option value=""${sel ? '' : ' selected'}>${defLabel}</option>`];
    for (const p of list) {
      opts.push(`<option value="${esc(p)}"${p === sel ? ' selected' : ''}>${esc(p)}</option>`);
    }
    el('providerSelect').innerHTML = opts.join('');
    el('providerSelect').disabled = !!sessionOpen;
    el('providerLockHint').classList.toggle('hidden', !sessionOpen);
  }

```

- [ ] **Step 7: Wire the change listener**

Right after the existing `el('modelSelect').addEventListener('change', ...)` block:

```js
  // Pick a provider (or "Inherit", value ''): record + post. In create mode the
  // host no-ops the persist; submit carries the final value.
  el('providerSelect').addEventListener('change', (e) => {
    const id = e.target.value;
    draft.selectedAgentProvider = id || null;
    post({ type: 'set-provider', id });
  });
```

- [ ] **Step 8: Carry it through submit/save**

In the `submitBtn` click handler, change:

```js
    const model = (draft.selectedModel ?? el('modelSelect').value ?? '') || null;
    post({ type: 'submit', key, title, description: el('desc').value, repos, approach, agent, model });
```

to:

```js
    const model = (draft.selectedModel ?? el('modelSelect').value ?? '') || null;
    const agentProvider = (draft.selectedAgentProvider ?? el('providerSelect').value ?? '') || null;
    post({ type: 'submit', key, title, description: el('desc').value, repos, approach, agent, model, agentProvider });
```

And in the `saveBtn` click handler, the equivalent `model`/`post({ type: 'save', ... })` lines the same way:

```js
    const model = (draft.selectedModel ?? el('modelSelect').value ?? '') || null;
    const agentProvider = (draft.selectedAgentProvider ?? el('providerSelect').value ?? '') || null;
    post({ type: 'save', key, title, description: el('desc').value, repos, approach, agent, model, agentProvider });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/ui/onboarding/webview.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/ui/onboarding/webview.html src/ui/onboarding/webview.test.ts
git commit -m "feat: add agent-core picker to the onboarding edit/create page"
```

---

## Task 8: Wire per-ticket resolution through extension.ts launch/dep-check sites

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `resolveProvider` (Task 3), `Ticket.agentProvider` (Task 2).
- Produces: `currentAgentAdapter(ticketId?)`, `guardCapability(capability, ticketId?, silent?)` — both resolve the ticket's own provider override when a ticket id is given, falling back to the manifest default exactly as before when it isn't.

This task has no dedicated unit test — `extension.ts` has none today (only the shallow `src/extensionActivation.test.ts`), and every call site below is either wrapped in `vscode.commands.registerCommand` or reads live editor state, so it isn't independently testable under vitest. Verify with the full suite + typecheck instead (Step 6).

- [ ] **Step 1: Add the import**

Near the existing `import { resolveAdapter } from './agent/registry.js';` (around line 31):

```ts
import { resolveAdapter, resolveProvider } from './agent/registry.js';
```

- [ ] **Step 2: Make `currentAgentAdapter` ticket-aware**

Find (around line 327):

```ts
  const currentAgentAdapter = (): AgentAdapter =>
    resolveAdapter(currentManifest()?.agentProvider ?? 'claude');
```

Replace with:

```ts
  const currentAgentAdapter = (ticketId?: number): AgentAdapter => {
    const ticketProvider =
      ticketId !== undefined ? getTicket(localStore, ticketId).agentProvider : undefined;
    return resolveAdapter(resolveProvider(ticketProvider, currentManifest()?.agentProvider));
  };
```

- [ ] **Step 3: Make `guardCapability` (and its exported shape) ticket-aware**

Find the `CapabilityGuard` type (around line 1948):

```ts
type CapabilityGuard = (capability: Capability, silent?: boolean) => boolean;
```

Replace with:

```ts
type CapabilityGuard = (capability: Capability, ticketId?: number, silent?: boolean) => boolean;
```

Find the `guardCapability` definition (around line 436):

```ts
  const guardCapability = (capability: Capability, silent = false): boolean => {
    const provider = currentManifest()?.agentProvider ?? 'claude';
    const faults = ensureCapability(
      capability,
      dependencyRegistry(provider),
      binaryExists,
      commandSucceeds,
    );
```

Replace with:

```ts
  const guardCapability = (capability: Capability, ticketId?: number, silent = false): boolean => {
    const ticketProvider =
      ticketId !== undefined ? getTicket(localStore, ticketId).agentProvider : undefined;
    const provider = resolveProvider(ticketProvider, currentManifest()?.agentProvider);
    const faults = ensureCapability(
      capability,
      dependencyRegistry(provider),
      binaryExists,
      commandSucceeds,
    );
```

(`refreshDepsStatus`, a few lines above, stays exactly as-is — the status bar has no single ticket in view, so it keeps checking the manifest default only.)

- [ ] **Step 4: Update every call site**

1. In `maybeDrive` (around line 994), which already has `ticketId` as its own parameter:

   ```ts
   if (!guardCapability('gates', gateToolsWarned)) {
   ```

   becomes:

   ```ts
   if (!guardCapability('gates', ticketId, gateToolsWarned)) {
   ```

2. In the `karst.openSession` command handler (around lines 1163–1167), which already resolves `ticketId`:

   ```ts
         const ticketId = ticketIdArg(arg);
         if (ticketId === undefined) return;
         const adapter = currentAgentAdapter();
         // Without the CLI the terminal opens, prints a shell "command not found",
         // and sits there looking like karst did something.
         if (!guardCapability('sessions')) return;
   ```

   becomes:

   ```ts
         const ticketId = ticketIdArg(arg);
         if (ticketId === undefined) return;
         const adapter = currentAgentAdapter(ticketId);
         // Without the CLI the terminal opens, prints a shell "command not found",
         // and sits there looking like karst did something.
         if (!guardCapability('sessions', ticketId)) return;
   ```

3. In the same handler, further down (around line 1373), where the launch model is resolved from the ticket `t` that's already been loaded:

   ```ts
         // Resolve the launch model: the ticket's own model wins, else the manifest
         // default, else undefined (let the agent CLI pick). Threaded as `--model`.
         const model = resolveModelForProvider(
           currentManifest()?.agentProvider ?? 'claude',
           t.model,
           currentManifest()?.defaultModel,
         );
   ```

   becomes:

   ```ts
         // Resolve the launch model: the ticket's own model wins, else the manifest
         // default, else undefined (let the agent CLI pick). Threaded as `--model`.
         // The provider it's resolved against is this same ticket's own resolved
         // agent core (§ agent core selection) — a ticket overridden to a different
         // provider must not carry an incompatible model pick across the switch.
         const model = resolveModelForProvider(
           resolveProvider(t.agentProvider, currentManifest()?.agentProvider),
           t.model,
           currentManifest()?.defaultModel,
         );
   ```

4. In the `karst.spinTicket` command handler (around line 1420), which already resolves `ticketId`:

   ```ts
         if (!guardCapability('worktrees') || !guardCapability('gates')) return;
   ```

   becomes:

   ```ts
         if (!guardCapability('worktrees', ticketId) || !guardCapability('gates', ticketId)) return;
   ```

5. In `makeDashboardActions` (the local function around line 1950), `ticketId` is already its own parameter — the `guardCapability` param it receives is now `CapabilityGuard` with the new shape, so no signature change is needed inside this function, only the call site (around line 2043):

   ```ts
         if (!guardCapability('ship')) return;
   ```

   becomes:

   ```ts
         if (!guardCapability('ship', ticketId)) return;
   ```

6. At the `makeDashboardActions(...)` call site (around line 795), where `currentAgentAdapter` is passed by bare reference inside the `(ticketId) => makeDashboardActions(...)` wrapper:

   ```ts
       (ticketId) =>
         makeDashboardActions(
           localStore,
           ticketId,
           currentAgentAdapter,
   ```

   becomes:

   ```ts
       (ticketId) =>
         makeDashboardActions(
           localStore,
           ticketId,
           () => currentAgentAdapter(ticketId),
   ```

   (`guardCapability` is passed by reference a few lines below in that same call — leave it exactly as-is; its type change in Step 3 is all that's needed, since `makeDashboardActions`'s own `guardCapability('ship', ticketId)` call in Step 4.5 now supplies the ticket id itself.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If any other caller of `guardCapability` or `currentAgentAdapter` turns up that this task's grep missed, TypeScript will point at it directly — fix it the same way (thread the ticket id it already has in scope).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — this task changes no testable pure logic (`resolveProvider` itself is already covered in Task 3), only how `extension.ts` wires it in, so the full suite passing with no new failures is the acceptance bar here.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts
git commit -m "feat: resolve per-ticket agent core at every launch and dependency-check site"
```

---

## Self-Review Notes (for the implementer, not a separate task)

- After Task 8, grep `src/extension.ts` for `agentProvider ?? 'claude'` and `currentAgentAdapter()` (no-arg) once more — anything left is either the intentionally-global `refreshDepsStatus`/`loadWelcomeState`/onboarding-host `get adapter()` (unchanged by design, see the spec's "Out of scope" note) or a site this plan missed and should be fixed the same way.
- Do not add a sidebar/dashboard badge for the override — out of scope per the spec.
- Do not touch `manifest/write.ts` or `manifest/schema.ts` — `agentProvider` per ticket is a DB column, not a manifest field; the manifest-level `agentProvider` (the default) is untouched.
