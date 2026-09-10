# Execution Plan: Antigravity Interactive Token Usage via the Conversation-DB Read

## Goal

Measure interactive Antigravity (agy) session token consumption and record it in karst's
existing interactive-usage ledger, so the `interactiveUsage` capability for `antigravity`
flips from `false` to `true` and the UI renders measured token numbers instead of "Token
usage not available for this provider".

This is the companion plan to
`docs/plans/2026-08-13-claude-interactive-usage-transcript-watch.md` (claude). That plan
reads Claude's session transcript; THIS plan reads agy's own conversation SQLite DB. They
share the exact same store seam, watch pattern, and capability-flip mechanics; the only
difference is the data source and its parser.

## Current State

Verified facts (all confirmed against the installed agy `1.1.12` and karst source):

- **agy DOES record token usage, contrary to the current guide.** `docs/guides/adding-agent-core.md` §14
  and `src/agent/antigravity.ts:121-122` claim "agy reports no usage in `-p` stdout and the
  watch reads no usage file. There is still no usage channel". That was verified against
  **1.1.11**. The installed **1.1.12** (`agy --version`) reports usage in two places:
  1. Headless: `agy -p "<prompt>" --output-format json` prints
     `{"conversation_id": "...", "status":"SUCCESS", "response":"...", "usage":{"input_tokens":N,"output_tokens":N,"thinking_tokens":N,"cache_read_tokens":N,"total_tokens":N}}`
     (verified live, three calls).
  2. **The conversation DB — the interactive channel.** The per-conversation SQLite DB
     (`<appdata>/conversations/<conv-id>.db`, the SAME DB the agy conversation watch
     already reads for lifecycle) stores one row per step in `steps`, and every
     model-generate step (`step_type` 15 and 23) carries a **usage submessage** in its
     `metadata` BLOB. The karst session history confirms interactive sessions write these
     DBs (e.g. `7a2a5cbf-...db` is an interactive karst session with 100+ usage-bearing
     model steps).
- **The usage submessage and its fields are now PINNED** by three controlled headless
  calls whose reported usage matches the DB exactly:
  - The `steps.metadata` BLOB is a protobuf. **Field 9 (wire type 2, tag byte `0x4a`) is a
    length-delimited submessage.** Within that submessage, varint fields are:
    - field 1 = context base (system-prompt tokens, constant per conversation; NOT usage)
    - **field 2 = input tokens for that call**
    - **field 3 = output tokens for that call** (includes thinking)
    - **field 5 = cache-read tokens for that call** (absent when 0)
    - field 6 = constant 24 (ignore)
    - field 8 = `sessionID` submessage (ignore)
    - field 9 = thinking tokens (informational; output already includes it — do not add)
    - field 10 = small per-call value (ignore)
    - field 11 = per-call id string (ignore; not needed as event id)
  - **Two steps contribute per turn** (type 15 = main generation, type 23 = a secondary
    model call). The session usage is the SUM of field 2/3/5 across ALL steps that carry
    the field-9 submessage. Verified:
    - Call 1: DB input `17846+99=17945`, output `285+3=288`, reported
      `input=17945, output=288, thinking=283, cache_read=0, total=18233`. ✓
    - Call 2: DB input `9737+99=9836`, output `288+4=292`, cache `8110`, reported
      `input=9836, output=292, thinking=283, cache_read=8110, total=10128`. ✓
    - Call 3: DB input `10132+493=10625`, output `347+5=352`, cache `8111`, reported
      `input=10625, output=352, thinking=325, cache_read=8111, total=10977`. ✓
  - `total_tokens` reported by agy = `input + output` (cache_read EXCLUDED). To be
    truthful to agy's own accounting, the wire sample must pass `total: input + output`
    explicitly; the store would otherwise derive `input+output+cacheRead`.
- The conversation DB is already opened read-only by the extension's agy sweep
  (`src/extension.ts` `runAgyConversationWatch`, ~lines 3026-3102) via
  `openAgyConversationDb(found.dbPath)`; the same `steps` table is queried for the
  `status = 9` lifecycle signal. Reading usage reuses that same open DB — no new file
  discovery is needed.
- karst's interactive token ledger is provider-agnostic and already fully wired:
  - `src/hooks/dispatch.ts` routes `hook_event_name: 'UsageUpdate'` → `ingestUsageUpdate`
    → `normalizeInteractiveUsage` → `appendInteractiveUsageSample`.
  - `src/store/interactiveUsageSamples.ts` appends CUMULATIVE per-session samples,
    computes the delta to `token_usage`, is idempotent on
    `(provider, provider_session_id, source_event_id)`, and resolves the process binding
    (impl segment vs fix) inside one transaction. It handles a counter decrease as a new
    epoch (conversation compaction / step-idx reset) and treats a resumed session's first
    observation as `baseline_only` via the confirmed launch intent's `session_origin`.
- The agy lifecycle watch already confirms the launch intent at `SessionStart` with the
  conversation id as `provider_session_id` (dispatch → `confirmSessionLaunchIntent`), so
  the store's binding resolution for antigravity implementation/fix sessions already works.
