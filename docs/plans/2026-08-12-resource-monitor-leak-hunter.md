# Execution Plan: Resource Monitor (leak hunter)

## Goal

Karst continuously observes the machine resources its own work consumes — spun servers, agent cores, gate scripts — attributes them to tickets, names resources it can PROVE are leaked, and renders them in a live Resources panel plus an always-on status bar meter. No new schema, no persistence, no measurable extension-host cost.

## Current State

Facts established by reading the repository (do not re-derive):

- `servers` table (`src/store/schema.sql:545`) holds `id, ticket_id, repo, host, port, pid, status, log_path, started_at, cwd`. `cwd` is NULL for pre-v21 rows and means UNKNOWN.
- `src/runtime/serverIdentity.ts` owns pid attribution: `attributeServer(row: ServerIdentity, facts: ProcessFacts): Attribution` where `Attribution = 'attributable' | 'dead' | 'foreign' | 'unknown'`. Async probes are exported as `systemAsyncProcessFacts: ProcessFactsSource`. `ProcessFactsSource` methods may return promises; `ProcessFacts` is the sync variant.
- `src/runtime/processTree.ts` exports `killTree(pid): KillOutcome` (`'killed' | 'denied' | 'unknown'`). It signals the process GROUP.
- `src/runtime/worktreeServers.ts` exports `stopServersUnder`, `reapStaleServers`, `describeReap`. `reapStaleServers` runs ONCE at activation today.
- `src/runtime/asyncProcess.ts` exports `commandOutput(command, args, timeoutMs = 2000): Promise<string | null>` — async `spawn`, `stdio: ['ignore','pipe','ignore']`, unref'd timeout, resolves `null` on any failure or non-zero exit. This is the ONLY process-probe helper this plan uses.
- `src/runtime/pathScope.ts` exports `canonicalPath` and `isPathUnder`.
- `src/ui/usage/` is the shape a window-scoped panel takes: `panel.ts` (manager + `UsagePanel`/`UsagePanelHost` interfaces), `state.ts`, `messages.ts` (`parse*Message` + `route*Action` + closed unions), `webview.html`. Wired in `src/extension.ts:2014` via `makeUsagePanelHost` (`src/extension.ts:4364`), which does `injectPalette(injectDesignSystem(readFileSync(...)))` then `injectCsp(html, newNonce())` at panel creation.
- `src/model/actionResult.ts` exports `readRequestId` and `reportAction` — the `action-result` seam (UI-R13).
- Three test files DISCOVER webview directories by scanning `src/ui/*/webview.html` and then assert a HARDCODED sorted list of the eight that exist today: `src/ui/designSystem.test.ts:46`, `src/ui/webviewCsp.test.ts:34`, `src/ui/conformance.test.ts:71`. Adding a ninth webview fails all three until the lists are updated.
- `scripts/copy-assets.mjs` carries an explicit `assets` array of webview HTML paths. A new webview not listed there is missing from `dist/` at runtime.
- `package.json` `contributes.commands` lists commands such as `karst.openTokenUsage` (line 106).
- `src/ui/depsIndicator.ts` is the pattern for status bar text: a pure builder returning `{ text, tooltip } | null`, with the `vscode` binding kept in `extension.ts` (`createStatusBarItem` at lines 1224, 2404, 2440).
- `src/extension.ts` already runs `setInterval` timers (`prSyncTimer` line 3008, `agyWatchTimer` line 3099) — the precedent for a background lane.
- `src/agent/headlessSpawn.ts` exports `spawnHeadlessCli(...)` and has `child.pid` in hand at line 114; it currently reports the pid only to `onDebug`.
- `src/ui/terminalIdentity.ts` persists `SessionTerminalRecord`s (pid per launch) in `workspaceState` under `karst.sessionTerminals`, exposed via `parseSessionTerminalRecords(raw)`.

Measured on the target machine during planning (these are the perf facts the design rests on):

| Probe | Cost |
|---|---|
| `ps -Ao ...` over ALL processes | 20–30 ms, in a child process (host event loop untouched) |
| `ps -p <10 pids>` | 10 ms — no cheaper than the full scan, and misses children |
| `du -sk` on one worktree | 65–90 ms warm; the repo currently has **100 worktrees** under `.karst/worktrees/` |

## Target State

- `runtime/resourceMonitor.ts` runs a **slow lane** every 30 s for the lifetime of the window and a **fast lane** every 2 s only while the Resources panel is visible.
- Each tick is ONE `ps` child process. CPU% is derived from the DELTA of cumulative CPU seconds between consecutive samples — never `ps %cpu`, which is a lifetime average on Linux.
- Every sample is classified into three lanes: **attributed** (a `servers` row whose pid `attributeServer` says is still ours, rolled up over its whole process tree), **unattributed** (top 5 by RSS from the same snapshot, machine-wide, labelled unknown), and **waste** (a closed set of PROVEN conditions).
- Status bar shows a meter, and turns amber naming a count when waste is found. Click opens the Resources panel.
- The Resources panel renders: a 5-minute CPU/RSS sparkline, an attributed table (ticket / repo / pid / CPU / RSS / uptime), the unattributed top-5, the waste list with a Kill action, and a disk lane populated only while the panel is open.
- Nothing is persisted. State is an in-memory ring buffer of 150 samples, dropped when the window closes.
- Windows is UNSUPPORTED: `ps` does not exist there. The monitor reports unsupported, the status bar stays hidden, and the panel renders one explanatory line.

## Scope

### In Scope

- New modules under `src/runtime/` (`procSnapshot.ts`, `procTreeCost.ts`, `resourceInventory.ts`, `wasteFindings.ts`, `resourceMonitor.ts`, `worktreeDisk.ts`).
- New store read module `src/store/runningServers.ts` (SELECT only).
- New webview `src/ui/resources/` (panel, state, messages, HTML) modelled on `src/ui/usage/`.
- New pure status-bar builder `src/ui/resourceStatus.ts`.
- `extension.ts` wiring, `package.json` command + timers, `copy-assets.mjs`, and the three hardcoded webview lists.
- Colocated vitest suites for each new module.

### Out of Scope

- Any schema change, migration, or `SCHEMA_VERSION` bump. **No table is added.**
- Persisting samples across window reloads or sharing them between windows.
- Changing `reapStaleServers`, `stopServersUnder`, `attributeServer`, or `killTree` behavior. The monitor CALLS them; it does not modify them.
- Changing `spawnHeadlessCli`'s spawn/kill/timeout semantics. Task 7 adds an optional notification callback only.
- Token/cost accounting — `token_usage` and the Usage panel are untouched.
- Windows support.
- Automatic killing. Every kill is a user click.

## Key Decisions

1. **CPU% is derived, not read.** `ps` `%cpu` is a lifetime average on Linux and a decayed average on macOS — useless for "what is burning my CPU right now". The snapshot reads cumulative CPU seconds (`time=`) instead, and `cpuPct` is `(cpuSeconds₂ − cpuSeconds₁) / (wallSeconds₂ − wallSeconds₁) × 100`. The FIRST sample after start has no predecessor, so its `cpuPct` is `null` and renders as `—`. A `null` is never coerced to `0`, which would read as a measured idle process.
2. **One `ps` per tick, no per-pid probes on the hot path.** Command: `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=`. `lstart` is exactly 5 whitespace-separated tokens on both BSD and GNU ps (`Tue Aug 12 10:33:21 2026`); `comm` is everything after it. `rss` is KiB on both and is multiplied by 1024 into bytes.
3. **Process trees are rolled up from the snapshot's own ppid index** — no extra spawn. A `npm run dev` leader's cost is the sum over its descendants, which is where the cost actually lives.
4. **Attribution is never cached across a kill.** The panel's Kill re-runs `attributeServer` with fresh async probes immediately before signalling. A sample can be up to 30 s old, and a stale sample must never signal a reissued pid.
5. **Waste is a closed set of three conditions**, all provable from evidence karst already holds:
   - `worktree-gone`: an attributed server whose recorded `cwd` no longer exists AND whose PARENT directory still exists (an unmounted volume is not a deletion — the rule `reapStaleServers` already uses).
   - `ticket-finished`: an attributed server whose ticket is at stage `done` or is archived.
   - `orphan-worktree-process`: an UNATTRIBUTED process whose confirmed live cwd is under a known worktree root and which matches no running `servers` row.
   Nothing else is waste. Busy CPU is not waste — a real `npm test` should peg a core.
