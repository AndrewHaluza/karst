# Execution Plan: Claude Interactive Token Usage via the Session Transcript Watch

## Goal

Measure interactive Claude session token consumption and record it in karst's existing
token ledger. Claude Code's documented hooks carry no token counters, but Claude Code
writes a per-session JSONL transcript file whose `assistant` messages carry per-API-call
token usage. A periodic sweep reads that file (read-only), sums the messages into a
cumulative per-session sample, and feeds it through the SAME `UsageUpdate` → store seam
that the codex/opencode bridges already use. The `interactiveUsage` capability for
`claude` flips from `false` to `true`, so the UI renders measured token numbers instead
of "Token usage not available for this provider".

## Current State

Verified facts (all confirmed against the installed Claude Code `2.1.231` and karst source):

- Claude Code stores one session transcript per session at
  `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The encoded-cwd dir name is the
  cwd with every char outside `[a-zA-Z0-9-]` replaced by `-` (verified:
  `/Users/nd/Work/projects/karst` → `-Users-nd-Work-projects-karst`; the worktree
  `/Users/nd/Work/projects/karst/.karst/worktrees/869e48tv6-feat-...` →
  `-Users-nd-Work-projects-karst--karst-worktrees-869e48tv6-feat-...`).
- The transcript filename equals the session id, and the `sessionId` captured inside the
  file equals the `session_id` karst already captures at `SessionStart` and persists on
  `tickets.session_id` (`src/store/tickets.ts`, `setSessionId`). So
  `tickets.sessionId` IS the transcript filename.
- Each line is one JSONL record. Only lines with `type === 'assistant'` carry
  `message.usage`, with keys `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, plus a stable top-level
  `uuid` per message. These counts are per-API-call (per message), NOT cumulative.
- Claude's official hooks reference documents `transcript_path` as a COMMON input field
  on every hook event, but the transcript is written asynchronously and may lag the
  in-memory conversation at `Stop` time — which is why this plan reads on a sweep
  interval, not at `Stop` time.
- karst's interactive token ledger already exists and is provider-agnostic:
  - `src/store/interactiveUsageSamples.ts` — `appendInteractiveUsageSample(store, {ticketId, sample})`
    appends a CUMULATIVE per-session sample and writes the delta to `token_usage`. It is
    idempotent on `(provider, provider_session_id, source_event_id)`, resolves the
    process binding (impl segment vs fix) inside one transaction, and treats a decrease
    as a new counter epoch.
  - `src/hooks/dispatch.ts` — `dispatchHook` routes a `hook_event_name: 'UsageUpdate'`
    payload through `ingestUsageUpdate` → `normalizeInteractiveUsage` →
    `appendInteractiveUsageSample`. This is exactly the seam the codex/opencode bridges
    post to.
  - `src/agent/interactiveUsage.ts` — `normalizeInteractiveUsage` narrows an untrusted
    wire object `{ event_id, input, output, cache_read?, cache_write?, total? }` into the
    sample shape.
- The precedent for reading a provider's own on-disk store is the Antigravity sweep:
  `src/agent/agyConversationWatch.ts` (pure module + `agyWatchTick` diff) wired in
  `src/extension.ts` at lines ~3024-3102 (`runAgyConversationWatch`, 10s interval,
  per-ticket state map cleared in the terminal-close callback at line ~796).
- Capability truth lives in ONE table and is consumed on read:
  - `src/agent/provider.ts` `PROVIDER_INTERACTIVE_USAGE = { claude: false, codex: true, antigravity: false, opencode: true }`.
  - `src/model/inside/agent.ts` `measuresSessionUsage` reads it; `tokenView` renders
    `{ state: 'unavailable', title: 'Token usage not available for this provider' }`
    when false, never a zero.
- Tests currently pinning `claude` as unmeasurable:
  - `src/agent/claude.test.ts:125-127` (`interactiveUsage` toBe(false))
  - `src/agent/settings.test.ts:62-79` (`providerInteractiveUsage('claude')` → false; the
    "registers lifecycle events only — Claude never gets a UsageUpdate hook" test at
    :54-60 stays VALID — we do NOT register a hook; we read a file)
  - `src/model/inside/agent.test.ts:378-411` (two "unavailable" rendering tests using
    provider `claude`)
  - `src/agent/antigravity.ts:121-127` and `antigravity.test.ts:39-45` remain `false` —
    do not touch.