- Capability truth lives in `src/agent/provider.ts` `PROVIDER_INTERACTIVE_USAGE`:
  `{ claude: false, codex: true, antigravity: false, opencode: true }`. After the claude
  plan, claude becomes `true`; after THIS plan, antigravity becomes `true`, so every
  implemented provider measures. `measuresSessionUsage` in `src/model/inside/agent.ts`
  reads the table; `tokenView` renders `{state:'unavailable', title:'Token usage not
  available for this provider'}` only for a provider the table marks `false`.
- Tests currently pinning antigravity as unmeasurable:
  - `src/agent/antigravity.test.ts:39-45` — "pins truthful absence of interactive usage".
  - `src/agent/settings.test.ts:71-74` — `providerInteractiveUsage('antigravity')` → false.
  - `src/model/inside/agent.test.ts:378-411` — two "unavailable" rendering tests that
    currently use provider `claude` (the claude plan converts them to `antigravity`; this
    plan must resolve them to their FINAL state, see Task 4).
  - `src/model/inside/agent.ts:456-457` comment — "a Claude/Antigravity session can never
    produce a token fact" (the claude plan trims it to antigravity; this plan removes the
    claim entirely).

## Target State

- New pure module `src/agent/agyUsageWatch.ts`: a minimal protobuf walker that extracts
  the field-9 usage submessage from a `steps.metadata` BLOB, aggregates per-call usage
  across a conversation into cumulative totals, and diffs per-ticket watch state into
  `{ kind: 'UsageUpdate', usage: { event_id, input, output, cache_read, total } }`
  events (mirroring `claudeTranscriptWatch.ts` and `agyWatchTick`).
- `AgyConversationDb` in `src/agent/agyConversationWatch.ts` gains a `usage()` method that
  returns the aggregate for the conversation (cumulative input/output/cacheRead + the max
  contributing step idx as the event id), read from the SAME already-open readonly DB.
- `src/extension.ts` `runAgyConversationWatch` additionally computes the usage snapshot
  per terminal, diffs it via `agyUsageTick`, and dispatches the emitted `UsageUpdate`
  payloads through the SAME `dispatchHook` call/closures the lifecycle events use. Per
  ticket usage state is cleared in the existing terminal-close callback.
- `PROVIDER_INTERACTIVE_USAGE.antigravity` and `AntigravityAdapter.capabilities.interactiveUsage`
  flip to `true`; the UI renders measured token numbers for antigravity sessions.
- No database schema change, no migration, no new dependency, no hook registration change,
  no `cli/guide.ts` change, no change to the antigravity headless (`-p`) adapter path.

## Scope

### In Scope
- The pure usage-parsing + aggregation + tick module and its unit tests.
- The `AgyConversationDb.usage()` read and its tests.
- The extension sweep wiring that feeds conversation-DB-derived `UsageUpdate` events into
  the existing store seam.
- The capability flip (provider table + antigravity adapter) and every test/doc that pins
  antigravity as unmeasurable.
- Correcting the now-false guide claims in `docs/guides/adding-agent-core.md` §14 and the
  `antigravity.ts` adapter comment (they were written against 1.1.11).

### Out of Scope
- Changing the antigravity **headless** adapter. `runHeadless` (`antigravity.ts:228-277`)
  runs `agy -p <prompt>` in default text mode and falls back to a marked estimate; wiring
  `--output-format json` + real headless counts is a separate change with its own
  `raw`-shape implications and is NOT part of this plan.
- Adding `transcript_path`-style fields to `HookPayload` (none needed; the path is derived
  and the DB is already located).
- Any change to `src/store/interactiveUsageSamples.ts`, `src/hooks/dispatch.ts`,
  `src/agent/interactiveUsage.ts` logic, or the DB schema.
- Registering any agy hook (agy still does not execute hooks; the DB read is the channel).
- Cross-window sweeps: each window sweeps its own terminals (same as the lifecycle watch);
  the store dedupes on event id.
- Rewriting dated design docs under `docs/superpowers/` (records of the time).

## Key Decisions

1. **Channel = the conversation DB's `steps.metadata` field-9 usage submessage, read on
   the EXISTING 10s agy sweep.** agy 1.1.12 persists per-call usage there (verified); the
   extension already opens that exact DB for lifecycle. No new discovery, no hooks.
2. **Usage is the SUM of varint fields 2/3/5 across every step carrying the field-9
   submessage** (types 15 AND 23). Both steps per turn contribute (verified against three
   controlled calls). Field 1 (context base) and fields 6/8/9/10/11 are ignored.
3. **Cumulative samples keyed by the max contributing step idx.** The store model is
   "cumulative sample, delta since last persisted observation". The aggregate is the full
   session cumulative; `event_id = String(maxContributingStepIdx)` is monotonic per
   conversation and scoped by `provider_session_id`, so a re-sweep of an unchanged DB is a
   duplicate no-op and a new step yields exactly its delta. A step-idx reset (compaction)
   decreases the cumulative → the store opens a new epoch (its existing behavior).
