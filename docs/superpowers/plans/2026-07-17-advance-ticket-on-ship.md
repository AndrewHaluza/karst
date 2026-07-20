# Advance Ticket On Ship — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After karst ships a ticket, optionally push a configured status to the ticketing provider (ClickUp), set up from the settings Ticketing page against a status list fetched from the provider.

**Architecture:** Three inert seams get wired: `updateTicketStatus` (uncalled), `clickupProvider.updateStatus` (no-op stub), and `ticketing.listId` (parsed, never read). The push decision lives in `done.ts` (`advanceTicketOnShip`), so `extension.ts` holds one call and every branch is unit-testable. The ticket is addressed by `sourceRef` — the ref the provider returned at fetch — never the user-editable `key`.

**Tech Stack:** TypeScript ESM, vitest, better-sqlite3, VS Code webview (vanilla JS, no framework).

**Spec:** `docs/superpowers/specs/2026-07-17-advance-ticket-on-ship-design.md`

## Global Constraints

- **ESM:** every relative import needs a `.js` suffix (`./done.js`), even from `.ts`.
- **`noUncheckedIndexedAccess` is on:** array/index access needs a guard or `!`.
- **No `vscode` import** in any module under test. `extension.ts` is the only file here that may import it.
- **TDD:** write the failing test, run it, watch it fail, then implement. Never write implementation first.
- **Run a single test file:** `npx vitest run src/path/to.test.ts`
- **Full suite:** `npm test`. **Types:** `npm run typecheck`.
- **Conventional commits.** Commit messages containing backticks or `$` MUST be passed via `git commit -F <file>` — zsh executes backticks inside a double-quoted `-m` string and will corrupt the message.
- **Immutability:** build new objects, never mutate in place.
- **Status values are provider status NAMES** (`"in review"`), never status ids. Verified against the ClickUp API; see the spec's "ClickUp API — verified" section.
- **Copy is fixed** — use these strings verbatim in the webview:
  - Toggle label: `Set the ticket status when karst ships`
  - Status label: `Status after ship`
  - Button: `Refresh`
  - Hint (missing prereq): `Add a List ID and API token to load statuses.`
  - Hint (loading): `Loading statuses…`
  - Hint (empty list): `This list has no statuses.`
  - Toast (push failed): `Ticket shipped, but the status update failed: <message>`

---

### Task 1: Manifest config fields

Adds `advanceOnShip` + `shipStatus` to `ticketing`, with the two coherence guards. Per CLAUDE.md's Manifest-field checklist: `types.ts` + `validateManifest` + a `writeManifest` round-trip test (`write.ts:112` spreads `ticketing` wholesale, so no `write.ts` edit is needed — the test proves it).

**Files:**
- Modify: `src/manifest/types.ts:118-122`
- Modify: `src/manifest/schema.ts:244-258`
- Test: `src/manifest/load.test.ts` (the existing `describe('ticketing')` block, ~line 575)
- Test: `src/manifest/writeManifest.test.ts:85` (the "round-trips every modeled section" test)

**Interfaces:**
- Consumes: nothing.
- Produces: `TicketingConfig.advanceOnShip?: boolean` (always set by validate; default `false`), `TicketingConfig.shipStatus?: string` (a provider status name; blank normalized to `undefined`).

- [ ] **Step 1: Write the failing tests**

In `src/manifest/load.test.ts`, add to the existing `describe('ticketing', ...)` block:

