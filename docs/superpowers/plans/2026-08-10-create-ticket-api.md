# Create Ticket from the Extension — API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any local process that can reach the extension's localhost HTTP endpoint create a persisted karst ticket by POSTing `{title, description}` to a new `POST /tickets` route.

**Architecture:** The extension already runs one localhost HTTP server (`src/hooks/endpoint.ts`, the Codex-hook bridge listener, bound to 127.0.0.1). We add a sibling route `POST /tickets` served by a new vscode-free module `src/hooks/ticketApi.ts` that validates untrusted JSON and persists through the SAME `createTicketFlow` the ticket form uses — so form-created, fetch-created, and API-created tickets all land in one creation path with one key-derivation rule (`generateTicketKey`). The hook path itself is untouched: its body-reading state machine is intentionally duplicated rather than refactored, because the hook contract (fast 2xx, malformed bodies swallowed, recorder counts) is security-relevant and heavily pinned by tests.

**Tech Stack:** Node `node:http` server (already running), better-sqlite3 store, vitest (integration tests hit the real listener on an ephemeral port, like `endpoint.test.ts` already does).

## Global Constraints

- The create path is `createTicketFlow` (`src/workflow/stages/create.ts`) — the API must reuse it, never write a parallel insert.
- Blank `key` is derived ONCE via `generateTicketKey(store, { projectId }, title)` (`src/store/tickets.ts:255`), the same rule `persistDraft` uses.
- Tickets are project-scoped (§ projects / multi-window): the `projectId` comes from the hosting window via an injected getter (`() => currentProject()?.id`), read at call time like every host getter in `extension.ts`. An unbound window (no project) creates an unassigned row, exactly like the ticket form does.
- `src/hooks/endpoint.ts` is host-agnostic and vscode-free — the new module must stay vscode-free too (testable with fakes).
- The `/hooks` handler must remain byte-identical in behavior: fast empty 2xx, malformed bodies swallowed, `HookChannelRecorder` counts hooks ONLY. `/tickets` requests must never be recorded in the hook channel (they are not hooks).
- API responses are JSON with a closed shape: `{ ok: true, ticket: {id, key, title, description} }` or `{ ok: false, error: <message> }`. Error messages are bounded, one-line, and never include raw SQL errors.
- ESM imports need `.js` suffixes; `noUncheckedIndexedAccess` is on.
- TDD: write the failing test, run it, implement, run it green, commit. Conventional commits (`feat: ...`).

---

### Task 1: Parse the create-ticket request (validation)

**Files:**
- Create: `src/hooks/ticketApi.ts` (parse + types only)
- Test: `src/hooks/ticketApi.test.ts`

**Interfaces:**
- Consumes: nothing yet (pure function over `unknown`).
- Produces:
  ```ts
  export interface CreateTicketRequest {
    title: string;        // trimmed, non-empty
    description?: string; // trimmed; blank/absent → undefined
    key?: string;         // trimmed; blank/absent → undefined (derived later)
  }
  export type ParseCreateTicketResult =
    | { ok: true; request: CreateTicketRequest }
    | { ok: false; message: string };
  export function parseCreateTicketRequest(raw: unknown): ParseCreateTicketResult;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseCreateTicketRequest } from './ticketApi.js';

describe('parseCreateTicketRequest', () => {
  it('accepts a title and trims it', () => {
    const r = parseCreateTicketRequest({ title: '  Fix login  ' });
    expect(r).toEqual({ ok: true, request: { title: 'Fix login' } });
  });

  it('accepts an optional description and key, trimming both', () => {
    const r = parseCreateTicketRequest({
      title: 'Fix login',
      description: '  detail  ',
      key: '  LOGIN-1  ',
    });
    expect(r).toEqual({
      ok: true,
      request: { title: 'Fix login', description: 'detail', key: 'LOGIN-1' },
    });
  });

  it('drops a blank description and a blank key (caller derives the key)', () => {
    const r = parseCreateTicketRequest({
      title: 'Fix login',
      description: '   ',
      key: '',
    });
    expect(r).toEqual({ ok: true, request: { title: 'Fix login' } });
  });

  it('rejects a missing title', () => {
    expect(parseCreateTicketRequest({})).toEqual({
      ok: false,
      message: 'title is required',
    });
  });

  it('rejects a blank title', () => {
    expect(parseCreateTicketRequest({ title: '   ' })).toEqual({
      ok: false,
      message: 'title is required',
    });
  });

  it('rejects a non-string title, description or key', () => {
    expect(parseCreateTicketRequest({ title: 42 })).toEqual({
      ok: false,
      message: 'title must be a string',
    });
    expect(parseCreateTicketRequest({ title: 'x', description: 42 })).toEqual({
      ok: false,
      message: 'description must be a string',
    });
    expect(parseCreateTicketRequest({ title: 'x', key: [] })).toEqual({
      ok: false,
      message: 'key must be a string',
    });
  });

  it('rejects a body that is not a JSON object', () => {
    expect(parseCreateTicketRequest(null)).toEqual({
      ok: false,
      message: 'request body must be a JSON object',
    });
    expect(parseCreateTicketRequest([{ title: 'x' }])).toEqual({
      ok: false,
      message: 'request body must be a JSON object',
    });
  });

  it('ignores unknown fields (caller may send extras)', () => {
    const r = parseCreateTicketRequest({ title: 'Fix login', priority: 1 });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/ticketApi.test.ts -v`