4. **Wire `total = input + output` explicitly** (agy's reported total excludes
   `cache_read`); `cache_read` is passed separately, matching the store's independent
   cache counters and agy's own accounting.
5. **Dispatch through `dispatchHook` with a `UsageUpdate` payload**, passing the same
   `notifyHook`, `shouldApplyHookState`, `sessionProviderFor`, `hookChannelRecorder`
   closures the agy lifecycle sweep uses. The store's binding resolution, generation
   barrier, baseline decision, and delta math are all reused unchanged.
6. **The protobuf walker is strict about structure, tolerant of unknown fields.** A
   `metadata` BLOB with no field-9 submessage (non-model steps: 14, 90, 98, …) contributes
   nothing. Within the submessage, unknown fields are skipped; present varint fields are
   read as finite non-negative integers (varints are non-negative by construction). If a
   submessage is present but has no field 2 (input), that step is skipped entirely.
7. **Capability flip is the last behavioral task** (Task 4), after the data path and the
   model/rendering expectations are settled (Task 5). Because EVERY implemented provider
   then measures, the two provider-based "unavailable" rendering tests
   (`model/inside/agent.test.ts:378-411`) are obsolete in their final state: one is
   deleted, the other converted to assert the silent (not unavailable) reading for a
   configured antigravity provider. See Task 4 for the exact, order-independent edits.

## Execution Order

### Task 1: Implement `agyUsageWatch.ts` (pure module) and its tests

#### Objective
Create the vscode-free, fs-free, store-free module that parses the conversation-DB usage
submessage, aggregates per-call usage into cumulative conversation totals, and diffs
per-ticket watch state into closed `UsageUpdate` events — with unit tests pinned against
the exact captured DB bytes.

#### Files
- `src/agent/agyUsageWatch.ts` — CREATE.
- `src/agent/agyUsageWatch.test.ts` — CREATE (TDD: write tests first, watch them fail for
  the intended reason, then implement).

#### Implementation

Add to `src/agent/agyUsageWatch.ts`:

```ts
/** Per-call usage extracted from one model-generate step's metadata. */
export interface AgyStepUsage {
  input: number;
  output: number;
  cacheRead: number;
}

/** Cumulative usage for one conversation, keyed by its last contributing step idx. */
export interface AgyConversationUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Max `idx` among contributing steps — the monotonic event id. */
  lastStepIdx: number | null;
}

/** A row of the foreign `steps` table; only `idx` + `metadata` are read. */
export interface AgyStepRow {
  idx: number;
  metadata: Buffer | null;
}
```

Implement a minimal protobuf walker and the extractor:

- `parseStepUsage(metadata: Buffer | null): AgyStepUsage | null`
  - `metadata === null` → `null`.
  - Walk the top-level protobuf: read tag bytes (`field = byte >> 3`, `wire = byte & 7`).
    - wire 0: skip a varint (multi-byte continuation).
    - wire 2: read the length varint, slice the payload.
    - wire 1: skip 8 bytes. wire 5: skip 4 bytes.
    - any other wire type: stop walking the top level (return whatever was found so far).
  - When `field === 9 && wire === 2`, treat the payload as the usage submessage and walk
    it with the same reader, collecting varint values: `field 2 → input`, `field 3 →
    output`, `field 5 → cacheRead`. Skip all other fields (1, 6, 8, 9, 10, 11, …).
  - Return `null` if no field-9 submessage was found OR the submessage has no field 2
    (input). Otherwise `{ input, output: field3 ?? 0, cacheRead: field5 ?? 0 }`.

- `aggregateConversationUsage(rows: readonly AgyStepRow[]): AgyConversationUsage | null`
  - For each row, `parseStepUsage(row.metadata)`; skip `null`.
  - Sum `input`/`output`/`cacheRead`; track `lastStepIdx = max(lastStepIdx, row.idx)`.
  - Return `null` if no step contributed; else
    `{ input, output, cacheRead, lastStepIdx }`.

Define the watch diff:

```ts
export interface AgyUsageState {
  eventId: string | null;
}

export type AgyUsageEvent = {
  kind: 'UsageUpdate';
  usage: {
    event_id: string;
    input: number;
    output: number;
    cache_read: number;
    total: number;
  };
};

export function agyUsageTick(
  state: AgyUsageState,
  usage: AgyConversationUsage | null,
): AgyUsageEvent[]
```

- `usage === null` → return `[]` (no model call recorded yet).
- `eventId = String(usage.lastStepIdx)`.
- `eventId === state.eventId` → return `[]` (no new step).
- Set `state.eventId = eventId`; return
  `[{ kind: 'UsageUpdate', usage: { event_id: eventId, input: usage.input, output: usage.output, cache_read: usage.cacheRead, total: usage.input + usage.output } }]`.

#### Constraints
- Import NOTHING. Pure TypeScript, no `node:*`, no `vscode`, no better-sqlite3, no fs.
- Keep the file under ~250 lines.
- Do not read `step_payload` or any other column; only `idx` + `metadata`.