6. **Only `worktree-gone` and `ticket-finished` are killable.** They have a `servers` row, so `attributeServer` can produce evidence. `orphan-worktree-process` is REPORT-ONLY: it has no recorded start time, so the strongest available evidence is a cwd match, and the blast radius of a wrong answer is a whole process group.
7. **cwd confirmation is bounded and slow-lane only.** On macOS a cwd probe is `lsof -p <pid>` at 30–80 ms each. At most 3 probes per slow tick, only for unattributed processes over `HEAVY_RSS_BYTES` (300 MiB) or over `HEAVY_CPU_PCT` (25). Never on the fast lane.
8. **Disk runs only while the panel is open**, one worktree at a time, results cached 60 minutes. 100 worktrees × ~70 ms warm cannot ride a 2 s timer, and a background disk lane would be pure cost for a question nobody asked.
9. **Every window samples independently; display is scoped to the window's project.** Rejected an elected-sampler lease (stale lease, dead holder, split brain — more failure modes than a 25 ms `ps` costs). The unattributed lane is machine-wide because an orphan belongs to no project; only attributed rows of the window's own project are killable.
10. **`baseline` servers (`ticket_id IS NULL`) are never waste.** A shared singleton keyed to the repository checkout is not a removable worktree — the exclusion `reapStaleServers` already makes.
11. **Single-flight per lane.** A tick never overlaps its predecessor; if the previous `ps` has not settled, the tick is skipped and counted.
12. **Windows is explicitly unsupported**, reported as a state, not a failure. `procSnapshot` returns `{ supported: false }` on `win32`.

---

## Execution Order

### Task 1: Implement the process snapshot reader — DONE

`src/runtime/procSnapshot.ts` and `src/runtime/procSnapshot.test.ts` are committed and passing.

#### Objective

One async `ps` invocation produces a parsed, typed snapshot of every process on the machine, with a ppid index. Pure parsing is separated from the spawn so it is testable without a machine.

#### Files

- `src/runtime/procSnapshot.ts` — created. The snapshot reader and its parser.
- `src/runtime/procSnapshot.test.ts` — created. Parser tests over VERBATIM `ps` output.

#### Implementation

1. Export the types:

```ts
export interface ProcRecord {
  pid: number;
  ppid: number;
  /** Resident set size in BYTES (ps reports KiB; converted here). */
  rssBytes: number;
  /** Cumulative CPU time consumed since the process started, in seconds. */
  cpuSeconds: number;
  /** Process start time, epoch ms, or null when `lstart` did not parse. */
  startedMs: number | null;
  /** Executable name as ps reports it (`comm`), never a full command line. */
  comm: string;
}

export interface ProcSnapshot {
  /** Wall clock at which the snapshot was taken, epoch ms. */
  takenMs: number;
  records: ReadonlyMap<number, ProcRecord>;
  /** pid -> its direct children's pids. */
  children: ReadonlyMap<number, readonly number[]>;
}
```

2. Export `parseCpuTime(value: string): number | null`. Accepts `ps` `time` format: `MM:SS.ss`, `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS`. Split on `-` for the optional day part, then on `:`. Returns total seconds as a float. Any component that is not a finite number returns `null` — a malformed field is dropped, never coerced to 0.

3. Export `parseProcTable(stdout: string, takenMs: number): ProcSnapshot`. For each non-empty line: split on runs of whitespace, `trim()` first. Token layout is fixed — `[0]=pid`, `[1]=ppid`, `[2]=rss`, `[3]=time`, `[4..8]=lstart` (exactly 5 tokens), `[9..]=comm` (joined with a single space). A line with fewer than 10 tokens is SKIPPED. `pid`/`ppid`/`rss` must parse as non-negative integers or the line is skipped. `cpuSeconds` comes from `parseCpuTime`; `null` skips the line. `startedMs` is `Date.parse(tokens.slice(4,9).join(' '))`, `null` when `NaN` (kept — start time is optional, unlike the others). Build `children` by appending each record's pid to `children.get(ppid)`.

4. Export the reader:

```ts
export type ProcSnapshotResult =
  | { supported: false }
  | { supported: true; snapshot: ProcSnapshot | null };

export async function readProcSnapshot(
  now: () => number = Date.now,
  platform: NodeJS.Platform = process.platform,
  run: typeof commandOutput = commandOutput,
): Promise<ProcSnapshotResult>;
```

`platform === 'win32'` returns `{ supported: false }` without spawning. Otherwise call `run('ps', ['-Ao', 'pid=,ppid=,rss=,time=,lstart=,comm='], PROC_SNAPSHOT_TIMEOUT_MS)`. A `null` return (spawn failure, non-zero exit, timeout) yields `{ supported: true, snapshot: null }` — "the OS did not answer this time", which the caller must render as unknown, never as zero usage.

5. Export `export const PROC_SNAPSHOT_TIMEOUT_MS = 5_000;`.

#### Constraints

- Import ONLY `commandOutput` from `./asyncProcess.js`. Do not import `node:child_process` directly, and never `spawnSync` — the extension-host event loop must stay free.
- Do not read `ps %cpu`. Do not add fields to the `-o` format beyond the six specified.
- No `vscode` import.

#### Edge Cases

- Empty stdout → a snapshot with empty maps, not `null`. `ps` answered; it just matched nothing (only reachable in tests).
- A `comm` containing spaces (e.g. `Google Chrome Helper`) → joined back with single spaces; parsing must not fail.
- A process that exits between two lines being written → nothing special; it simply is not in the next snapshot.
- `lstart` unparseable → `startedMs: null`, record KEPT.
- `rss` of `0` (kernel threads on Linux) → kept as `0`; it is a real measurement.

#### Verification

```bash
npx vitest run src/runtime/procSnapshot.test.ts
```