## Target State

- New pure module `src/agent/claudeTranscriptWatch.ts` that:
  - resolves `~/.claude/projects` (honoring `CLAUDE_CONFIG_DIR`, default
    `~/.claude/projects`);
  - derives the transcript path from a worktree cwd + session id via the verified
    encoding `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`;
  - parses a transcript into a cumulative `ClaudeTranscriptUsage` sample keyed by the
    LAST usage-bearing assistant message's `uuid`;
  - diffs per-ticket watch state and emits `{ kind: 'UsageUpdate', usage: { event_id,
    input, output, cache_read, cache_write } }` events (mirroring `agyWatchTick`).
- `src/extension.ts` gets a `runClaudeTranscriptWatch` sweep (10s interval) that iterates
  window terminals identified as provider `claude`, reads the transcript (async, gated by
  an mtime+size fingerprint so unchanged files are not re-read), and dispatches the
  emitted events through the SAME `dispatchHook` call, closures and `UsageUpdate` seam as
  the codex/opencode bridges. Per-ticket state is cleared in the existing terminal-close
  callback.
- `PROVIDER_INTERACTIVE_USAGE.claude` and `ClaudeAdapter.capabilities.interactiveUsage`
  flip to `true`; the UI therefore renders measured token numbers for claude sessions.
- No database schema change, no migration, no new dependency, no hook registration change,
  no `cli/guide.ts` change.

## Scope

### In Scope
- The new transcript-read module and its unit tests.
- The extension sweep wiring that feeds transcript-derived `UsageUpdate` events into the
  existing store seam.
- The capability flip (provider table + claude adapter) and every test that pins it.
- Doc-comment updates that are now factually wrong (`interactiveUsage.ts` top comment,
  `model/inside/agent.ts` comment, `docs/glossary.md` Interactive usage entry).

### Out of Scope
- Adding `transcript_path` to `HookPayload`/`parseHookPayload` (the path is derived, not
  read from the untrusted payload).
- Any change to `src/store/interactiveUsageSamples.ts`, `src/hooks/dispatch.ts`,
  `src/agent/interactiveUsage.ts` logic, or the DB schema.
- Registering a `UsageUpdate` hook for claude in `src/agent/settings.ts` (none is needed;
  the sweep is not a hook).
- Live dashboard refresh on each usage sample (the store write happens; the existing
  refresh triggers propagate it, exactly like the codex/opencode bridges).
- Cross-window sweeps: each window sweeps ITS OWN terminals, same as the agy watch.
  The store dedupes on event id, so overlap is harmless.
- Changing the Antigravity capability (stays `false`).
- Rewriting dated design docs under `docs/superpowers/` (AGENTS.md: they are a record).

## Key Decisions

1. **Channel = the on-disk transcript, read on a sweep, NOT a hook.** Claude's hooks
   carry no counters; the transcript does. The file may lag at `Stop` time, so a 10s
   sweep re-reads until it catches up — same rationale as the agy conversation watch.
2. **Transcript path is DERIVED, never trusted from the payload.** `transcript_path`
   arrives on hook events but is agent-authored input; deriving
   `<projectsDir>/<encode(cwd)>/<session_id>.jsonl` from the worktree cwd + the already-
   persisted `tickets.session_id` avoids widening the untrusted `HookPayload` surface.
   The encoding `replace(/[^a-zA-Z0-9-]/g, '-')` is pinned by unit tests against the
   real captured dir names.
3. **Cumulative-sum samples keyed by the LAST message uuid.** The store model is
   "cumulative sample, delta since last persisted observation". The transcript's
   per-message usage is summed across the whole file to make the cumulative sample; the
   last usage-bearing assistant message's `uuid` is the `event_id` (idempotency key).
   A re-sweep of an unchanged file yields the same event id → the store rejects it as a
   duplicate (or `claudeTranscriptTick` emits nothing at all).
4. **Dispatch through `dispatchHook` with a `UsageUpdate` payload**, passing the same
   `notifyHook`, `shouldApplyHookState`, `sessionProviderFor`, `hookChannelRecorder`
   closures the agy sweep uses. This reuses worktree→ticket resolution, the generation
   barrier, provider resolution, and the store's attribution/baseline/delta logic — the
   extension adds no second path into the ledger.