#### Edge Cases
- **Non-model steps** (types 14, 90, 98, etc. carry no field-9 submessage): `parseStepUsage`
  returns `null`; they contribute nothing.
- **`metadata` is NULL** on a model step (foreign schema, may lag): skipped this sweep,
  picked up when the row's metadata is written.
- **Submessage present but missing field 2 (input)**: that step is skipped entirely (never
  a fabricated zero).
- **Both type-15 and type-23 steps per turn**: both parsed; the SUM across all contributing
  steps equals the reported conversation usage (verified).
- **Re-sweep with no new step**: same `lastStepIdx` → `[]`.
- **New step appended**: higher idx → one event with the full cumulative numbers; the store
  computes the delta.
- **Step-idx reset / conversation compaction**: the cumulative may DECREASE; the tick still
  emits (new event id); the store's `hasCounterDecrease` opens a new epoch. The module
  simply reports the current file contents.

#### Verification

New file `src/agent/agyUsageWatch.test.ts` with these cases (all pure). The fixture bytes
below are VERBATIM from a real conversation DB created by agy 1.1.12 (`agy -p "Repeat the
word hello five times." --output-format json`, conversation `b9722f2f-3831-4c77-9167-c14fb5342645`,
which reported `input=9836, output=292, thinking=283, cache_read=8110, total=10128`). They
are the `steps.metadata` BLOB hex for the two usage-bearing steps of that conversation:

```ts
// idx=3, step_type=15 (main generation): input 9737, output 288, cache_read 8110
const TYPE15_METADATA = Buffer.from(
  '0a0b08d1e4f6d30610b0bde30e1802320c08d6e4f6d30610a8ce9efd013a0c08d6e4f6d30610f0aca6b302420c08d6e4f6d30610f0aca6b3024a4f088c0810894c18a00228ae3f301842210a0973657373696f6e494412142d33373530373633303334333632383935353739489b0250055a1755624a39616f6948494c434632386f5076365063734138588c08622430306366303937322d316631372d343865322d383263612d3663616237616230326433636a03088c08a2014e0a2434326636386230342d633632632d346638382d396365642d6264346139316564393763361003222462393732326632662d333833312d346337372d393136372d633134666235333432363435a80101d201240a100808120c08d6e4f6d3061080ffa0fd010a100803120c08d6e4f6d30610f8caa9b30282020c08d6e4f6d30610f0aca6b302',
  'hex',
);

// idx=4, step_type=23 (secondary model call): input 99, output 4, cache_read 0
const TYPE23_METADATA = Buffer.from(
  '0a0c08d6e4f6d30610c0ec90b5021805420b08d7e4f6d3061088f1b8704a47089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f724834734134622430306366303937322d316631372d343865322d383263612d366361623761623032643363a201500a2434326636386230342d633632632d346638382d396365642d62643461393165643937633610041801222462393732326632662d333833312d346337372d393136372d633134666235333432363435d201350a100801120c08d6e4f6d30610e08b91b5020a100802120c08d6e4f6d30610d8a5a5b5020a0f0803120b08d7e4f6d30610f89fb970e201491247089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f72483473413482020c08d6e4f6d3061098fc9db502',
  'hex',
);
```

1. `parseStepUsage(null)` → `null`.
2. `parseStepUsage` of a minimal non-model BLOB with no field-9 tag, e.g.
   `Buffer.from('0a0b08d1e4f6d30610d0dfe50d1805', 'hex')` → `null`.
3. `parseStepUsage(TYPE15_METADATA)` → `{ input: 9737, output: 288, cacheRead: 8110 }`.
4. `parseStepUsage(TYPE23_METADATA)` → `{ input: 99, output: 4, cacheRead: 0 }`.
5. `aggregateConversationUsage([{ idx: 3, metadata: TYPE15_METADATA }, { idx: 4, metadata: TYPE23_METADATA }])`
   → `{ input: 9836, output: 292, cacheRead: 8110, lastStepIdx: 4 }`.
6. `aggregateConversationUsage([])` and
   `aggregateConversationUsage([{ idx: 0, metadata: Buffer.from('0a0b08d1e4f6d30610d0dfe50d1805', 'hex') }])`
   → `null`.
7. `agyUsageTick`:
   - `agyUsageTick({ eventId: null }, null)` → `[]`, state unchanged.
   - `agyUsageTick({ eventId: null }, { input: 9836, output: 292, cacheRead: 8110, lastStepIdx: 4 })`
     → one event with the exact wire object
     `{ event_id: '4', input: 9836, output: 292, cache_read: 8110, total: 10128 }`, state
     updated to `{ eventId: '4' }`.
   - same usage again → `[]`.
   - a NEW usage `{ input: 10412, output: 402, cacheRead: 8111, lastStepIdx: 6 }` → one
     event with `event_id: '6'` and the new cumulative numbers; state updated.

```bash
npx vitest run src/agent/agyUsageWatch.test.ts
```

Expected: all new tests pass; no other suite touched.

