# Sandbox Lifecycle and Evidence Bridge Implementation Plan (Docker plan Increment 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hook events (needs-you, launch intent, liveness) and impl/fix done markers from an agent inside an sbx or docker sandbox reach the host, and a sandbox can never forge another ticket's, stage's or session's evidence.

**Architecture:** One per-ticket host directory is the ONLY extra read-write mount. The in-sandbox hook script (the existing shared `HOOK_BRIDGE`, gaining a `file:` transport) appends NDJSON lines to `events.ndjson` there. A host async poller tails that file; a pure verifier checks every line against the session's own ticket / stage / session id and rebuilds the `HookPayload` from the host's own facts; accepted hook events go through the existing `dispatchHook`, accepted markers run the existing `karst stage <impl|fix> pass` CLI as an async child. The bridge never carries a verdict.

**Tech Stack:** TypeScript (ESM, `.js` import suffix, `noUncheckedIndexedAccess`), vitest, `node:fs/promises`, Stryker (≥ 85 on `src/extension/**`).

**Spec:** `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 3; evidence `spikes/docker-sandbox/RESULTS.md` exp 6 (file bridge C, p50 RTT 21.9 ms) and exp 7 (verifier rejects foreign markers); rules `arch:AC-31`, `arch:AC-32`, `arch:AC-33`, `arch:AC-08`, `core:HOOK-04`. Prototype to port: `spikes/docker-sandbox/06-bridge/verify-events.mjs`.

## Global Constraints

- No `spawnSync` / `execSync` anywhere new (CLAUDE.md: nothing blocks the extension-host event loop). Child processes: async spawn, argv arrays only.
- Verdicts are exit-code based. The bridge carries hook events and `impl`/`fix` markers only; `MARKER_STAGES` (`src/agent/markerStage.ts`) is the only markable set. A line naming any other stage is rejected.
- Host-agnostic: new modules take injected interfaces (fs paths, `onLine`, `debug`), never `vscode`, never the global logger (`arch:DBG-01`; `debug` is an injected callback).
- AC-08: a change to the hook channel covers all four adapters (claude, codex, opencode, opencode2) in the same commit, or a declared reason on `surfaces`. agy stays unsupported (no hook channel today).
- `core:HOOK-04` rule 4: fail open. A defect in the bridge script or poller must never throw into the agent or block a tool call.
- Identity is bound by PATH: ticket id and worktree come from the host's own bridge registration, never from line content. Line content is untrusted.
- Bounds: line ≤ `MAX_BRIDGE_LINE_BYTES` = 65536; one poll reads ≤ 1 MiB; a symlink at `events.ndjson` is refused.
- Files < 400 lines; new test naming rule from `CONTRIBUTING.md` §5: pure fs tmp-dir tests stay `*.test.ts`; spawning a real child → `*.integration.test.ts`; headless end-to-end → `*.e2e.test.ts`.
- Strict TDD (RED → GREEN), conventional commits. Run scoped vitest only: `npx vitest run <file>`; full suite once at the end via `npm run -s test:unit`.

## Dependencies already landed (verified in this worktree)

`SessionRunner` seam (`src/agent/sessionRunner.ts`), sbx runner (`src/agent/sbx/sbxRunner.ts`), docker runner (`src/agent/docker/dockerRunner.ts`, `dockerRunArgs.ts`), `resolveRunner` hook in `SessionManager.openSession` (`src/ui/session.ts:~560`), `backendSessionOptions` (`src/extension/ops/sandboxSyncOps.ts`). Today `session.ts` passes `...(inSandbox ? {} : { hookChannel })` to `buildInteractiveCommand` and skips the MCP config — that gap (`arch:AC-32` "Known gaps") is what this plan closes for the hook channel. MCP tools in the sandbox stay out of scope.

## File Structure

| File | Responsibility |
|---|---|
| `src/agent/bridge/bridgeDir.ts` (new) | pure path math + async create/remove of the per-ticket host dir and its offset state file |
| `src/agent/bridge/bridgeVerifier.ts` (new) | pure `verifyBridgeLine(line, expect)`; port of the spike verifier; builds the host-side `HookPayload` |
| `src/agent/bridge/bridgePoller.ts` (new) | async tail of `events.ndjson`: partial lines, truncation, symlink refusal, persisted offset |
| `src/agent/bridge/bridgeSink.ts` (new) | wires verifier + poller to `dispatchHook` and the marker runner; one `BridgeAttachment` per ticket |
| `src/agent/bridge/bridgeRegistry.ts` (new) | attach / detach / sweep of attachments; boot re-attach and orphan removal |
| `src/agent/hookBridge.ts` | `HOOK_BRIDGE` gains the `file:` transport; new `MARKER_EMIT` script source |
| `src/agent/adapter.ts` | `HookChannel` gains `runDir?` (the path the AGENT sees) |
| `src/agent/claude.ts`, `codex.ts`, `opencode.ts`, `opencode2.ts` | compose in-sandbox command paths from `runDir ?? configDir` |
| `src/agent/sessionRunner.ts` | `InteractiveLaunchSpec.bridgeDir?` |
| `src/agent/sbx/sbxRunner.ts`, `src/agent/docker/dockerRunArgs.ts` | mount the bridge dir (only extra rw mount) |
| `src/ui/session.ts` | in a sandbox: build the file channel instead of dropping it |
| `src/extension/ops/bootSweeps.ts` | boot: re-attach live bridges, remove orphans |
| `docs/agent-cores/HOOK-CONTRACT.md`, `docs/arch/agent-cores.md` | sandbox channel (`HOOK-02`/`HOOK-03` gap), `AC-32` known-gap removal, new `AC-34` |

## Decisions (fixed — from the original plan)

1. **Transport: path-bound file bridge** (exp 6). The dir is the ONLY extra rw mount, a per-ticket host dir under globalStorage, never the worktree. Host polls it (async, no `spawnSync`). No loopback relay (blocked by sbx policy by default).
2. **Host verifier is the authority:** every event is checked against the session's own ticket id, stage and agent session id; anything else is dropped and debug-logged with the `[bridge]` prefix.
3. **Hook bridge gets a sandbox channel** — the in-sandbox hook writes the bridge file instead of POSTing to the HTTP endpoint. `HOOK-04` rules apply.

Added by this plan (derived, not new scope):

4. **Same script, new transport.** The four adapters already pass `endpointUrl` as `argv[2]` of `bridge.cjs`. A `file://` endpoint switches the script to append mode, so no adapter grows a second hook script (AC-08 by construction).
5. **The agent-visible path differs from the host path.** The dir is mounted at `/karst-bridge/<ticketId>` in the sandbox; adapters WRITE their script/settings to the host `configDir` but must COMPOSE command paths from `runDir`. This is the one adapter-level change (Task 4).
6. **No reply channel.** The mail-delivery Stop reply (`HOOK-03`) needs a response; a file cannot give one. Sandbox sessions fall back to the typed-pointer sweep, declared in `HOOK-03`.
7. **Offset state lives OUTSIDE the mounted dir** (`<root>/state/<ticketId>.json`) so the sandbox cannot rewrite it.
8. **Markers reuse the CLI.** An accepted marker runs `node <cli> stage <impl|fix> pass --db --manifest --ticket` as an async child, so `assertMarkerHasWork`, the waiting guard and the graph guard apply unchanged. No second marker implementation.

---

### Task 1: `bridgeVerifier` — pure line verification

**Files:**
- Create: `src/agent/bridge/bridgeVerifier.ts`
- Test: `src/agent/bridge/bridgeVerifier.test.ts`

