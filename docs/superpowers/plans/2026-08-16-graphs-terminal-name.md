# Graphs Terminal Name & Graph Run/Services Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three graph-approach presentation defects: a brand-new ticket shows `run 3` (a global DB id), graph session terminals are named `Karst planner 4`/`Karst node N` with no karst logo instead of a regular session name with the brand icon, and graph agent sessions read as running "services" (even in repos with no runnable service, with 2 per repo).

**Architecture:** Three independent, host-agnostic fixes. (1) The graph-run ordinal is computed READ-side (`COUNT` over the ticket's own runs) so the Inside impl strip renders a per-ticket `run N` while the real `id` keeps flowing to actions/logs. (2) A `TerminalNamingBag` (name + brand icon) replaces the `sessionNameOf: (runId, kind) => "Karst <kind> <runId>"` string at the graph driver seam and is threaded through `AgentNodeLaunch.sessionIconPath` into the graph terminal host, which currently creates terminals with no `iconPath`. (3) A `servers.kind` column (`'service'` default, `'agent'` for graph sessions) keeps the reapers (`listRunningServers`, `stopServersUnder`, `reapStaleServers`) seeing every row while the service-display readers (`listServersByTicket`, diagnostics `readServers`) filter agent rows out.

**Tech Stack:** TypeScript, ESM, vitest, better-sqlite3 (Node ABI), `node:sqlite` CLI. No new dependencies.

## Global Constraints

- ESM (`type:module`): every relative import needs a `.js` suffix; `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` is on: array access needs `!` or a guard.
- Host-agnostic invariants: logic takes injected interfaces; `vscode` is NEVER a runtime dep. `ui/terminalNaming.ts` is vscode-free — the graph driver may import its `TerminalNamingBag` type, but never `vscode`.
- Conventional commits; strict TDD (RED → GREEN); keep files small (<400 lines typical).
- New schema column checklist: `schema.sql` (fresh DBs) + a guarded ALTER in `migrations.ts` + bump `SCHEMA_VERSION` + update db.test.ts's `user_version` assertions. Migrations never backfill data they can't derive.
- `servers.kind` must be placed LAST in the `schema.sql` CREATE TABLE (after `cwd`), because a migrated DB gets it via `ALTER TABLE … ADD COLUMN` which SQLite always appends — a fresh DB and a migrated one must stay byte-for-byte comparable on column order (the v21 `servers.cwd` precedent).
- The `servers` registry is the SINGLE reaper surface (869ed2n50 detached-process class). Graph sessions must STAY registered in `servers` so `removeWorktree` → `stopServersUnder` and the global `reapStaleServers` sweep still kill them. Only the service-DISPLAY readers filter `kind`.
- The graph-run `id` (`approach_graph_runs.id`) stays the identity everywhere internal (actions, logs, `[graph] run ${graphRunId}` diagnostics, `graphRunForTicket`). Only the DISPLAY string in `graphInsideProcess` switches to the ordinal.
- A `TerminalNamingBag` name is what both the terminal tab AND the agent CLI's own session name receive (the regular-session precedent in `ui/session.ts`). Adapters without a naming flag (opencode, codex, agy) already ignore it.
- Graph sessions are re-attached by env (`KARST_TICKET_ID`/`KARST_LAUNCH_ID`) via the per-window identity registry, never by terminal name — renaming graph terminals breaks nothing.

---

### Task 1: Display a per-ticket graph-run ordinal instead of the global DB id

**Problem:** `model/inside/graph.ts` `graphInsideProcess` renders `run ${input.graphRun.id}`, and `input.graphRun.id` is the `approach_graph_runs` row id — a GLOBAL autoincrement across every ticket. A brand-new ticket whose graph is the 3rd run in the registry reads `run 3` ("why 3 for new ticket? it's from inside component"). Fix: compute a 1-based per-ticket ordinal at read time.

**Files:**
- Modify: `src/ui/dashboard/graphInside.ts` (`latestGraphRunFor` / `buildGraphInsideInput`)
- Modify: `src/model/inside/graph.ts` (`GraphInsideInput.graphRun` + `graphInsideProcess`)
- Test: `src/ui/dashboard/graphInside.test.ts`
- Test: `src/model/inside/graph.test.ts`

**Interfaces:**
- Consumes: `approach_graph_runs` rows (columns `id`, `ticket_id`, `stage_attempt`, `approach_id`, `status`, `created_at`).
- Produces: `GraphInsideInput.graphRun` gains `runNumber: number`; `graphInsideProcess` renders `run ${input.graphRun.runNumber} · …`. `graphRun.id` remains the real id and is still what every `GraphActionTarget` and internal diagnostic carries.

- [ ] **Step 1: Write the failing test for the ordinal**

Add to `src/ui/dashboard/graphInside.test.ts` (same describe block as `buildGraphInsideInput`; the existing `seedGraph` helper creates one run via `createGraphRun`):

```ts
it('numbers the run per ticket, not by the global row id', () => {
  const h = deps();
  const { ticketId } = seedGraph(h, {});
  // A second ticket's first run must still read run 1, even though its row id
  // is larger than every existing run's.
  const other = createGraphRun(h.db, {
    ticketId: ticketId + 1000,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-12T00:00:00.000Z',
  });
  expect(buildGraphInsideInput(h, other)!.graphRun.runNumber).toBe(1);
  expect(buildGraphInsideInput(h, ticketId)!.graphRun.runNumber).toBe(1);
});
```

(Add the `createGraphRun` import to the test's import list if it is not already there.)

Then add a rendering test in `src/model/inside/graph.test.ts` that proves the DETAIL string uses the ordinal, not the id:

```ts
it('renders the per-ticket run ordinal, never the global run id', () => {
  const view = graphInsideProcess(
    input({ graphRun: { ...input({}).graphRun!, id: 99, runNumber: 2 } }),
  )!;
  expect(view.rows[0]!.detail).toContain('run 2');
  expect(view.rows[0]!.detail).not.toContain('run 99');
});
```

(Extend the `input()` helper first — see Step 3 — so this test compiles; the RED here is the ordinal helper + the type.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/graphInside.test.ts src/model/inside/graph.test.ts`
Expected: FAIL — `runNumber` does not exist on the `graphRun` object (type error) / the detail still renders the global id.

- [ ] **Step 3: Add the ordinal and render it**

In `src/model/inside/graph.ts`, add `runNumber` to the `graphRun` field of `GraphInsideInput` (next to `id`):

```ts
  graphRun: {
    id: number;
    /** The 1-based run ordinal among THIS ticket's graph runs — the display
     *  number. The global row `id` above is the identity; `runNumber` is how
     *  it reads on the strip ("run 1" for a new ticket whatever the DB-wide
     *  autoincrement has reached). */
    runNumber: number;
    status: string;
    approachId: string;
    stageAttempt: number;
    createdAt: string;
  } | null;
```

Then change the detail line in `graphInsideProcess` (currently `` `run ${input.graphRun.id} · …` ``):

```ts
    detail: sanitizeGraphText(
      `run ${input.graphRun.runNumber} · ${graphRunStatusCopy(input.graphRun.status)} · ${input.graphRun.approachId}`,
    ),
```

In `src/ui/dashboard/graphInside.ts`, add the read-side ordinal helper next to `latestGraphRunFor`:

```ts
/** The 1-based ordinal of `runId` among the ticket's OWN graph runs — the
 *  display number, never the global row id. A fresh ticket's first run reads
 *  `run 1`, whatever `approach_graph_runs.id` the registry has reached. */
export function graphRunOrdinal(store: Store, ticketId: number, runId: number): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM approach_graph_runs WHERE ticket_id = ? AND id <= ?')
    .get(ticketId, runId) as { n: number };
  return row.n;
}
```

And in `buildGraphInsideInput`'s return object, populate it:

```ts
    graphRun: {
      id: run.id,
      runNumber: graphRunOrdinal(deps.store, ticketId, run.id),
      status: run.status,
      approachId: run.approach_id,
      stageAttempt: run.stage_attempt,
      createdAt: run.created_at,
    },
```

- [ ] **Step 4: Update the existing tests' fixtures**

In `src/model/inside/graph.test.ts`, the `input()` helper's `graphRun` object gains `runNumber: 7` so the existing `` detail ``contain('run 7')`` assertion at the "renders the run, planner, revision, diagnostics, and artifact evidence rows" test keeps passing:

```ts
    graphRun: {
      id: 7,
      runNumber: 7,
      status: 'running',
      approachId: 'karst-graph-engineering',
      stageAttempt: 0,
      createdAt: '2026-08-11T00:00:00.000Z',
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/graphInside.test.ts src/model/inside/graph.test.ts`
Expected: PASS (both the new ordinal/rendering tests and all pre-existing graph-projection tests).

- [ ] **Step 6: Run the wider suite to catch other `graphRun.id` readers**

Run: `npm run typecheck` then `npx vitest run src/ui/dashboard src/model/inside`
Expected: PASS. `graphRun.id` is still present, so any other consumer of the id (actions, `graphInsideProcess` stop/confirm/attach closures) is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/graphInside.ts src/model/inside/graph.ts src/ui/dashboard/graphInside.test.ts src/model/inside/graph.test.ts
git commit -m "fix: show per-ticket graph run ordinal, not the global row id"
```

---

### Task 2: Give graph session terminals the regular session name and the karst brand icon

**Problem:** Graph sessions are named by `sessionNameOf: (runId, kind) => \`Karst ${kind} ${runId}\`` (extension.ts) → a terminal tab reading `Karst planner 4`, and node sessions by a hardcoded `Karst node <nodeRunId>` (executors/agent.ts). `makeGraphTerminalHost` (extension.ts) creates terminals with NO `iconPath`, so the tab is also missing the karst logo that every regular session wears. Regular sessions get `terminalNaming({ name: terminalTicketName(ticket, template), brandIcon })` → `Karst: <key> — <title>` + the brand mark. Fix: resolve the naming at the driver seam as a `TerminalNamingBag` (host supplies ticket name + brand icon) and thread `sessionIconPath` into the transport's terminal host.

**Files:**
- Modify: `src/approaches/graph/transport/agentTransport.ts` (`CreateTransportTerminalOpts`, `AgentNodeLaunch`)
- Modify: `src/approaches/graph/transport/supervisedCliTransport.ts` (`start`)
- Modify: `src/approaches/graph/driver.ts` (`GraphDriverDeps`, 3 launch functions, `driveReadyNodeRuns` executor deps)
- Modify: `src/approaches/graph/executors/agent.ts` (`RunAgentNodeDeps`, `runAgentNode`)
- Modify: `src/extension.ts` (`makeGraphTerminalHost`, `graphDriverDeps`' `sessionNameOf` binding, imports)
- Test: `src/approaches/graph/driver.test.ts`
- Test: `src/approaches/graph/graphE2eHarness.test.ts`
- Test: `src/approaches/graph/executors/agent.test.ts`
- Test: `src/approaches/graph/transport/supervisedCliTransport.test.ts`

**Interfaces:**
- Consumes: `TerminalNamingBag` (`{ name: string; iconPath?: string; color?: string }`) from `src/ui/terminalNaming.ts` (vscode-free); `terminalTicketName(ticket, template)` from `src/store/ticketLabelTemplate.ts`; `getTicket(store, id)` from `src/store/tickets.ts`; `brandIcon` (`BrandIconPaths`).
- Produces:
  - `GraphDriverDeps.sessionNameOf` is REPLACED by `sessionNamingOf: (graphRunId: number, runId: number, kind: 'planner' | 'node') => TerminalNamingBag`.
  - `AgentNodeLaunch.sessionIconPath?: string` and `CreateTransportTerminalOpts.iconPath?: string`.
  - `RunAgentNodeDeps.sessionNamingOf` with the same signature.
  - The supervised CLI transport passes `iconPath` through to `terminalHost.createTerminal`.
  - The ACP transport (no terminal, protocol-driven) only carries the name — `sessionIconPath` is inert there (declared in `AgentNodeLaunch`, unused by `acpTransport`).

- [ ] **Step 1: Write the failing test for the transport forwarding the icon**

In `src/approaches/graph/transport/supervisedCliTransport.test.ts`, add a test that a launch carrying `sessionIconPath` forwards it to the terminal host (the existing harness's `terminalHost.createTerminal` records its opts — assert on that record):

```ts
it('forwards the session icon path to the terminal host', async () => {
  const terminal = { processId: async () => 4242 } as never;
  const calls: Array<Record<string, unknown>> = [];
  const h = harness({
    terminalHost: {
      createTerminal: (opts) => {
        calls.push(opts as Record<string, unknown>);
        return terminal;
      },
    },
  });
  await h.transport.start({
    ...h.request,
    sessionName: 'Karst: K-1 — fix',
    sessionIconPath: '/icon/karst.svg',
  });
  expect(calls[0]!.iconPath).toBe('/icon/karst.svg');
  expect(calls[0]!.name).toBe('Karst: K-1 — fix');
});
```

(Match the existing harness's shapes — read `supervisedCliTransport.test.ts` first; if its `harness` factory takes no deps, extend it minimally to accept a `terminalHost` override.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/approaches/graph/transport/supervisedCliTransport.test.ts`
Expected: FAIL — `iconPath` is not a property of `CreateTransportTerminalOpts`/the forwarded call.

- [ ] **Step 3: Widen the transport types and forward the icon**

In `src/approaches/graph/transport/agentTransport.ts`:

```ts
export interface CreateTransportTerminalOpts {
  name: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  env: Record<string, string>;
  hideFromUser?: boolean;
  /** The karst brand mark for the terminal tab (a path to the logo asset). */
  iconPath?: string;
}
```

and in `AgentNodeLaunch`, next to `sessionName`:

```ts
  sessionName?: string;
  /** The karst brand mark for the terminal tab; `sessionName` stays the text. */
  sessionIconPath?: string;
```

In `src/approaches/graph/transport/supervisedCliTransport.ts` `start`, pass it through:

```ts
      const terminal = deps.terminalHost.createTerminal({
        name: request.sessionName ?? `Karst node ${request.nodeRunId}`,
        cwd: request.cwd,
        shellPath: built.command,
        shellArgs: built.args,
        env: { ...built.env, ...request.graphEnv },
        ...(request.sessionIconPath ? { iconPath: request.sessionIconPath } : {}),
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/approaches/graph/transport/supervisedCliTransport.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the executor resolving the naming bag**

In `src/approaches/graph/executors/agent.test.ts`, extend the `harness` deps builder and assert the launch carries the resolved name + icon:

```ts
it('names the node session from the injected naming bag', async () => {
  const transport = fakeTransport(true);
  const h = harness(transport);
  const result = await runAgentNode(h.deps, h.input);
  expect(result.kind).toBe('launched');
  const launch = transport.starts[0]!;
  expect(launch.sessionName).toBe('Karst node 11');
  expect(launch.sessionIconPath).toBe('/icon/karst.svg');
  expect(launch.interactive.sessionName).toBe('Karst node 11');
});
```

For this to compile, the deps builder must provide `sessionNamingOf` — add it to `harness`'s deps object (Step 7 shows the stub). The test FAILS first because `RunAgentNodeDeps` has no `sessionNamingOf` yet.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/approaches/graph/executors/agent.test.ts`
Expected: FAIL — `RunAgentNodeDeps` has no `sessionNamingOf`.

- [ ] **Step 7: Resolve the naming bag in the executor**

In `src/approaches/graph/executors/agent.ts`:

- import the type: `import type { TerminalNamingBag } from '../../../ui/terminalNaming.js';`
- add to `RunAgentNodeDeps`:

```ts
  /** The terminal naming bag for a graph session (name + brand icon). */
  sessionNamingOf: (graphRunId: number, runId: number, kind: 'planner' | 'node') => TerminalNamingBag;
```

- in `runAgentNode`, replace the hardcoded name with a resolved bag (right where `launch` is built):

```ts
  const naming = deps.sessionNamingOf(input.graphRunId, input.nodeRunId, 'node');
  const launch: SupervisedLaunchRequest = {
    nodeRunId: input.nodeRunId,
    ticketId: input.ticketId,
    graphRunId: input.graphRunId,
    repo: input.repo,
    cwd: input.cwd,
    generation: input.generation,
    sessionName: naming.name,
    ...(naming.iconPath ? { sessionIconPath: naming.iconPath } : {}),
    graphEnv: deps.graphEnv({
      nodeRunId: input.nodeRunId,
      ticketId: input.ticketId,
      graphRunId: input.graphRunId,
      revisionId: input.revisionId,
      generation: input.generation,
    }),
    adapter: input.adapter,
    interactive: {
      cwd: input.cwd,
      model: resolved.model,
      effort: resolved.effort,
      initialPrompt: prompt,
      sessionName: naming.name,
    },
  };
```

Update the `agent.test.ts` `harness` deps builder:

```ts
    sessionNamingOf: (_graphRunId, runId, kind) => ({ name: `Karst ${kind} ${runId}`, iconPath: '/icon/karst.svg' }),
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/approaches/graph/executors/agent.test.ts`
Expected: PASS.

- [ ] **Step 9: Change the driver seam from a name string to a naming bag**

In `src/approaches/graph/driver.ts`:

- import the type: `import type { TerminalNamingBag } from '../../ui/terminalNaming.js';`
- replace the deps field (currently line ~158):

```ts
  sessionNameOf: (runId: number, kind: 'planner' | 'node') => string;
```
with:
```ts
  sessionNamingOf: (graphRunId: number, runId: number, kind: 'planner' | 'node') => TerminalNamingBag;
```

- update every call site (six of them, in `bootstrapAndLaunchPlanner`, `relaunchBootstrapPlanner`, `launchReplanPlanner`) from the two-arg string form to a resolved bag. Each launch currently does, e.g.:

```ts
  const session = await deps.transport.start({
    ...
    sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    ...
    interactive: {
      ...
      sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    },
  } satisfies SupervisedLaunchRequest);
```

Replace with (resolve once):

```ts
  const naming = deps.sessionNamingOf(graphRunId, plannerRunId, 'planner');
  const session = await deps.transport.start({
    ...
    sessionName: naming.name,
    ...(naming.iconPath ? { sessionIconPath: naming.iconPath } : {}),
    ...
    interactive: {
      ...
      sessionName: naming.name,
    },
  } satisfies SupervisedLaunchRequest);
```

`graphRunId` is in scope at every call site (`graphRunId`, `input.graphRunId`, `launch.graphRunId` respectively).

- in `driveReadyNodeRuns`, where the `RunAgentNodeDeps` object is built for `runAgentNode` (around line 875), thread the driver's resolver through:

```ts
      sessionNamingOf: (graphRunId, runId, kind) => deps.sessionNamingOf(graphRunId, runId, kind),
```

- [ ] **Step 10: Update the driver/harness test stubs**

In `src/approaches/graph/driver.test.ts` (the `Deps` factory) and `src/approaches/graph/graphE2eHarness.test.ts` (the `GraphDriverDeps` factory):

```ts
    sessionNamingOf: (_graphRunId, runId, kind) => ({ name: `Karst ${kind} ${runId}` }),
```

The `Karst ${kind} ${runId}` form is deliberate: `graphE2eHarness.test.ts`'s `nodeCapabilityOf` and the `graph.e2e.test.ts` assertions match node launches by `sessionName === \`Karst node ${nodeRunId}\`` / `startsWith('Karst node')`, and the driver only ever calls this for planner launches (nodes flow through the executor's own resolver). Keeping the same shape means those matchers stay green.

- [ ] **Step 11: Run the graph suites to verify they pass**

Run: `npx vitest run src/approaches/graph`
Expected: PASS (driver, executor, transports, coordinator, e2e harness). The stubs now return a bag, so every launch request still carries a `sessionName`.

- [ ] **Step 12: Bind the naming bag in the extension host**

In `src/extension.ts`:

- ensure the imports exist at the top (add any that are missing):
  - `import { getTicket } from './store/tickets.js';`
  - `import { terminalTicketName } from './store/ticketLabelTemplate.js';`
  - `import { terminalNaming } from './ui/terminalNaming.js';`
- in `makeGraphTerminalHost.createTerminal` (currently `name/cwd/shellPath/shellArgs/env/hideFromUser` only), add the icon just like `makeTerminalHost` does:

```ts
      const terminal = vscode.window.createTerminal({
        name: opts.name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        // The brand mark rides the graph tab exactly like a regular session's
        // (Terminal.creationOptions is readonly — the launch glyph is frozen).
        ...(opts.iconPath ? { iconPath: vscode.Uri.file(opts.iconPath) } : {}),
      });
```

- replace the `sessionNameOf` binding in `graphDriverDeps` (currently `` (runId, kind) => \`Karst ${kind} ${runId}\` ``):

```ts
      sessionNamingOf: (graphRunId, runId, kind) => {
        // A graph session's terminal reads like any other session terminal:
        // the manifest's terminal-name template + the brand mark. The ticket is
        // resolved through the graph run so a session can be named for the
        // ticket it belongs to, not for an opaque run id ("Karst planner 4").
        const ticket = getTicket(localStore, graphRunTicketId(graphRunId));
        return terminalNaming({
          name: ticket
            ? terminalTicketName(ticket, currentManifest()?.terminalNameTemplate)
            : `Karst ${kind} ${runId}`,
          brandIcon,
        });
      },
```

(`graphRunTicketId`, `currentManifest`, `brandIcon`, and `localStore` are all already in scope inside `graphDriverDeps`'s closure. `getTicket` throws for an unknown id — guard with the ticket existence check if the surrounding code prefers `try/catch`, or reuse whichever ticket lookup `graphRunTicketId`'s callers already use.)

- [ ] **Step 13: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS. The removed `sessionNameOf` no longer appears anywhere (grep `sessionNameOf` should return zero non-test hits once `sessionNamingOf` has replaced it).

- [ ] **Step 14: Run the full unit suite**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/approaches/graph src/extension.ts src/ui/terminalNaming.ts
git commit -m "feat: name graph session terminals like regular sessions and wear the brand icon"
```

---

### Task 3: Keep graph agent sessions out of the services display

**Problem:** Every graph session (planner + node) registers a `servers` row with `status='running'` and `host`/`port` NULL (`extension.ts` `recordSession`). The service-display readers — `listServersByTicket` (dashboard, sidebar, `karst context`) and diagnostics `readServers` (topology) — show them as running services, so a repo with NO runnable service in the manifest reads as having "services launched", and two parallel nodes in one worktree read as "2 services in 1 repo". The rows must STAY in `servers` (the reapers `stopServersUnder`/`reapStaleServers`/the resource monitor depend on them); only the DISPLAY must distinguish. Fix: a `servers.kind` column (`'service'` default, `'agent'` for graph sessions) and a `kind = 'service'` filter on the two display readers.

**Files:**
- Modify: `src/store/schema.sql` (`servers` table)
- Modify: `src/store/migrations.ts` (`SCHEMA_VERSION` + guarded ALTER)
- Modify: `src/extension.ts` (`recordSession` insert)
- Modify: `src/store/dashboard.ts` (`listServersByTicket`)
- Modify: `src/diagnostics/storeEvidence.ts` (`readServers`)
- Test: `src/store/db.test.ts`
- Test: `src/store/dashboard.test.ts`
- Test: `src/diagnostics/storeEvidence.test.ts` (and/or `src/diagnostics/collectMetadata.test.ts`)

**Interfaces:**
- Consumes: `servers` rows (`id`, `ticket_id`, `repo`, `host`, `port`, `pid`, `status`, `cwd`, and now `kind`).
- Produces: `servers.kind TEXT NOT NULL DEFAULT 'service'`; graph sessions inserted with `kind = 'agent'`; `listServersByTicket` and `readServers` return only `kind = 'service'` rows. `listRunningServers` (resource monitor) and the reaper SQL are UNCHANGED and still see every row.

- [ ] **Step 1: Write the failing tests**

In `src/store/dashboard.test.ts`, add a test that agent-kind rows are not services:

```ts
it('excludes graph-agent rows from the services list', () => {
  const { store, a } = ctx(); // match the existing harness
  const other = createTicket(store, { key: 'G-2', title: 'Graph ticket', projectId: a.projectId });
  store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'web', 1, 'running', '/wt/web', '2026-08-12T00:00:00.000Z', 'service')",
    )
    .run(other.id);
  store.db
    .prepare(
      "INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind) VALUES (?, 'web', 2, 'running', '/wt/web', '2026-08-12T00:00:00.000Z', 'agent')",
    )
    .run(other.id);
  const servers = listServersByTicket(store, other.id);
  expect(servers).toHaveLength(1);
  expect(servers[0]!.status).toBe('running');
});
```

(Match the file's existing harness shape — check `dashboard.test.ts`'s `ctx()`/seed helpers first and reuse them.)

In `src/diagnostics/storeEvidence.test.ts`, add a case where an agent row is dropped from `readServers`:

```ts
it('readServers excludes graph-agent rows', () => {
  // seed two rows for the ticket: one kind='service', one kind='agent'
  // (INSERT ... kind = 'service' / 'agent' as in the dashboard test above)
  const result = readServers(store, ticketId, 10);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.repo).toBe('api');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/dashboard.test.ts src/diagnostics/storeEvidence.test.ts`
Expected: FAIL — the agent row is returned (no kind filter yet). (These compile: SQLite tolerates a `kind` column named in the INSERT only if the column exists — it does not yet, so the INSERT itself errors; if so, the RED is the "no such column: kind" failure, which is equally valid RED.)

- [ ] **Step 3: Add the `kind` column to the schema**

In `src/store/schema.sql`, at the END of the `servers` CREATE TABLE (after the `cwd` column and its comment block):

```sql
  -- The registry doubles as the reaper surface AND the services display. A
  -- graph planner/node session is a real running process that must be reaped
  -- (869ed2n50 class), but it is NOT a service: kind distinguishes the two so
  -- the display readers can drop agent sessions while the reapers keep them.
  -- Placed LAST, matching where the ALTER necessarily appends on an upgrade.
  kind          TEXT NOT NULL DEFAULT 'service'   -- service | agent (graph session)
);
```

- [ ] **Step 4: Add the guarded migration and bump the version**

In `src/store/migrations.ts`:

- bump `export const SCHEMA_VERSION = 45;` → `= 46;`
- add a version-gated step at the end of `migrate` (after the `if (current < 45)` block), mirroring the v45 style:

```ts
  if (current < 46) {
    // v46: `servers.kind` distinguishes a real service from a graph agent
    // session. Graph sessions register in `servers` so the reapers kill them
    // (869ed2n50), but the services DISPLAY must not read them as services.
    // The guard reads the CURRENT columns, so a fresh DB (already carrying it
    // via schema.sql) is a no-op and a re-open is idempotent. NOTHING IS
    // BACKFILLED: a pre-v46 row predates the distinction and is a service (the
    // DEFAULT), which is the honest answer — every pre-v46 row was one.
    const serverCols = tableColumns(db, 'servers');
    if (serverCols.size > 0 && !serverCols.has('kind')) {
      db.exec("ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'service'");
    }
  }
```

- [ ] **Step 5: Write the agent rows and filter the display readers**

In `src/extension.ts`, `recordSession` (the `INSERT INTO servers` in `createSupervisedCliTransport`'s deps) gains the kind:

```ts
    recordSession: (row) => {
      graphCoordinatorStore?.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at, kind)
           VALUES (?, ?, ?, 'running', ?, ?, 'agent')`,
        )
        .run(row.ticketId, row.repo, row.pid, row.cwd, row.startedAt);
    },
```

In `src/store/dashboard.ts`, `listServersByTicket` filters:

```ts
      `SELECT id, ticket_id, repo, host, port, status FROM servers
        WHERE ticket_id = ? AND kind = 'service'
        ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, repo`,
```

In `src/diagnostics/storeEvidence.ts`, `readServers` filters:

```ts
  const rows = store.db.prepare(
    `SELECT repo, status, (host IS NOT NULL AND port IS NOT NULL) AS has_address,
            COUNT(*) OVER() AS total_count
       FROM servers
      WHERE ticket_id = ? AND kind = 'service'
      ORDER BY id DESC
      LIMIT ?`,
  ).all(ticketId, limit + 1) as Array<{
```

- [ ] **Step 6: Update the migration/version tests**

In `src/store/db.test.ts`:

- replace every hardcoded `user_version` assertion `toBe(45)` → `toBe(46)` (54 occurrences — `grep -rn "toBe(45)" src/store/db.test.ts` and update them all).
- add a migration test that a pre-v46 DB gains the column with the service default:

```ts
  it('migrates a v45 DB to v46, adding servers.kind defaulting to service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE servers (
         id INTEGER PRIMARY KEY, ticket_id INTEGER, repo TEXT NOT NULL, host TEXT,
         port INTEGER, pid INTEGER, status TEXT NOT NULL, log_path TEXT,
         started_at TEXT NOT NULL DEFAULT (datetime('now')), cwd TEXT)`,
    );
    legacy
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, pid, status, cwd) VALUES (1,'api','h',3000,4242,'running','/wt/api')",
      )
      .run();
    legacy.pragma('user_version = 45');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());

    const cols = new Set(
      (migrated.db.prepare("PRAGMA table_info('servers')").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    expect(cols.has('kind')).toBe(true);
    // The pre-v46 row was a service — the DEFAULT is the honest answer, never a guess.
    expect(
      migrated.db.prepare("SELECT kind FROM servers WHERE ticket_id = 1").get(),
    ).toEqual({ kind: 'service' });
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(46);
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts src/store/dashboard.test.ts src/diagnostics/storeEvidence.test.ts src/diagnostics/collectMetadata.test.ts`
Expected: PASS. Other suites that seed `servers` without a `kind` column keep compiling (the DEFAULT covers them) and their expectations are unchanged because every existing fixture row is a service.

- [ ] **Step 8: Run the full unit suite and typecheck**

Run: `npm run typecheck` then `npm run test:unit`
Expected: PASS. In particular `src/approaches/graph/transport/supervisedCliTransport.test.ts`, `src/approaches/graph/workspace/*`, and `src/runtime/worktreeServers.test.ts` still pass: the reaper paths were not touched and still match every running row regardless of kind.

- [ ] **Step 9: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/db.test.ts src/store/dashboard.ts src/store/dashboard.test.ts src/diagnostics/storeEvidence.ts src/diagnostics/storeEvidence.test.ts src/extension.ts
git commit -m "fix: never read graph agent sessions as services (servers.kind)"
```

---

## Self-Review

**1. Spec coverage.**
- "why 3 for new ticket? it's from inside component" → Task 1 (per-ticket ordinal; the 3 was the global `approach_graph_runs.id`).
- "terminal missing karst's logo, name is not as a regular session, Karst planner 4" → Task 2 (brand icon via `sessionIconPath`, name via `terminalTicketName(ticket, terminalNameTemplate)`).
- "somewhy services launched with graph approach … 2 services in 1 repo" → Task 3 (`servers.kind='agent'` + display filter; the "2 services" were two parallel node sessions in one worktree, and the "services" were agent sessions, not manifest services).

**2. Placeholder scan.** Every step carries concrete code or an exact symbol reference. No "TBD/TODO/appropriate error handling/similar to Task N". The two test snippets that say "(match the existing harness…)" are location instructions, not placeholders — the implementing engineer is told to reuse the file's own helpers and every assertion is specified.

**3. Type consistency.**
- `sessionNamingOf: (graphRunId, runId, kind) => TerminalNamingBag` is used identically in `GraphDriverDeps` and `RunAgentNodeDeps`; Task 2 is the only rename (the old `sessionNameOf` disappears everywhere, including extension.ts).
- `runNumber` is defined on `GraphInsideInput.graphRun` (Task 1) and rendered by `graphInsideProcess`; the actions still carry the real `graphRun.id`.
- `servers.kind` is written as `'agent'` in `recordSession` (Task 3) and read by `kind = 'service'` in the two display readers; the reaper readers never mention `kind`.
- The `TerminalNamingBag` shape (`name`/`iconPath`/`color`) is the exact type `ui/terminalNaming.ts` exports, so the host binding and the executor agree.