5. **Async file read gated by an mtime+size fingerprint.** The extension host must not
   block on a potentially large transcript every 10s. `statSync` (cheap) compares against
   the last read's `{mtimeMs,size}`; the file is `await readFile` only when changed.
6. **A usage-bearing message contributes only when every required count is valid.** A
   count is a finite non-negative number (the `interactiveUsage.ts` rule). Required
   `input_tokens`/`output_tokens` absent-or-invalid, a present-but-invalid cache key, or
   a missing/non-string `uuid` → the whole message is skipped (nothing fabricated, no
   `0` invented, no idempotency key guessed). Optional absent cache keys read as `0`.
7. **Capability flip is the last behavioral task**, so the UI and pinned tests change
   exactly when the data path is real.

## Execution Order

### Task 1: Implement `claudeTranscriptWatch.ts` (pure module) and its tests

#### Objective
Create the vscode-free, host-agnostic module that locates, reads, parses, and diffs
Claude session transcripts into closed `UsageUpdate` events, with full unit-test
coverage. This is the whole data source; nothing else in the plan invents Claude numbers.

#### Files
- `src/agent/claudeTranscriptWatch.ts` — CREATE. The new module.
- `src/agent/claudeTranscriptWatch.test.ts` — CREATE. Unit tests (TDD: write tests
  first, watch them fail for the intended reason, then implement).

#### Implementation

Add to `src/agent/claudeTranscriptWatch.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Relative project-dir root under the config dir (default `~/.claude`). */
export const CLAUDE_PROJECTS_RELATIVE = join('projects');

/**
 * The Claude Code config root's `projects/` dir. Honors `CLAUDE_CONFIG_DIR`
 * (the official override), else `<home>/.claude/projects`.
 */
export function resolveClaudeProjectsDir(
  env?: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env?.CLAUDE_CONFIG_DIR;
  const configDir =
    typeof override === 'string' && override.length > 0 ? override : join(home, '.claude');
  return join(configDir, CLAUDE_PROJECTS_RELATIVE);
}

/**
 * The transcript project-dir name: every char outside `[a-zA-Z0-9-]` becomes `-`.
 * Verified against Claude Code 2.1.231:
 *   `/Users/nd/Work/projects/karst` -> `-Users-nd-Work-projects-karst`
 *   `.../karst/.karst/worktrees/<slug>` -> `-Users-nd-Work-projects-karst--karst-worktrees-<slug>`
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** The session's transcript file path. `sessionId` is the file basename. */
export function transcriptPathFor(projectsDir: string, cwd: string, sessionId: string): string {
  return join(projectsDir, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}
```

Define and export:

```ts
/** One parsed, cumulative session sample from a transcript. */
export interface ClaudeTranscriptUsage {
  /** uuid of the LAST usage-bearing assistant message — the idempotency key. */
  eventId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one sweep observed for one transcript. */
export interface ClaudeTranscriptSnapshot {
  transcriptPath: string;
  usage: ClaudeTranscriptUsage | null;
}

/** Per-ticket memory of the last observed transcript. */
export interface ClaudeWatchState {
  transcriptPath: string | null;
  eventId: string | null;
  /** mtime+size of the last read transcript. SWEEP-maintained — this module is fs-free, so it only ever reads/writes this field's value via the state object the sweep passes; the module never sets it. */
  fingerprint: { mtimeMs: number; size: number } | null;
}

export type ClaudeWatchEvent = {
  kind: 'UsageUpdate';
  usage: {
    event_id: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
};
```

Implement `parseClaudeTranscript(text: string): ClaudeTranscriptUsage | null`:

1. Split `text` on `'\n'`. For each non-empty line:
   - `JSON.parse` in a try/catch; an unparseable line (a truncated mid-write record) is
     skipped, never fatal.
   - If `record.type !== 'assistant'`, skip. Non-assistant lines (user/system/
     last-prompt/mode/attachment/file-history-snapshot/ai-title/…) carry no usage.
   - `usage = (record.message as Record<string, unknown> | null | undefined)?.usage`. If
     `record.message` is not an object or `usage` is not a plain object, skip the line.
   - Local rule `count(v: unknown): number | null` = `typeof v === 'number' &&
     Number.isFinite(v) && v >= 0 ? v : null`.
   - `const input = count(usage['input_tokens']); const output = count(usage['output_tokens']);`
     If either is `null`, skip the line.
   - `const cacheRead = count(usage['cache_read_input_tokens']);`
     `const cacheWrite = count(usage['cache_creation_input_tokens']);`
     If `'cache_read_input_tokens' in usage` and `cacheRead === null`, skip the line.
     If `'cache_creation_input_tokens' in usage` and `cacheWrite === null`, skip the line.
     (Absent key → undefined → `count` returns `null` → reads as `0`; PRESENT but
     non-count → message skipped, never coerced to `0`.)
   - If `record.uuid` is not a non-empty string, skip the line (no idempotency key).
   - Accumulate `input += input`, `output += output`,
     `cacheRead += cacheRead ?? 0`, `cacheWrite += cacheWrite ?? 0`; set
     `lastUuid = record.uuid`.
2. Return `null` when no message contributed (no `lastUuid`); otherwise
   `{ eventId: lastUuid, input, output, cacheRead, cacheWrite }` — CUMULATIVE over the
   whole file, keyed by the last contributing message.

Implement `claudeTranscriptTick(state: ClaudeWatchState, snapshot: ClaudeTranscriptSnapshot | null): ClaudeWatchEvent[]`:

- `snapshot === null` → return `[]` (session may not have written a transcript yet).
- If `snapshot.transcriptPath !== state.transcriptPath` → reset `state.transcriptPath =
  snapshot.transcriptPath` and `state.eventId = null` (a new conversation).
- `snapshot.usage === null` → return `[]` (file exists, no usable usage yet; state
  fingerprint is handled by the sweep, not here).
- If `snapshot.usage.eventId === state.eventId` → return `[]` (no new spend).
- Else set `state.eventId = snapshot.usage.eventId` and return
  `[{ kind: 'UsageUpdate', usage: { event_id: u.eventId, input: u.input, output: u.output, cache_read: u.cacheRead, cache_write: u.cacheWrite } }]`
  where `u = snapshot.usage`.

#### Constraints
- Import ONLY `node:os` and `node:path`. No `vscode`, no better-sqlite3, no
  `node:fs`, no `node:child_process` (keeps `diagnostics/nonInterference.test.ts` green
  and the module importable by read-only consumers).
- No interaction with the store or dispatch; the sweep does that.
- Keep the file under ~400 lines.

#### Edge Cases
- **Missing transcript file** (session just started, no `assistant` message yet): sweep
  passes `null` snapshot → tick returns `[]`.
- **Truncated final line** (mid-write): skipped via JSON.parse failure; earlier lines
  still parsed; the completed line is picked up by a later sweep.
- **Present-but-invalid counter** (`input_tokens: "lots"`, negative, NaN): that message
  is skipped entirely (required counts null). A present-but-invalid optional cache key
  also skips the message. Absent cache keys read as `0`.
- **Assistant message without `uuid`**: skipped (cannot be the idempotency key).
- **No usage-bearing message in the file**: returns `null`.
- **Counter decrease** (e.g. transcript rewrite/compaction): handled downstream by the
  store (`hasCounterDecrease` → new epoch). The module simply reports the current
  cumulative file contents.
- **Same file, no new spend** (only user/system lines appended): `eventId` unchanged →
  tick returns `[]`.
- **`CLAUDE_CONFIG_DIR` unset**: default `~/.claude/projects`.

#### Verification

New file `src/agent/claudeTranscriptWatch.test.ts` with these cases (all pure, no fs,
no store):

1. `resolveClaudeProjectsDir` honors `CLAUDE_CONFIG_DIR` override; else
   `~/.claude/projects` (pass `env`/`home` args).
2. `encodeClaudeProjectDir` maps the two real captured names from the doc comment
   (base repo path and the worktree path) to their exact encoded forms.
3. `transcriptPathFor` joins `projectsDir`, encoded cwd, and `<sessionId>.jsonl`.
4. `parseClaudeTranscript` parses a VERBATIM multi-line transcript fixture (use the real
   shapes captured in this environment: an `assistant` line carrying
   `message.usage` with `input_tokens`/`output_tokens`/`cache_read_input_tokens`/
   `cache_creation_input_tokens`/`uuid`; a `user` line; a `last-prompt` line; a second
   `assistant` line). Asserts: cumulative `input`/`output`/`cacheRead`/`cacheWrite`
   sums across BOTH assistant lines; `eventId` equals the second assistant line's `uuid`.