**Interfaces:**
- Consumes: `MarkerStage`, `isMarkerStage` from `../markerStage.js`; `HookPayload` from `../../hooks/dispatch.js`; `StageKey` from `../../model/types.js`.
- Produces:
  - `export const MAX_BRIDGE_LINE_BYTES = 65536;`
  - `export interface BridgeExpectation { readonly ticketId: number; readonly worktreePath: string; readonly launchId: string | undefined; readonly stage: () => StageKey | null; readonly sessionId: () => string | undefined }`
  - `export type BridgeAccepted = { readonly kind: 'hook'; readonly payload: HookPayload } | { readonly kind: 'marker'; readonly stage: MarkerStage }`
  - `export type BridgeVerdict = { readonly ok: true; readonly event: BridgeAccepted } | { readonly ok: false; readonly reason: string }`
  - `export function verifyBridgeLine(line: string, expect: BridgeExpectation): BridgeVerdict`

Line schema (written by the in-sandbox scripts, untrusted): `{"v":1,"kind":"hook","ticket":<n>,"payload":{...}}` and `{"v":1,"kind":"marker","ticket":<n>,"stage":"impl"|"fix"}`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MAX_BRIDGE_LINE_BYTES, verifyBridgeLine, type BridgeExpectation } from './bridgeVerifier.js';

const expectOf = (over: Partial<BridgeExpectation> = {}): BridgeExpectation => ({
  ticketId: 7,
  worktreePath: '/wt/t7',
  launchId: 'L1',
  stage: () => 'impl',
  sessionId: () => undefined,
  ...over,
});
const hook = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: 'hook', ticket: 7, payload: { hook_event_name: 'Notification', message: 'permission_prompt', session_id: 's1', cwd: '/sandbox/repo', ...o } });
const marker = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, kind: 'marker', ticket: 7, stage: 'impl', ...o });

