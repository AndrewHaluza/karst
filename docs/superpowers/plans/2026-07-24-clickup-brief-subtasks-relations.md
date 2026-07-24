# ClickUp Brief Subtasks and Relations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include immediate ClickUp subtasks and best-effort title/status metadata for task relations in Karst's persisted brief.

**Architecture:** Extend the existing ClickUp Get Task request and provider-local relation parser; the provider-neutral `ContextBrief` and Markdown renderer already have the required `child`, `title`, and `status` fields. Enrich unresolved task refs through supported Get Task calls, deduplicated by ref, while degrading failures to the existing bare-ID rows.

**Tech Stack:** TypeScript, ESM, Vitest, injected `fetch`, ClickUp API v2.

## Global Constraints

- Use only ClickUp's supported API; native attached ClickUp Docs remain unavailable.
- Include only immediate children whose `parent` equals the fetched task ID; do not recurse.
- Do not fetch or embed related-task descriptions.
- Related-task failures must not fail the primary ticket fetch.
- Preserve the existing bare relation when metadata is unavailable.
- Keep API tokens scoped to `api.clickup.com`.
- Follow strict RED→GREEN TDD and Conventional Commits.

## File Structure

- Modify `src/integrations/clickup.ts`: compose Get Task query parameters, parse immediate child relations, and enrich unresolved relation refs.
- Modify `src/integrations/clickup.test.ts`: cover request construction, immediate-child filtering, deduplication, enrichment, and graceful degradation.
- No renderer or provider-neutral type changes: `src/integrations/ticketing.ts` and `src/integrations/briefMarkdown.ts` already support the intended result.

---

### Task 1: Fetch and parse immediate subtasks

**Files:**
- Modify: `src/integrations/clickup.ts`
- Test: `src/integrations/clickup.test.ts`

**Interfaces:**
- Consumes: ClickUp `RawTask` payload and `ClickupDeps.teamId`.
- Produces: `parseRelations(task: RawTask): BriefRelation[]` entries with `kind: 'child'`; Get Task URL containing `include_subtasks=true`.

- [ ] **Step 1: Write failing request and parsing tests**

Add focused tests in `describe('clickupProvider.fetchTicket enrichment', ...)`:

```ts
it('requests subtasks and includes only immediate children as rich child relations', async () => {
  const { fn, calls } = fakeFetch({
    '/task/T-100/comment': { json: {} },
    '/task/T-100': {
      json: {
        id: 'T-100',
        name: 'Parent',
        subtasks: [
          { id: 'C-1', parent: 'T-100', name: 'Immediate', status: { status: 'to do' } },
          { id: 'GC-1', parent: 'C-1', name: 'Nested', status: { status: 'open' } },
          { parent: 'T-100', name: 'Missing id' },
        ],
      },
    },
  });
  const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

  const brief = await provider.fetchTicket!('T-100');

  expect(calls.find((c) => c.url.includes('/task/T-100?'))?.url)
    .toContain('include_subtasks=true');
  expect(brief.relations).toEqual([
    { kind: 'child', ref: 'C-1', title: 'Immediate', status: 'to do' },
  ]);
});

it('composes include_subtasks with custom task id parameters', async () => {
  const { fn, calls } = fakeFetch({
    '/task/T-100/comment': { json: {} },
    '/task/T-100': { json: { id: 'T-100', name: 'Parent' } },
  });
  const provider = clickupProvider({
    fetchFn: fn,
    token: async () => 'tok',
    teamId: '9001',
  });

  await provider.fetchTicket!('T-100');

  const taskCall = calls.find((c) =>
    c.url.includes('/task/T-100?') && !c.url.includes('/comment'),
  );
  expect(taskCall?.url).toContain('include_subtasks=true');
  expect(taskCall?.url).toContain('custom_task_ids=true');
  expect(taskCall?.url).toContain('team_id=9001');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/integrations/clickup.test.ts
```

Expected: FAIL because Get Task lacks `include_subtasks=true`, `RawTask` lacks `subtasks`, and `parseRelations` emits no child rows.

- [ ] **Step 3: Implement minimal query composition and child parsing**

Extend `RawTask`:

```ts
interface RawTask {
  // existing fields...
  subtasks?: RawTask[];
}
```

Add immediate children at the end of `parseRelations`:

```ts
for (const child of task.subtasks ?? []) {
  if (
    self &&
    child.parent === self &&
    typeof child.id === 'string' &&
    child.id
  ) {
    const title = child.name?.trim();
    const status = child.status?.status?.trim();
    out.push({
      kind: 'child',
      ref: child.id,
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
    });
  }
}
```

Replace the fixed Get Task suffix with a helper that safely composes parameters:

```ts
function taskQuery(teamId: string | undefined, includeSubtasks = false): string {
  const query = new URLSearchParams();
  if (teamId) {
    query.set('custom_task_ids', 'true');
    query.set('team_id', teamId);
  }
  if (includeSubtasks) query.set('include_subtasks', 'true');
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}
```