5. `parseClaudeTranscript` returns `null` for: empty string; only non-assistant lines;
   an assistant line whose usage is absent; an assistant line whose `uuid` is missing.
6. `parseClaudeTranscript` skips a truncated/unparseable line but still sums the
   surrounding valid lines (the fixture includes a line like `{"type":"assistant","uuid":`).
7. `parseClaudeTranscript` skips a message with a present-but-invalid counter (e.g.
   `input_tokens: "lots"`) — the message contributes nothing and its uuid is not used.
8. `claudeTranscriptTick`: `null` snapshot → `[]`; first snapshot with usage → one
   `UsageUpdate` with the exact wire object (event_id/input/output/cache_read/
   cache_write); same snapshot again → `[]`; a NEW snapshot (same path, later eventId,
   higher cumulative counts) → one event with the new cumulative numbers; a snapshot on
   a DIFFERENT transcriptPath → one event (session change). Seed every state with
   `{ transcriptPath: null, eventId: null, fingerprint: null }`.

```bash
npx vitest run src/agent/claudeTranscriptWatch.test.ts
```

Expected: all new tests pass; no other suite touched.

#### Completion Criteria
- [ ] `src/agent/claudeTranscriptWatch.ts` exists with the five exported symbols above.
- [ ] `src/agent/claudeTranscriptWatch.test.ts` passes with the eight cases above.
- [ ] The module imports only `node:os`/`node:path` and contains no store/dispatch logic.
- [ ] `npx vitest run src/agent/claudeTranscriptWatch.test.ts` is green.

---

### Task 2: Wire the claude transcript watch sweep into `extension.ts`

#### Objective
Add the periodic sweep that finds claude sessions in this window, reads their
transcripts, and dispatches transcript-derived `UsageUpdate` events through the existing
`dispatchHook` seam — so they land in the interactive-usage ledger attributed to the
correct process run/segment.

#### Files
- `src/extension.ts` — MODIFY: add imports, per-ticket state map, the sweep function,
  its interval, and the terminal-close cleanup line.

#### Implementation

1. Add the module import after the agy import block (currently `src/extension.ts:120-127`):

```ts
import {
  resolveClaudeProjectsDir,
  transcriptPathFor,
  parseClaudeTranscript,
  claudeTranscriptTick,
  type ClaudeTranscriptSnapshot,
  type ClaudeWatchState,
} from './agent/claudeTranscriptWatch.js';
```

2. Add `statSync` to the existing `node:fs` import and add a `readFile` import from
   `node:fs/promises` (check the file's current `node:fs` import first and extend it
   rather than adding a second `node:fs` import).

3. Next to the agy state map declaration (`src/extension.ts:711`, `const agyWatchStates = ...`),
   add:

```ts
const claudeTranscriptStates = new Map<number, ClaudeWatchState>();
```

4. In the terminal-close callback, immediately after
   `agyWatchStates.delete(ticketId);` (`src/extension.ts:796`), add:

```ts
claudeTranscriptStates.delete(ticketId);
```

5. Immediately after the agy sweep block (which ends at `src/extension.ts:3102`, after
   `context.subscriptions.push({ dispose: () => clearInterval(agyWatchTimer) });`),
   insert the following sweep (mirroring the agy sweep's structure, closures and error
   handling; uses `notifyHook`, `shouldApplyHookState`, `sessionProviderFor`,
   `hookChannelRecorder`, `logError`, `terminalIdentity`, `listWorktreesByTicket`,
   `getTicket`, `localStore`, `dispatchHook`, `HookPayload` — all already in scope at
   that point in the file):