Test cases required:
- parses a verbatim 3-line macOS `ps -Ao pid=,ppid=,rss=,time=,lstart=,comm=` sample (paste real output captured with that exact command) into 3 records with the right pids, byte-converted RSS, and second-resolution `cpuSeconds`.
- parses a verbatim GNU/Linux sample of the same command.
- `parseCpuTime` covers `'0:00.42'`, `'12:03'`, `'1:02:03'`, `'2-03:04:05'`, and returns `null` for `'abc'`.
- a `comm` with spaces round-trips.
- a short line (9 tokens) is skipped and does not throw.
- an unparseable `lstart` keeps the record with `startedMs === null`.
- `children` maps a parent pid to both of its children.
- `readProcSnapshot` with `platform: 'win32'` returns `{ supported: false }` and the injected `run` is NEVER called.
- `readProcSnapshot` with a `run` resolving `null` returns `{ supported: true, snapshot: null }`.

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/procSnapshot.ts` exports `ProcRecord`, `ProcSnapshot`, `ProcSnapshotResult`, `PROC_SNAPSHOT_TIMEOUT_MS`, `parseCpuTime`, `parseProcTable`, `readProcSnapshot`.
- [ ] No `spawnSync` and no direct `node:child_process` import in the file.
- [ ] All listed test cases exist and pass.

---

### Task 2: Implement process-tree cost roll-up and CPU delta

#### Objective

Turn two consecutive snapshots into per-leader cost: the summed RSS of a whole process group and its instantaneous CPU%, derived from the CPU-seconds delta.

#### Files

- `src/runtime/procTreeCost.ts` — created.
- `src/runtime/procTreeCost.test.ts` — created.

#### Implementation

1. Types:

```ts
export interface TreeCost {
  /** The leader pid the cost is attributed to. */
  pid: number;
  /** Summed RSS of the leader and every descendant, in bytes. */
  rssBytes: number;
  /**
   * Instantaneous CPU across the tree, percent of one core (may exceed 100 for
   * a multi-threaded tree). NULL when no previous snapshot covers this tree —
   * "not measured yet", never 0.
   */
  cpuPct: number | null;
  /** Number of processes in the tree, including the leader. */
  procCount: number;
  /** Leader's start time, epoch ms, or null. */
  startedMs: number | null;
}
```

2. Export `collectTree(snapshot: ProcSnapshot, leader: number): ProcRecord[]` — breadth-first over `snapshot.children` starting at `leader`, including the leader's own record. A pid already visited is not revisited (guards a malformed cycle). Returns `[]` when the leader is absent from `snapshot.records`.

3. Export:

```ts
export function treeCost(
  snapshot: ProcSnapshot,
  previous: ProcSnapshot | null,
  leader: number,
): TreeCost | null;
```

Returns `null` when `collectTree` is empty (the leader is gone). Otherwise `rssBytes` is the sum over the tree; `procCount` its length; `startedMs` the leader's.

`cpuPct`: `null` when `previous` is `null`, when the wall delta `(snapshot.takenMs - previous.takenMs)` is `<= 0`, or when NONE of the tree's pids appear in `previous.records`. Otherwise sum `cpuSeconds` over the CURRENT tree members that ALSO exist in `previous.records` **with the same `startedMs`** (a pid whose start time changed is a different process — its cumulative counter must not be differenced against another process's), subtract the matching sum from `previous`, divide by wall-delta seconds, multiply by 100. A negative result is clamped to `0` (a counter that went backwards means processes left the tree; report idle, not a negative rate).

4. Export `export function sumCosts(costs: readonly TreeCost[]): { rssBytes: number; cpuPct: number | null }` — `cpuPct` is `null` only when EVERY input is `null`; otherwise the sum treats `null` as `0` (a tree that is not yet measured contributes nothing rather than voiding the total).

#### Constraints

- Pure functions only. No I/O, no clock, no imports beyond `./procSnapshot.js` types.
- Do not change `procSnapshot.ts`.

#### Edge Cases

- Leader absent from the current snapshot → `null` (caller reads this as "gone").
- Leader present, no children → tree of 1.
- A descendant that appeared since the previous snapshot → contributes RSS but not CPU delta (it has no previous entry).
- A pid present in both snapshots with a DIFFERENT `startedMs` → excluded from the CPU delta on both sides.
- A cyclic ppid table → terminates via the visited set.
- Zero wall delta (two snapshots in the same millisecond) → `cpuPct: null`.

#### Verification

```bash
npx vitest run src/runtime/procTreeCost.test.ts
```

Test cases required: leader-plus-two-children RSS sum; `cpuPct` null on first snapshot; a 1 s wall gap with 0.5 CPU-seconds consumed yielding `50`; a 1 s gap with 2.0 CPU-seconds across a 4-process tree yielding `200`; a pid reused with a different `startedMs` excluded from the delta; a counter that went backwards clamped to `0`; missing leader → `null`; a cycle terminates; `sumCosts` returns `null` only when all inputs are `null`.

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/procTreeCost.ts` exports `TreeCost`, `collectTree`, `treeCost`, `sumCosts`.
- [ ] `cpuPct` is `null`, never `0`, when unmeasured. A test asserts this explicitly.
- [ ] All listed test cases exist and pass.

---

### Task 3: Add the running-servers store read

#### Objective

A project-scopable, SELECT-only read of every running server row plus the lifecycle facts the waste rules need, so no consumer writes raw SQL.

#### Files

- `src/store/runningServers.ts` — created.
- `src/store/runningServers.test.ts` — created.

#### Implementation

1. Types and reads:

```ts
export interface RunningServerRow {
  id: number;
  ticketId: number | null;
  repo: string;
  pid: number | null;
  cwd: string | null;
  startedAt: string | null;
  host: string | null;
  port: number | null;
}

export function listRunningServers(store: Store, projectId?: number): RunningServerRow[];
```

Query: `SELECT s.id, s.ticket_id, s.repo, s.pid, s.cwd, s.started_at, s.host, s.port FROM servers s WHERE s.status = 'running'`. When `projectId` is provided, append `AND (s.ticket_id IS NULL OR s.ticket_id IN (SELECT id FROM tickets WHERE project_id = ?))` and bind it. `ORDER BY s.id`. Baseline rows (`ticket_id IS NULL`) are always included — they belong to the repository checkout, not to a project's ticket.

2. Lifecycle read:

```ts
export interface TicketLifecycle {
  id: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  archived: boolean;
}

export function listTicketLifecycle(store: Store, ids: readonly number[]): Map<number, TicketLifecycle>;
```

Returns an empty map for an empty `ids` array WITHOUT querying. Otherwise `SELECT id, key, title, stage_current, archived_at FROM tickets WHERE id IN (<n placeholders>)`, built by generating exactly `ids.length` `?` placeholders and binding positionally. `archived` is `archived_at IS NOT NULL`.

Before writing the query, confirm the actual column names on `tickets` with `grep -n "archived" src/store/schema.sql`; if the archive marker is not `archived_at`, use the real column and keep the boolean semantics. This is the one lookup in the plan whose column name must be confirmed against the file.

#### Constraints

- SELECT only. This module must never contain `INSERT`, `UPDATE`, or `DELETE`.
- Positional `?` binding only — never string interpolation of a value.
- Do not modify `src/store/schema.sql`, `src/store/migrations.ts`, or `SCHEMA_VERSION`. **No schema change is part of this plan.**
- Do not modify `src/runtime/worktreeServers.ts`'s existing inline query.

#### Edge Cases

- `projectId` undefined → all projects (the deliberate recovery-style view; the monitor always passes one).
- A running row with `pid IS NULL` → returned as-is; the inventory treats a null pid as unattributable.
- `listTicketLifecycle` with ids that do not exist → simply absent from the map.
- Baseline rows have `ticketId === null` and never appear in the lifecycle map.

#### Verification

```bash
npx vitest run src/store/runningServers.test.ts
```

Test cases required (use `openStore(':memory:')` as the existing store suites do): only `status='running'` rows are returned; a stopped row is excluded; a baseline row survives project scoping; a row belonging to another project is excluded when `projectId` is passed; `listTicketLifecycle([])` returns an empty map and does not throw; an archived ticket reports `archived: true`.

Expected: all pass.

#### Completion Criteria

- [ ] `src/store/runningServers.ts` exports `RunningServerRow`, `listRunningServers`, `TicketLifecycle`, `listTicketLifecycle`.
- [ ] `grep -nE "INSERT|UPDATE|DELETE" src/store/runningServers.ts` returns nothing.
- [ ] `git diff --name-only` shows no change to `schema.sql` or `migrations.ts`.
- [ ] All listed test cases exist and pass.

---

### Task 4: Implement the resource inventory