#### Completion Criteria
- [ ] `src/agent/agyUsageWatch.ts` exists with `parseStepUsage`, `aggregateConversationUsage`,
      `agyUsageTick`, and the three interfaces above.
- [ ] The module imports nothing and touches no fs/store/vscode.
- [ ] `npx vitest run src/agent/agyUsageWatch.test.ts` is green.
- [ ] The parsed values in tests 3-5 match the verified agy usage exactly.

---

### Task 2: Add `AgyConversationDb.usage()` and its tests

#### Objective
Give the already-open readonly conversation-DB handle a `usage()` method that reads the
`steps` table and returns the aggregate, so the extension sweep needs no second connection.

#### Files
- `src/agent/agyConversationWatch.ts` — MODIFY: extend `AgyConversationDb` + `openAgyConversationDb`.
- `src/agent/agyConversationWatch.test.ts` — MODIFY: add the `metadata` column to the
  fixture schema and add `usage()` cases.

#### Implementation

1. Extend the `AgyConversationDb` interface (currently at `agyConversationWatch.ts:41-47`)
   with:

```ts
/** Cumulative per-call usage recorded in this conversation, or null when none yet. */
usage(): AgyConversationUsage | null;
```

2. In `openAgyConversationDb` (`agyConversationWatch.ts:51-70`), add:

```ts
const usageStmt = db.prepare('SELECT idx, metadata FROM steps ORDER BY idx');
```

and in the returned object add:

```ts
usage(): AgyConversationUsage | null {
  const rows = usageStmt.all() as { idx: number; metadata: Buffer | null }[];
  return aggregateConversationUsage(rows);
}
```

3. Add the import at the top of the file:
   `import { aggregateConversationUsage, type AgyConversationUsage } from './agyUsageWatch.js';`

#### Constraints
- Do not change the lifecycle queries (`trajectory_metadata_blob`, `steps WHERE status = 9`).
- Do not change `findConversationForWorktree` or `agyWatchTick`.
- Keep the DB opened `readonly` exactly as it is today.

#### Edge Cases
- **`steps` table empty or all metadata NULL**: `aggregateConversationUsage` returns `null`
  → the sweep emits nothing.
- **`steps.metadata` column present but rows carry `NULL`** (a step written before its
  metadata): `parseStepUsage(null)` → `null` → skipped; later sweeps pick it up.
- **A conversation DB that exists but is mid-write (WAL)**: the readonly read already works
  for the lifecycle signal; reading `metadata` uses the same connection.

#### Verification

Update `src/agent/agyConversationWatch.test.ts`:

- In `fixtureDb` (`agyConversationWatch.test.ts:15-32`), add a `metadata BLOB` column to
  the `steps` CREATE TABLE, and add an optional `usageFixtures` parameter (array of
  `{ idx, step_type, metadataHex }`) that inserts usage-bearing rows alongside the
  existing `status = 9` fixture rows. Existing lifecycle tests must still pass unchanged
  (their rows simply get `metadata NULL`).
- Add tests:
  1. `db.usage()` on a DB with no usage rows → `null`.
  2. `db.usage()` on a DB with the call-2 type-15 (idx 3) + type-23 (idx 4) rows →
     `{ input: 9836, output: 292, cacheRead: 8110, lastStepIdx: 4 }`.
  3. `db.usage()` returns the same cumulative on a second call (read-only, no mutation).

```bash
npx vitest run src/agent/agyConversationWatch.test.ts src/agent/agyUsageWatch.test.ts
```

Expected: both suites green; existing lifecycle tests still pass.

#### Completion Criteria
- [ ] `AgyConversationDb` declares `usage()` and `openAgyConversationDb` implements it.
- [ ] `agyConversationWatch.test.ts` fixture gains the `metadata` column and usage tests.
- [ ] `npx vitest run src/agent/agyConversationWatch.test.ts src/agent/agyUsageWatch.test.ts` is green.

---

### Task 3: Wire usage dispatch into the agy sweep in `extension.ts`

#### Objective
Make the existing 10s agy sweep also emit transcript-of-record `UsageUpdate` events from
the conversation DB, through the same `dispatchHook` seam the lifecycle events use — so
antigravity session usage lands in the interactive-usage ledger attributed to the correct
process run/segment.

#### Files
- `src/extension.ts` — MODIFY: imports, per-ticket usage-state map, the usage read +
  dispatch inside `runAgyConversationWatch`, and the terminal-close cleanup.

#### Implementation

1. Add to the existing agy imports (`extension.ts:120-127`):

```ts
import {
  agyUsageTick,
  type AgyConversationUsage,
  type AgyUsageState,
} from './agent/agyUsageWatch.js';
```

2. Next to the lifecycle state map (`extension.ts:711`, `const agyWatchStates = ...`), add:

```ts
// Per-ticket memory of the agy usage watch: the last conversation step idx already
// emitted as a UsageUpdate. Ephemeral — rebuilt from the DB on every sweep, cleared
// when the terminal closes (the store dedupes on event id anyway).
const agyUsageStates = new Map<number, AgyUsageState>();
```

3. In the terminal-close callback, immediately after
   `agyWatchStates.delete(ticketId);` (`extension.ts:796`), add:

```ts
agyUsageStates.delete(ticketId);
```

4. In `runAgyConversationWatch`, inside the per-terminal block, the DB is already opened
   and closed in a try/finally (`extension.ts:3036-3050`). AFTER the lifecycle
   `agyWatchTick` dispatch loop and STILL inside that same per-terminal try (after the
   lifecycle `dispatchHook` calls at `extension.ts:3078-3092`), insert the usage step:

```ts
// Conversation-DB token usage: agy 1.1.12 persists per-call usage in this same DB
// (steps.metadata field-9 submessage — see agyUsageWatch.ts), so the lifecycle watch
// doubles as the usage channel. The cumulative sample rides the same UsageUpdate seam
// and closures as the codex/opencode bridges — attribution (impl segment vs fix), the
// generation barrier, and the store's cumulative-delta ledger are shared. A re-sweep
// of an unchanged DB emits nothing; the store dedupes on event id anyway.
const usageState = agyUsageStates.get(named.ticketId) ?? { eventId: null };
const usage = db.usage();
const usageEvents = agyUsageTick(usageState, usage);
agyUsageStates.set(named.ticketId, usageState);
for (const event of usageEvents) {
  const usagePayload: HookPayload = {
    hook_event_name: 'UsageUpdate',
    cwd: worktree.path,
    session_id: conversationId ?? '',
    usage: event.usage,
    ...(named.launchId ? { launchId: named.launchId } : {}),
  };
  try {
    dispatchHook(
      localStore,
      usagePayload,
      notifyHook,
      shouldApplyHookState,
      sessionProviderFor,
      hookChannelRecorder,
    );
  } catch (error) {
    logError(`karst: agy usage dispatch failed for ticket ${named.ticketId}`, error);
  }
}
```

Notes:
- `db` here is the `AgyConversationDb` already opened at `extension.ts:3040`; the `usage()`
  read runs before the `db.close()` in that block's `finally`.
- `conversationId` is already computed in the sweep (`extension.ts:3062`,
  `snapshot?.conversationId`); the guard `conversationId ?? ''` keeps the payload shape
  valid; `ingestUsageUpdate` drops a payload with a missing/unattributable session id
  without writing.
- The lifecycle block `if (events.length === 0) continue;` at `extension.ts:3058` returns
  early when there are no lifecycle events — the usage step above must be placed so it
  STILL RUNS when lifecycle produced no events. Therefore place the usage read/dispatch
  OUTSIDE and AFTER that early `continue`, before the `finally`/close — i.e. after the
  lifecycle `for (const event of events)` loop, at the same nesting level as the
  `if (events.length === 0) continue;` check, so it executes for every matched terminal
  regardless of lifecycle outcome.

#### Constraints
- Do not modify `dispatchHook`, `ingestUsageUpdate`, the store, or the generation barrier.
- Do not open a second DB connection; reuse the already-open `db`.
- Do not change the lifecycle watch behavior.
- Keep the sweep window-scoped (`vscode.window.terminals`), same as today.

#### Edge Cases
- **Terminal closed**: the close callback deletes the per-ticket usage state; the next
  sweep simply re-reads the DB and, if the store already has the last event id, the
  `appendInteractiveUsageSample` duplicate path is a no-op.
- **No conversation found yet** (`snapshot === null` / no DB): the existing code paths
  `continue` before the usage step (the DB is only opened when `findConversationForWorktree`
  succeeds). If `db.usage()` returns `null`, `agyUsageTick` returns `[]`.
- **Extension reload**: in-memory state resets; the sweep re-reads the whole conversation.
  If the last step idx is already in the store, dispatch is a duplicate (no double count);
  if new steps landed during the reload, the cumulative delta covers exactly them.
- **Stale/foreign generation**: `shouldApplyHookState` (the generation barrier) rejects the
  payload before the store — same behavior as the bridges.
- **`session_id` mismatch**: if `tickets.session_id` was never set or differs, the store's
  binding resolution returns `unattributed` and nothing is written — never a fabricated row.

#### Verification
```bash
npm run typecheck
npx vitest run src/agent/agyUsageWatch.test.ts src/agent/agyConversationWatch.test.ts
```
Expected: typecheck passes (the sweep compiles against the module API); the module tests
still pass. Then:
```bash
npm test
```
Expected: full suite green, including `extensionActivation.test.ts`.

#### Completion Criteria
- [ ] Imports added for `agyUsageTick` and the usage types.
- [ ] `agyUsageStates` map declared and deleted in the terminal-close callback.
- [ ] The usage read + dispatch block runs for every matched antigravity terminal,
      including when lifecycle produced no events.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.

---

### Task 4: Flip the antigravity interactive-usage capability and update pinned tests

#### Objective
Make `antigravity` a measured interactive-usage provider end to end (the data path is
now real), and update every test that pinned it as unmeasurable to the correct FINAL
state (all four implemented providers measure).