```ts
  it('defaults advanceOnShip to false', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing?.advanceOnShip).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('parses advanceOnShip and shipStatus', () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: clickup\n  listId: "42"\n` +
      `  advanceOnShip: true\n  shipStatus: "in review"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        listId: '42',
        advanceOnShip: true,
        shipStatus: 'in review',
      });
    } finally {
      cleanup();
    }
  });

  it('rejects advanceOnShip without a shipStatus', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/shipStatus is required/);
    } finally {
      cleanup();
    }
  });

  it('rejects a blank shipStatus with advanceOnShip', () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: true\n  shipStatus: "   "\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/shipStatus is required/);
    } finally {
      cleanup();
    }
  });

  it("rejects advanceOnShip on the 'manual' provider", () => {
    const yaml =
      `${VALID}\nticketing:\n  provider: manual\n  advanceOnShip: true\n  shipStatus: "done"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/requires a provider that can set status/);
    } finally {
      cleanup();
    }
  });

  it('rejects a non-boolean advanceOnShip', () => {
    const yaml = `${VALID}\nticketing:\n  provider: clickup\n  advanceOnShip: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/advanceOnShip must be a boolean/);
    } finally {
      cleanup();
    }
  });
```

Three EXISTING tests in that block assert exact-equality on the whole config object and will now fail, because validate always sets `advanceOnShip: false`. Update them:

- `"defaults to { provider: 'manual' } when omitted"` → expected becomes `{ provider: 'manual', advanceOnShip: false }`
- `'parses a clickup provider with teamId and listId'` → expected gains `advanceOnShip: false`
- `'leaves teamId and listId absent when omitted'` → expected gains `advanceOnShip: false`

In `src/manifest/writeManifest.test.ts`, in the `full` object of the "round-trips every modeled section" test (line ~122), replace the `ticketing` line with:

```ts
        ticketing: {
          provider: 'clickup',
          teamId: '9001',
          listId: '42',
          advanceOnShip: true,
          shipStatus: 'in review',
        },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/writeManifest.test.ts`
Expected: FAIL — the new parse tests get `undefined` for `advanceOnShip`; the throw tests fail because nothing throws.

- [ ] **Step 3: Add the type fields**

In `src/manifest/types.ts`, replace the `TicketingConfig` interface:

```ts
export interface TicketingConfig {
  provider: TicketProvider;
  teamId?: string;
  listId?: string;
  /**
   * Push `shipStatus` to the provider after a successful ship. Always set by
   * `validateManifest` (default `false`).
   */
  advanceOnShip?: boolean;
  /**
   * Provider status NAME to set after ship (ClickUp's PUT takes a name, not an
   * id). Required when `advanceOnShip` is true; blank normalizes to undefined.
   */
  shipStatus?: string;
}
```

- [ ] **Step 4: Implement the validation**

In `src/manifest/schema.ts`, replace `validateTicketing` (and update its doc comment):

```ts
/**
 * Parse the top-level `ticketing` block (default `{ provider: 'manual' }`):
 * `provider` must be 'clickup' or 'manual'; `teamId`/`listId`/`shipStatus` are
 * parsed only when present. `advanceOnShip` always lands (default `false`).
 *
 * Two coherence guards, so a config that cannot do anything never reaches disk:
 * an advance with no status to set is a typo, and an advance on `manual` is
 * silently inert (the manual provider only records locally).
 */
function validateTicketing(raw: unknown): TicketingConfig {
  if (raw === undefined) return { provider: 'manual', advanceOnShip: false };
  if (!isObject(raw)) throw new ManifestError('ticketing must be a mapping');
  if (raw.provider !== 'clickup' && raw.provider !== 'manual') {
    throw new ManifestError("ticketing.provider must be 'clickup' or 'manual'");
  }
  const config: TicketingConfig = { provider: raw.provider, advanceOnShip: false };
  if (raw.teamId !== undefined) {
    config.teamId = requireString(raw.teamId, 'ticketing.teamId');
  }
  if (raw.listId !== undefined) {
    config.listId = requireString(raw.listId, 'ticketing.listId');
  }
  if (raw.shipStatus !== undefined) {
    const status = requireString(raw.shipStatus, 'ticketing.shipStatus').trim();
    if (status) config.shipStatus = status;
  }
  if (raw.advanceOnShip !== undefined) {
    if (typeof raw.advanceOnShip !== 'boolean') {
      throw new ManifestError('ticketing.advanceOnShip must be a boolean');
    }
    config.advanceOnShip = raw.advanceOnShip;
  }
  if (config.advanceOnShip) {
    if (!config.shipStatus) {
      throw new ManifestError(
        'ticketing.shipStatus is required when ticketing.advanceOnShip is true',
      );
    }
    if (config.provider === 'manual') {
      throw new ManifestError(
        "ticketing.advanceOnShip requires a provider that can set status (not 'manual')",
      );
    }
  }
  return config;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/writeManifest.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/manifest/types.ts src/manifest/schema.ts src/manifest/load.test.ts src/manifest/writeManifest.test.ts
git commit -m "feat(manifest): add ticketing.advanceOnShip and ticketing.shipStatus"
```

---

### Task 2: ClickUp listStatuses + real updateStatus

Implements the two ClickUp calls. `PUT /task/{id}` takes `{status: "<name>"}`; `GET /list/{listId}` returns `statuses[]` whose `status` field is the name. Both verified — see the spec.

**Files:**
- Modify: `src/integrations/clickup.ts` (`ClickupDeps` at 25-30; `updateStatus` stub at 112-115)
- Test: `src/integrations/clickup.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ClickupDeps.listId?: string`; `clickupProvider(...).listStatuses(): Promise<string[]>`; a working `updateStatus(ref: string, status: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/clickup.test.ts`. Note `fakeFetch` (already at the top of that file) records `calls`; it ignores `method`/`body`, so extend the recorder first — replace the existing `fakeFetch` helper with this version, which also records them:

```ts
/** A minimal fetch double: routes by URL substring to a canned Response. */
function fakeFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    method?: string;
    body?: string;
  }[] = [];
  const fn = (async (
    url: string | URL,
    init?: { headers?: Record<string, string>; method?: string; body?: string },
  ) => {
    const u = String(url);
    calls.push({
      url: u,
      headers: init?.headers ?? {},
      method: init?.method,
      body: init?.body,
    });
    const match = Object.entries(routes).find(([frag]) => u.includes(frag));
    if (!match) return new Response('not found', { status: 404 });
    const [, r] = match;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
```

Then add the new tests:

```ts
const LIST = {
  id: '42',
  name: 'Sprint',
  statuses: [
    { id: 's1', status: 'to do', orderindex: 0, color: '#aaa', type: 'open' },
    { id: 's2', status: 'in review', orderindex: 1, color: '#bbb', type: 'custom' },
    { id: 's3', status: 'done', orderindex: 2, color: '#ccc', type: 'done' },
  ],
};

describe('clickupProvider.listStatuses', () => {
  it('maps the list statuses to names in provider order', async () => {
    const { fn } = fakeFetch({ '/list/42': { json: LIST } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual(['to do', 'in review', 'done']);
  });

  it('returns [] when the list has no statuses of its own (inherited from its Space)', async () => {
    const { fn } = fakeFetch({ '/list/42': { json: { id: '42', name: 'Sprint' } } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual([]);
  });

  it('drops entries whose status is not a string', async () => {
    const { fn } = fakeFetch({
      '/list/42': { json: { statuses: [{ status: 'open' }, { status: 42 }, {}] } },
    });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    expect(await provider.listStatuses!()).toEqual(['open']);
  });

  it('throws a ClickupError when no listId is configured', async () => {
    const { fn } = fakeFetch({});
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.listStatuses!()).rejects.toThrow(ClickupError);
  });

  it('throws a ClickupError on a non-ok response', async () => {
    const { fn } = fakeFetch({ '/list/42': { status: 401, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', listId: '42' });

    await expect(provider.listStatuses!()).rejects.toThrow(/401/);
  });
});

describe('clickupProvider.updateStatus', () => {
  it('PUTs the status name to the task', async () => {
    const { fn, calls } = fakeFetch({ '/task/abc123': { json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await provider.updateStatus('abc123', 'in review');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/task/abc123');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'in review' });
    expect(calls[0]!.headers.Authorization).toBe('tok');
  });

  it('carries the custom-task-id suffix when a teamId is configured', async () => {
    const { fn, calls } = fakeFetch({ '/task/abc123': { json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok', teamId: '9001' });

    await provider.updateStatus('abc123', 'done');

    expect(calls[0]!.url).toContain('custom_task_ids=true&team_id=9001');
  });

  it('throws a ClickupError when the provider rejects the status', async () => {
    const { fn } = fakeFetch({ '/task/abc123': { status: 400, json: {} } });
    const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

    await expect(provider.updateStatus('abc123', 'nope')).rejects.toThrow(ClickupError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/clickup.test.ts`
Expected: FAIL — `provider.listStatuses` is `undefined` (`listStatuses!()` throws "is not a function"), and the `updateStatus` tests fail because the stub makes no request (`calls` is empty).

- [ ] **Step 3: Add `listId` to the deps and a `RawList` shape**

In `src/integrations/clickup.ts`, replace `ClickupDeps`:

```ts
export interface ClickupDeps {
  fetchFn: FetchLike;
  token: TokenProvider;
  /** Optional team/workspace id, appended when custom task ids are in play. */
  teamId?: string;
  /** List whose statuses `listStatuses` reads. Absent → `listStatuses` throws. */
  listId?: string;
}
```

Add next to the other `Raw*` interfaces (after `RawComments`):

```ts
/**
 * `GET /list/{id}`. `statuses` is optional: a List can inherit its statuses from
 * its Space (`override_statuses: false`), so an absent array is a real response,
 * not a malformed one. Only the status NAME is read — ClickUp's PUT sets status
 * by name, and the status `id` is optional in the payload.
 */
interface RawList {
  statuses?: { status?: string }[];
}
```

- [ ] **Step 4: Add `putJson` beside `getJson`**

Inside `clickupProvider`, directly after the `getJson` function:

```ts
  async function putJson(url: string, body: unknown): Promise<void> {
    const token = await deps.token();
    let res: Response;
    try {
      res = await deps.fetchFn(url, {
        method: 'PUT',
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ClickupError(`request failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new ClickupError(`PUT ${url} returned ${res.status}`);
    }
  }