Expected: FAIL — module `ticketApi` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/hooks/ticketApi.ts`:

```ts
/**
 * Create-ticket API (§ create ticket from the extension). The extension's
 * localhost hook endpoint also serves `POST /tickets`, so any local process
 * that can reach it (an agent CLI via its hook channel, a script, curl) can
 * mint a ticket in this window's project.
 *
 * The HTTP surface lives here, vscode-free, so the whole flow is unit-testable:
 * parse (untrusted JSON → validated request) and persist (key derivation +
 * the SAME `createTicketFlow` the ticket form uses — one creation path, one
 * key rule). `endpoint.ts` stays a thin router over this module.
 */

/** Fields a ticket-creation request may carry. Everything is validated. */
export interface CreateTicketRequest {
  title: string;
  description?: string;
  key?: string;
}

export type ParseCreateTicketResult =
  | { ok: true; request: CreateTicketRequest }
  | { ok: false; message: string };

/**
 * Narrow untrusted JSON to a CreateTicketRequest. The body is external input,
 * so every field is checked as an optional string before it reaches a SQL bind.
 * Unknown fields are ignored (the caller may send extras); blank description
 * and blank key are treated as absent — an absent key means "derive one from
 * the title" downstream.
 */
export function parseCreateTicketRequest(raw: unknown): ParseCreateTicketResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== 'string') {
    return { ok: false, message: 'title must be a string' };
  }
  const title = o.title.trim();
  if (!title) return { ok: false, message: 'title is required' };
  if (o.description !== undefined && typeof o.description !== 'string') {
    return { ok: false, message: 'description must be a string' };
  }
  if (o.key !== undefined && typeof o.key !== 'string') {
    return { ok: false, message: 'key must be a string' };
  }
  const description = o.description?.trim() || undefined;
  const key = o.key?.trim() || undefined;
  return {
    ok: true,
    request: {
      title,
      ...(description ? { description } : {}),
      ...(key ? { key } : {}),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/ticketApi.test.ts -v`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ticketApi.ts src/hooks/ticketApi.test.ts
git commit -m "feat(api): parse create-ticket requests (title + optional description/key)"
```

---

### Task 2: Persist through the shared create flow

**Files:**
- Modify: `src/hooks/ticketApi.ts` (add `createTicketFromApi`)
- Test: `src/hooks/ticketApi.test.ts`

**Interfaces:**
- Consumes: `parseCreateTicketRequest` (Task 1), `generateTicketKey(store, {projectId?}, title)` from `../store/tickets.js`, `createTicketFlow(store, {key, title, description?, projectId?})` from `../workflow/stages/create.js`.
- Produces:
  ```ts
  export function createTicketFromApi(
    store: Store,
    request: CreateTicketRequest,
    opts?: { projectId?: number },
  ): Ticket;
  ```

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/ticketApi.test.ts`:

```ts
import { openStore, type Store } from '../store/db.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  listTickets,
  archiveTicket,
} from '../store/tickets.js';
import { createTicketFromApi } from './ticketApi.js';

describe('createTicketFromApi', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('creates a persisted ticket with a title-derived key', () => {
    const t = createTicketFromApi(store, { title: 'Fix login redirect' });
    expect(t.key).toBe('FIX-LOGIN-REDIRECT');
    expect(t.title).toBe('Fix login redirect');
    expect(getTicketByKey(store, 'FIX-LOGIN-REDIRECT')).not.toBeNull();
    expect(listTickets(store).some((x) => x.id === t.id)).toBe(true);
  });

  it('persists the description', () => {
    const t = createTicketFromApi(store, {
      title: 'Fix login redirect',
      description: 'session cookie not set',
    });
    expect(getTicket(store, t.id).description).toBe('session cookie not set');
  });

  it('honors an explicit key without touching the title derivation', () => {
    const t = createTicketFromApi(store, { key: 'LOGIN-1', title: 'Fix login' });
    expect(t.key).toBe('LOGIN-1');
    expect(getTicketByKey(store, 'LOGIN-1')?.id).toBe(t.id);
  });

  it('derives a suffixed key on a collision', () => {
    createTicket(store, { key: 'FIX-LOGIN', title: 'existing' });
    const t = createTicketFromApi(store, { title: 'Fix login' });
    expect(t.key).toBe('FIX-LOGIN-2');
  });

  it('is idempotent by key: recreating the same key returns the same row', () => {
    const first = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    const second = createTicketFromApi(store, { key: 'LOGIN-1', title: 'b' });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('a'); // existing fields untouched
  });

  it('resurrects an archived ticket on key collision', () => {
    const t = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    archiveTicket(store, t.id);
    const again = createTicketFromApi(store, { key: 'LOGIN-1', title: 'a' });
    expect(again.archivedAt).toBeNull();
  });

  it('scopes the key uniqueness pass to the given project', () => {
    createTicket(store, { key: 'FIX-LOGIN', title: 'in A', projectId: 1 });
    const inB = createTicketFromApi(store, { title: 'Fix login' }, { projectId: 2 });
    expect(inB.key).toBe('FIX-LOGIN'); // project A's key does not collide here
    expect(inB.projectId).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/ticketApi.test.ts -v`
Expected: FAIL — `createTicketFromApi` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/hooks/ticketApi.ts`:

```ts
import type { Store } from '../store/db.js';
import { generateTicketKey, type Ticket } from '../store/tickets.js';
import { createTicketFlow } from '../workflow/stages/create.js';

/**
 * Create (or resurrect) the ticket through `createTicketFlow` — the same path
 * the ticket form's `persistDraft` uses, so an API-created ticket is
 * byte-identical in store shape to a form-created one. A blank key is derived
 * from the title exactly once, scoped to the project.
 */
export function createTicketFromApi(
  store: Store,
  request: CreateTicketRequest,
  opts: { projectId?: number } = {},
): Ticket {
  const key =
    request.key ??
    generateTicketKey(store, { projectId: opts.projectId }, request.title);
  return createTicketFlow(store, {
    key,
    title: request.title,
    description: request.description,
    projectId: opts.projectId,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/ticketApi.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ticketApi.ts src/hooks/ticketApi.test.ts
git commit -m "feat(api): persist create-ticket requests through createTicketFlow"
```

---

### Task 3: Serve `POST /tickets` on the extension's HTTP endpoint

**Files:**
- Modify: `src/hooks/ticketApi.ts` (add `serveCreateTicketRequest` + body reader + JSON helpers)
- Modify: `src/hooks/endpoint.ts` (route `/tickets` before the hook handler; add `TicketApiOptions` to `HookEndpointOptions`)
- Test: `src/hooks/endpoint.test.ts`

**Interfaces:**
- Consumes: `parseCreateTicketRequest`, `createTicketFromApi` (Tasks 1–2).
- Produces (in `ticketApi.ts`):
  ```ts
  export interface TicketApiOptions {
    /** The hosting window's project (§ projects); read at call time. */
    projectId?: () => number | undefined;
    /** Fired after a ticket is created so sidebar + dashboard refresh. */
    onTicketCreated?: (ticketId: number) => void;
  }
  export interface ServeCreateTicketDeps {
    store: Store;
    options?: TicketApiOptions;
    maxBodyBytes: number;
    requestTimeoutMs: number;
  }
  export function serveCreateTicketRequest(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ServeCreateTicketDeps,
  ): void;
  ```
- Produces (in `endpoint.ts`): `HookEndpointOptions` gains `ticketApi?: TicketApiOptions`.

- [ ] **Step 1: Write the failing tests**

Append a `describe('POST /tickets', ...)` block to `src/hooks/endpoint.test.ts`:

```ts
describe('POST /tickets', () => {
  let store: Store;
  let ep: HookEndpoint;
  let created: number[];

  beforeEach(async () => {
    store = openStore(':memory:');
    created = [];
    ep = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      ticketApi: {
        projectId: () => 7,
        onTicketCreated: (id) => created.push(id),
      },
    });
  });
  afterEach(async () => {
    await ep?.close();
    store.close();
  });

  const postJson = async (body: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${ep.url.replace(/\/hooks$/, '')}/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  it('creates a ticket with a title and description and returns it', async () => {
    const { status, json } = await postJson({
      title: 'Fix login',
      description: 'session cookie not set',
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      ok: true,
      ticket: { title: 'Fix login', description: 'session cookie not set' },
    });
    const key = (json as { ticket: { key: string } }).ticket.key;
    expect(key).toBe('FIX-LOGIN');
    expect(getTicketByKey(store, key)).not.toBeNull();
    expect(created).toEqual([expect.any(Number)]);
  });

  it('derives the key from the title when none is given', async () => {
    const { json } = await postJson({ title: 'Fix login' });
    expect((json as { ticket: { key: string } }).ticket.key).toBe('FIX-LOGIN');
  });

  it('honors an explicit key', async () => {
    const { json } = await postJson({ title: 'Fix login', key: 'LOGIN-1' });
    expect((json as { ticket: { key: string } }).ticket.key).toBe('LOGIN-1');
  });

  it('rejects a missing title with 400 and a JSON error', async () => {
    const { status, json } = await postJson({ description: 'no title' });
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'title is required' });
  });

  it('rejects a non-string title with 400', async () => {
    const { status, json } = await postJson({ title: 42 });
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'title must be a string' });
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await fetch(`${ep.url.replace(/\/hooks$/, '')}/tickets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'request body is not valid JSON',
    });
  });

  it('rejects a non-object JSON body with 400', async () => {
    const { status, json } = await postJson(null);
    expect(status).toBe(400);
    expect(json).toEqual({ ok: false, error: 'request body must be a JSON object' });
  });

  it('rejects a GET on /tickets with 404 (the endpoint serves POSTs only)', async () => {
    const res = await fetch(`${ep.url.replace(/\/hooks$/, '')}/tickets`);
    expect(res.status).toBe(404);
  });

  it('scopes the created ticket to the window project getter', async () => {
    const { json } = await postJson({ title: 'Fix login' });
    const id = (json as { ticket: { id: number } }).ticket.id;
    expect(getTicket(store, id).projectId).toBe(7);
  });

  it('counts nothing on the hook channel recorder for a /tickets request', async () => {
    // The recorder (passed to a separate endpoint instance below) must not see
    // ticket-API traffic — /tickets is not a hook.
    const recorder = createHookChannelRecorder();
    const ep2 = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
      recorder,
      ticketApi: { projectId: () => undefined },
    });
    try {
      await fetch(`${ep2.url.replace(/\/hooks$/, '')}/tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Fix login' }),
      });
      expect(recorder.snapshot().total).toBe(0);
    } finally {
      await ep2.close();
    }
  });
});
```

Note: `createHookChannelRecorder` exposes `snapshot(): { total, outcomes, events, firstAt, lastAt }` (`src/diagnostics/hookChannel.ts:109`) — the assertion above uses `total`, which is zero when nothing was recorded.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/endpoint.test.ts -v`
Expected: FAIL — `/tickets` returns 404 (route not served).

- [ ] **Step 3: Implement the route**

`src/hooks/ticketApi.ts` — append:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../store/db.js';

export interface TicketApiOptions {
  /** The hosting window's project (§ projects); read at call time. */
  projectId?: () => number | undefined;
  /** Fired after a ticket is created so the sidebar + dashboard refresh. */
  onTicketCreated?: (ticketId: number) => void;
}

export interface ServeCreateTicketDeps {
  store: Store;
  options?: TicketApiOptions;
  maxBodyBytes: number;
  requestTimeoutMs: number;
}

type BodyResult =
  | { kind: 'body'; body: string }
  | { kind: 'oversize' } // 413 written, request destroyed
  | { kind: 'timeout' } //  408 written, request destroyed
  | { kind: 'aborted' }; // nothing written — the peer went away

/**
 * Read the request body with the same bounds as the hook path (max bytes +
 * deadline), and the same response semantics: oversize → 413 with the request
 * destroyed, deadline → 408 with the request destroyed, abort → silence.
 * Deliberately NOT shared with the hook handler — that path's byte-identical
 * behavior is pinned by tests and must not be disturbed.
 */
function readCreateBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  timeoutMs: number,
  resolve: (result: BodyResult) => void,
): void {
  let body = '';
  let settled = false;

  function cleanup(): void {
    clearTimeout(deadline);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('aborted', onAborted);
    req.removeListener('error', onAborted);
  }
  function finish(result: BodyResult, destroy: boolean): void {
    if (settled) return;
    settled = true;
    cleanup();
    if (destroy) req.destroy();
    resolve(result);
  }
  const onAborted = (): void => finish({ kind: 'aborted' }, false);
  const onData = (chunk: Buffer | string): void => {
    if (settled) return;
    body += chunk.toString();
    if (body.length > maxBytes) {
      res.writeHead(413);
      res.end();
      finish({ kind: 'oversize' }, true);
    }
  };
  const onEnd = (): void => finish({ kind: 'body', body }, false);
  const deadline = setTimeout(() => {
    res.writeHead(408);
    res.end();
    finish({ kind: 'timeout' }, true);
  }, timeoutMs);

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('aborted', onAborted);
  req.on('error', onAborted);
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Serve one `POST /tickets` request. Validation failures are 400 with a
 * bounded one-line error; a successful create is 201 with the created
 * ticket's id/key/title/description. Internal errors are 500 with a generic
 * message — raw SQL/text never leaves the host.
 */
export function serveCreateTicketRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServeCreateTicketDeps,
): void {
  readCreateBody(req, res, deps.maxBodyBytes, deps.requestTimeoutMs, (result) => {
    if (result.kind !== 'body') return; // response already written / aborted

    let raw: unknown;
    try {
      raw = JSON.parse(result.body || '{}');
    } catch {
      respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' });
      return;
    }
    const parsed = parseCreateTicketRequest(raw);
    if (!parsed.ok) {
      respondJson(res, 400, { ok: false, error: parsed.message });
      return;
    }

    let ticket;
    try {
      ticket = createTicketFromApi(deps.store, parsed.request, {
        projectId: deps.options?.projectId?.(),
      });
    } catch (e) {
      respondJson(res, 500, { ok: false, error: 'failed to create the ticket' });
      return;
    }
    deps.options?.onTicketCreated?.(ticket.id);
    respondJson(res, 201, {
      ok: true,
      ticket: {
        id: ticket.id,
        key: ticket.key,
        title: ticket.title,
        description: ticket.description,
      },
    });
  });
}
```

`src/hooks/endpoint.ts` — route before the hook logic:

```ts
import { serveCreateTicketRequest, type TicketApiOptions } from './ticketApi.js';
```

In `HookEndpointOptions`, add:

```ts
  /**
   * Ticket-creation API (§ create ticket from the extension): when present,
   * `POST /tickets` is served alongside `/hooks`. Requests are never counted
   * on the hook channel recorder — this is not a hook.
   */
  ticketApi?: TicketApiOptions;
```

In the `createServer` callback, right after the method check and BEFORE `parseHookRequestTarget`:

```ts
      // The create-ticket API is a sibling route: POST /tickets, JSON in,
      // JSON out. It is served before the hook target parse, so it never
      // touches the hook path or its recorder.
      if (requestPath(req.url) === '/tickets') {
        serveCreateTicketRequest(req, res, {
          store,
          options: options.ticketApi,
          maxBodyBytes: MAX_BODY_BYTES,
          requestTimeoutMs,
        });
        return;
      }
```

And add the helper next to `parseHookRequestTarget`:

```ts
/** The URL's pathname, '' for a target that does not parse as a URL. */
function requestPath(raw: string | undefined): string {
  try {
    return new URL(raw ?? '', 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/endpoint.test.ts src/hooks/ticketApi.test.ts -v`
Expected: PASS — new `/tickets` cases AND every pre-existing hook case (regression check).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/ticketApi.ts src/hooks/endpoint.ts src/hooks/endpoint.test.ts
git commit -m "feat(api): serve POST /tickets on the extension's localhost endpoint"
```

---

### Task 4: Wire the host — window project + UI refresh

**Files:**
- Modify: `src/extension.ts` (the `startHookEndpoint` call at ~line 2201)
- Test: `src/extensionActivation.test.ts` (source pin, existing pattern)

**Interfaces:**
- Consumes: `HookEndpointOptions.ticketApi` (Task 3): `{ projectId?: () => number | undefined, onTicketCreated?: (ticketId: number) => void }`.
- Produces: nothing downstream — this is the wiring terminator.

- [ ] **Step 1: Write the failing test**

Append to `src/extensionActivation.test.ts`:

```ts
  // The create-ticket API lands tickets on THIS window's project (the DB is
  // shared by every window), and a created ticket must appear in the sidebar
  // without anyone opening the form. Pinned as source like every wiring case
  // in this file: extension.ts imports `vscode` and cannot load under vitest.
  it('wires the ticket API to the window project and a sidebar refresh', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toContain('ticketApi: {');
    expect(source).toContain('projectId: () => currentProject()?.id,');
    expect(source).toContain('onTicketCreated: (ticketId) => {');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/extensionActivation.test.ts -v`
Expected: FAIL — the wiring strings are absent.

- [ ] **Step 3: Wire the host**

In `src/extension.ts`, add `ticketApi` to the `startHookEndpoint` options object (after `{ recorder: hookChannelRecorder },`):

```ts
    {
      recorder: hookChannelRecorder,
      ticketApi: {
        // Same getter pattern as the ticket form: the project binds at
        // activation, read it at call time.
        projectId: () => currentProject()?.id,
        // A created ticket must appear in the sidebar immediately; a dashboard
        // tab for it is not open (no one navigated to it), and pushState is a
        // no-op when no panel is open — safe either way.
        onTicketCreated: (ticketId) => {
          provider.refresh();
          dashboard.pushState(ticketId);
        },
      },
    },
```

- [ ] **Step 4: Verify**

Run: `npx vitest run src/extensionActivation.test.ts -v` — PASS.
Run: `npm run typecheck` — clean.
Run: `npx vitest run src/hooks/endpoint.test.ts src/hooks/ticketApi.test.ts -v` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/extensionActivation.test.ts
git commit -m "feat(api): bind ticket creation to the window project and refresh the sidebar"
```

---

### Task 5: Full verification + manual smoke test

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all suites pass (pretest rebuilds better-sqlite3 for the Node ABI — normal).

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean typecheck; `dist/` compiles.

- [ ] **Step 3: Manual smoke test in the Extension Dev Host (F5)**

1. F5 launches the dev host; the endpoint binds and `writeCurrentEndpoint` writes the URL to `<configDir>/codex/current-endpoint`.
2. Read the URL: `cat "<configDir>/codex/current-endpoint"` (e.g. `.../globalStorage/karst.karst/codex/current-endpoint`) — it ends in `/hooks`.
3. POST a create request (swap `/hooks` → `/tickets`):
   ```bash
   BASE=$(cat "<configDir>/codex/current-endpoint" | sed 's#/hooks$##')
   curl -s -X POST "$BASE/tickets" \
     -H 'content-type: application/json' \
     -d '{"title":"Smoke test ticket","description":"created via POST /tickets"}'
   ```
   Expected: `{"ok":true,"ticket":{...}}` with status 201.
4. The sidebar list shows the new ticket (key `SMOKE-TEST-TICKET`).
5. Negative: `curl -s -X POST "$BASE/tickets" -d '{}'` → 400 `{"ok":false,"error":"title is required"}`.

- [ ] **Step 4: Commit any follow-up fixes found in smoke testing** (conventional commit, or none if clean).

---

## Self-Review

**1. Spec coverage:** The ticket requires (a) an interface that accepts ticket creation requests — `POST /tickets` on the existing localhost endpoint (Task 3), (b) clarified required fields — `title` required, `description`/`key` optional, documented in `parseCreateTicketRequest` (Task 1), (c) creation logic — `createTicketFromApi` reusing `createTicketFlow` (Task 2), (d) persistence — verified by tests + smoke test (Tasks 2/5), (e) validation/error handling — 400 with bounded messages, 413 oversize, 408 timeout, 500 generic, JSON errors (Tasks 1/3), (f) "the extension can trigger creation" — host wiring refreshes the sidebar (Task 4) + e2e smoke (Task 5). ✓

**2. Placeholder scan:** No TBDs; every step carries real code or an exact command. The single note (recorder shape in Task 3's test) names the source file to check, not a placeholder.

**3. Type consistency:** `CreateTicketRequest`/`ParseCreateTicketResult` defined in Task 1, consumed verbatim by `createTicketFromApi` (Task 2) and `serveCreateTicketRequest` (Task 3). `TicketApiOptions` defined in Task 3, consumed by `HookEndpointOptions.ticketApi` (Task 3) and wired in Task 4 with the exact field names `projectId`/`onTicketCreated`. `generateTicketKey(store, {projectId}, title)` and `createTicketFlow(store, {key, title, description?, projectId?})` match the real signatures verified in `store/tickets.ts:255` and `workflow/stages/create.ts`. `getTicketByKey`/`getTicket`/`listTickets`/`archiveTicket` are all existing exports of `store/tickets.js`.