#### Files
- `src/agent/provider.ts` — MODIFY: `PROVIDER_INTERACTIVE_USAGE.antigravity` and comment.
- `src/agent/antigravity.ts` — MODIFY: capability comment + `interactiveUsage: true`.
- `src/agent/antigravity.test.ts` — MODIFY: the capability assertion.
- `src/agent/settings.test.ts` — MODIFY: the `providerInteractiveUsage('antigravity')`
  assertion.
- `src/model/inside/agent.test.ts` — MODIFY: the two "unavailable" tests (lines ~378-411)
  to their FINAL state. These lines may currently reference `claude` (if the claude plan
  has NOT run) or `antigravity` (if it HAS). The edits below are specified so they produce
  the correct result in either case.

#### Implementation

1. `src/agent/provider.ts` — change `antigravity: false` to `antigravity: true` (line 50).
   Update the block comment (lines 35-39) so the truth table reads: codex/opencode post
   `UsageUpdate` from their bridges; claude's interactive usage is read from its session
   transcript (`claudeTranscriptWatch.ts`); antigravity's interactive usage is read from
   its conversation DB (`agyUsageWatch.ts`); every implemented provider is now measured.
2. `src/agent/antigravity.ts` — replace the capability comment at lines 121-122 (which
   says "There is still no usage channel: interactiveUsage stays false") and set
   `interactiveUsage: true` (line 126). The comment must state: agy 1.1.12 persists
   per-call usage in the conversation DB's `steps.metadata` (field-9 submessage), read by
   `agyUsageWatch.ts` through the same sweep that reads lifecycle — the hooks remain
   non-executing, the DB is the channel.
3. `src/agent/antigravity.test.ts` — replace the test at lines 39-45 with one named
   "advertises interactive usage — the conversation DB records per-call token counts",
   asserting `adapter.capabilities.interactiveUsage` toBe(true).
4. `src/agent/settings.test.ts` — at lines 71-74, change the expected `interactiveUsage`
   for `antigravity` to `true`.
5. `src/model/inside/agent.test.ts`:
   - **Delete** the test titled "renders unavailable — never a zero — for a provider with
     no per-session usage" (lines ~378-394). After this change every implemented provider
     measures, so no provider can render unavailable; the rendering itself remains pinned
     by the direct `tokenView(tokens, false)` test at lines ~413-425.
   - **Convert** the test titled "renders unavailable from the configured provider before
     anything ran" (lines ~396-411). Replace its body so it passes
     `{ provider: 'antigravity', model: 'claude-opus-4-8' }` as the configured provider
     and asserts `process.tokens` toBeUndefined() — a pending impl for a measuring
     configured provider shows the truth about the provider karst will launch (nothing
     measured yet is silent, never "unavailable", never a zero). Update its comment to
     name antigravity's conversation-DB channel. The test currently passes
     `{ provider: 'claude', ... }`; if the claude plan already converted it to antigravity,
     the provider value is already right and only the assertion + comment change.

#### Constraints
- Do NOT touch `src/agent/claude.ts` or the claude capability (the claude plan owns it).
- Do NOT touch `src/agent/settings.ts` (no hook registration change — agy never gets a
  UsageUpdate hook; the DB read is not a hook).
- Do NOT change `tokenView` or `measuresSessionUsage` logic in this task.

#### Edge Cases
- The "never a zero" invariant remains pinned by the direct `tokenView(tokens, false)`
  test (lines ~413-425) and by the "omits tokens when nothing was measured on a measuring
  provider" test (lines ~331-352). Both must remain and pass unchanged.
- If the claude plan converted lines 378-411 to antigravity before this plan ran, deleting
  line 378-394 and converting 396-411 to the silent assertion is still the correct final
  state (no double-edit hazard, because each edit targets the current text by title).

#### Verification
```bash
npx vitest run src/agent/antigravity.test.ts src/agent/settings.test.ts src/model/inside/agent.test.ts
npm run typecheck
```
Expected: the three suites pass with the updated assertions; the claude capability tests
(`src/agent/claude.test.ts`) are untouched by this task.

#### Completion Criteria
- [ ] `PROVIDER_INTERACTIVE_USAGE.antigravity` is `true`.
- [ ] `AntigravityAdapter.capabilities.interactiveUsage` is `true`.
- [ ] `antigravity.test.ts`, `settings.test.ts`, and `model/inside/agent.test.ts` updated
      and green; `tokenView(tokens, false)` test unchanged.
- [ ] `npx vitest run src/agent/antigravity.test.ts src/agent/settings.test.ts src/model/inside/agent.test.ts` passes.

---

### Task 5: Correct the now-false documentation and comments

#### Objective
Fix every doc/comment that still claims antigravity has no usage channel, and the model
comment that names antigravity as unmeasured.

#### Files
- `src/model/inside/agent.ts` — MODIFY: comment at lines ~456-457.
- `src/agent/interactiveUsage.ts` — MODIFY: top doc comment (lines 3-20).
- `docs/guides/adding-agent-core.md` — MODIFY: the Antigravity section (§14, lines ~420-453).
- `docs/glossary.md` — MODIFY: the **Interactive usage** entry (lines ~234-237).