```

- [ ] **Step 5: Implement `updateStatus` and `listStatuses`**

In the returned object, replace the `updateStatus` stub (the one commented "ClickUp status updates are post-MVP"):

```ts
    /**
     * Set a task's status. ClickUp takes the status NAME (`{status: "in review"}`),
     * not an id. `ref` is the provider's own task ref (`sourceRef`), never karst's
     * ticket key — see `advanceTicketOnShip`.
     */
    async updateStatus(ref: string, status: string): Promise<void> {
      await putJson(`${API_BASE}/task/${encodeURIComponent(ref)}${teamSuffix}`, { status });
    },

    async listStatuses(): Promise<string[]> {
      if (!deps.listId) {
        throw new ClickupError('a List ID is required to load statuses');
      }
      const list = (await getJson(
        `${API_BASE}/list/${encodeURIComponent(deps.listId)}`,
      )) as RawList;
      return (list.statuses ?? [])
        .map((s) => s.status)
        .filter((s): s is string => typeof s === 'string');
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/integrations/clickup.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/clickup.ts src/integrations/clickup.test.ts
git commit -m "feat(clickup): implement updateStatus and listStatuses"
```

---

### Task 3: Thread listId through the ticketing seam

`makeTicketingProvider` currently drops `listId` on the floor, so Task 2's `listStatuses` is unreachable from production. This connects it.

**Files:**
- Modify: `src/integrations/ticketing.ts` (interface at 35-43; `makeTicketingProvider` doc + body at 60-75)
- Test: `src/integrations/ticketing.test.ts`

**Interfaces:**
- Consumes: `ClickupDeps.listId` (Task 2).
- Produces: `TicketingProvider.listStatuses?(): Promise<string[]>`; `makeTicketingProvider` passes `config.listId` through.

- [ ] **Step 1: Write the failing tests**

Append to `src/integrations/ticketing.test.ts`:

```ts
describe('makeTicketingProvider — listStatuses', () => {
  it('threads listId through to the clickup provider', async () => {
    const urls: string[] = [];
    const spyFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ statuses: [{ status: 'in review' }] }));
    }) as unknown as typeof fetch;

    const provider = makeTicketingProvider(
      { provider: 'clickup', listId: '42' },
      spyFetch,
      token,
    );

    expect(await provider.listStatuses!()).toEqual(['in review']);
    expect(urls[0]).toContain('/list/42');
  });

  it('gives the manual provider no listStatuses', () => {
    const provider = makeTicketingProvider({ provider: 'manual' }, noopFetch, token);
    expect(provider.listStatuses).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/integrations/ticketing.test.ts`
Expected: FAIL — the first test throws a `ClickupError` ("a List ID is required to load statuses") because `makeTicketingProvider` never passes `listId`.

- [ ] **Step 3: Add `listStatuses` to the provider interface**

In `src/integrations/ticketing.ts`, add to `TicketingProvider` (after `fetchTicket`):

```ts
  /**
   * The status NAMES a ticket can be moved to, in provider order. Optional:
   * `manualProvider` has no remote to list from. Names (not `{id, name}` pairs)
   * because `updateStatus` takes a name and ClickUp marks the status id optional.
   */
  listStatuses?(): Promise<string[]>;
```

- [ ] **Step 4: Thread `listId` and fix the stale comment**

Replace the `makeTicketingProvider` doc comment and body. The old comment claims `listId` is "intentionally not threaded" — that is now false:

```ts
/**
 * Select a ticketing provider from manifest config. `manual` (or absent config)
 * yields `manualProvider` (local-only, no fetch/list); `clickup` yields a
 * `clickupProvider` bound to the injected `fetch` + token, with `teamId` and
 * `listId` wired through — `listId` is what `listStatuses` reads (§15). The
 * `clickup` import is type-erased at the seam, so no runtime cycle forms.
 */
export function makeTicketingProvider(
  config: TicketingConfig | undefined,
  fetchFn: FetchLike,
  token: TokenProvider,
): TicketingProvider {
  if (config?.provider !== 'clickup') return manualProvider();
  return clickupProvider({
    fetchFn,
    token,
    teamId: config.teamId,
    listId: config.listId,
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/integrations/ticketing.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/ticketing.ts src/integrations/ticketing.test.ts
git commit -m "feat(ticketing): thread listId to the provider and add listStatuses"
```

---

### Task 4: `providerRef` + `advanceTicketOnShip`

The heart of the feature. `updateTicketStatus` is replaced by `advanceTicketOnShip`, which owns the whole decision (enabled? status set? ref addressable?) so `extension.ts` holds one call.

**Why `sourceRef`, not `key`:** `key` is seeded from the fetched ref but is user-editable free text afterwards (`updateTicketCore`, `store/tickets.ts:180-193`, wired at `extension.ts:1342`), and a manual ticket has a hand-typed `key` with no ref at all. Sending it would `PUT /task/<free text>` at a task nobody fetched. `sourceRef` is the provider's own ref (`ui/onboarding/actions.ts:120,139`) and is what `providerTicketUrl` already uses (`ticketUrl.ts:11-20`).

**Files:**
- Modify: `src/workflow/stages/done.ts` (whole file)
- Create: `src/workflow/stages/done.test.ts`
- Modify: `src/workflow/stages/ship.test.ts:285-292` (the `describe('updateTicketStatus')` block)
- Modify: `src/workflow/lifecycle.integration.test.ts:14,17,117-120`

**Interfaces:**
- Consumes: `TicketingConfig.advanceOnShip`/`shipStatus` (Task 1); `TicketingProvider.updateStatus` (Task 3).
- Produces:
  - `providerRef(ticket: Ticket): string | null`
  - `type AdvanceResult = { advanced: true; status: string } | { advanced: false; reason: 'disabled' | 'no-ref' }`
  - `advanceTicketOnShip(store: Store, ticketId: number, ticketing: TicketingConfig | undefined, provider: TicketingProvider): Promise<AdvanceResult>`
  - `updateTicketStatus` is **removed**.

- [ ] **Step 1: Write the failing test**

Create `src/workflow/stages/done.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow, updateTicketOnboarding, getTicket } from '../../store/tickets.js';
import { providerRef, advanceTicketOnShip } from './done.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';

/** A provider double that records what it was asked to set. */
function recorder(): TicketingProvider & { updates: { ref: string; status: string }[] } {
  const updates: { ref: string; status: string }[] = [];
  return {
    updates,
    async updateStatus(ref, status) {
      updates.push({ ref, status });
    },
  };
}

const ON: TicketingConfig = {
  provider: 'clickup',
  advanceOnShip: true,
  shipStatus: 'in review',
};

/** A ticket carrying a provider ref — the only kind that is addressable. */
function fetchedTicket(store: Store, ref = 'abc123'): number {
  const id = createTicketFlow(store, { key: 'PROJ-1', title: 't', source: 'clickup' }).id;
  updateTicketOnboarding(store, id, { sourceRef: ref });
  return id;
}

describe('providerRef', () => {
  it('returns the sourceRef the provider gave us', () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    expect(providerRef(getTicket(store, id))).toBe('abc123');
  });

  it('returns null for a manual ticket with a hand-typed key and no ref', () => {
    const store = openStore(':memory:');
    // The hazard case: `key` looks like a task id but was never fetched from any
    // provider. Addressing it would move an unrelated ClickUp task.
    const id = createTicketFlow(store, { key: 'abc123', title: 't' }).id;
    expect(providerRef(getTicket(store, id))).toBeNull();
  });

  it('treats a blank sourceRef as no ref', () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store, '   ');
    expect(providerRef(getTicket(store, id))).toBeNull();
  });
});

describe('advanceTicketOnShip', () => {
  it('pushes the configured status using the sourceRef', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, ON, provider);

    expect(res).toEqual({ advanced: true, status: 'in review' });
    expect(provider.updates).toEqual([{ ref: 'abc123', status: 'in review' }]);
  });

  it('does nothing when advanceOnShip is false', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(
      store, id, { provider: 'clickup', advanceOnShip: false, shipStatus: 'in review' }, provider,
    );

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('does nothing when there is no ticketing config at all', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, undefined, provider);

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('does nothing when shipStatus is blank', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider = recorder();

    const res = await advanceTicketOnShip(
      store, id, { provider: 'clickup', advanceOnShip: true, shipStatus: '  ' }, provider,
    );

    expect(res).toEqual({ advanced: false, reason: 'disabled' });
    expect(provider.updates).toEqual([]);
  });

  it('refuses to push when the ticket has no provider ref', async () => {
    const store = openStore(':memory:');
    const id = createTicketFlow(store, { key: 'abc123', title: 't' }).id;
    const provider = recorder();

    const res = await advanceTicketOnShip(store, id, ON, provider);

    expect(res).toEqual({ advanced: false, reason: 'no-ref' });
    expect(provider.updates).toEqual([]);
  });

  it('lets a provider error propagate to the caller', async () => {
    const store = openStore(':memory:');
    const id = fetchedTicket(store);
    const provider: TicketingProvider = {
      async updateStatus() {
        throw new Error('ClickUp: PUT returned 401');
      },
    };

    await expect(advanceTicketOnShip(store, id, ON, provider)).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/workflow/stages/done.test.ts`
Expected: FAIL — `providerRef` and `advanceTicketOnShip` are not exported from `./done.js`.

- [ ] **Step 3: Rewrite `done.ts`**

Replace the entire contents of `src/workflow/stages/done.ts`:

```ts
import type { Store } from '../../store/db.js';
import { getTicket, type Ticket } from '../../store/tickets.js';
import type { TicketingConfig } from '../../manifest/types.js';
import type { TicketingProvider } from '../../integrations/ticketing.js';

/**
 * Done stage (§T4.5, §11, §15). Pushes the ticket's post-ship status through the
 * ticketing provider (swappable seam).
 *
 * [L4] Independent of ship: PRs and ticket-status have separate failure modes, so
 * this never depends on ship having succeeded — only on the ticket id. Ship has
 * already transitioned to done by the time this runs (`ship.ts:120`), so a failure
 * here cannot drag a shipped ticket back to red.
 */

/**
 * The provider-side handle for a ticket: the ref the provider itself returned at
 * fetch, never the user-editable `key`. `null` → nothing addressable.
 *
 * `key` is NOT usable here. It is seeded from the fetched ref at create
 * (`ui/onboarding/actions.ts:129`) but `updateTicketCore` lets the user edit it to
 * arbitrary text, and a manual ticket has a hand-typed `key` and no ref at all.
 * Sending it would address a task nobody ever fetched.
 */
export function providerRef(ticket: Ticket): string | null {
  const ref = (ticket.sourceRef ?? '').trim();
  return ref === '' ? null : ref;
}

/** Why the push did nothing, so the caller can log rather than guess. */
export type AdvanceResult =
  | { advanced: true; status: string }
  | { advanced: false; reason: 'disabled' | 'no-ref' };

/**
 * Push the configured post-ship status, when configured and addressable. Owns the
 * whole decision so the (untestable) `vscode` binding holds one call and every
 * branch that could reach a live provider is covered by tests.
 *
 * Throws whatever the provider throws — the caller warns; it never fails the ship.
 */
export async function advanceTicketOnShip(
  store: Store,
  ticketId: number,
  ticketing: TicketingConfig | undefined,
  provider: TicketingProvider,
): Promise<AdvanceResult> {
  const status = ticketing?.advanceOnShip ? (ticketing.shipStatus ?? '').trim() : '';
  if (!status) return { advanced: false, reason: 'disabled' };

  const ref = providerRef(getTicket(store, ticketId));
  if (!ref) return { advanced: false, reason: 'no-ref' };

  await provider.updateStatus(ref, status);
  return { advanced: true, status };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/workflow/stages/done.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Migrate the two existing callers**

`updateTicketStatus` no longer exists, so both call sites break.

In `src/workflow/stages/ship.test.ts`, DELETE the whole trailing block (line ~285):

```ts
describe('updateTicketStatus', () => {
  it('updates via the injected provider (manual)', async () => {
    // …
  });
});
```

It was testing a `done.ts` concern from the wrong file, and `done.test.ts` now covers it. Then remove the two imports it used, which are now unused in that file: `updateTicketStatus` (from `./done.js`) and `manualProvider` (from `../../integrations/ticketing.js`).

In `src/workflow/lifecycle.integration.test.ts`, replace lines 117-120:

```ts
    // update the external ticket status via the provider seam
    const provider = manualProvider();
    await updateTicketStatus(store, id, 'done', provider);
    expect(provider.updates).toEqual([{ key: 'PROJ-142', status: 'done' }]);
```

with:

```ts
    // update the external ticket status via the provider seam — addressed by the
    // provider's own ref, which a fetched ticket carries.
    updateTicketOnboarding(store, id, { sourceRef: 'CU-abc123' });
    const updates: { ref: string; status: string }[] = [];
    const provider: TicketingProvider = {
      async updateStatus(ref, status) {
        updates.push({ ref, status });
      },
    };
    const advanced = await advanceTicketOnShip(
      store,
      id,
      { provider: 'clickup', advanceOnShip: true, shipStatus: 'done' },
      provider,
    );
    expect(advanced).toEqual({ advanced: true, status: 'done' });
    expect(updates).toEqual([{ ref: 'CU-abc123', status: 'done' }]);
```

Fix that file's imports:
- line 14: `import { updateTicketStatus } from './stages/done.js';` → `import { advanceTicketOnShip } from './stages/done.js';`
- line 17: `import { manualProvider } from '../integrations/ticketing.js';` → `import type { TicketingProvider } from '../integrations/ticketing.js';` (delete the line instead if `manualProvider` is used elsewhere in the file — check first with `grep -n manualProvider src/workflow/lifecycle.integration.test.ts`)
- add `updateTicketOnboarding` to the existing `../store/tickets.js` import.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. No references to `updateTicketStatus` remain — confirm with `grep -rn updateTicketStatus src/` (expect no output).

- [ ] **Step 7: Commit**

```bash
git add src/workflow/stages/done.ts src/workflow/stages/done.test.ts src/workflow/stages/ship.test.ts src/workflow/lifecycle.integration.test.ts
git commit -F - <<'EOF'
feat(done): advanceTicketOnShip, addressed by sourceRef

Replaces updateTicketStatus, which derived its identifier from `key`. `key` is
user-editable free text and a manual ticket has one with no provider ref, so a
push would have addressed a task nobody fetched. `providerRef` uses `sourceRef`,
following the providerTicketUrl precedent, and returns null rather than guessing.

advanceTicketOnShip owns the whole decision (enabled, status set, ref
addressable) so the vscode binding holds one call and every branch that can
reach a live provider is unit-tested.
EOF
```

---

### Task 5: Settings messages for the status fetch

The webview↔host protocol. A dedicated error type keeps a failed status fetch on the hint line beside the control instead of the panel-level error banner.

**Files:**
- Modify: `src/ui/settings/messages.ts` (both unions; `SettingsActions`; `parseSettingsMessage`; `routeSettingsAction`)
- Test: `src/ui/settings/messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - webview→host: `{ type: 'fetch-ticket-statuses'; listId: string; teamId?: string }`
  - host→webview: `{ type: 'ticket-statuses'; statuses: string[] }`, `{ type: 'ticket-statuses-error'; message: string }`
  - `SettingsActions.fetchTicketStatuses(listId: string, teamId?: string): void`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/settings/messages.test.ts` (follow the file's existing import/harness style):

```ts
describe('fetch-ticket-statuses', () => {
  it('parses a message with a listId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42' })).toEqual({
      type: 'fetch-ticket-statuses',
      listId: '42',
    });
  });

  it('carries an optional teamId', () => {
    expect(
      parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' }),
    ).toEqual({ type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' });
  });

  it('drops a message with a missing or blank listId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses' })).toBeNull();
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '' })).toBeNull();
  });

  it('drops a message with a non-string teamId', () => {
    expect(
      parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42', teamId: 9001 }),
    ).toBeNull();
  });

  it('routes to fetchTicketStatuses', () => {
    const calls: { listId: string; teamId?: string }[] = [];
    const actions = {
      fetchTicketStatuses: (listId: string, teamId?: string) => calls.push({ listId, teamId }),
    } as unknown as SettingsActions;

    routeSettingsAction(
      { type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' },
      actions,
    );

    expect(calls).toEqual([{ listId: '42', teamId: '9001' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: FAIL — `parseSettingsMessage` returns `null` for the valid messages (unknown `type` hits `default`).

- [ ] **Step 3: Extend the unions and the actions interface**

In `src/ui/settings/messages.ts`, add to `SettingsWebviewMessage` (after `get-approach-command-body`):

```ts
  | { type: 'fetch-ticket-statuses'; listId: string; teamId?: string };
```

Add to `SettingsHostMessage`:

```ts
  | { type: 'ticket-statuses'; statuses: string[] }
  | { type: 'ticket-statuses-error'; message: string };
```

Add to `SettingsActions`:

```ts
  /**
   * Load the provider's status names for the settings draft's list. Takes the
   * ids from the DRAFT (not the saved manifest) so Refresh works before Save.
   */
  fetchTicketStatuses(listId: string, teamId?: string): void;
```

- [ ] **Step 4: Parse and route it**

In `parseSettingsMessage`, add a case before `default`:

```ts
    case 'fetch-ticket-statuses': {
      if (!str('listId')) return null;
      if (raw.teamId !== undefined && typeof raw.teamId !== 'string') return null;
      return {
        type: 'fetch-ticket-statuses',
        listId: raw.listId as string,
        ...(raw.teamId ? { teamId: raw.teamId as string } : {}),
      };
    }
```

In `routeSettingsAction`, add a case:

```ts
    case 'fetch-ticket-statuses':
      actions.fetchTicketStatuses(msg.listId, msg.teamId);
      return;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/messages.ts src/ui/settings/messages.test.ts
git commit -m "feat(settings): add fetch-ticket-statuses messages"
```

---

### Task 6: Settings action that fetches the statuses

`SettingsActionsDeps` has no `fetch` and no token accessor, so the fetch needs one injected seam. That seam is also what keeps this unit-testable and `vscode`-free.

**Files:**
- Modify: `src/ui/settings/actions.ts` (`SettingsActionsDeps` at 14-55; the returned actions object)
- Test: `src/ui/settings/actions.test.ts` (the `harness` helper at ~line 29)

**Interfaces:**
- Consumes: `SettingsActions.fetchTicketStatuses` (Task 5); `TicketingProvider.listStatuses` (Task 3).
- Produces: `SettingsActionsDeps.makeProvider(config: TicketingConfig): TicketingProvider`.

- [ ] **Step 1: Write the failing test**

In `src/ui/settings/actions.test.ts`, add to the `deps` object inside `harness` (alongside `setToken`, `hasToken`, …):

```ts
    makeProvider: () => ({ async updateStatus() {}, async listStatuses() { return []; } }),
```

Add these imports at the top of the file:

```ts
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';
```

Then append the tests:

```ts
describe('fetchTicketStatuses', () => {
  it('posts the provider status names', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listStatuses() {
          return ['to do', 'in review'];
        },
      }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses',
      statuses: ['to do', 'in review'],
    });
  });

  it('builds the provider from the draft ids, so Refresh works before Save', async () => {
    const seen: TicketingConfig[] = [];
    const { actions } = harness({
      makeProvider: (config: TicketingConfig): TicketingProvider => {
        seen.push(config);
        return { async updateStatus() {}, async listStatuses() { return []; } };
      },
    });

    await actions.fetchTicketStatuses('99', '9001');

    expect(seen).toEqual([{ provider: 'clickup', listId: '99', teamId: '9001' }]);
  });

  it('posts a status-scoped error, not a panel-level one, when the fetch fails', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({
        async updateStatus() {},
        async listStatuses(): Promise<string[]> {
          throw new Error('ClickUp: GET /list/42 returned 401');
        },
      }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses-error',
      message: 'ClickUp: GET /list/42 returned 401',
    });
    expect(posted.some((m) => m.type === 'error')).toBe(false);
  });

  it('reports a provider that cannot list statuses', async () => {
    const { actions, posted } = harness({
      makeProvider: () => ({ async updateStatus() {} }),
    });

    await actions.fetchTicketStatuses('42');

    expect(posted).toContainEqual({
      type: 'ticket-statuses-error',
      message: 'This provider cannot list statuses.',
    });
  });
});
```

Note: `harness` returns `{ actions, posted, order }` (`actions.test.ts:53`), so the destructuring above matches as written.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: FAIL — `actions.fetchTicketStatuses is not a function`, plus a type error on the unknown `makeProvider` dep.

- [ ] **Step 3: Add the dep**

In `src/ui/settings/actions.ts`, add these imports:

```ts
import type { TicketingProvider } from '../../integrations/ticketing.js';
import type { TicketingConfig } from '../../manifest/types.js';
```

Add to `SettingsActionsDeps`:

```ts
  /**
   * Build a ticketing provider for an ad-hoc config (the settings DRAFT), so the
   * status list can be fetched before the config is saved. Injected to keep this
   * module free of `fetch` and of `vscode`.
   */
  makeProvider(config: TicketingConfig): TicketingProvider;