```ts
// Claude interactive usage watch: Claude's documented hooks carry no token
// counters, but Claude Code writes a per-session JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl whose `assistant` messages
// carry per-API-call token usage (input_tokens/output_tokens/
// cache_read_input_tokens/cache_creation_input_tokens) with a stable message
// uuid. The sweep reads that file (read-only, like the agy conversation DB),
// sums the messages into a CUMULATIVE session sample keyed by the LAST
// message's uuid, and posts it through the SAME UsageUpdate seam and closures
// as the codex/opencode bridges — attribution (impl segment vs fix), the
// generation barrier, and the store's cumulative-delta ledger are shared. A
// re-sweep of an unchanged transcript emits nothing; the store dedupes on event
// id anyway. Session end -> the terminal-close callback clears the watch state.
// Interactive usage is not a liveness signal: nothing here touches agent_state.
const CLAUDE_TRANSCRIPT_WATCH_INTERVAL_MS = 10_000;
let claudeTranscriptWatchRunning = false;
const runClaudeTranscriptWatch = async (): Promise<void> => {
  if (claudeTranscriptWatchRunning) return;
  claudeTranscriptWatchRunning = true;
  try {
    const projectsDir = resolveClaudeProjectsDir();
    for (const terminal of vscode.window.terminals) {
      const named = terminalIdentity.identify(terminal);
      if (named?.identity?.provider !== 'claude') continue;
      const worktree = listWorktreesByTicket(localStore, named.ticketId)[0];
      if (!worktree) continue;
      const sessionId = getTicket(localStore, named.ticketId).sessionId;
      if (!sessionId) continue;
      const transcriptPath = transcriptPathFor(projectsDir, worktree.path, sessionId);
      let fingerprint: { mtimeMs: number; size: number } | null = null;
      try {
        const st = statSync(transcriptPath);
        fingerprint = { mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        continue; // no transcript yet — the session may not have written one
      }
      const state =
        claudeTranscriptStates.get(named.ticketId) ??
        { transcriptPath: null, eventId: null, fingerprint: null };
      if (
        state.transcriptPath === transcriptPath &&
        state.fingerprint !== null &&
        state.fingerprint.mtimeMs === fingerprint.mtimeMs &&
        state.fingerprint.size === fingerprint.size
      ) {
        continue; // unchanged since the last read — nothing new to parse
      }
      let text: string;
      try {
        text = await readFile(transcriptPath, 'utf8');
      } catch (error) {
        logError(`karst: claude transcript read failed for ticket ${named.ticketId}`, error);
        continue;
      }
      const usage = parseClaudeTranscript(text);
      const snapshot: ClaudeTranscriptSnapshot = { transcriptPath, usage };
      const events = claudeTranscriptTick(state, snapshot);
      state.fingerprint = fingerprint;
      claudeTranscriptStates.set(named.ticketId, state);
      if (events.length === 0) continue;
      for (const event of events) {
        const payload: HookPayload = {
          hook_event_name: 'UsageUpdate',
          cwd: worktree.path,
          session_id: sessionId,
          usage: event.usage,
          ...(named.launchId ? { launchId: named.launchId } : {}),
        };
        try {
          dispatchHook(
            localStore,
            payload,
            notifyHook,
            shouldApplyHookState,
            sessionProviderFor,
            hookChannelRecorder,
          );
        } catch (error) {
          logError(`karst: claude transcript usage dispatch failed for ticket ${named.ticketId}`, error);
        }
      }
    }
  } catch (error) {
    logError('karst: claude transcript usage watch failed', error);
  } finally {
    claudeTranscriptWatchRunning = false;
  }
};
void runClaudeTranscriptWatch();
const claudeTranscriptTimer = setInterval(
  () => void runClaudeTranscriptWatch(),
  CLAUDE_TRANSCRIPT_WATCH_INTERVAL_MS,
);
context.subscriptions.push({ dispose: () => clearInterval(claudeTranscriptTimer) });
```

The sweep owns `state.fingerprint`; `claudeTranscriptTick` (Task 1) touches only
`transcriptPath`/`eventId`. Task 1's tests seed state with `fingerprint: null`.

#### Constraints
- Do not modify `dispatchHook`, `ingestUsageUpdate`, the store, or the generation
  barrier. The sweep only CALLS `dispatchHook` exactly as the agy sweep does.
- Do not re-read unchanged files (fingerprint gate). Do not block on the read
  (`await readFile`).
- Keep the sweep window-scoped (`vscode.window.terminals`) like the agy watch.

#### Edge Cases
- **Terminal closed**: the existing close callback deletes the per-ticket state
  (`claudeTranscriptStates.delete(ticketId)`), so a closed session's memory dies with it.
- **Ticket has no sessionId yet** (SessionStart hook not yet processed): skip.
- **No worktree row** (adopted/unregistered): skip.
- **Transcript not yet written**: `statSync` throws → `continue`.
- **File removed mid-session** (user cleared `~/.claude`, session migration): `readFile`
  throws → logged, `continue`; the next tick re-stats and recovers when the file returns.