#### Objective

Turn one snapshot plus the known-pid sources into the three lanes: attributed rows, unattributed heavy hitters, and the bounded cwd confirmations that the waste rules need.

#### Files

- `src/runtime/resourceInventory.ts` — created.
- `src/runtime/resourceInventory.test.ts` — created.

#### Implementation

1. Input and output types:

```ts
/** A pid karst believes it started, and what it belongs to. */
export interface KnownPid {
  pid: number;
  kind: 'server' | 'agent' | 'gate' | 'session';
  ticketId: number | null;
  /** Repository name for a server; the call site label for an agent/gate; null for a session. */
  label: string | null;
  /** Only servers carry an identity row; other kinds are trusted by construction. */
  identity?: ServerIdentity;
  /** `servers.id`, present only for `kind: 'server'` — what a Kill acts on. */
  serverId?: number;
}

export interface AttributedRow {
  pid: number;
  kind: KnownPid['kind'];
  ticketId: number | null;
  label: string | null;
  serverId: number | null;
  attribution: Attribution;
  cost: TreeCost | null;
  cwd: string | null;
  comm: string;
}

export interface UnattributedRow {
  pid: number;
  comm: string;
  cost: TreeCost;
  /** Confirmed live cwd, when a bounded probe was spent on it. */
  cwd: string | null;
  /** The live directory was removed out from under the process. */
  cwdDeleted: boolean;
}

export interface Inventory {
  takenMs: number;
  attributed: AttributedRow[];
  unattributed: UnattributedRow[];
  /** Sum across attributed rows only — karst's own footprint. */
  totals: { rssBytes: number; cpuPct: number | null };
}
```

2. Constants:

```ts
export const UNATTRIBUTED_TOP_N = 5;
export const HEAVY_RSS_BYTES = 300 * 1024 * 1024;
export const HEAVY_CPU_PCT = 25;
export const MAX_CWD_PROBES_PER_TICK = 3;
```

3. The builder:

```ts
export async function buildInventory(opts: {
  snapshot: ProcSnapshot;
  previous: ProcSnapshot | null;
  known: readonly KnownPid[];
  facts: ProcessFactsSource;
  /** Probe live cwds for heavy unknowns. False on the fast lane. */
  confirmCwd: boolean;
  debug?: (message: string) => void;
}): Promise<Inventory>;
```

Steps, in order:

  a. For each `KnownPid`: compute `cost = treeCost(snapshot, previous, pid)`. When `identity` is present, resolve `attribution` by awaiting each of `facts.isAlive`, `facts.liveCwd`, `facts.processStartMs` for that pid and applying the SAME rule `attributeServer` encodes. **Do not duplicate that rule** — call `attributeServer(identity, resolved)` where `resolved` is a `ProcessFacts` built from the three awaited values (`{ isAlive: () => aliveValue, liveCwd: () => cwdValue, processStartMs: () => startValue }`). This is the one adapter that turns async probes into the sync shape `attributeServer` requires; it exists so the attribution rule has exactly one implementation. When `identity` is absent, `attribution` is `'attributable'` if the pid is in `snapshot.records`, else `'dead'`.

  b. Collect the pid set covered by every attributed TREE (`collectTree` for each known pid) — a child of a known server must never also appear as an unattributed heavy hitter.

  c. Unattributed candidates: every record in `snapshot` whose pid is not in that covered set AND whose pid is not `process.pid` and not `1`. Compute `treeCost` for each candidate that is a tree ROOT among the candidates (its ppid is not itself a candidate), so a tree is counted once at its top. Sort by `rssBytes` descending, take `UNATTRIBUTED_TOP_N`.

  d. When `confirmCwd` is true: for at most `MAX_CWD_PROBES_PER_TICK` of those rows, in sort order, that exceed `HEAVY_RSS_BYTES` or whose `cpuPct` exceeds `HEAVY_CPU_PCT`, `await facts.liveCwd(pid)` and record `cwd`/`cwdDeleted`. Others keep `cwd: null, cwdDeleted: false`.

  e. `totals` is `sumCosts` over the attributed rows' non-null costs.

  f. Emit `debug` lines at entry (`[resources] inventory: N known pids, M processes`), at the cwd-probe decision (`[resources] cwd probe: pid X (rss …)`), and at exit (`[resources] inventory: A attributed, U unattributed, totals …`).

#### Constraints

- Do not re-implement the attribution rule. `attributeServer` from `./serverIdentity.js` is the only decider.
- Do not call `killTree` or any mutating function from this module. The inventory OBSERVES.
- No `vscode` import; `debug` is an injected callback per the debug-logging rules.
- Do not add a cwd probe on the fast lane — `confirmCwd` is the switch and the caller owns it.

#### Edge Cases

- A known pid absent from the snapshot → `cost: null`, `attribution: 'dead'` when there is no identity, or whatever `attributeServer` says when there is.
- A known pid of `null`/`0`/negative → skipped before any probe (`attributeServer` already returns `'unknown'` for these; do not spawn a probe for them).
- Two `KnownPid`s with the same pid → deduplicate by pid, keeping the first; a duplicate must not double-count RSS in `totals`.
- Fewer than `UNATTRIBUTED_TOP_N` candidates → return what exists.
- `facts.liveCwd` returning `null` → `cwd: null`; "the OS will not say" is not evidence.
- `previous === null` → every `cpuPct` is `null` and `totals.cpuPct` is `null`.

#### Verification

```bash
npx vitest run src/runtime/resourceInventory.test.ts
```

Test cases required: an attributed server rolls up its children's RSS; a child of a known server never appears in the unattributed lane; the unattributed lane is capped at 5 and sorted by RSS desc; `confirmCwd: false` spends ZERO `liveCwd` probes (assert the fake's call count is 0); `confirmCwd: true` spends at most 3 and only on rows over the thresholds; a duplicate pid in `known` is counted once; a known pid missing from the snapshot yields `cost: null`; `previous: null` yields `totals.cpuPct === null`.

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/resourceInventory.ts` exports the four types, the four constants, and `buildInventory`.
- [ ] `grep -n "killTree\|INSERT\|UPDATE" src/runtime/resourceInventory.ts` returns nothing.
- [ ] The zero-probe assertion for `confirmCwd: false` exists and passes.
- [ ] All listed test cases exist and pass.

---

### Task 5: Implement the waste findings rule

#### Objective

Name only resources karst can PROVE are leaked, with a wording and a killability flag per finding.

#### Files

- `src/runtime/wasteFindings.ts` — created.
- `src/runtime/wasteFindings.test.ts` — created.

#### Implementation

1. Types:

```ts
export type WasteKind = 'worktree-gone' | 'ticket-finished' | 'orphan-worktree-process';

export interface WasteFinding {
  kind: WasteKind;
  pid: number;
  /** `servers.id` when the finding has a row to act on; null for an orphan. */
  serverId: number | null;
  ticketId: number | null;
  /** One line naming what is wasted and why it is provably waste. */
  reason: string;
  rssBytes: number;
  /** Only findings with a `servers` row may be signalled (Key Decision 6). */
  killable: boolean;
}