#### Implementation

1. `src/model/inside/agent.ts` — the comment at lines ~456-457 ("a Claude/Antigravity
   session can never produce a token fact") must be rewritten to remove BOTH names. New
   text: per-session usage exists for every implemented provider — codex/opencode via
   their bridges, claude via its session transcript, antigravity via its conversation DB
   (`agent/provider.ts` is the truth table). Do not change any logic.
2. `src/agent/interactiveUsage.ts` — the top comment (lines 3-20) names only opencode and
   codex as interactive-usage sources and says "the provider bridge POSTs". Add that
   claude's and antigravity's interactive usage are ALSO measured (claude via its session
   transcript read by `claudeTranscriptWatch.ts`; antigravity via its conversation DB read
   by `agyUsageWatch.ts`), and clarify that a "sample source" is any channel that produces
   numeric cumulative counts with a stable id — a bridge POST, a transcript read, or a
   conversation-DB read. No logic change.
3. `docs/guides/adding-agent-core.md` §14 — replace the final bullet
   ("Capabilities: lifecycleEvents: true and resume: true (the watch delivers both),
   interactiveUsage: false (no usage channel exists — never a measured zero)") and the
   `-p` "no usage in stdout" claim with the verified 1.1.12 reality: `-p --output-format
   json` reports a `usage` block; the conversation DB's `steps.metadata` field-9
   submessage records per-call input/output/cache_read (types 15 and 23; sum across
   steps), read by `agyUsageWatch.ts`; the capability is now
   `lifecycleEvents: true, resume: true, interactiveUsage: true`. State plainly that this
   was re-verified against 1.1.12 and the earlier "no usage channel" note was written
   against 1.1.11.
4. `docs/glossary.md` **Interactive usage** entry — replace the whole entry with text that
   names all four providers as measured: codex/opencode post `UsageUpdate` from their
   bridges; claude's interactive usage is read from Claude Code's session transcript
   (`claudeTranscriptWatch.ts`); antigravity's is read from its conversation DB
   (`agyUsageWatch.ts`). No provider is unmeasured; a missing fact is never rendered as a
   zero.

#### Constraints
- Do not change any logic in these files.
- Do not rewrite dated docs under `docs/superpowers/` (records of the time).
- Do not touch the `docs/plans/*.md` plan files themselves.

#### Verification
```bash
npm run typecheck
```
Expected: passes (comment-only changes). Then confirm no surviving false claim:
```bash
rg -n -i "no usage channel|interactiveUsage stays|reports no usage" src docs/guides docs/glossary.md
```
Expected: no matches (the only remaining "no usage" phrasing, if any, must describe the
pre-1.1.12 agy in dated records under `docs/superpowers/`).

#### Completion Criteria
- [ ] `model/inside/agent.ts` comment no longer names any provider as unmeasured.
- [ ] `interactiveUsage.ts` top comment names the agy conversation-DB channel.
- [ ] `adding-agent-core.md` §14 reflects the verified 1.1.12 usage channel.
- [ ] `docs/glossary.md` Interactive usage entry names all four providers.
- [ ] `npm run typecheck` passes.

---

## Final Verification

1. Task order depends: Task 2 needs Task 1's module; Task 3 needs Task 2's `db.usage()`;
   Task 4 needs Tasks 1-3 (the data path) and its model-test edits are order-independent
   of the claude plan; Task 5 is comment-only. Execute strictly in order 1 → 2 → 3 → 4 → 5.
2. Run the focused suites for the touched areas.
3. Run the full gates.

Commands:

```bash
npx vitest run src/agent/agyUsageWatch.test.ts src/agent/agyConversationWatch.test.ts src/agent/antigravity.test.ts src/agent/settings.test.ts src/model/inside/agent.test.ts
npm run typecheck
npm test
npm run build
```

Expected:
- The five focused suites are green.
- `typecheck` passes (the new pure module has no runtime deps; the sweep compiles).
- `npm test` (vitest, in-memory SQLite) is green — `pretest` rebuilds better-sqlite3 for
  the Node ABI automatically.
- `npm run build` compiles `tsconfig.build.json` and copies webview assets (unchanged) —
  build succeeds.

Manual end-to-end check (F5 in VS Code, Electron ABI via `dev:extension`):
1. Create/run a ticket at `impl` with provider `antigravity`.
2. Start an interactive agy session (it writes a conversation DB in
   `~/.gemini/antigravity-cli/conversations/`; the lifecycle watch captures the
   conversation id as `session_id`).
3. Send at least one message that triggers a model call (an `assistant`/model-generate
   turn), then wait ~10-20s.
4. Open the ticket's Inside view: the impl process's token row shows a measured number
   (not "Token usage not available for this provider").
5. Optionally verify the store:
   `SELECT provider, provider_session_id, input_tokens, output_tokens, cache_read_tokens, source_event_id FROM interactive_usage_samples;`
   shows rows whose cumulative counts match the conversation DB's summed field-2/3/5, and
   `token_usage` has the corresponding `call_site = 'implementation'` delta rows.

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