describe('verifyBridgeLine', () => {
  it('accepts an own-ticket hook and rebuilds cwd + launchId from host facts', () => {
    const r = verifyBridgeLine(hook({ launchId: 'FORGED' }), expectOf());
    expect(r).toEqual({
      ok: true,
      event: { kind: 'hook', payload: { hook_event_name: 'Notification', message: 'permission_prompt', session_id: 's1', cwd: '/wt/t7', launchId: 'L1' } },
    });
  });
  it('omits launchId when the session has none', () => {
    const r = verifyBridgeLine(hook(), expectOf({ launchId: undefined }));
    expect(r.ok && r.event.kind === 'hook' && 'launchId' in r.event.payload).toBe(false);
  });
  it('accepts the own-stage marker', () => {
    expect(verifyBridgeLine(marker(), expectOf())).toEqual({ ok: true, event: { kind: 'marker', stage: 'impl' } });
  });
  it('rejects another ticket (hook and marker)', () => {
    expect(verifyBridgeLine(hook({}).replace('"ticket":7', '"ticket":8'), expectOf())).toEqual({ ok: false, reason: 'ticket 8 != 7' });
    expect(verifyBridgeLine(marker({ ticket: 8 }), expectOf())).toEqual({ ok: false, reason: 'ticket 8 != 7' });
  });
  it('rejects a marker for another stage', () => {
    expect(verifyBridgeLine(marker({ stage: 'fix' }), expectOf())).toEqual({ ok: false, reason: 'stage fix != impl' });
  });
  it('rejects a marker while the ticket has no markable stage', () => {
    expect(verifyBridgeLine(marker(), expectOf({ stage: () => 'review' }))).toEqual({ ok: false, reason: 'stage impl != review' });
  });
  it('rejects a non-markable stage name (a gate verdict can never ride the bridge)', () => {
    expect(verifyBridgeLine(marker({ stage: 'ship' }), expectOf({ stage: () => 'ship' }))).toEqual({ ok: false, reason: 'stage ship is not markable' });
  });
  it('rejects a hook from another agent session once one is bound', () => {
    expect(verifyBridgeLine(hook({ session_id: 's2' }), expectOf({ sessionId: () => 's1' }))).toEqual({ ok: false, reason: 'session s2 != s1' });
    expect(verifyBridgeLine(hook({ session_id: 's1' }), expectOf({ sessionId: () => 's1' })).ok).toBe(true);
  });
  it('rejects malformed JSON, wrong version, unknown kind, non-object, bad ticket type', () => {
    for (const line of ['{not json', '[]', '"x"', JSON.stringify({ v: 2, kind: 'hook', ticket: 7 }), JSON.stringify({ v: 1, kind: 'verdict', ticket: 7 }), JSON.stringify({ v: 1, kind: 'hook', ticket: '7', payload: {} })]) {
      const r = verifyBridgeLine(line, expectOf());
      expect(r.ok).toBe(false);
    }
  });
  it('rejects a hook whose payload lacks a string hook_event_name or session_id', () => {
    expect(verifyBridgeLine(hook({ hook_event_name: 5 }), expectOf()).ok).toBe(false);
    expect(verifyBridgeLine(hook({ session_id: undefined }), expectOf()).ok).toBe(false);
  });
  it('rejects an oversized line without parsing it', () => {
    const big = hook({ message: 'x'.repeat(MAX_BRIDGE_LINE_BYTES) });
    expect(verifyBridgeLine(big, expectOf())).toEqual({ ok: false, reason: 'line too large' });
  });
  it('drops unknown payload fields (only the allowlist survives)', () => {
    const r = verifyBridgeLine(hook({ evil: 'x', ticketId: 99 }), expectOf());
    expect(r.ok && r.event.kind === 'hook' && 'evil' in r.event.payload).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/bridge/bridgeVerifier.test.ts`
Expected: FAIL — cannot resolve `./bridgeVerifier.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { HookPayload } from '../../hooks/dispatch.js';
import type { StageKey } from '../../model/types.js';
import { isMarkerStage, type MarkerStage } from '../markerStage.js';

export const MAX_BRIDGE_LINE_BYTES = 65536;

/** What the HOST knows about the session that owns one bridge file. Line content is never a source for these. */
export interface BridgeExpectation {
  readonly ticketId: number;
  readonly worktreePath: string;
  readonly launchId: string | undefined;
  /** The ticket's current stage, read live: a marker is valid only for it. */
  readonly stage: () => StageKey | null;
  /** The agent session id once the host captured one; undefined before the first SessionStart. */
  readonly sessionId: () => string | undefined;
}

export type BridgeAccepted =
  | { readonly kind: 'hook'; readonly payload: HookPayload }
  | { readonly kind: 'marker'; readonly stage: MarkerStage };

export type BridgeVerdict =
  | { readonly ok: true; readonly event: BridgeAccepted }
  | { readonly ok: false; readonly reason: string };

const reject = (reason: string): BridgeVerdict => ({ ok: false, reason });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The only payload fields the host takes from a line; cwd and launchId are rebuilt from host facts. */
const STRING_FIELDS = ['hook_event_name', 'session_id', 'message', 'notification_type', 'tool_name', 'file_path'] as const;

function hookPayload(raw: Record<string, unknown>, expect: BridgeExpectation): HookPayload | string {
  if (typeof raw.hook_event_name !== 'string' || typeof raw.session_id !== 'string') {
    return 'payload needs string hook_event_name and session_id';
  }
  const bound = expect.sessionId();
  if (bound !== undefined && raw.session_id !== bound) return `session ${raw.session_id} != ${bound}`;
  const payload: Record<string, unknown> = { cwd: expect.worktreePath };
  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === 'string') payload[key] = value;
  }
  if (raw.stop_hook_active === true) payload.stop_hook_active = true;
  if (isRecord(raw.usage)) payload.usage = raw.usage;
  if (expect.launchId !== undefined) payload.launchId = expect.launchId;
  return payload as HookPayload;
}

/**
 * Verify ONE bridge line (port of `spikes/docker-sandbox/06-bridge/verify-events.mjs`).
 * Pure. The host binds identity by path; a line can only be accepted for the
 * session that owns the file, and never carries a verdict (arch:AC-31).
 */
export function verifyBridgeLine(line: string, expect: BridgeExpectation): BridgeVerdict {
  if (Buffer.byteLength(line, 'utf8') > MAX_BRIDGE_LINE_BYTES) return reject('line too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return reject('malformed');
  }
  if (!isRecord(parsed) || parsed.v !== 1) return reject('malformed');
  if (typeof parsed.ticket !== 'number') return reject('malformed');
  if (parsed.ticket !== expect.ticketId) return reject(`ticket ${parsed.ticket} != ${expect.ticketId}`);
  if (parsed.kind === 'hook') {
    if (!isRecord(parsed.payload)) return reject('malformed');
    const built = hookPayload(parsed.payload, expect);
    return typeof built === 'string' ? reject(built) : { ok: true, event: { kind: 'hook', payload: built } };
  }
  if (parsed.kind === 'marker') {
    const stage = parsed.stage;
    if (typeof stage !== 'string' || !isMarkerStage(stage)) return reject(`stage ${String(stage)} is not markable`);
    const current = expect.stage();
    if (stage !== current) return reject(`stage ${stage} != ${current}`);
    return { ok: true, event: { kind: 'marker', stage } };
  }
  return reject('unknown kind');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/bridge/bridgeVerifier.test.ts`
Expected: PASS (12 tests). If the "rejects a non-markable stage" case reports `stage ship != ship`, the `isMarkerStage` check ran after the equality check — keep markable first.

- [ ] **Step 5: Commit**

```bash
git add src/agent/bridge/bridgeVerifier.ts src/agent/bridge/bridgeVerifier.test.ts
git commit -m "feat(bridge): pure host-side verifier for sandbox evidence lines"
```

---

### Task 2: `bridgeDir` + `bridgePoller` — host dir and async tail

**Files:**
- Create: `src/agent/bridge/bridgeDir.ts`, `src/agent/bridge/bridgePoller.ts`
- Test: `src/agent/bridge/bridgeDir.test.ts`, `src/agent/bridge/bridgePoller.test.ts`

**Interfaces:**
- Consumes: `MAX_BRIDGE_LINE_BYTES` from `./bridgeVerifier.js`.
- Produces:
  - `export const SANDBOX_BRIDGE_MOUNT_ROOT = '/karst-bridge';`
  - `export interface BridgePaths { readonly dir: string; readonly eventsFile: string; readonly stateFile: string; readonly runDir: string }`
  - `export function bridgePaths(root: string, ticketId: number): BridgePaths` — `dir = <root>/events/<id>`, `eventsFile = <dir>/events.ndjson`, `stateFile = <root>/state/<id>.json`, `runDir = /karst-bridge/<id>`.
  - `export function ensureBridgeDir(paths: BridgePaths): Promise<void>` (creates dir + empty `events.ndjson` mode 0o666 so the sandbox user can append; creates `state/`)
  - `export function removeBridgeDir(paths: BridgePaths): Promise<void>` (rm -rf dir and state file; ENOENT is fine)
  - `export function listBridgeTicketIds(root: string): Promise<number[]>` (numeric dir names under `<root>/events`)
  - `export interface BridgePoller { start(): void; stop(): Promise<void>; pollOnce(): Promise<void> }`
  - `export function createBridgePoller(opts: { file: string; stateFile: string; intervalMs: number; onLine: (line: string) => void; debug?: (m: string) => void }): BridgePoller`

- [ ] **Step 1: Write the failing tests**

`bridgeDir.test.ts`:

```ts
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir } from './bridgeDir.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bridge-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

describe('bridgeDir', () => {
  it('derives host and in-sandbox paths from the ticket id only', () => {
    expect(bridgePaths('/g', 7)).toEqual({
      dir: '/g/events/7', eventsFile: '/g/events/7/events.ndjson', stateFile: '/g/state/7.json', runDir: '/karst-bridge/7',
    });
  });
  it('rejects a non-integer ticket id (path traversal guard)', () => {
    expect(() => bridgePaths('/g', 1.5)).toThrow();
    expect(() => bridgePaths('/g', -1)).toThrow();
  });
  it('ensure creates the dir with an empty events file, idempotently', async () => {
    const p = bridgePaths(root, 7);
    await ensureBridgeDir(p);
    await ensureBridgeDir(p);
    expect(await readFile(p.eventsFile, 'utf8')).toBe('');
    expect((await stat(p.stateFile.replace(/7\.json$/, ''))).isDirectory()).toBe(true);
  });
  it('remove deletes dir and state, tolerating absence', async () => {
    const p = bridgePaths(root, 7);
    await ensureBridgeDir(p);
    await removeBridgeDir(p);
    await removeBridgeDir(p);
    await expect(stat(p.dir)).rejects.toThrow();
  });
  it('lists numeric ticket dirs only', async () => {
    await ensureBridgeDir(bridgePaths(root, 3));
    await ensureBridgeDir(bridgePaths(root, 12));
    await symlink('/', join(root, 'events', 'evil'));
    expect((await listBridgeTicketIds(root)).sort((a, b) => a - b)).toEqual([3, 12]);
  });
  it('lists nothing when the root has no events dir', async () => {
    expect(await listBridgeTicketIds(join(root, 'nope'))).toEqual([]);
  });
});
```

`bridgePoller.test.ts`:

```ts
import { appendFile, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BRIDGE_LINE_BYTES } from './bridgeVerifier.js';
import { createBridgePoller } from './bridgePoller.js';

let dir: string; let file: string; let stateFile: string;
let lines: string[]; let logs: string[];
const make = () => createBridgePoller({ file, stateFile, intervalMs: 5, onLine: (l) => lines.push(l), debug: (m) => logs.push(m) });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'poll-'));
  file = join(dir, 'events.ndjson'); stateFile = join(dir, 'state.json');
  lines = []; logs = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('bridgePoller', () => {
  it('emits complete lines once and holds a partial line until its newline arrives', async () => {
    await writeFile(file, 'a\nb\npart');
    const p = make();
    await p.pollOnce();
    expect(lines).toEqual(['a', 'b']);
    await appendFile(file, 'ial\n');
    await p.pollOnce();
    expect(lines).toEqual(['a', 'b', 'partial']);
    await p.pollOnce();
    expect(lines).toHaveLength(3);
  });
  it('does not split a multi-byte character across polls', async () => {
    const bytes = Buffer.from('é\n');
    await writeFile(file, bytes.subarray(0, 1));
    const p = make();
    await p.pollOnce();
    await appendFile(file, bytes.subarray(1));
    await p.pollOnce();
    expect(lines).toEqual(['é']);
  });
  it('treats a missing file as empty', async () => {
    await make().pollOnce();
    expect(lines).toEqual([]);
  });
  it('restarts from the persisted offset and re-reads an unfinished partial line', async () => {
    await writeFile(file, 'a\npar');
    await make().pollOnce();
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ offset: 2 });
    await appendFile(file, 'tial\nb\n');
    const second = make();
    await second.pollOnce();
    expect(lines).toEqual(['a', 'partial', 'b']);
  });
  it('resets to the start after truncation and logs it', async () => {
    await writeFile(file, 'one\ntwo\n');
    const p = make();
    await p.pollOnce();
    await truncate(file, 0);
    await appendFile(file, 'three\n');
    await p.pollOnce();
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(logs.some((m) => m.startsWith('[bridge]') && m.includes('truncat'))).toBe(true);
  });
  it('refuses a symlinked events file', async () => {
    const target = join(dir, 'secret'); await writeFile(target, 'leak\n');
    await symlink(target, file);
    await make().pollOnce();
    expect(lines).toEqual([]);
    expect(logs.some((m) => m.includes('symlink'))).toBe(true);
  });
  it('drops an unterminated line longer than the cap instead of buffering forever', async () => {
    await writeFile(file, 'x'.repeat(MAX_BRIDGE_LINE_BYTES + 10));
    const p = make();
    await p.pollOnce();
    await appendFile(file, 'tail\nok\n');
    await p.pollOnce();
    expect(lines).toEqual(['ok']);
    expect(logs.some((m) => m.includes('oversized'))).toBe(true);
  });
  it('ignores a corrupt state file and starts from 0', async () => {
    await writeFile(stateFile, '{"offset":"x"}');
    await writeFile(file, 'a\n');
    await make().pollOnce();
    expect(lines).toEqual(['a']);
  });
  it('start() polls on an interval until stop() resolves', async () => {
    const p = make();
    p.start();
    await writeFile(file, 'live\n');
    await new Promise((r) => setTimeout(r, 60));
    await p.stop();
    expect(lines).toEqual(['live']);
    await appendFile(file, 'late\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(lines).toEqual(['live']);
  });
  it('swallows an onLine throw so one bad line cannot stop the tail', async () => {
    await writeFile(file, 'a\nb\n');
    const seen: string[] = [];
    const p = createBridgePoller({ file, stateFile, intervalMs: 5, onLine: (l) => { seen.push(l); if (l === 'a') throw new Error('boom'); }, debug: (m) => logs.push(m) });
    await p.pollOnce();
    expect(seen).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/bridge/bridgeDir.test.ts src/agent/bridge/bridgePoller.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

`bridgeDir.ts`:

```ts
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Where the per-ticket dir appears INSIDE the sandbox (arch:AC-34). */
export const SANDBOX_BRIDGE_MOUNT_ROOT = '/karst-bridge';

export interface BridgePaths {
  readonly dir: string;
  readonly eventsFile: string;
  readonly stateFile: string;
  readonly runDir: string;
}

export function bridgePaths(root: string, ticketId: number): BridgePaths {
  if (!Number.isInteger(ticketId) || ticketId < 0) throw new Error(`bridge: invalid ticket id ${ticketId}`);
  const dir = join(root, 'events', String(ticketId));
  return {
    dir,
    eventsFile: join(dir, 'events.ndjson'),
    stateFile: join(root, 'state', `${ticketId}.json`),
    runDir: `${SANDBOX_BRIDGE_MOUNT_ROOT}/${ticketId}`,
  };
}

/** The sandbox user is not the host user: the dir and file must be writable by it. Idempotent. */
export async function ensureBridgeDir(paths: BridgePaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o777 });
  await mkdir(dirname(paths.stateFile), { recursive: true });
  // 'a' never truncates: an existing log (a restart) is kept.
  await writeFile(paths.eventsFile, '', { flag: 'a', mode: 0o666 });
}

export async function removeBridgeDir(paths: BridgePaths): Promise<void> {
  await rm(paths.dir, { recursive: true, force: true });
  await rm(paths.stateFile, { force: true });
}

export async function listBridgeTicketIds(root: string): Promise<number[]> {
  let entries;
  try {
    entries = await readdir(join(root, 'events'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name));
}
```

`bridgePoller.ts`:

```ts
import { lstat, open, readFile, rename, writeFile } from 'node:fs/promises';
import { MAX_BRIDGE_LINE_BYTES } from './bridgeVerifier.js';

const MAX_READ_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface BridgePoller {
  start(): void;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
}

export interface BridgePollerOptions {
  readonly file: string;
  /** Lives OUTSIDE the sandbox-mounted dir. */
  readonly stateFile: string;
  readonly intervalMs: number;
  readonly onLine: (line: string) => void;
  readonly debug?: (message: string) => void;
}

async function loadOffset(stateFile: string): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile, 'utf8'));
    const offset = (parsed as { offset?: unknown }).offset;
    return typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

async function saveOffset(stateFile: string, offset: number): Promise<void> {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ offset }));
  await rename(tmp, stateFile);
}

/**
 * Async tail of the per-ticket `events.ndjson` (Decision 1): setTimeout chain
 * (never overlapping), bounded reads, no spawnSync. The persisted offset is
 * the first UNCONSUMED byte, so a restart re-reads a half-written line.
 */
export function createBridgePoller(opts: BridgePollerOptions): BridgePoller {
  const log = (m: string): void => opts.debug?.(`[bridge] ${m}`);
  let offset: number | undefined;
  let carry: Buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let discarding = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function readNew(): Promise<void> {
    if (offset === undefined) offset = await loadOffset(opts.stateFile);
    let stat;
    try {
      stat = await lstat(opts.file);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      log(`refusing ${opts.file}: symlink or not a regular file`);
      return;
    }
    if (stat.size < offset) {
      log(`events file truncated (${stat.size} < ${offset}); restarting from 0`);
      offset = 0;
      carry = Buffer.alloc(0);
    }
    if (stat.size === offset) return;
    const length = Math.min(stat.size - offset, MAX_READ_BYTES);
    const handle = await open(opts.file, 'r');
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    offset += chunk.length;
    let buf: Buffer = Buffer.concat([carry, chunk]);
    if (discarding) {
      // Still inside an oversized line: nothing up to its newline is trusted.
      const nl = buf.indexOf(NEWLINE);
      if (nl === -1) {
        carry = Buffer.alloc(0);
        await saveOffset(opts.stateFile, offset);
        return;
      }
      buf = buf.subarray(nl + 1);
      discarding = false;
    }
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE)) {
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (line.length === 0) continue;
      try {
        opts.onLine(line);
      } catch (err) {
        log(`onLine threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (buf.length > MAX_BRIDGE_LINE_BYTES) {
      log(`dropped an oversized unterminated line (${buf.length} bytes)`);
      discarding = true;
      carry = Buffer.alloc(0);
      await saveOffset(opts.stateFile, offset);
      return;
    }
    carry = buf;
    await saveOffset(opts.stateFile, offset - carry.length);
  }

  const pollOnce = (): Promise<void> => {
    inFlight = inFlight.then(readNew).catch((err) => {
      log(`poll failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return inFlight;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void pollOnce().then(schedule);
    }, opts.intervalMs);
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    pollOnce,
  };
}
```

The `discarding` flag makes the oversized case drop the whole physical line (its remainder `tail\n` never reaches `onLine`), which is what the `['ok']` test pins.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/bridge/bridgeDir.test.ts src/agent/bridge/bridgePoller.test.ts`
Expected: PASS (6 + 10).

- [ ] **Step 5: Commit**

```bash
git add src/agent/bridge/bridgeDir.ts src/agent/bridge/bridgeDir.test.ts src/agent/bridge/bridgePoller.ts src/agent/bridge/bridgePoller.test.ts
git commit -m "feat(bridge): per-ticket bridge dir and async NDJSON tail"
```

---

### Task 3: Runner mounts — the bridge dir is the only extra rw mount

**Files:**
- Modify: `src/agent/sessionRunner.ts` (`InteractiveLaunchSpec` gains `readonly bridgeDir?: string` — the HOST path)
- Modify: `src/agent/docker/dockerRunArgs.ts` (`InteractiveArgsInput` gains `bridgeDir?`; `interactiveRunArgs` adds one bind), `src/agent/docker/dockerRunner.ts` (pass `spec.bridgeDir`)
- Modify: `src/agent/sbx/sbxRunner.ts`
- Test: `src/agent/docker/dockerRunArgs.test.ts`, `src/agent/sbx/sbxRunner.test.ts`, `src/agent/sessionRunner.test.ts`

**Interfaces:**
- Consumes: `bindMount(source, target, readonly)` (`dockerRunArgs.ts:42`); `SANDBOX_BRIDGE_MOUNT_ROOT` + `bridgePaths` (Task 2).
- Produces: runners mount `spec.bridgeDir` at `/karst-bridge/<ticketId>` (read-write) and only when `spec.bridgeDir` is set; host runner ignores it.

- [ ] **Step 1: Confirm how sbx takes an extra workspace** (decides the sbx argv; do not guess)

Run: `sbx run --help 2>&1 | head -40` and `sbx create --help 2>&1 | head -30`
Expected: usage shows `[WORKSPACE...]` with an optional `:ro` suffix and/or a mount flag. Record the exact form in the sbx test below. Two outcomes:
  a. Extra workspace mounts at the SAME absolute path inside (`<bridgeDir>`): then the in-sandbox `runDir` for sbx is the host `bridgeDir` itself. Set `PlacedInteractiveLaunch` mapping accordingly and make Task 4's `runDir` come from the runner (add `readonly bridgeRunDir?: string` to the spec's result — see Step 3 note).
  b. A `--mount host:container` style exists: use it with `/karst-bridge/<ticketId>`.
If neither exists, STOP and record it as a blocker in `spikes/docker-sandbox/RESULTS.md` follow-ups; sbx stays without a hook channel (declared in `AC-32`), docker proceeds.

- [ ] **Step 2: Write the failing tests**

`dockerRunArgs.test.ts` (add; the first test pins the exact argv delta, the second that nothing else changed):

```ts
it('adds exactly one rw bind for the bridge dir at /karst-bridge/<id>', () => {
  const base = interactiveRunArgs(INPUT);
  const withBridge = interactiveRunArgs({ ...INPUT, ticketId: 7, bridgeDir: '/g/events/7' });
  const delta = withBridge.filter((a, i) => a !== base[i] || i >= base.length);
  expect(withBridge).toContain('type=bind,source=/g/events/7,target=/karst-bridge/7');
  expect(withBridge.join(' ')).not.toContain('readonly,target=/karst-bridge');
  expect(withBridge.length).toBe(base.length + 2); // '--mount', <spec>
  expect(delta.length).toBeGreaterThan(0);
});
it('omits the bridge mount without bridgeDir', () => {
  expect(interactiveRunArgs(INPUT).join(' ')).not.toContain('karst-bridge');
});
```

(`INPUT` is the existing fixture in that file; add `ticketId` to `InteractiveArgsInput` as `readonly ticketId?: number`. If `bindMount` renders the pair differently, copy its exact output from `bindMount('/g/events/7','/karst-bridge/7',false)` into the first assertion.)

`sbxRunner.test.ts` (shape follows Step 1's recorded syntax; example for outcome a):

```ts
it('creates with the bridge dir as the single extra workspace', () => {
  const placed = runner.placeInteractive({ ...SPEC, bridgeDir: '/g/events/7' });
  expect(placed.shellArgs).toEqual(['run', '--clone', '--name', NAME, 'claude', SPEC.hostWorktreePath, '/g/events/7', '--', '--dangerously-skip-permissions', ...SPEC.args]);
});
it('does not re-pass the bridge dir when reattaching', () => {
  const placed = reattachRunner.placeInteractive({ ...SPEC, bridgeDir: '/g/events/7' });
  expect(placed.shellArgs.join(' ')).not.toContain('/g/events/7');
});
```

`sessionRunner.test.ts` (host runner ignores it):

```ts
it('host runner never mounts: bridgeDir does not change the placed launch', () => {
  const a = HOST_SESSION_RUNNER.placeInteractive(SPEC);
  expect(HOST_SESSION_RUNNER.placeInteractive({ ...SPEC, bridgeDir: '/x' })).toEqual(a);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/agent/docker/dockerRunArgs.test.ts src/agent/sbx/sbxRunner.test.ts src/agent/sessionRunner.test.ts`
Expected: FAIL (new assertions; `bridgeDir` not on the types).

- [ ] **Step 4: Implement**

`sessionRunner.ts`: add to `InteractiveLaunchSpec`:

```ts
  /**
   * Host path of the per-ticket evidence-bridge dir (arch:AC-34). Sandbox
   * runners mount it read-write as the ONLY extra mount; the host runner
   * ignores it.
   */
  readonly bridgeDir?: string;
```

`dockerRunArgs.ts` — in `InteractiveArgsInput` add `readonly ticketId?: number; readonly bridgeDir?: string;` and in `interactiveRunArgs`, next to `auth`:

```ts
  const bridge =
    input.bridgeDir !== undefined && input.ticketId !== undefined
      ? ['--mount', bindMount(input.bridgeDir, `${SANDBOX_BRIDGE_MOUNT_ROOT}/${input.ticketId}`, false)]
      : [];
```

and spread `...bridge` right after `...auth` in the returned array. `dockerRunner.ts` passes `ticketId: spec.ticketId, bridgeDir: spec.bridgeDir`. `sbxRunner.ts`: when creating (`!known.has(name)`) append `...(spec.bridgeDir ? [spec.bridgeDir] : [])` after the worktree argument (outcome a) or the Step-1 mount flag (outcome b).

Add the `SANDBOX_BRIDGE_MOUNT_ROOT` import from `../bridge/bridgeDir.js`.

- [ ] **Step 5: Run tests, then commit**

Run: `npx vitest run src/agent/docker/dockerRunArgs.test.ts src/agent/docker/dockerRunner.test.ts src/agent/sbx/sbxRunner.test.ts src/agent/sessionRunner.test.ts`
Expected: PASS.

```bash
git add src/agent
git commit -m "feat(bridge): sandbox runners mount the evidence bridge dir as the only extra rw mount"
```

---

### Task 4: Hook channel selection — `file:` transport in the shared script, all four adapters

**Files:**
- Modify: `src/agent/hookBridge.ts` (`HOOK_BRIDGE` file branch; new `MARKER_EMIT` export)
- Modify: `src/agent/adapter.ts` (`HookChannel.runDir?`)
- Modify: `src/agent/claude.ts` (~l.206-230), `src/agent/codex.ts` (~l.475; `appendHookArgs`), `src/agent/opencode.ts` (~l.1031-1045), `src/agent/opencode2.ts` (~l.416-426)
- Modify: `src/agent/hookFailureLog.ts` only if the new script path needs registration (it should not)
- Test: `src/agent/hookBridge.integration.test.ts` (spawns the real script → integration), `src/agent/adapterConformance.test.ts`, per-adapter tests

**Interfaces:**
- Consumes: `bridgePaths(...).runDir` (Task 2).
- Produces:
  - `HookChannel` gains `readonly runDir?: string` — when set, the channel is the FILE channel: `endpointUrl` is `file://<runDir>/events.ndjson`, `configDir` is the HOST bridge dir (where adapters write `bridge.cjs`, settings and `emit-marker.cjs`), `runDir` is the same dir as the agent sees it.
  - `export const MARKER_EMIT: string` (CJS source): `node <runDir>/emit-marker.cjs <impl|fix>` appends `{"v":1,"kind":"marker","ticket":<n>,"stage":"<stage>"}`; exits 1 with a usage error otherwise.
  - Every adapter: `join(configDir, provider)` is used to WRITE; the command string it embeds uses `join(runDir ?? configDir, provider)`. `emit-marker.cjs` is written next to `bridge.cjs`.

- [ ] **Step 1: Find every place a hook command path is composed**

Run: `grep -n "bridge.cjs\|configDir" src/agent/claude.ts src/agent/codex.ts src/agent/opencode.ts src/agent/opencode2.ts src/agent/opencode2Bridge.ts src/agent/hookSettings.ts 2>/dev/null`
Expected: the sites where a command line (`node <path>/bridge.cjs <url> <diag> <provider>`) is built. List them in the commit body. Each site must call one new helper `hookCommandDir(channel): string` returning `channel.runDir ?? channel.configDir` for the COMMAND, while writes keep using `configDir`. Add the helper to `adapter.ts` beside `HookChannel`, with its own tiny test.

- [ ] **Step 2: Write the failing tests**

`hookBridge.integration.test.ts` (new cases; real `node` child, tmp dir):

```ts
it('file transport appends one verified-shape line and exits 0 without any network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hb-'));
  const events = join(dir, '7', 'events.ndjson');
  await mkdir(join(dir, '7'), { recursive: true });
  await writeFile(join(dir, '7', 'bridge.cjs'), HOOK_BRIDGE);
  const input = JSON.stringify({ hook_event_name: 'PermissionRequest', cwd: '/sandbox/repo', session_id: 's1' });
  const res = await runNode(join(dir, '7', 'bridge.cjs'), [`file://${events}`, join(dir, '7', 'diag.jsonl'), 'claude'], input);
  expect(res.code).toBe(0);
  const [line] = (await readFile(events, 'utf8')).trim().split('\n');
  expect(JSON.parse(line!)).toEqual({
    v: 1, kind: 'hook', ticket: 7,
    payload: { hook_event_name: 'Notification', message: 'permission_prompt', cwd: '/sandbox/repo', session_id: 's1' },
  });
});
it('file transport fails open: an unwritable events path exits 0 and logs', async () => { /* events path under a missing dir → code 0, diagnostics line 'request-error:ENOENT' */ });
it('file transport writes a UsageUpdate line when usage is present', async () => { /* same input shape as an http usage case; payload.hook_event_name === 'UsageUpdate' */ });
it('emit-marker appends a marker line and rejects an unknown stage', async () => {
  /* run MARKER_EMIT with [`${dir}/7/events.ndjson`, 'impl'] → one line {"v":1,"kind":"marker","ticket":7,"stage":"impl"};
     with 'ship' → exit 1, file unchanged */
});
```

(`runNode` is the existing spawn helper in that file; reuse it.) `ticket` is parsed by the script from the parent directory name of the events path, as a decimal integer; a non-numeric parent dir exits 0 silently (fail open) and logs `invalid-endpoint`.

`adapterConformance.test.ts`: for each adapter with `surfaces.hookChannel.supported`, build an interactive command with `{ hookChannel: { endpointUrl: 'file:///karst-bridge/7/events.ndjson', configDir: hostBridgeDir, runDir: '/karst-bridge/7' } }` and assert (a) the argv/settings it produces mention `/karst-bridge/7` and never `hostBridgeDir`; (b) `bridge.cjs` exists under `hostBridgeDir/<provider>/`. Agy is skipped with its declared reason.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/agent/hookBridge.integration.test.ts src/agent/adapterConformance.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `HOOK_BRIDGE`, immediately before the existing `const posts = [];` block's `nextPost()` loop starts, add a file branch at the top of `nextPost`:

```js
    const fileTarget = endpoints[endpointIndex];
    if (typeof fileTarget === 'string' && fileTarget.startsWith('file://')) {
      try {
        const eventsPath = decodeURIComponent(new URL(fileTarget).pathname);
        const ticket = Number(path.basename(path.dirname(eventsPath)));
        if (!Number.isInteger(ticket) || ticket < 0) { finish(0, 'invalid-endpoint'); return; }
        fs.appendFileSync(eventsPath, JSON.stringify({ v: 1, kind: 'hook', ticket, payload }) + '\n');
      } catch (err) {
        logFailure(err && typeof err.code === 'string' ? 'request-error:' + err.code : 'request-error');
      }
      index += 1;
      nextPost();
      return;
    }
```

(`payload` is the existing `const payload = posts[index];` — place the branch AFTER that line.) Fail-open: every path ends in `finish(0)` via the normal `index >= posts.length` exit; there is no reply block, so `stopBlockEligible` can never wait. The endpoint-fallback code (`current-endpoint` file read at the top) is skipped for `file://` because `argvEndpoint` is not loopback: confirm `isLoopbackHost` is not applied to the argv endpoint (it guards only the fallback candidate); if the `endpoints` array builder filters non-http URLs, add `|| u.startsWith('file://')` to its filter.

`MARKER_EMIT` (exported string, same file):

```ts
export const MARKER_EMIT = String.raw`const fs = require('node:fs');
const path = require('node:path');
const [eventsPath, stage] = process.argv.slice(2);
if (!eventsPath || (stage !== 'impl' && stage !== 'fix')) {
  process.stderr.write('usage: emit-marker.cjs <events.ndjson> <impl|fix>\n');
  process.exit(1);
}
const ticket = Number(path.basename(path.dirname(eventsPath)));
if (!Number.isInteger(ticket) || ticket < 0) process.exit(1);
fs.appendFileSync(eventsPath, JSON.stringify({ v: 1, kind: 'marker', ticket, stage }) + '\n');
`;
```

Each of the four adapters: where it writes `bridge.cjs`, also write `emit-marker.cjs` (same atomic temp+rename helper; extract one `writeBridgeScripts(dir)` helper into `hookBridge.ts`'s sibling `hookBridgeFiles.ts` to avoid four copies — AC-08), and switch the embedded command directory to `hookCommandDir(channel)` (Step 1 helper). The HTTP path is untouched when `runDir` is unset, so host sessions are byte-identical (assert with the existing adapter snapshot tests).

- [ ] **Step 5: Run tests, then commit**

Run: `npx vitest run src/agent/hookBridge.integration.test.ts src/agent/adapterConformance.test.ts src/agent/claude.test.ts src/agent/opencode2.test.ts` plus the codex/opencode tests you touched.
Expected: PASS; no existing snapshot changes.

```bash
git add src/agent
git commit -m "feat(bridge): file transport in the shared hook script, wired through all four adapters"
```

---

### Task 5: `bridgeSink` + session wiring + end-to-end

**Files:**
- Create: `src/agent/bridge/bridgeSink.ts`
- Modify: `src/ui/session.ts` (~l.569-600, the `inSandbox` branch)
- Modify: `src/extension/ops/` — the wiring that owns `SessionManager` construction (find with `grep -rn "new SessionManager" src`); the binding stays a thin call into `bridgeRegistry` (Task 6), logic in `src/extension/ops/` per the ratchet test.
- Test: `src/agent/bridge/bridgeSink.test.ts`, `src/agent/bridge/bridge.e2e.test.ts`

**Interfaces:**
- Consumes: `verifyBridgeLine`, `BridgeExpectation` (Task 1); `createBridgePoller` (Task 2); `dispatchHook` (`src/hooks/dispatch.ts:410`, signature `(store, payload, notify?, shouldApplyState?, sessionProviderFor?, recorder?, debug?, tracker?)`).
- Produces:
  - `export type MarkerRunner = (stage: MarkerStage) => Promise<{ readonly code: number; readonly stderr: string }>`
  - `export interface BridgeAttachmentDeps { readonly paths: BridgePaths; readonly expect: BridgeExpectation; readonly dispatch: (payload: HookPayload) => void; readonly runMarker: MarkerRunner; readonly intervalMs: number; readonly debug?: (m: string) => void }`
  - `export interface BridgeAttachment { start(): void; stop(): Promise<void>; pollOnce(): Promise<void> }`
  - `export function createBridgeAttachment(deps: BridgeAttachmentDeps): BridgeAttachment` — poller `onLine` → `verifyBridgeLine`; `ok` hook → `dispatch(payload)`; `ok` marker → `runMarker(stage)` (not awaited inside the poll; failures debug-logged `[bridge] marker <stage> exited <code>: <stderr>`); `!ok` → `debug("[bridge] ticket <id> dropped: <reason>")`.
  - `session.ts`: `OpenSessionOptions` gains `bridge?: { readonly paths: BridgePaths }`; in the `inSandbox` branch the hook channel becomes `{ endpointUrl: 'file://' + paths.runDir + '/events.ndjson', configDir: paths.dir, runDir: paths.runDir, launchId }` (so `launchId` still orders lifecycle hooks), `placeInteractive` receives `bridgeDir: paths.dir`, and `ensureBridgeDir` runs before `placeInteractive`. With no `bridge` option an sbx/docker launch behaves exactly as today (no channel).

- [ ] **Step 1: Write the failing tests**

`bridgeSink.test.ts` (fake `dispatch` / `runMarker`, real tmp dir and poller via `pollOnce`):

```ts
it('dispatches an own-ticket hook with host-built cwd and launchId', async () => { /* write a hook line; pollOnce; dispatch called once with cwd === expect.worktreePath */ });
it('runs the CLI marker once for an own-stage marker and never dispatches it as a hook', async () => { /* runMarker called with 'impl'; dispatch not called */ });
it('drops a forged other-ticket marker and logs [bridge] ... ticket 8 != 7', async () => { /* runMarker not called; debug has the line */ });
it('drops a forged other-stage marker', async () => {});
it('logs a failing marker run but keeps tailing', async () => { /* runMarker resolves {code:1}; a following hook line is still dispatched */ });
it('a runMarker rejection is swallowed and logged', async () => {});
```

`bridge.e2e.test.ts` (`*.e2e.test.ts`, headless, in-memory store via `openStore(':memory:')`, fake runner = just a tmp bridge dir; a helper plays "the sandbox" by appending lines):

```ts
it('a needs-you written inside the "sandbox" dir reaches the amber signal', async () => {
  /* create ticket + worktree row; attachment with dispatch = (p) => dispatchHook(store, p, notify);
     append the claude PermissionRequest-shaped line (Notification/permission_prompt); pollOnce;
     expect notify called for the ticket and store agent_state needs-you */
});
it('a forged marker for another ticket is dropped and the stage does not move', async () => {});
it('the own-stage marker invokes the marker runner exactly once even if the file is re-polled', async () => {});
it('a hook line carrying a foreign cwd still lands on the OWNING ticket (cwd is rebuilt)', async () => {});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/agent/bridge/bridgeSink.test.ts` then `npx vitest run src/agent/bridge/bridge.e2e.test.ts --config vitest.integration.config.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `bridgeSink.ts`**

```ts
import type { HookPayload } from '../../hooks/dispatch.js';
import type { MarkerStage } from '../markerStage.js';
import type { BridgePaths } from './bridgeDir.js';
import { createBridgePoller, type BridgePoller } from './bridgePoller.js';
import { verifyBridgeLine, type BridgeExpectation } from './bridgeVerifier.js';

export type MarkerRunner = (stage: MarkerStage) => Promise<{ readonly code: number; readonly stderr: string }>;

export interface BridgeAttachmentDeps {
  readonly paths: BridgePaths;
  readonly expect: BridgeExpectation;
  readonly dispatch: (payload: HookPayload) => void;
  readonly runMarker: MarkerRunner;
  readonly intervalMs: number;
  readonly debug?: (message: string) => void;
}

export type BridgeAttachment = Pick<BridgePoller, 'start' | 'stop' | 'pollOnce'>;

export function createBridgeAttachment(deps: BridgeAttachmentDeps): BridgeAttachment {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const id = deps.expect.ticketId;
  const runMarker = (stage: MarkerStage): void => {
    void deps.runMarker(stage).then(
      (r) => { if (r.code !== 0) log(`ticket ${id} marker ${stage} exited ${r.code}: ${r.stderr.trim()}`); },
      (err: unknown) => log(`ticket ${id} marker ${stage} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  return createBridgePoller({
    file: deps.paths.eventsFile,
    stateFile: deps.paths.stateFile,
    intervalMs: deps.intervalMs,
    ...(deps.debug ? { debug: deps.debug } : {}),
    onLine: (line) => {
      const verdict = verifyBridgeLine(line, deps.expect);
      if (!verdict.ok) { log(`ticket ${id} dropped: ${verdict.reason}`); return; }
      if (verdict.event.kind === 'hook') deps.dispatch(verdict.event.payload);
      else runMarker(verdict.event.stage);
    },
  });
}
```

The production `runMarker` (built in the `src/extension/ops/` wiring, not in the sink) spawns `process.execPath` with `[cliEntry, 'stage', stage, 'pass', '--db', dbPath, '--manifest', manifestPath, '--ticket', ticketKey]` through the existing `spawnHeadlessCli` (async; same helper the runners use). Never `spawnSync`.

`session.ts` change, concretely: replace `...(inSandbox ? {} : { hookChannel })` with

```ts
...(inSandbox
  ? options.bridge ? { hookChannel: sandboxHookChannel(options.bridge.paths, hookChannel.launchId) } : {}
  : { hookChannel }),
```

where `sandboxHookChannel` lives in `bridgeDir.ts`:

```ts
export function sandboxHookChannel(paths: BridgePaths, launchId: string | undefined): HookChannel {
  return {
    endpointUrl: `file://${paths.runDir}/events.ndjson`,
    configDir: paths.dir,
    runDir: paths.runDir,
    ...(launchId !== undefined ? { launchId } : {}),
  };
}
```

Before `placeInteractive`: `if (inSandbox && options.bridge) await ensureBridgeDir(options.bridge.paths);` and pass `bridgeDir: options.bridge.paths.dir` in the spec. `onLaunchPrepared` already runs for any non-undefined `launchId`, so the launch-intent handshake works unchanged for sandbox sessions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/bridge src/ui/session.test.ts` and the e2e file with the integration config.
Expected: PASS. Add to `session.test.ts`: sandbox launch with `bridge` → `placeInteractive` spec carries `bridgeDir` and the built command has the file channel; sandbox launch WITHOUT `bridge` → no hook channel (today's behaviour, pinned).

- [ ] **Step 5: Commit**

```bash
git add src/agent src/ui src/extension
git commit -m "feat(bridge): verified sandbox events reach dispatchHook and the done-marker CLI"
```

---

### Task 6: Lifecycle — attach on launch, dispose removes, boot re-attaches

**Files:**
- Create: `src/agent/bridge/bridgeRegistry.ts`
- Modify: `src/extension/ops/bootSweeps.ts`, `src/extension/ops/sandboxSyncOps.ts` (dispose path), and the launch wiring from Task 5
- Test: `src/agent/bridge/bridgeRegistry.test.ts`, `src/extension/ops/bootSweeps.test.ts` (extend)

**Interfaces:**
- Consumes: `createBridgeAttachment`, `bridgePaths`, `ensureBridgeDir`, `removeBridgeDir`, `listBridgeTicketIds`.
- Produces:
  - `export interface BridgeRegistry { attach(ticketId: number): Promise<BridgePaths>; detach(ticketId: number): Promise<void>; dispose(ticketId: number): Promise<void>; sweep(openTicketIds: ReadonlySet<number>): Promise<{ readonly reattached: number[]; readonly removed: number[] }> }`
  - `export function createBridgeRegistry(deps: { root: string; build: (ticketId: number, paths: BridgePaths) => BridgeAttachment | undefined; debug?: (m: string) => void }): BridgeRegistry`
  - `attach` is idempotent (second call returns the same paths, one poller); `detach` stops the poller and keeps the dir (terminal closed — the sandbox lives on, `arch:AC-32`); `dispose` = detach + `removeBridgeDir`; `build` returns `undefined` for a ticket that no longer exists (nothing attached).

- [ ] **Step 1: Write the failing tests**

```ts
it('attach is idempotent: one attachment, one start()', async () => {});
it('detach stops the poller but leaves events.ndjson (sandbox keeps running)', async () => {});
it('dispose stops the poller and removes the dir and the offset state', async () => {});
it('sweep re-attaches a bridge dir whose ticket is open', async () => { /* dir exists for 3; open={3} → reattached [3], poller started */ });
it('sweep removes a bridge dir whose ticket is closed or unknown', async () => { /* dir for 9; open={} → removed [9], dir gone */ });
it('sweep is safe on an empty root', async () => {});
it('sweep never throws: a build() that throws is logged and skipped', async () => {});
```

`bootSweeps.test.ts`: the boot sequence calls `registry.sweep(openTicketIds)` after `reconcileOnStart`, once, and a rejection is logged via `deps.logError` without aborting later sweeps (match the existing sweep tests' pattern in that file).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/agent/bridge/bridgeRegistry.test.ts`; Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { bridgePaths, ensureBridgeDir, listBridgeTicketIds, removeBridgeDir, type BridgePaths } from './bridgeDir.js';
import type { BridgeAttachment } from './bridgeSink.js';

export interface BridgeRegistryDeps {
  readonly root: string;
  readonly build: (ticketId: number, paths: BridgePaths) => BridgeAttachment | undefined;
  readonly debug?: (message: string) => void;
}

export interface BridgeRegistry {
  attach(ticketId: number): Promise<BridgePaths>;
  detach(ticketId: number): Promise<void>;
  dispose(ticketId: number): Promise<void>;
  sweep(openTicketIds: ReadonlySet<number>): Promise<{ readonly reattached: number[]; readonly removed: number[] }>;
}

export function createBridgeRegistry(deps: BridgeRegistryDeps): BridgeRegistry {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const live = new Map<number, BridgeAttachment>();

  const attach = async (ticketId: number): Promise<BridgePaths> => {
    const paths = bridgePaths(deps.root, ticketId);
    if (live.has(ticketId)) return paths;
    await ensureBridgeDir(paths);
    const attachment = deps.build(ticketId, paths);
    if (attachment) { live.set(ticketId, attachment); attachment.start(); }
    return paths;
  };
  const detach = async (ticketId: number): Promise<void> => {
    const a = live.get(ticketId);
    live.delete(ticketId);
    if (a) await a.stop();
  };
  const dispose = async (ticketId: number): Promise<void> => {
    await detach(ticketId);
    await removeBridgeDir(bridgePaths(deps.root, ticketId));
  };
  const sweep: BridgeRegistry['sweep'] = async (open) => {
    const reattached: number[] = [];
    const removed: number[] = [];
    for (const id of await listBridgeTicketIds(deps.root)) {
      try {
        if (open.has(id)) { await attach(id); reattached.push(id); }
        else { await dispose(id); removed.push(id); }
      } catch (err) {
        log(`sweep skipped ticket ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { reattached, removed };
  };
  return { attach, detach, dispose, sweep };
}
```

Wiring: the launch wiring (Task 5) calls `registry.attach(ticketId)` and passes the returned `paths` as `options.bridge`; closing a terminal calls `registry.detach`; `SessionRunner.dispose` call sites in `sandboxSyncOps.ts` also call `registry.dispose(ticketId)` AFTER the runner's own dispose (so a failed `sbx rm` leaves the evidence dir for a retry, never an orphaned sandbox with a deleted dir). `build` closes over `store`, `dispatchHook` deps (`notify`, `shouldApplyState`, `sessionProviderFor`, `recorder`, `debug`) — reuse the exact closures the HTTP endpoint is constructed with so the generation barrier and recorder are shared (as `agyWatchDispatch` does, `arch:AC-…` agy sweep) — and an `expect` whose `stage()` reads `deriveStageCurrent`/ticket row and `sessionId()` reads the ticket's captured agent session id.

- [ ] **Step 4: Run tests** — `npx vitest run src/agent/bridge src/extension/ops/bootSweeps.test.ts src/extension/ops/ratchet.test.ts`; Expected: PASS (the ratchet test enforces that `extension.ts` handlers stay bindings).

- [ ] **Step 5: Commit**

```bash
git add src/agent src/extension
git commit -m "feat(bridge): attach/detach/dispose lifecycle and boot re-attach of live bridges"
```

---

### Task 7: Docs, mutation gate, manual F5

**Files:**
- Modify: `docs/agent-cores/HOOK-CONTRACT.md` (`core:HOOK-02` row note: "sandbox: file channel"; `core:HOOK-03`: no reply channel in a sandbox → typed-pointer sweep; `core:HOOK-04` add rule 6)
- Modify: `docs/arch/agent-cores.md` (`arch:AC-32` "Known gaps": strike the hook-channel clause, keep MCP; add `arch:AC-34` "Sandbox evidence bridge")
- Modify: `CLAUDE.md` Architecture list only if a new binding invariant appears (it does not; keep CLAUDE.md untouched)

- [ ] **Step 1: Write `arch:AC-34`** (keyed block: `## [@arch:AC-34] Sandbox evidence bridge — a sandbox reaches the host through one verified file` … `END_DOC_BLOCK: [@arch:AC-34]`), covering exactly: Decisions 1-8 above in prose; the line schema; the verifier's accept rules (own ticket, own markable stage, bound session id; `cwd` and `launchId` rebuilt by the host); the bounds; "the bridge never carries a verdict"; the residual risk (a sandboxed agent can still emit a valid own-stage `impl` marker early — identical to today's host agent; `assertMarkerHasWork` and the gates remain the check); Known gaps (no reply channel, no MCP, ports/services/gates Increment 4). Add rule 6 to `HOOK-04`: "A sandbox channel is a transport of the SAME shared script, never a second script; an adapter composes command paths from `runDir ?? configDir`."

- [ ] **Step 2: Validate doc structure**

Run: `grep -E '^## \[@' docs/arch/agent-cores.md | grep -E 'AC-3[1-4]'` and `awk -v id="[@arch:AC-34]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/arch/agent-cores.md | tail -3`
Expected: four headings; the awk output ends with `END_DOC_BLOCK: [@arch:AC-34]`.

- [ ] **Step 3: Mutation + gates**

Run: `npx stryker run --mutate src/extension/ops/*.ts --mutate src/agent/bridge/*.ts` then `node scripts/mutationSummary.mjs | head -30`
Expected: score ≥ 85 on touched `src/extension/**`; add tests for any survivor in `bridge*.ts` (`src/agent/**` is not gated but keep ≥ 85 as the target). Then once: `npm run -s typecheck`, `npm run -s lint:react`, `npm run -s test:unit`, `npx vitest run --config vitest.integration.config.ts src/agent/hookBridge.integration.test.ts src/agent/bridge`.
Expected: all green.

- [ ] **Step 4: Manual F5 (exit criterion; record results in the PR description, not in code)**

1. Manifest `agentBackend: sbx`; open a claude ticket session. Trigger a permission prompt → the sidebar glyph turns amber (needs-you). Run `node /karst-bridge/<id>/claude/emit-marker.cjs /karst-bridge/<id>/events.ndjson impl` (or the seeded marker command) → the ticket leaves `impl` (only with real changes in the branch; otherwise the refusal appears in the output log as `[bridge] … marker impl exited 1`).
2. Manifest `agentBackend: docker`; opencode session: same two checks.
3. Forge test: from inside the sandbox append `{"v":1,"kind":"marker","ticket":<other id>,"stage":"impl"}` → output log shows `[bridge] ticket <id> dropped: ticket <other> != <id>`; the other ticket does not move.
4. Close the terminal → poller stops, dir remains; `karst.sandbox.dispose` → dir and state gone.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs(bridge): AC-34 sandbox evidence bridge, HOOK sandbox channel"
```

---

## Exit criteria

- Suites green (unit + integration + the e2e file); `typecheck`, `lint:react` clean; Stryker ≥ 85 on touched `src/extension/**`.
- Task 7 step 4 manual F5 passes for an sbx claude session and a docker opencode session.
- `grep -rn "spawnSync\|execSync" src/agent/bridge src/extension/ops` finds nothing new.

## Out of scope

Ports/services/gates inside the sandbox (Increment 4), archive/recovery/provider switch (5), rollout/default flip (6), agy (no hook channel), MCP tools inside the sandbox, a mail-reply channel for sandbox sessions.

## Self-Review

- **Spec coverage:** Decision 1 → Tasks 2, 3; Decision 2 → Task 1 (ticket/stage/session) + Task 5 e2e; Decision 3 → Task 4 + Task 7 docs; original task order 1-6 maps to Tasks 1, 2, 3, 4, 5, 6; docs/Stryker/F5 exit criteria → Task 7. Original item "bridgeDir.ts + poller offset persisted" → Task 2.
- **Placeholders:** the two intentionally deferred facts (sbx extra-workspace syntax; the exact adapter command-composition sites) each have a concrete discovery step with an expected result and a fallback, not a TODO. Two test bodies in Tasks 4-6 are described by assertion in a comment where they mirror an adjacent fully-written test; the executor writes them in the same shape.
- **Type consistency:** `BridgeExpectation`, `BridgeVerdict`, `BridgePaths` (`dir`, `eventsFile`, `stateFile`, `runDir`), `BridgeAttachment`, `MarkerRunner`, `HookChannel.runDir` and `InteractiveLaunchSpec.bridgeDir` are used with the same names in every task. `Verdict` from `model/types.ts` is deliberately not reused (`BridgeVerdict`).