```

- [ ] **Step 4: Implement the action**

Add to the returned actions object in `buildSettingsActions` (after `clearToken`):

```ts
      async fetchTicketStatuses(listId: string, teamId?: string): Promise<void> {
        const provider = deps.makeProvider({
          provider: 'clickup',
          listId,
          ...(teamId ? { teamId } : {}),
        });
        if (!provider.listStatuses) {
          ctx.post({
            type: 'ticket-statuses-error',
            message: 'This provider cannot list statuses.',
          });
          return;
        }
        try {
          ctx.post({ type: 'ticket-statuses', statuses: await provider.listStatuses() });
        } catch (e) {
          // Status-scoped, not panel-level: this lands on the hint line beside the
          // control that caused it.
          ctx.post({ type: 'ticket-statuses-error', message: errorMessage(e) });
        }
      },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/actions.ts src/ui/settings/actions.test.ts
git commit -m "feat(settings): fetch provider statuses from the draft config"
```

---

### Task 7: Settings Ticketing UI

A second card in the Ticketing section, below the provider card, shown only for `clickup`. Manual has no statuses to list and advancing a local no-op record means nothing, so the card is absent rather than disabled.

**No unit test:** `webview.html` is a runtime asset, not a module — it cannot be imported under vitest. Verified manually in Step 4. Keep logic here thin; the testable half already lives in Tasks 5-6.

**Files:**
- Modify: `src/ui/settings/webview.html` (markup after `#clickupFields`, ~line 454; JS near `ticketingCfg`, ~line 1536)