- **Changed file but no new spend** (non-assistant lines appended): the fingerprint
  advances, parse runs, tick emits nothing (eventId unchanged); no dispatch.
- **Extension reload**: the in-memory state map resets; the sweep re-reads the whole
  transcript. If the last message uuid is already in the store, `dispatchHook` →
  `appendInteractiveUsageSample` returns `duplicate` (no double count); if new messages
  landed during the reload, the cumulative sample delta covers exactly them.
- **Stale/foreign generation**: `shouldApplyHookState` (the generation barrier) rejects
  the payload before the store — same behavior as the bridges.

#### Verification
```bash
npm run typecheck
npx vitest run src/agent/claudeTranscriptWatch.test.ts
```
Expected: typecheck passes (the sweep compiles against the module API); the module tests
still pass. Then:
```bash
npm test
```
Expected: full suite green, including `extensionActivation.test.ts`.

#### Completion Criteria
- [ ] Imports added for the module, `statSync`, and `readFile`.
- [ ] `claudeTranscriptStates` map declared and deleted in the terminal-close callback.
- [ ] The sweep block, interval, and disposal registered after the agy sweep block.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.

---

### Task 3: Flip the claude interactive-usage capability and update every pinned test

#### Objective
Make `claude` a measured interactive-usage provider end to end (data path now real), and
update every test that pinned it as unmeasurable.

#### Files
- `src/agent/provider.ts` — MODIFY: `PROVIDER_INTERACTIVE_USAGE.claude` and its comment.
- `src/agent/claude.ts` — MODIFY: the capability comment + `interactiveUsage: true`.
- `src/agent/claude.test.ts` — MODIFY: the capability assertion.
- `src/agent/settings.test.ts` — MODIFY: the `providerInteractiveUsage('claude')`
  assertion (and only its comment; the "registers lifecycle events only" test at :54-60
  stays exactly as-is — we do NOT register a UsageUpdate hook for claude).
- `src/model/inside/agent.test.ts` — MODIFY: the two "unavailable" tests to use
  `antigravity` instead of `claude`.

#### Implementation

1. `src/agent/provider.ts` — change line 48 from `claude: false` to `claude: true`; update
   the block comment at lines 35-39 so the truth table reads: codex/opencode bridges
   emit `UsageUpdate`; claude's interactive usage is read from its session transcript by
   `claudeTranscriptWatch.ts`; antigravity has no token-bearing channel at all.
2. `src/agent/claude.ts` — replace the capability comment at lines 90-93 and set
   `interactiveUsage: true` at line 97. The comment must state: interactive usage for
   claude is measured by reading Claude Code's session transcript
   (`claudeTranscriptWatch.ts`) — the hooks remain lifecycle-only (settings.ts registers
   no `UsageUpdate` hook), the transcript is the channel.
3. `src/agent/claude.test.ts` — rename the test at lines 125-127 to assert
   `interactiveUsage` toBe(true), with a comment naming the transcript watch.
4. `src/agent/settings.test.ts` — at line 65 change the expected `interactiveUsage` for
   `claude` to `true`. Update the comment at lines 49-53 to say claude's interactive
   usage comes from the transcript watch (not a hook), so the lifecycle-only
   registration and the absent `UsageUpdate` hook remain correct.
