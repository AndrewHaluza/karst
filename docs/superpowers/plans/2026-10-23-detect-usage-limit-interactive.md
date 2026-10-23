# Interactive Usage-Limit Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an interactive agent session (impl/fix/planning/setup) hits its provider usage limit, record a D158 `interactive` park and offer "Pick agent/model…" (a persisted session switch) and "Retry same".

**Architecture:** A vscode-free detector turns a per-core error signal into a quota verdict via D158 `isQuotaExhausted` (never prose). A host-agnostic op records the park (deduped by the store's open-row key incl. `session_id`) and raises a notification. Two actions act on it: Pick calls the existing `applyAgentSwitchSelection` and claims the row only on `'switched'`; Retry same relaunches via `karst.openSession` and claims `'retry'`. `extension.ts` only binds.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest, better-sqlite3 store, VS Code notification API behind the `Notify` seam.

**Spec:** ticket brief FEAT-DETECT-USAGE-LIMIT-IN (T776, D160); builds on `docs/superpowers/plans/2026-10-13-usage-limit-park-offers.md` (D159) and `docs/arch/agent-cores.md` (`arch:AC-13`, `AC-07`).

## Global Constraints

- Quota test is `isQuotaExhausted` / `QUOTA_PHRASES` only (`src/agent/cliFailure.ts`), never `LIMIT_PHRASES`.
- Park row: `kind='interactive'`, `lane=null`, `target=null`, `stage` = ticket's current stage; planning/setup → `stage=null`, keyed by `session_id`. No stage block.
- Claim AFTER the switch: only outcome `'switched'` claims (resolution `` `switched:${provider}/${model ?? 'default'}` ``). stale/unavailable/cancelled/launch-failed leave the row open.
- Retry same must NOT call `applyAgentSwitchSelection` (no confirm, no persist); claim `'retry'` after relaunch.
- Switch launches `{allowResume:false}`; never promise resume.
- Logic in `src/extension/ops/` with `Notify` seam; `extension.ts` bindings only (`ops/ratchet.test.ts`). `spawnSync` banned. No new polling beyond existing watches.
- Mutation score ≥ 85 on changed `src/extension/**`. Strict TDD. Files < 400 lines.
- No new webview UI (notification + QuickPick only).

## Per-core signal decision (Task 0 outcome, fixed here)

| core | signal | verdict |
|---|---|---|
| opencode, opencode2 | normalized `session.error` hook, `message` = provider error text (`opencode.ts:821`, `opencode2Bridge.ts:337`); today `dispatch.ts` treats it as no-signal | **detect** |
| claude | Claude transcript (`claudeTranscriptWatch`, already polled): assistant entry with `isApiErrorMessage: true`; text is provider-authored, so prose cannot set it | **detect** |
| codex | bridge forwards only Stop/Notification/Usage; no provider-error event | no change, documented |
| agy | no hook channel; conversation-DB watch exposes run status, no error text | no change, documented |

---

### Task 1: Pure detector

**Files:**
- Create: `src/agent/interactiveQuota.ts`
- Test: `src/agent/interactiveQuota.test.ts`

**Interfaces:**
- Produces: `quotaTextFromHook(payload: { hook_event_name?: string; message?: unknown }): string | null` (non-null only for `session.error` with string message); `quotaTextFromClaudeEntry(entry: unknown): string | null` (only `isApiErrorMessage === true`, joins `message.content[].text`); `isInteractiveQuota(provider: string, text: string): boolean` → `isQuotaExhausted({tool: provider, exitCode: 1, stdout: '', stderr: text})`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { quotaTextFromHook, quotaTextFromClaudeEntry, isInteractiveQuota } from './interactiveQuota.js';

describe('interactive quota detector', () => {
  it('session.error message is candidate text; other events are not', () => {
    expect(quotaTextFromHook({ hook_event_name: 'session.error', message: 'insufficient_quota' })).toBe('insufficient_quota');
    expect(quotaTextFromHook({ hook_event_name: 'Stop', message: 'usage limit' })).toBeNull();
    expect(quotaTextFromHook({ hook_event_name: 'session.error', message: 5 })).toBeNull();
  });
  it('claude entry counts only when isApiErrorMessage is true', () => {
    const e = (flag: boolean) => ({ isApiErrorMessage: flag, message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] } });
    expect(quotaTextFromClaudeEntry(e(true))).toBe('Claude usage limit reached');
    expect(quotaTextFromClaudeEntry(e(false))).toBeNull();
    expect(quotaTextFromClaudeEntry('x')).toBeNull();
  });
  it('quota phrases hit; prose about a rate limit does not', () => {
    expect(isInteractiveQuota('claude', 'Claude usage limit reached')).toBe(true);
    expect(isInteractiveQuota('opencode', 'You exceeded your current quota (insufficient_quota)')).toBe(true);
    expect(isInteractiveQuota('claude', 'I should add a rate limit to this endpoint')).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/agent/interactiveQuota.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement**

```ts
import { isQuotaExhausted } from './cliFailure.js';

export function quotaTextFromHook(payload: { hook_event_name?: string; message?: unknown }): string | null {
  if (payload.hook_event_name !== 'session.error') return null;
  return typeof payload.message === 'string' && payload.message !== '' ? payload.message : null;
}

export function quotaTextFromClaudeEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { isApiErrorMessage?: unknown; message?: { content?: unknown } };
  if (e.isApiErrorMessage !== true) return null;
  const content = e.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => (typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
    .join('\n')
    .trim();
  return text === '' ? null : text;
}

export function isInteractiveQuota(provider: string, text: string): boolean {
  return isQuotaExhausted({ tool: provider, exitCode: 1, stdout: '', stderr: text });
}
```

- [ ] **Step 4:** rerun test → PASS. If `HeadlessFailure` needs more required fields, satisfy them with empty values (typecheck tells).
- [ ] **Step 5:** `git add src/agent/interactiveQuota*.ts && git commit -m "feat: detect provider quota text from interactive session signals"`

---

### Task 2: Record op (park + dedup + prompt)

**Files:**
- Create: `src/extension/ops/interactiveUsageLimitOps.ts`
- Test: `src/extension/ops/interactiveUsageLimitOps.test.ts`

**Interfaces:**
- Consumes: `insertOpenPark`, `listOpenParks`, `UsageLimitParkRow` (`src/store/usageLimitParks.ts`); `Notify` (`./notify.js`); Task 1 `isInteractiveQuota`.
- Produces:
  - `interface InteractiveSignal { ticketId: number; sessionId: string; provider: AgentProvider; model: string | null; stage: StageKey | null; text: string }`
  - `recordInteractiveUsageLimit(deps: { store: Store; notify: Notify; offer: (parkId: number, signal: InteractiveSignal) => void }, signal): number | null` — returns park id; `null` when not quota. Calls `offer` only when the park is NEW (no open row existed for ticket+stage+session).

- [ ] **Step 1: Failing tests** (use `openStore(':memory:')` + a ticket-creating helper copied from `usageLimitParks.test.ts`):
  - quota text → one open row `kind='interactive'`, `lane/target` null, `session_id` set, `offer` called once.
  - prose `'add a rate limit'` → returns null, zero rows, no offer.
  - same signal twice → one row, `offer` once.
  - planning (`stage:null`) two sessions `s1`,`s2` → two rows.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement**

```ts
export function recordInteractiveUsageLimit(deps, s: InteractiveSignal): number | null {
  if (!isInteractiveQuota(s.provider, s.text)) return null;
  const isOpen = listOpenParks(deps.store, s.ticketId).some(
    (p) => p.kind === 'interactive' && p.stage === s.stage && p.sessionId === s.sessionId,
  );
  const id = insertOpenPark(deps.store, {
    ticketId: s.ticketId, stage: s.stage, kind: 'interactive', lane: null, target: null,
    sessionId: s.sessionId, provider: s.provider, model: s.model, detail: s.text,
  });
  if (!isOpen) deps.offer(id, s);
  return id;
}
```

  (Check `UsageLimitParkRow` field name for session id with `grep -n sessionId src/store/usageLimitParks.ts` and match it.)
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat: record an interactive usage-limit park once per session`.

---

### Task 3: Pick / Retry actions

**Files:**
- Modify: `src/extension/ops/interactiveUsageLimitOps.ts` (add actions; split to `interactiveUsageLimitActions.ts` if > 300 lines)
- Test: `src/extension/ops/interactiveUsageLimitActions.test.ts`
- Modify: `src/extension.ts` `switchAgentSession` (~L1783-1870) to RETURN the `AgentSwitchOutcome` (still shows toasts) so the action can read it.

**Interfaces:**
- Consumes: `claimUsageLimitPark(store, parkId, resolution)`, `AgentSwitchOutcome` (`src/agent/sessionSwitch.ts`).
- Produces: `makeInteractiveParkActions(deps: { store; notify; pick: (parkedProvider, parkedModel) => Promise<{provider: AgentProvider; model: string | null} | undefined>; switchSession: (ticketId, sel: {provider; model}) => Promise<AgentSwitchOutcome | undefined>; relaunch: (ticketId) => Promise<void> })` returning `{ pickAgent(parkId): Promise<'switched'|'open'|'gone'>; retrySame(parkId): Promise<'retried'|'gone'> }`.

Behavior:
- `pickAgent`: load open park (else `'gone'`) → `pick` (undefined ⇒ `'open'`) → `switchSession`; only `outcome.kind === 'switched'` ⇒ `claimUsageLimitPark(store, id, 'switched:<provider>/<model ?? "default">')`, return `'switched'` (a lost claim does nothing further). Any other kind ⇒ `'open'`, row untouched.
- `retrySame`: open park (else `'gone'`) → `relaunch(ticketId)` → claim `'retry'`. Never calls `pick`/`switchSession`.

- [ ] **Step 1: Failing tests** with fakes: switched ⇒ row resolved `switched:codex/gpt-x`, and `switchSession` spy called once with the pick (persist is asserted in the existing `sessionSwitch` tests; here assert via the extension-level test in Task 4 that `updateTicketFields` is called with the new provider through a real `applyAgentSwitchSelection` + fake deps: add ONE test building `AgentSwitchFlowDeps` fakes and asserting `persist` called with `{provider, model, effort}`); each of `stale`/`unavailable`/`cancelled`/`launch-failed` ⇒ row still open, `'open'`; `pick` returns undefined ⇒ `'open'`; retry ⇒ `pick`/`switchSession` never called, row `resolution === 'retry'`, `relaunch` called once; second concurrent `pickAgent` after claim ⇒ `'gone'`; two `claim` race ⇒ second gets `claimed:false` and no further effect.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** per Behavior above (use `listOpenParks(...).find(p => p.id === parkId)` for load).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat: interactive usage-limit Pick and Retry-same actions`.

---

### Task 4: Wiring (hook, Claude transcript, host binding)

**Files:**
- Modify: `src/hooks/dispatch.ts` — accept optional trailing `onSessionError?: (payload: HookPayload, ticketId: number) => void` and call it for `session.error` only (state transition stays "no signal"); `src/hooks/dispatch.test.ts` extends the existing `session.error` test.
- Modify: `src/extension.ts` — bindings only: (a) pass `onSessionError` that builds an `InteractiveSignal` (current stage from the ticket row, `sessionId` from payload, provider/model from `sessionProviderFor`/ticket) and calls `recordInteractiveUsageLimit`; (b) in `runClaudeTranscriptWatch`, scan only entries newer than the tick's last seen line count with `quotaTextFromClaudeEntry` and record; (c) `offer` shows `notify` warning "<core> hit its usage limit" with buttons **Pick agent/model…**, **Retry same**, **Dismiss** (Dismiss = `resolveOpenParks`-style claim `'dismissed'`); (d) `relaunch` = `sessions.disposeSession(ticketId)` then `executeCommand('karst.openSession', ticketId, { allowResume: true, providerReady: true })`; (e) `pick` = `makeUsageLimitAgentModelPicker(() => modelCatalog)`.
- Modify: `src/extension/ops/ratchet.test.ts` only if it enumerates ops files.
- Test: `src/hooks/dispatch.test.ts`; `src/extension/ops/interactiveUsageLimitWiring.test.ts` (fixture per signal core).

- [ ] **Step 1: Failing tests** — fixtures: opencode `session.error` with `{ error: { message: 'insufficient_quota' } }` normalized payload ⇒ park + `offer`; opencode2 same; claude transcript JSONL line `{"isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"Claude usage limit reached"}]}}` ⇒ park + `offer`; claude ordinary assistant line whose text says "rate limit" (no flag) ⇒ nothing; `dispatchHook` still returns the same state for `session.error` (no transition).
- [ ] **Step 2:** run changed files → FAIL.
- [ ] **Step 3:** implement; keep scanning tail-incremental inside the existing transcript tick (no extra timer).
- [ ] **Step 4:** `npx vitest related src/hooks/dispatch.ts src/extension.ts src/extension/ops/interactiveUsageLimitOps.ts` → PASS; `npm run -s typecheck`.
- [ ] **Step 5:** commit `feat: wire interactive usage-limit detection into hook and transcript signals`.

---

### Task 5: Docs, gates, ship

**Files:**
- Modify: `docs/arch/agent-cores.md` — new `## [@arch:AC-42] Interactive usage-limit detection and the persisted switch` … `END_DOC_BLOCK: [@arch:AC-42]` (keyed-block format). Content: the per-core table above; "no signal" cores unchanged; **exception to D159 one-shot**: interactive Pick is a persisted switch (`deps.persist`), headless re-runs stay one-shot; claim-after-switch rule; Retry same bypasses `applyAgentSwitchSelection`; switched core launches `allowResume:false` and context carries only via the kickoff seed the header switch's launch (`karst.openSession` → session kickoff builder; name the exact builder found by `grep -n "kickoff" src/extension.ts src/agent/sessionSwitch.ts`) — no resume promised.
- Modify: `src/store/usageLimitParks.ts` doc comment ("reserved for … (D160)" → implemented by `interactiveUsageLimitOps`).

- [ ] **Step 1:** write the block; run `npm run -s docs:graph` if the system map changes.
- [ ] **Step 2:** `npx stryker run --mutate src/agent/interactiveQuota.ts,src/extension/ops/interactiveUsageLimitOps.ts` then `node scripts/mutationSummary.mjs`; add tests for survivors until ≥ 85.
- [ ] **Step 3:** full `npm run -s test:unit 2>&1 | tail -20`, `npm run -s typecheck`, `npm run -s lint:react`.
- [ ] **Step 4:** commit `docs: AC-42 interactive usage-limit detection`; fire `stage impl`.

---

## Self-Review

- Spec coverage: detect per core (T1/T4 + table), park shape (T2), D159 prompt (T4c), persisted-switch exception doc (T5), claim-after-switch + 4 non-switched outcomes (T3), `allowResume:false` + seed named (T5), Retry same (T3), no-signal cores documented (T5), all listed tests (T1–T4: per-core fixture, Pick persist, open-on-failure, Retry no persist/modal, prose no park, dedup).
- Placeholders: none; the only lookups (session-id field name, kickoff builder name) are explicit grep steps.
- Types: `InteractiveSignal`, `recordInteractiveUsageLimit`, `makeInteractiveParkActions` names consistent across tasks.