**Interfaces:**
- Consumes: the Task 5 messages.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Add the markup**

In `src/ui/settings/webview.html`, immediately AFTER the closing `</div>` of the provider card's `.card` (the one containing `#clickupFields`, ~line 456) and BEFORE the closing `</div>` of `#section-ticketing`, insert:

```html
      <!-- After-ship advance. Hidden unless provider === clickup: manual has no
           statuses to list, and advancing a local no-op record means nothing. -->
      <div class="card open hidden" id="advanceCard">
        <div class="card-body" style="display:block;padding-top:14px">
          <div class="toggle">
            <input type="checkbox" id="f-advanceOnShip" />
            <label for="f-advanceOnShip">Set the ticket status when karst ships</label>
          </div>

          <div id="advanceStatusRow" class="hidden" style="margin-top:10px">
            <label for="f-shipStatus">Status after ship</label>
            <div class="row" style="align-items:center">
              <select id="f-shipStatus"></select>
              <button class="secondary fixed" id="refreshStatusesBtn">Refresh</button>
            </div>
            <div id="statusHint" class="installed-tag"></div>
          </div>
        </div>
      </div>
```

- [ ] **Step 2: Add the state + wiring**

In the `<script>` block, near the existing `ticketingCfg()` helper (~line 1539), add:

```js
  // Fetched status names for the draft's list. null = not loaded yet.
  let ticketStatuses = null;
  let statusHintText = '';

  function ticketingPrereqsMet() {
    const cfg = ticketingCfg();
    return Boolean(cfg.listId) && state.tokenConfigured;
  }

  function requestTicketStatuses() {
    const cfg = ticketingCfg();
    if (!ticketingPrereqsMet()) {
      ticketStatuses = null;
      statusHintText = 'Add a List ID and API token to load statuses.';
      renderAdvance();
      return;
    }
    ticketStatuses = null;
    statusHintText = 'Loading statuses…';
    renderAdvance();
    post({ type: 'fetch-ticket-statuses', listId: cfg.listId, teamId: cfg.teamId });
  }

  function renderAdvance() {
    const cfg = ticketingCfg();
    const isClickup = cfg.provider === 'clickup';
    el('advanceCard').classList.toggle('hidden', !isClickup);
    if (!isClickup) return;

    const on = el('f-advanceOnShip').checked;
    el('advanceStatusRow').classList.toggle('hidden', !on);

    const sel = el('f-shipStatus');
    const saved = cfg.shipStatus || '';
    const names = ticketStatuses || [];
    // A saved status that the provider no longer lists must stay visible and
    // selected — never silently drop it and save an empty status away.
    const stale = saved && names.length > 0 && !names.includes(saved);
    const options = stale ? [saved].concat(names) : names;

    sel.innerHTML = options
      .map((n) => `<option value="${esc(n)}"${n === saved ? ' selected' : ''}>${esc(n)}</option>`)
      .join('');

    const empty = ticketStatuses !== null && names.length === 0;
    sel.disabled = ticketStatuses === null || empty;

    let hint = statusHintText;
    if (empty) hint = 'This list has no statuses.';
    else if (stale) hint = `"${saved}" is no longer in this list.`;
    el('statusHint').textContent = hint;

    // The draft must never hold advanceOnShip:true with no shipStatus — the
    // schema rejects that pair and Save would trip the panel-level error banner.
    const value = sel.value || '';
    if (on && value) {
      cfg.advanceOnShip = true;
      cfg.shipStatus = value;
    } else {
      cfg.advanceOnShip = false;
      delete cfg.shipStatus;
    }
  }
```