5. `src/model/inside/agent.test.ts`:
   - Test at lines 378-394 ("renders unavailable — never a zero — for a provider with no
     per-session usage"): change `segment({ id: 1, provider: 'claude' })` to
     `segment({ id: 1, provider: 'antigravity' })`; update the comment (lines 379-381) to
     name antigravity, which has no token-bearing channel.
   - Test at lines 396-411 ("renders unavailable from the configured provider before
     anything ran"): change the configured `{ provider: 'claude', model: 'claude-opus-4-8' }`
     to `{ provider: 'antigravity', model: 'claude-opus-4-8' }`; update the comment to say
     a pending impl for an unmeasurable configured provider shows the truth about the
     provider karst will launch.

#### Constraints
- Do NOT touch `src/agent/antigravity.ts` or `antigravity.test.ts` (stays `false`).
- Do NOT touch `src/agent/settings.ts` (no hook registration change).
- Do NOT change `src/model/inside/agent.ts` logic in this task (only its comment changes
  in Task 4).

#### Edge Cases
- The model tests must still prove the UNAVAILABLE rendering exists — for a provider that
  genuinely cannot measure (antigravity). The "never a zero" invariant is preserved by
  those same tests.

#### Verification
```bash
npx vitest run src/agent/claude.test.ts src/agent/settings.test.ts src/model/inside/agent.test.ts
npm run typecheck
```
Expected: the three suites pass with the updated assertions; nothing else breaks.

#### Completion Criteria
- [ ] `PROVIDER_INTERACTIVE_USAGE.claude` is `true`.
- [ ] `ClaudeAdapter.capabilities.interactiveUsage` is `true`.
- [ ] `claude.test.ts`, `settings.test.ts`, and `model/inside/agent.test.ts` updated and
      green; `antigravity` capability untouched.

---

### Task 4: Update now-false documentation comments

#### Objective
Fix the doc comments and glossary entries that still claim claude is unmeasured.

#### Files
- `src/agent/interactiveUsage.ts` — MODIFY: top doc comment (lines 3-20), which names
  only opencode and codex as interactive-usage sources. Add that claude's interactive
  usage is also measured, read from Claude Code's session transcript by
  `claudeTranscriptWatch.ts`; the "bridge POSTs" wording must not imply claude posts
  usage events.
- `src/model/inside/agent.ts` — MODIFY: the comment at lines 456-457 ("a
  Claude/Antigravity session can never produce a token fact") → say antigravity only.
- `docs/glossary.md` — MODIFY: the **Interactive usage** entry (lines 234-237). New text:
  codex/opencode post `UsageUpdate` from their bridges; claude's interactive usage is
  read from Claude Code's session transcript by the claude transcript watch
  (`claudeTranscriptWatch.ts`); antigravity reports nothing and stays unmeasured (never
  a measured zero).

#### Constraints
- Do not change any logic in these files.
- Do not rewrite dated docs under `docs/superpowers/` (records of the time).

#### Verification
```bash
npm run typecheck
```
Expected: passes (comment-only changes). Grep to confirm no surviving "claude" claim in
those three files that says claude is unmeasured:
```bash
rg -n -i "claude" src/agent/interactiveUsage.ts src/model/inside/agent.ts docs/glossary.md
```
Expected: only accurate statements remain.

#### Completion Criteria
- [ ] `interactiveUsage.ts` top comment names the claude transcript watch.
- [ ] `model/inside/agent.ts` comment mentions only antigravity as unmeasured.
- [ ] `docs/glossary.md` Interactive usage entry reflects the claude transcript watch.
- [ ] `npm run typecheck` passes.

---

## Final Verification

1. Task order depends: Task 2 needs Task 1's module; Task 3 needs Tasks 1-2 (the data
   path) to be real; Task 4 is comment-only. Execute strictly in order 1 → 2 → 3 → 4.
2. Run the focused suites for the touched areas.
3. Run the full gates.

Commands:

```bash
npx vitest run src/agent/claudeTranscriptWatch.test.ts src/agent/claude.test.ts src/agent/settings.test.ts src/model/inside/agent.test.ts
npm run typecheck
npm test
npm run build
```

Expected:
- The four focused suites are green.
- `typecheck` passes (both tsconfigs resolve; the new module has no runtime deps).
- `npm test` (vitest, in-memory SQLite) is green — `pretest` rebuilds better-sqlite3 for
  the Node ABI automatically.
- `npm run build` compiles `tsconfig.build.json` and copies webview assets (unchanged) —
  build succeeds.

Manual end-to-end check (F5 in VS Code, Electron ABI via `dev:extension`):
1. Create/run a ticket at `impl` with provider `claude`.
2. Start an interactive claude session (it launches in the worktree with the hook
   settings, so `SessionStart` captures `session_id`).
3. Send at least one message that triggers a model call (an `assistant` turn).
4. Within ~10-20s, open the ticket's Inside view: the impl process's token row shows a
   measured number (not "Token usage not available for this provider").
5. Optionally verify the store:
   `SELECT provider, provider_session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, source_event_id FROM interactive_usage_samples;`
   shows one row per new assistant message (cumulative counts), and `token_usage` has the
   corresponding `call_site = 'implementation'` delta row.

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

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