export interface DirectoryProbe {
  exists(path: string): boolean;
}
```

2. The rule:

```ts
export function findWaste(opts: {
  inventory: Inventory;
  servers: readonly RunningServerRow[];
  lifecycle: ReadonlyMap<number, TicketLifecycle>;
  /** Roots under which a process is considered to be inside a karst worktree. */
  worktreeRoots: readonly string[];
  dirs: DirectoryProbe;
}): WasteFinding[];
```

  a. **`worktree-gone`** — for each attributed row with `serverId !== null`, `ticketId !== null` (baseline rows are exempt, Key Decision 10), `attribution === 'attributable'`, and a non-null recorded `cwd` on its `RunningServerRow`: when `dirs.exists(cwd) === false` AND `dirs.exists(dirname(cwd)) === true`, emit with `killable: true`. Reason: `` `${repo} server still running in a worktree that no longer exists (${cwd})` ``.

  b. **`ticket-finished`** — for each attributed row with `serverId !== null` and a `ticketId` whose lifecycle says `stageCurrent === 'done'` or `archived === true`: emit with `killable: true`. Reason: `` `${repo} server still running for ${archived ? 'an archived' : 'a completed'} ticket ${key ?? id}` ``.

  c. **`orphan-worktree-process`** — for each unattributed row with a CONFIRMED `cwd` that `isPathUnder(cwd, root)` for some root in `worktreeRoots`, and whose pid matches no `servers` row's pid: emit with `serverId: null`, `ticketId: null`, `killable: false`. Reason: `` `unattributed ${comm} (pid ${pid}) running inside a karst worktree${cwdDeleted ? ' that has been deleted' : ''}` ``.

  d. A pid may produce at most ONE finding. Precedence: `worktree-gone` > `ticket-finished` > `orphan-worktree-process`.

3. Export `export function describeWaste(f: WasteFinding): string` — `` `${f.reason} — ${formatBytes(f.rssBytes)}` ``. Implement a local `formatBytes` (bytes → `MB`/`GB`, one decimal); do not add a dependency for it.

#### Constraints

- Use `isPathUnder` from `./pathScope.js` for containment — never `startsWith`. Slug disambiguation makes `…/abc-2` a real sibling of `…/abc`.
- Never emit a finding for a baseline server (`ticketId === null`).
- Never set `killable: true` on `orphan-worktree-process`.
- Pure — `dirs` is injected so the rule is testable without a filesystem.

#### Edge Cases

- `cwd` missing AND its parent missing → NOT waste (an unmounted volume takes the parent with it; absence is not proof of deletion).
- `attribution` of `'foreign'`, `'unknown'`, or `'dead'` → never a finding. Only `'attributable'` rows can be waste.
- A ticket id with no lifecycle entry → not `ticket-finished` (unknown is not finished).
- An unattributed row whose `cwd` was never confirmed (`null`) → never a finding. An unprobed process is not accused.
- `worktreeRoots` empty → no `orphan-worktree-process` findings.
- The same pid qualifying for two kinds → one finding, by the stated precedence.

#### Verification

```bash
npx vitest run src/runtime/wasteFindings.test.ts
```

Test cases required: a deleted worktree with a surviving parent is `worktree-gone` and killable; a deleted worktree whose PARENT is also gone yields NOTHING (regression: unmounted volume); a baseline server in a deleted worktree yields nothing; a `done` ticket's server is `ticket-finished`; an archived ticket's server is `ticket-finished`; a `foreign` attribution never produces a finding; an unattributed process under a worktree root with a confirmed cwd is `orphan-worktree-process` with `killable === false`; an unattributed process with `cwd: null` produces nothing; a sibling path `…/abc-2` is not reported under root `…/abc`; a pid qualifying for two kinds produces exactly one finding.

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/wasteFindings.ts` exports `WasteKind`, `WasteFinding`, `DirectoryProbe`, `findWaste`, `describeWaste`.
- [ ] `grep -n "startsWith" src/runtime/wasteFindings.ts` returns nothing.
- [ ] No finding is ever emitted for a baseline server; a test asserts it.
- [ ] All listed test cases exist and pass.

---

### Task 6: Implement the worktree disk lane

#### Objective

Measure worktree disk usage one directory at a time, abortably, with a one-hour cache, so the 100-worktree cost never lands on a timer.

#### Files

- `src/runtime/worktreeDisk.ts` — created.
- `src/runtime/worktreeDisk.test.ts` — created.

#### Implementation

1. Types and constants:

```ts
export interface DiskUsage {
  path: string;
  bytes: number;
  measuredMs: number;
}
export const DISK_CACHE_TTL_MS = 60 * 60 * 1_000;
export const DISK_PROBE_TIMEOUT_MS = 30_000;
```

2. `export class WorktreeDiskCache` with:
   - `constructor(now: () => number = Date.now, run: typeof commandOutput = commandOutput)`.
   - `get(path: string): DiskUsage | undefined` — cached value, or `undefined` when absent or older than `DISK_CACHE_TTL_MS`.
   - `measure(path: string, signal?: AbortSignal): Promise<DiskUsage | null>` — returns the cached value when fresh WITHOUT spawning. Otherwise runs `run('du', ['-sk', path], DISK_PROBE_TIMEOUT_MS)`, parses the leading integer of the first line as KiB, converts to bytes, caches, returns. A `null` from `run`, unparseable output, or an already-aborted signal returns `null` and caches NOTHING.
   - `measureAll(paths: readonly string[], signal: AbortSignal, onEach: (u: DiskUsage) => void): Promise<void>` — awaits `measure` for each path **strictly sequentially**, calling `onEach` after each success, and returns early the moment `signal.aborted` is true. Sequential is required: parallel `du` over 100 worktrees is a disk-thrash storm.

#### Constraints

- Only `commandOutput` for the spawn. No `spawnSync`, no `node:child_process`.
- Never call `measureAll` from a timer in this module — scheduling belongs to Task 7.
- No `vscode` import.

#### Edge Cases

- `du` writing to stderr for unreadable subdirectories → `commandOutput` ignores stderr and returns non-null only on exit 0; a non-zero exit yields `null` (report nothing rather than a partial size stated as a total).
- Abort mid-list → the already-measured entries stay cached; the rest are simply not measured.
- The same path requested twice within the TTL → exactly one spawn. A test asserts the injected `run` was called once.
- Empty `paths` → resolves immediately, `onEach` never called.

#### Verification

```bash
npx vitest run src/runtime/worktreeDisk.test.ts
```

Test cases required: `'145412\t/path\n'` parses to `145412 * 1024` bytes; a second `measure` within the TTL spawns zero times; a `measure` after the TTL spawns again; `run` returning `null` yields `null` and caches nothing; `measureAll` calls `onEach` once per path in order; an abort part-way stops further spawns (assert the call count).

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/worktreeDisk.ts` exports `DiskUsage`, `DISK_CACHE_TTL_MS`, `DISK_PROBE_TIMEOUT_MS`, `WorktreeDiskCache`.
- [ ] The sequential guarantee and the abort early-return are covered by tests.
- [ ] All listed test cases exist and pass.

---

### Task 7: Implement the resource monitor (lane scheduler and live pid registry)

#### Objective

The single host-agnostic object that owns the two sampling lanes, the ring buffer, the live pid registry, and the kill path. Everything above it is pure; everything below it is `vscode`.

#### Files

- `src/runtime/resourceMonitor.ts` — created.
- `src/runtime/resourceMonitor.test.ts` — created.

#### Implementation

1. Constants:

```ts
export const SLOW_LANE_INTERVAL_MS = 30_000;
export const FAST_LANE_INTERVAL_MS = 2_000;
export const RING_CAPACITY = 150;
```

2. Sample and deps:

```ts
export interface ResourceSample {
  takenMs: number;
  totals: { rssBytes: number; cpuPct: number | null };
}

export interface ResourceReading {
  supported: boolean;
  /** True when the last tick's `ps` did not answer. */
  degraded: boolean;
  inventory: Inventory | null;
  waste: WasteFinding[];
  history: readonly ResourceSample[];
}