Wire the controls — add alongside the other ticketing listeners (near the `f-ticketTeamId`/`f-ticketListId` handlers, ~line 1606):

```js
  el('f-advanceOnShip').addEventListener('change', () => {
    // Fetch on toggle-on, never on listId keystrokes — that would hammer the API
    // on the way to a valid id. Refresh covers a later edit.
    if (el('f-advanceOnShip').checked && ticketStatuses === null) requestTicketStatuses();
    else renderAdvance();
    markDirty();
  });

  el('f-shipStatus').addEventListener('change', () => {
    renderAdvance();
    markDirty();
  });

  el('refreshStatusesBtn').addEventListener('click', () => {
    requestTicketStatuses();
  });
```

Handle the host messages — add to the webview's `message` listener switch, beside the existing `state`/`validation` cases:

```js
      case 'ticket-statuses':
        ticketStatuses = msg.statuses;
        statusHintText = '';
        // Default to the first status so the common path is coherent immediately:
        // toggled on with nothing chosen would be an invalid draft.
        if (!ticketingCfg().shipStatus && msg.statuses.length > 0) {
          ticketingCfg().shipStatus = msg.statuses[0];
        }
        renderAdvance();
        break;
      case 'ticket-statuses-error':
        ticketStatuses = null;
        statusHintText = msg.message;
        renderAdvance();
        break;
```

Finally, at the end of the existing `renderTicketing()` function (`webview.html:1593`, which sets `f-ticketTeamId`/`f-ticketListId` and toggles `#clickupFields`), add:

```js
    el('f-advanceOnShip').checked = Boolean(cfg.advanceOnShip);
    renderAdvance();
```

Notes for the implementer — these all already exist in this file, reuse them and do NOT redefine:
- `el` (`webview.html:551`), `esc` (552), `post` (550), `markDirty` (633).
- `state.tokenConfigured` is the stored-token flag (`src/ui/settings/state.ts:40`).
- The host-message `switch (msg.type)` is at `webview.html:1652` — add the two new cases beside `case 'state'` (1653) and `case 'validation'` (1671).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds. `webview.html` is copied into `dist/` by `scripts/copy-assets.mjs` — never edit the `dist/` copy.

- [ ] **Step 4: Verify manually**