Use `taskQuery(deps.teamId)` for update status, `taskQuery(deps.teamId, true)` for the primary Get Task, and keep the comment query compatible through `taskQuery(deps.teamId)`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run src/integrations/clickup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/clickup.ts src/integrations/clickup.test.ts
git commit -m "fix: include ClickUp subtasks in briefs"
```

---

### Task 2: Enrich task relations without making briefs fragile

**Files:**
- Modify: `src/integrations/clickup.ts`
- Test: `src/integrations/clickup.test.ts`

**Interfaces:**
- Consumes: `BriefRelation[]`, provider-local `getJson(url): Promise<unknown>`, and `taskQuery(teamId)`.
- Produces: provider-local `enrichRelations(relations: BriefRelation[]): Promise<BriefRelation[]>`; each unique unresolved ref is fetched at most once.

- [ ] **Step 1: Write failing enrichment tests**

Add three focused tests:

```ts
it('enriches unresolved task relations with title and status', async () => {
  const { fn } = fakeFetch({
    '/task/REL-1': {
      json: { id: 'REL-1', name: 'Related work', status: { status: 'in progress' } },
    },
    '/task/T-100/comment': { json: {} },
    '/task/T-100?': {
      json: {
        id: 'T-100',
        name: 'Parent',
        linked_tasks: [{ task_id: 'REL-1' }],
      },
    },
  });
  const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

  const brief = await provider.fetchTicket!('T-100');

  expect(brief.relations).toEqual([
    {
      kind: 'related',
      ref: 'REL-1',
      title: 'Related work',
      status: 'in progress',
    },
  ]);
});

it('fetches a repeated unresolved relation ref only once', async () => {
  const { fn, calls } = fakeFetch({
    '/task/REL-1': { json: { id: 'REL-1', name: 'Shared relation' } },
    '/task/T-100/comment': { json: {} },
    '/task/T-100?': {
      json: {
        id: 'T-100',
        name: 'Parent',
        linked_tasks: [{ task_id: 'REL-1' }],
        dependencies: [{ task_id: 'T-100', depends_on: 'REL-1' }],
      },
    },
  });
  const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

  await provider.fetchTicket!('T-100');

  expect(calls.filter((c) => c.url.endsWith('/task/REL-1'))).toHaveLength(1);
});

it('keeps a bare relation when metadata fetch fails', async () => {
  const { fn } = fakeFetch({
    '/task/REL-1': { status: 403, json: {} },
    '/task/T-100/comment': { json: {} },
    '/task/T-100?': {
      json: {
        id: 'T-100',
        name: 'Parent',
        linked_tasks: [{ task_id: 'REL-1' }],
      },
    },
  });
  const provider = clickupProvider({ fetchFn: fn, token: async () => 'tok' });

  await expect(provider.fetchTicket!('T-100')).resolves.toMatchObject({
    relations: [{ kind: 'related', ref: 'REL-1' }],
  });
});
```

Place the more specific related-task fake routes before primary-task routes because `fakeFetch` selects the first matching substring.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run src/integrations/clickup.test.ts
```

Expected: FAIL because unresolved relation refs are never fetched or enriched.

- [ ] **Step 3: Implement best-effort deduplicated enrichment**

Inside `clickupProvider`, add:

```ts
async function enrichRelations(relations: BriefRelation[]): Promise<BriefRelation[]> {
  const pending = new Map<string, Promise<RawTask | undefined>>();

  function metadata(ref: string): Promise<RawTask | undefined> {
    const existing = pending.get(ref);
    if (existing) return existing;
    const request = getJson(
      `${API_BASE}/task/${encodeURIComponent(ref)}${taskQuery(deps.teamId)}`,
    )
      .then((raw) => raw as RawTask)
      .catch(() => undefined);
    pending.set(ref, request);
    return request;
  }

  return Promise.all(
    relations.map(async (relation) => {
      if (relation.title && relation.status) return relation;
      const task = await metadata(relation.ref);
      if (!task) return relation;
      const title = relation.title ?? task.name?.trim();
      const status = relation.status ?? task.status?.status?.trim();
      return {
        ...relation,
        ...(title ? { title } : {}),
        ...(status ? { status } : {}),
      };
    }),
  );
}
```

In `fetchTicket`, replace:

```ts
const relations = parseRelations(task);
```

with:

```ts
const relations = await enrichRelations(parseRelations(task));
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run src/integrations/clickup.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run static and full regression verification**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0 with no failing tests or TypeScript errors.

- [ ] **Step 6: Review the final diff against the spec**

Run:

```bash
git diff --check
git diff --stat HEAD~1
git status --short
```

Expected: no whitespace errors; only the ClickUp provider/tests and this ticket's approved docs are changed.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/clickup.ts src/integrations/clickup.test.ts
git commit -m "fix: enrich ClickUp task relations in briefs"
```

- [ ] **Step 8: Record the implementation marker**

Run the ticket-provided exact `karst stage impl pass` command only after all verification and commits succeed.