export interface ResourceMonitorDeps {
  store: Store;
  projectId: () => number | undefined;
  /** Roots under which a process counts as inside a karst worktree. */
  worktreeRoots: () => string[];
  facts?: ProcessFactsSource;
  dirs?: DirectoryProbe;
  now?: () => number;
  readSnapshot?: typeof readProcSnapshot;
  debug?: (message: string) => void;
  logError?: LogError;
}
```

3. `export class ResourceMonitor`:

   - `registerPid(entry: KnownPid): () => void` — adds a live non-server pid (agent, gate, session) to an internal `Map<number, KnownPid>` and returns a disposer that removes it. Server pids are NOT registered here; they are read from the store every tick, because a server outlives the call that started it.
   - `start(): void` / `dispose(): void` — owns the slow-lane `setInterval` (`.unref()` is NOT used; `dispose` clears it). `start` is idempotent.
   - `setPanelVisible(visible: boolean): void` — starts the fast-lane interval when true, clears it when false. Idempotent in both directions.
   - `onReading(listener: (r: ResourceReading) => void): () => void` — subscribe; returns an unsubscriber. Every completed tick notifies every listener.
   - `reading(): ResourceReading` — the current value, for a listener that subscribes late.
   - `refreshNow(): Promise<void>` — force one slow-lane tick (used on panel open, so the panel is not blank for up to 30 s).
   - `kill(serverId: number): Promise<KillOutcome | 'not-attributable'>` — the ONLY mutating method. It (1) re-reads the `servers` row via `listRunningServers`, (2) re-resolves attribution with FRESH async probes exactly as Task 4 step (a) does, (3) returns `'not-attributable'` without signalling unless the result is `'attributable'`, (4) otherwise calls `killTree(pid)` and returns its outcome. On `'denied'` it leaves the row untouched (still `running`, truthfully); on `'killed'` it calls the existing `markServerStopped(store, id)` from `src/runtime/supervisor.ts`. It never touches a row for a `'denied'` or `'not-attributable'` result.

4. A tick (`private async tick(confirmCwd: boolean)`):

   - Single-flight: if a tick is in flight, increment a skipped counter, emit a `debug` line, and return.
   - `readSnapshot()`. `{ supported: false }` → set `supported: false`, clear the interval(s), notify once, and never tick again. `snapshot: null` → set `degraded: true`, keep the previous reading's inventory, notify, return.
   - Build `known` from `listRunningServers(store, projectId())` (`kind: 'server'`, `identity` from `{pid, cwd, startedAt}`, `serverId: row.id`) plus every entry in the registry.
   - `buildInventory({ snapshot, previous, known, facts, confirmCwd, debug })`.
   - `findWaste({ inventory, servers, lifecycle: listTicketLifecycle(store, ticketIds), worktreeRoots: worktreeRoots(), dirs })`.
   - Push `{ takenMs, totals }` onto the ring (drop the oldest past `RING_CAPACITY`), store `snapshot` as `previous`, notify listeners.
   - The WHOLE tick body is wrapped in `try/catch`: a throw is passed to `logError` and the previous reading is retained. A monitoring defect may never break the window.
   - `confirmCwd` is `true` on the slow lane and `false` on the fast lane.

5. Debug lines use the `[resources]` prefix at entry, at the lane decision, and at exit, per the project's debug-logging rules.

6. Wire the pid registry into the headless spawner: in `src/agent/headlessSpawn.ts`, add an OPTIONAL `onSpawned?: (pid: number) => (() => void) | void` to `HeadlessSpawnOptions`. Immediately after the child is created and `child.pid` is known (the existing `onDebug` line at ~114), call it when defined and both `child.pid !== undefined`; retain the returned disposer and invoke it in the SAME place the promise settles (success, abort, and timeout paths alike), so a registration can never outlive its process. Change nothing else in that file — not the spawn options, not the kill logic, not the timeouts.

#### Constraints

- No `vscode` import. Every host fact arrives through `ResourceMonitorDeps`.
- Do not modify `attributeServer`, `killTree`, `reapStaleServers`, `stopServersUnder`, or `markServerStopped`. Call them.
- `spawnHeadlessCli`'s existing behavior must be byte-for-byte unchanged apart from the optional callback: same spawn options, same `killTree` on abort/timeout, same rejection wording.
- The monitor writes NOTHING to the store except through `markServerStopped` on a confirmed kill.

#### Edge Cases

- `dispose()` during an in-flight tick → the tick completes and its notification is suppressed (guard on a `disposed` flag before notifying).
- `setPanelVisible(true)` on an unsupported platform → no interval is created.
- Both lanes due in the same instant → single-flight means the second is skipped, not queued.
- A listener that throws → caught per listener so one bad subscriber cannot stop the others; reported via `logError`.
- `projectId()` returning `undefined` (binding not complete) → `listRunningServers` is called unscoped for that tick; this is a transient activation state, not an error.
- `kill` for a `serverId` whose row is gone → `'not-attributable'`, no signal.

#### Verification

```bash
npx vitest run src/runtime/resourceMonitor.test.ts src/agent/headlessSpawn.test.ts
```

Test cases required (all with fake timers, an injected `readSnapshot`, and an in-memory store): the slow lane ticks at 30 s and the fast lane at 2 s only after `setPanelVisible(true)`; `setPanelVisible(false)` stops the fast lane; `confirmCwd` is `true` on the slow lane and `false` on the fast lane (assert via a spy on the injected `facts.liveCwd`); an in-flight tick causes the next to be skipped, not queued; `{supported:false}` stops all ticking and reports `supported: false`; a `null` snapshot sets `degraded` and retains the previous inventory; the ring never exceeds `RING_CAPACITY`; a throwing listener does not prevent the others from being notified; a thrown tick reaches `logError` and retains the previous reading; `kill` on a `'foreign'` attribution returns `'not-attributable'` and `killTree` is NEVER called; `kill` on `'attributable'` calls `killTree` and marks the row stopped; `kill` returning `'denied'` leaves the row `running`.

The existing `headlessSpawn` suite must still pass unchanged; add one case asserting `onSpawned` receives the pid and its disposer runs when the process settles.

Expected: all pass.

#### Completion Criteria

- [ ] `src/runtime/resourceMonitor.ts` exports the constants, `ResourceSample`, `ResourceReading`, `ResourceMonitorDeps`, `ResourceMonitor`.
- [ ] `grep -n "vscode" src/runtime/resourceMonitor.ts` returns nothing.
- [ ] The "kill never signals a non-attributable pid" test exists and passes.
- [ ] `npx vitest run src/agent/headlessSpawn.test.ts` passes with no pre-existing test modified.

---

### Task 8: Build the Resources webview (panel, state, messages, HTML)

#### Objective

A window-scoped panel rendering the live reading, modelled exactly on `src/ui/usage/`.

#### Files

- `src/ui/resources/state.ts` — created. Host-side view model.
- `src/ui/resources/messages.ts` — created. Closed message unions, parser, action router.
- `src/ui/resources/panel.ts` — created. `ResourcesPanelManager` + `ResourcesPanel`/`ResourcesPanelHost` interfaces.
- `src/ui/resources/webview.html` — created.
- `src/ui/resources/state.test.ts`, `src/ui/resources/messages.test.ts`, `src/ui/resources/panel.test.ts`, `src/ui/resources/webview.test.ts` — created.

#### Implementation

1. `state.ts` — `export interface ResourcesState` with: `supported: boolean`, `degraded: boolean`, `totals: { rssBytes: number; cpuPct: number | null }`, `rows: ResourceRowView[]` (ticket label, repo/label, pid, `cpuPct: number | null`, `rssBytes`, `procCount`, `uptimeMs: number | null`, `attribution`), `unknown: UnknownRowView[]`, `waste: WasteRowView[]` (`kind`, `reason`, `rssBytes`, `killable`, `serverId`), `history: ResourceSample[]`, `disk: DiskRowView[]` (`path`, `display`, `bytes`, `measuredMs`). Export `buildResourcesState(reading, disk, pathContext)`.
   Every path shown goes through `repoDisplayPath` + `PathContext` (the existing rule for ship/PR surfaces); import it rather than formatting locally. Locate it with `grep -rn "export function repoDisplayPath" src`.
   All display strings (bytes, percent, uptime) are rendered HOST-SIDE here — the webview cannot import a formatter. An absent fact renders `''`, never a placeholder.

2. `messages.ts`:

```ts
export type ResourcesWebviewMessage =
  | { type: 'request-state' }
  | { type: 'kill-server'; serverId: number }
  | { type: 'refresh' }
  | { type: 'measure-disk' };