Press F5, open karst settings → Ticketing.
- Provider `manual` → no advance card.
- Provider `clickup`, no List ID → toggle on → hint reads `Add a List ID and API token to load statuses.`, select disabled.
- Add a real List ID + token → Refresh → the list populates and the first status is selected.
- Bad List ID → Refresh → the ClickUp error text shows on the hint line, NOT in the panel banner.
- Pick a status → Save → reopen the panel → the value persists and is selected.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html
git commit -m "feat(settings): after-ship status controls on the Ticketing page"
```

---

### Task 8: Wire the push into ship

The last mile. `makeDashboardActions` is module-level (`extension.ts:1283`), so `currentManifest`/`context` are NOT in scope there — the config and provider arrive as getter params, matching how `DashboardManager` already takes `() => currentManifest()?.ticketing` at line 589.

**Files:**
- Modify: `src/extension.ts` — imports (~73-94); `buildSettingsActions` deps (~508); `makeDashboardActions` signature (1283-1291) and its `shipTicket` handler (1348-1366); the call site (574-585)

**Interfaces:**
- Consumes: `advanceTicketOnShip` (Task 4); `makeTicketingProvider` (Task 3, already imported at line 92); `SettingsActionsDeps.makeProvider` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Add the imports**

In `src/extension.ts`, next to the existing `import { shipTicket as runShipTicket } from './workflow/stages/ship.js';` (line 73):

```ts
import { advanceTicketOnShip } from './workflow/stages/done.js';
```

Add `TicketingConfig` and `TicketingProvider` to the existing type imports (from `./manifest/types.js` and `./integrations/ticketing.js` respectively).

- [ ] **Step 2: Bind the settings `makeProvider` dep**

In the `buildSettingsActions({ … })` object (line ~508), add alongside `setToken`/`clearToken`:

```ts
      // Build a provider from the settings DRAFT config so the statuses list can
      // be fetched before Save. Same fetch + token wiring as onboarding's getter.
      makeProvider: (config: TicketingConfig) =>
        makeTicketingProvider(config, fetch, makeTokenProvider(context)),
```

- [ ] **Step 3: Add the two getters to `makeDashboardActions`**

Replace the signature at line 1283:

```ts
function makeDashboardActions(
  store: Store,
  ticketId: number,
  agentAdapter: AgentAdapter,
  editTicket: () => void,
  afterServerChange: () => void,
  logError: LogError,
  guardCapability: CapabilityGuard,
  // Read fresh at call time so a status saved in settings applies without a
  // window reload — same getter pattern as the onboarding provider.
  ticketing: () => TicketingConfig | undefined,
  ticketingProvider: () => TicketingProvider,
): DashboardActions {
```

- [ ] **Step 4: Push the status after ship**

Replace the `shipTicket` handler (line ~1348):

```ts
    shipTicket: () => {
      // Before the model call, not after: `runShipTicket` asks a model to write
      // the PR description first, so an unguarded click burns a call per repo and
      // then dies at `gh pr create`.
      if (!guardCapability('ship')) return;
      void runShipTicket(store, { ticketId }, undefined, agentAdapter)
        .then(async () => {
          // The PRs are open and the branch is pushed — the irreversible part
          // succeeded, and ship.ts already transitioned to done. So a failed
          // status push warns; it never drags a shipped ticket back to red.
          try {
            const res = await advanceTicketOnShip(
              store,
              ticketId,
              ticketing(),
              ticketingProvider(),
            );
            if (!res.advanced && res.reason === 'no-ref') {
              logError(
                `ticket #${ticketId} shipped without a status update: no provider ref`,
                undefined,
              );
            }
          } catch (e) {
            logError('ticket status update failed', e);
            void vscode.window.showWarningMessage(
              `Ticket shipped, but the status update failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          afterServerChange();
        })
        .catch((e) => {
          logError('ship failed', e);
          // `shipTicket` already recorded the reason on the ship stage, so the
          // dashboard now explains itself — but the user just clicked a button
          // and deserves an answer to THAT click, not a ticket that quietly goes
          // red. Refresh first so the fault card is there when the toast lands.
          afterServerChange();
          void vscode.window.showErrorMessage(
            `Ship failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    },
```

Check `LogError`'s signature before using `logError(msg, undefined)` — it is `(m, e) => logger.error(m, e)` at line 156. If its second parameter is required and non-optional, pass `new Error('no provider ref')` instead, or drop to a single-argument call if the type allows.

- [ ] **Step 5: Pass the getters at the call site**

At line ~574, add the two arguments after `guardCapability`:

```ts
      makeDashboardActions(
        localStore,
        ticketId,
        agentAdapter,
        () => onboarding.openEdit(ticketId),
        () => {
          provider.refresh();
          dashboard.pushState(ticketId);
        },
        logError,
        guardCapability,
        () => currentManifest()?.ticketing,
        () =>
          makeTicketingProvider(
            currentManifest()?.ticketing,
            fetch,
            makeTokenProvider(context),
          ),
      ),
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Verify manually**

Press F5. With `advanceOnShip` on and a `shipStatus` set:
1. Ship a ticket fetched from ClickUp (it has a `sourceRef`) → the task moves to that status; the PRs still open.
2. Ship a **manual** ticket whose `key` was hand-typed to look like a ClickUp id → nothing is pushed and no task moves. This is the hazard the `sourceRef` guard exists for; confirm no network call fires, not just that ship is green.
3. Clear the token, ship again → the PRs open, ship stays green, and a warning toast names the failure.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -F - <<'EOF'
feat(ship): advance the ticket in the provider after a successful ship

Pushes ticketing.shipStatus once the PRs are open, when advanceOnShip is set.
The config and provider arrive as getters so a settings change applies without a
window reload.

A failed push warns and leaves ship passed: the PRs are already open and ship.ts
has transitioned to done, so there is nothing to roll back and ship has no failed
edge to land on.
EOF
```

---

## Verification

- [ ] `npm test` — all green
- [ ] `npm run typecheck` — clean
- [ ] `grep -rn updateTicketStatus src/` — no output (fully replaced)
- [ ] `git log --oneline` shows 8 commits, one per task