export type ResourcesHostMessage =
  | { type: 'state'; state: ResourcesState }
  | { type: 'disk'; rows: DiskRowView[] }
  | ActionResultMessage;

export interface ResourcesActions {
  requestState(): void | Promise<void>;
  killServer(serverId: number): void | Promise<void>;
  refresh(): void | Promise<void>;
  measureDisk(): void | Promise<void>;
}
```

`parseResourcesMessage(raw): ResourcesWebviewMessage | null` narrows strictly: `serverId` must be a positive safe integer or the message is `null`. **The webview never sends a pid or a path** — only a `servers.id` the host re-resolves, exactly as `merge-pr` carries only a repo name. `routeResourcesAction` mirrors `routeUsageAction`, reporting through `reportAction`/`readRequestId`.

3. `panel.ts` — `ResourcesPanelManager` with `open()` (idempotent, reveals an existing panel), `dispose()`. On open it calls `monitor.setPanelVisible(true)` and `void monitor.refreshNow()`; on the panel's dispose it calls `setPanelVisible(false)` and aborts any in-flight disk pass. It subscribes to `monitor.onReading` and posts `{type:'state'}` per reading, unsubscribing on dispose. Disk is pushed separately via `{type:'disk'}` as each `onEach` fires, using the same latest-request + `AbortController` guard `pushWorktreeStats` uses (`src/ui/dashboard/panel.ts:617`). `killServer` awaits `monitor.kill(serverId)` and resolves the action with the outcome wording: `'killed'` → "Stopped", `'denied'` → "Refused — the process is still running", `'unknown'` → "Result unknown", `'not-attributable'` → "Not stopped — that pid is no longer provably ours".

4. `webview.html` — copy the structural skeleton of `src/ui/usage/webview.html` and keep, verbatim, its `/*KARST_DS_CSS*/`, `/*KARST_DS_JS*/`, and `/*KARST_PALETTE*/` markers and its CSP `<meta>`. Content:
   - Header: totals meter, a `degraded` note when set, an unsupported-platform line when `supported === false`.
   - A 5-minute sparkline drawn as INLINE SVG from `state.history` (a `<polyline>` per series, viewBox-scaled). No chart library, no external asset.
   - Table: attributed rows. Table: unknown rows, labelled as unattributed and explicitly not claimed to be karst's.
   - Waste list: each row a `<button class="k-btn k-btn-danger">Stop</button>` (danger variant — an irreversible kill) rendered ONLY when `killable`; a non-killable finding renders its reason with no control and a visible explanation of why it cannot be stopped (never a `title`-only explanation, UI-R19).
   - Disk section with a `Measure` button.
   - Every control: local pending state on click, `aria-busy`, disabled while pending, a watchdog that reports "unknown" on timeout, and a terminal outcome from `action-result`. Geometry is stable while pending (reserve the status slot; do not blank the label).
   - Icon-only controls carry an accessible name.

#### Constraints

- No UI framework, no chart library (UI-R01). Inline SVG only.
- Shared color/type/spacing via `--k-*` tokens; local grid geometry stays local (UI-R04/R05).
- Never post a pid or a path from the webview.
- The kill confirmation lives HOST-side (Task 9), not in the webview — a crafted message must not be able to skip it.
- Do not introduce a `.k-status` primitive; the codebase has `.k-dot` (documented gap G1). Use what exists.
- Read `docs/ui/UI-RULES.md` before writing the HTML and cite the rule ids satisfied in the commit message (UI-R35).

#### Edge Cases

- `supported === false` → one explanatory line, no tables, no controls.
- `degraded === true` → the last known numbers stay on screen with a visible "last reading did not complete" note. Never blank to zeros.
- `cpuPct === null` → renders `—`.
- Empty waste list → a plain "nothing leaked" line, not an empty table shell.
- A kill whose row vanished between render and click → the `not-attributable` outcome renders as its own message, not as a failure.
- Disk never measured → the section shows its `Measure` button and no rows.

#### Verification

```bash
npx vitest run src/ui/resources src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts src/ui/conformance.test.ts
```

`webview.test.ts` must assert: the three injection markers are present; the CSP meta is present; no `<script src=`, no `<link rel="stylesheet"`, no `http://`/`https://` asset URL; no chart-library identifier; every `<button>` that posts carries an `aria-busy` assignment path; the kill button carries the danger class.

Note: the three discovery suites will FAIL here because their hardcoded seven-name lists do not yet include `resources`. Task 9 fixes them. Running them here is how the executor confirms the expected failure mode before fixing it.

Expected: the `src/ui/resources` suites pass; the three discovery suites fail ONLY on the hardcoded-list assertion.

#### Completion Criteria

- [ ] All four `src/ui/resources/*.test.ts` files exist and pass.
- [ ] `grep -n "KARST_DS_CSS\|KARST_DS_JS\|KARST_PALETTE" src/ui/resources/webview.html` returns three hits.
- [ ] `parseResourcesMessage` rejects a message carrying a `pid` or a `path`; a test asserts it.
- [ ] No literal model name, no external URL, and no chart library in the HTML.

---

### Task 9: Wire the monitor, panel, and status bar into the extension

#### Objective

Bind the vscode-facing surfaces: the command, the panel host, the status bar item, the timers, and the three hardcoded webview lists.

#### Files

- `src/ui/resourceStatus.ts` — created. Pure status-bar builder.
- `src/ui/resourceStatus.test.ts` — created.
- `src/extension.ts` — modified. Construct the monitor, register the command and status item, dispose both.
- `package.json` — modified. Add the `karst.openResources` command contribution.
- `scripts/copy-assets.mjs` — modified. Add `ui/resources/webview.html` to `assets`.
- `src/ui/designSystem.test.ts`, `src/ui/webviewCsp.test.ts`, `src/ui/conformance.test.ts` — modified. Add `'resources'` to each hardcoded expected list (keep them sorted).

#### Implementation

1. `resourceStatus.ts`:

```ts
export interface ResourceIndicator { text: string; tooltip: string; warning: boolean; }
export function buildResourceIndicator(reading: ResourceReading): ResourceIndicator | null;
```

Returns `null` when `!reading.supported` or when `reading.inventory === null` (nothing measured yet) — a permanent empty badge is noise on the one surface the user cannot dismiss, the same reasoning `buildDepsIndicator` documents. With waste: `` `$(warning) Karst: ${n} leaked` `` and `warning: true`, tooltip listing `describeWaste` per finding (cap at 5 lines plus `…and N more`). Without waste: `` `$(pulse) Karst ${cpu} · ${rss}` `` and `warning: false`, tooltip naming the process count and the sample age. `cpuPct === null` renders `—`.

2. `extension.ts` — DONE: all wiring below is already present.

   - ~~Import `ResourceMonitor`, `ResourcesPanelManager`, `buildResourceIndicator`.~~ (present at lines 232, 326, 328)
   - ~~Construct the monitor after the store and project binding exist~~ (present at line 2035)
   - ~~`monitor.start()`; push both the monitor and the panel manager into `context.subscriptions`~~ (present at line 2064)
   - ~~Add `makeResourcesPanelHost(context, brandIcon)` alongside `makeUsagePanelHost`~~ (present at line 4395)
   - ~~Register `karst.openResources` → `resourcesPanel.open()`~~ (present at line 3832)
   - ~~Create the status item with `vscode.window.createStatusBarItem`~~ (present at line 2069)
   - Wire `onSpawned` on the gate and agent spawn paths ONLY where a `ResourceMonitor` is already in scope: pass `onSpawned: (pid) => monitor.registerPid({ pid, kind: 'agent', ticketId, label: callSite })` through the existing `instrumentAdapter` debug wiring point. If threading it requires changing a signature beyond adding one optional field, STOP and report — do not restructure the adapter seam.
   - Register session terminal pids: where `rememberSessionTerminal` is already called, additionally `monitor.registerPid({ pid, kind: 'session', ticketId, label: null })` and keep the disposer alongside the existing `forgetSessionTerminal` call site.

3. `package.json` — add to `contributes.commands`, matching the surrounding entries' shape:

```json
{ "command": "karst.openResources", "title": "Karst: Resource Monitor", "category": "Karst" }
```

Copy `category`/`icon` conventions from the neighbouring `karst.openTokenUsage` entry (line 106) rather than inventing them.

4. `scripts/copy-assets.mjs` — add `'ui/resources/webview.html'` to the `assets` array.

5. The three discovery tests — add `'resources'` to each `toEqual([...])` list, keeping alphabetical order (`dashboard, diffs, gettingStarted, resources, settings, sidebar, ticketForm, usage`).

6. The kill confirmation is HOST-side: `ResourcesPanelManager`'s `killServer` action, when constructed from `extension.ts`, is wrapped in a `vscode.window.showWarningMessage(…, { modal: true }, 'Stop process')` gate. Declining resolves the action as cancelled and signals nothing. The panel manager itself takes this as an injected `confirm?: (message: string) => Promise<boolean>` so it stays testable without `vscode`.

#### Constraints

- `extension.ts` holds bindings only — no monitoring logic, no attribution, no formatting.
- Do not change `karst.openTokenUsage` or any existing command.
- Do not remove or reorder existing `assets` entries.
- Do not change the semantics of `rememberSessionTerminal`/`forgetSessionTerminal`.
- Do not add a dependency. Everything here uses `vscode` and existing modules.

#### Edge Cases

- Windows → `buildResourceIndicator` returns `null`, the item stays hidden, the panel still opens and states the platform is unsupported.
- Panel opened before the first tick → `refreshNow()` populates it; until then the state renders as "measuring".
- Window closed with the panel open → `dispose` clears both intervals and the disk `AbortController`.
- Two windows on the same project → each shows its own reading; a kill in one is seen by the other on its next tick as a row that is simply gone.

#### Verification

```bash
npx vitest run src/ui/resourceStatus.test.ts src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts src/ui/conformance.test.ts
npm run typecheck
npm run build
```

`resourceStatus.test.ts` cases: unsupported → `null`; no inventory yet → `null`; waste present → `warning: true` and the count in the text; no waste → the meter form with `warning: false`; `cpuPct === null` → `—`; more than 5 findings → the tooltip caps and says "…and N more".

Expected: all suites pass; typecheck clean; `npm run build` emits `dist/ui/resources/webview.html`.

#### Completion Criteria

- [ ] `karst.openResources` opens the panel from the command palette.
- [ ] The three discovery suites pass with `resources` in their lists.
- [ ] `ls dist/ui/resources/webview.html` exists after `npm run build`.
- [ ] `grep -n "attributeServer\|treeCost\|findWaste" src/extension.ts` returns nothing — no logic leaked into the binding layer.

---

### Task 10: Verify the cost budget

#### Objective

Prove the claim the whole design rests on: the monitor does not degrade the extension host.

#### Files

- `src/runtime/resourceMonitor.cost.test.ts` — created.

#### Implementation

1. A test asserting the event loop stays free while a tick runs, modelled on the existing guard `gates/run.test.ts` "leaves the event loop free while the child runs" — read that test first and mirror its technique. Inject a `readSnapshot` that resolves after a `setTimeout`, and assert a `setImmediate`/timer scheduled meanwhile fires BEFORE the tick resolves.
2. A test asserting one slow tick issues exactly ONE snapshot read regardless of how many known pids exist (feed 50 known pids; assert the injected `readSnapshot` call count is 1).
3. A test asserting the fast lane spends ZERO `liveCwd` probes over 10 consecutive fast ticks.
4. A test asserting the disk lane is never invoked by either interval — only by an explicit `measureDisk` call.
5. Record the measured `ps` cost from this plan's Current State table as a comment at the top of the file so a future reader knows what budget the test defends.

#### Constraints

- No real `ps` or `du` invocation in these tests — every probe is injected.
- Do not add a benchmark dependency.

#### Edge Cases

- A slow machine in CI → the assertions are about ORDERING and CALL COUNTS, never wall-clock thresholds. Do not write a timing assertion that can flake.

#### Verification

```bash
npx vitest run src/runtime/resourceMonitor.cost.test.ts
```

Expected: all pass, with no timing-threshold assertion in the file.

#### Completion Criteria

- [ ] All four assertions exist and pass.
- [ ] `grep -nE "toBeLessThan\([0-9]+\)" src/runtime/resourceMonitor.cost.test.ts` finds no wall-clock threshold.

---

## Final Verification

1. Full test suite green.
2. Typecheck clean.
3. Build emits the new webview asset.
4. Manual: press F5, open the Extension Development Host, run **Karst: Resource Monitor** from the command palette.
   - The panel renders within ~2 s (the forced `refreshNow`), showing totals and at least the extension host's own tree if a server is running.
   - Spin a ticket so a server starts; confirm the row appears with its repo, a non-null RSS, and a `cpuPct` that is `—` on the first reading and numeric on the second.
   - Delete a spun worktree directory by hand (`rm -rf` a worktree whose server is running), wait one slow tick (30 s), and confirm the status bar turns amber saying `1 leaked` and the panel lists the `worktree-gone` finding with a **Stop** button.
   - Click **Stop**, accept the modal, and confirm the process is gone (`ps -p <pid>` prints nothing) and the row disappears on the next tick.
   - Close the panel and confirm the fast lane stops (with `debug: true` in `karst.yml`, the Karst output channel shows `[resources]` lines at 30 s intervals only).

Commands:

```bash
npm run typecheck
npm test
npm run build
```

Expected:
- `npm run typecheck` exits 0.
- `npm test` exits 0 with no pre-existing test modified other than the three hardcoded webview lists.
- `npm run build` produces `dist/ui/resources/webview.html`.
- `git diff --stat src/store/schema.sql src/store/migrations.ts` is empty — **no schema change was made**.

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

Stop only for a concrete blocker: a referenced file, API, dependency, or subsystem does not exist; repository state materially contradicts a fact this plan depends on; a required credential or external resource is unavailable; the prescribed implementation is technically impossible; executing the plan would require an architectural or product decision it does not cover; two instructions directly contradict each other; verification proves a fundamental assumption false.

When stopping, report: the task number, the exact blocker, the evidence establishing it, which plan assumption is invalid, and the minimum planning decision required to continue.

Do not propose or implement an alternative unless explicitly asked to re-plan.
