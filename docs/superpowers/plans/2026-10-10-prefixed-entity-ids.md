# Prefixed Entity Ids (T583 / D88 / P17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One canonical typed id (`T<n>` ticket, `D<n>` draft, `P<n>` planning session) shown to and accepted from humans and agents everywhere outside webviews.

**Architecture:** A vscode-free `src/model/entityId.ts` owns the prefix map, `formatId`, `formatTicketRef` and `parseId`. Every text site and CLI/MCP id input goes through it. Agent sessions learn their own id via one line in the existing context header (facts block = instruction layer; heading = inline kickoff). No schema change.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `noUncheckedIndexedAccess`), vitest, Stryker (>= 85 on `src/extension/**`).

**Spec:** ticket IDS-ONE-PREFIXED-ID-FORMAT-T583 (`karst context IDS-ONE-PREFIXED-ID-FORMAT-T583`). Follow-up D90 does webviews; do NOT touch `src/ui/**`.

## Global Constraints

- Prefix map is `PREFIX = {ticket:'T', draft:'D', plan:'P'}` in `src/model/entityId.ts` only; no other non-test file hard-codes `'T'|'D'|'P'` as an id prefix.
- No zero-padding, no separator: `T583`, never `T-583`. With a key: `T583 · ABC-123` (middle dot).
- `#N` means a GitHub PR number only. Graph `revisionNumber`, `nodeRunId`, `processRunId`, `instructionsHash` `#` uses are NOT entity ids: leave them.
- `parseId` accepts `T583`/`t583`; bare `583` and legacy `#583` only when `expectedKind` is given; wrong kind error names the expected prefix.
- Self-id is ONE line inside the existing header (docs/arch/prompt-metrics.md `@arch:RESIDENT`), not a new section.
- Strict TDD; small commits; conventional commits. Test names per CLAUDE.md naming rule. Run single files (`npx vitest run <file>`), full suite once at end (`npm run -s test:unit`, `typecheck`, then `npx stryker run --mutate <changed src/extension files>`).
- Debug logs (`[driver]`, `[delivery]`…) may keep `#id` only if not an entity id; convert entity ids anyway when the line is touched.

---

### Task 1: entityId module

**Files:**
- Create: `src/model/entityId.ts`
- Test: `src/model/entityId.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EntityKind = 'ticket' | 'draft' | 'plan';
  export const PREFIX: Readonly<Record<EntityKind, string>>;
  export function formatId(kind: EntityKind, n: number): string;           // 'T583'
  export function formatTicketRef(id: number, key: string | null | undefined): string; // 'T583 · KEY' | 'T583'
  export function parseId(text: string, expectedKind?: EntityKind): { kind: EntityKind; n: number };  // throws Error
  ```

- [ ] **Step 1: Write failing tests** (`src/model/entityId.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { PREFIX, formatId, formatTicketRef, parseId } from './entityId.js';

describe('entityId', () => {
  it('has the pinned prefix map', () => {
    expect(PREFIX).toEqual({ ticket: 'T', draft: 'D', plan: 'P' });
  });
  it('formats', () => {
    expect(formatId('ticket', 583)).toBe('T583');
    expect(formatId('draft', 88)).toBe('D88');
    expect(formatId('plan', 17)).toBe('P17');
  });
  it('formats a ticket ref with and without key', () => {
    expect(formatTicketRef(583, 'ABC-123')).toBe('T583 · ABC-123');
    expect(formatTicketRef(583, null)).toBe('T583');
    expect(formatTicketRef(583, '  ')).toBe('T583');
  });
  it('rejects a non-positive or non-integer number when formatting', () => {
    expect(() => formatId('ticket', 0)).toThrow(/positive integer/);
    expect(() => formatId('ticket', 1.5)).toThrow(/positive integer/);
  });
  it('parses prefixed ids, either case, with or without expectedKind', () => {
    expect(parseId('T583')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('t583', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('D88')).toEqual({ kind: 'draft', n: 88 });
    expect(parseId('p17')).toEqual({ kind: 'plan', n: 17 });
  });
  it('accepts bare and legacy # only with expectedKind', () => {
    expect(parseId('583', 'ticket')).toEqual({ kind: 'ticket', n: 583 });
    expect(parseId('#88', 'draft')).toEqual({ kind: 'draft', n: 88 });
    expect(() => parseId('583')).toThrow(/prefix/);
    expect(() => parseId('#583')).toThrow(/prefix/);
  });
  it('rejects a wrong kind naming the expected prefix', () => {
    expect(() => parseId('D88', 'ticket')).toThrow(/expected a ticket id \(T<n>\).*D88/);
  });
  it('rejects junk, zero, leading zeros, signs and whitespace-padded input', () => {
    for (const bad of ['', 'T', 'T0', 'T01', 'T-5', 'X5', 'T5x', '0', '01', '-3', '1.5', 'T 5'])
      expect(() => parseId(bad, 'ticket')).toThrow();
    expect(parseId(' T5 ', 'ticket').n).toBe(5); // trimmed
  });
  it('rejects unsafe huge numbers', () => {
    expect(() => parseId('T99999999999999999999', 'ticket')).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/model/entityId.test.ts` (module missing).

- [ ] **Step 3: Implement**

```ts
/**
 * The one canonical short id for the three numeric entities (docs/arch/ids.md).
 * Display-only: derived from the integer primary keys, no schema involved.
 * `#N` is reserved for GitHub PR numbers.
 */
export type EntityKind = 'ticket' | 'draft' | 'plan';

export const PREFIX: Readonly<Record<EntityKind, string>> = {
  ticket: 'T',
  draft: 'D',
  plan: 'P',
};

const NOUN: Readonly<Record<EntityKind, string>> = {
  ticket: 'ticket',
  draft: 'draft',
  plan: 'planning session',
};

const KIND_BY_PREFIX = new Map<string, EntityKind>(
  (Object.keys(PREFIX) as EntityKind[]).map((k) => [PREFIX[k], k]),
);

function assertId(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`id must be a positive integer, got ${n}`);
}

export function formatId(kind: EntityKind, n: number): string {
  assertId(n);
  return `${PREFIX[kind]}${n}`;
}

/** `T583 · ABC-123`, or `T583` when the ticket has no (or a blank) provider key. */
export function formatTicketRef(id: number, key: string | null | undefined): string {
  const k = key?.trim();
  return k ? `${formatId('ticket', id)} · ${k}` : formatId('ticket', id);
}

const CANONICAL = /^[1-9][0-9]*$/;

export function parseId(text: string, expectedKind?: EntityKind): { kind: EntityKind; n: number } {
  const raw = text.trim();
  const want = expectedKind
    ? `expected a ${NOUN[expectedKind]} id (${PREFIX[expectedKind]}<n>)`
    : 'expected an id like T<n>, D<n> or P<n>';
  const fail = (): never => {
    throw new Error(`invalid id '${text}': ${want}`);
  };
  const prefixed = /^([A-Za-z])(.*)$/.exec(raw);
  if (prefixed) {
    const kind = KIND_BY_PREFIX.get(prefixed[1]!.toUpperCase());
    if (!kind || !CANONICAL.test(prefixed[2]!)) return fail();
    if (expectedKind && kind !== expectedKind) {
      throw new Error(`wrong id kind: ${want}, got '${raw}' (a ${NOUN[kind]} id)`);
    }
    return finish(kind, prefixed[2]!, fail);
  }
  if (!expectedKind) {
    throw new Error(`id '${text}' needs a prefix (${Object.values(PREFIX).join('/')}): ${want}`);
  }
  const digits = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!CANONICAL.test(digits)) return fail();
  return finish(expectedKind, digits, fail);
}

function finish(kind: EntityKind, digits: string, fail: () => never): { kind: EntityKind; n: number } {
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return fail();
  return { kind, n };
}
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(ids): add entityId formatter/parser`.

---

### Task 2: CLI ticket input accepts `T583`

**Files:**
- Modify: `src/cli/resolveTicket.ts:34-52,64` (`resolveTicketByKey`, `selectNamesake` ids list)
- Modify: `src/cli/sessionIdentity.ts:12-14` (`ticketLabel` → `formatTicketRef`)
- Modify: `src/cli/subtaskCommand.ts:125` (`parent:` value)
- Test: `src/cli/resolveTicket.test.ts`, `src/cli/sessionIdentity.test.ts`, `src/cli/subtaskCommand.test.ts`

**Interfaces:**
- Consumes: `parseId`, `formatTicketRef` (Task 1).
- Produces: `resolveTicketByKey(store, 'T583', slug)` resolves ticket row 583; `ticketLabel(t)` returns `formatTicketRef(t.id, t.key)`.

- [ ] **Step 1: Failing tests.** In `resolveTicket.test.ts` (mirror its existing store-setup helper): ticket id N resolves via `'T<N>'`, `'t<N>'`, bare `'<N>'`; a key lookup still wins over id when a ticket key equals the string; project scoping: `'T<N>'` of another project returns `undefined` when `projectSlug` set; `'D5'` and `'T0'` return `undefined` (not throw). Ambiguity error message lists `T<id>` not `#<id>`. `sessionIdentity.test.ts`: `ticketLabel({id:3,key:'K-1'})` → `'T3 · K-1'`; `{id:3,key:null}` → `'T3'`. Update every existing expectation of the old `#id` label found by `npx vitest run src/cli` failures.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Replace the `/^[1-9][0-9]*$/` block with:

```ts
  let id: number;
  try {
    const parsed = parseId(key, 'ticket');
    id = parsed.n;
  } catch {
    return undefined; // not an id form (wrong kind, junk) — let the caller report "no ticket found"
  }
```
keep the existing no-unscoped-fallback comment. Ambiguity list: `candidates.map((t) => formatId('ticket', t.id))`. `ticketLabel` body: `return formatTicketRef(t.id, t.key);`. `subtaskCommand.ts:125`: `parent: formatTicketRef(parentId, parent.key)` — check the existing subtask test for the shape and update it; add the new expectation.
- [ ] **Step 4: PASS** — `npx vitest run src/cli/resolveTicket.test.ts src/cli/sessionIdentity.test.ts src/cli/subtaskCommand.test.ts src/cli/messageCommand.test.ts src/cli/main.test.ts`; fix label expectations in message/main tests.
- [ ] **Step 5: Commit** `feat(cli): accept and print prefixed ticket ids`.

---

### Task 3: Draft ids — propose/list/dependsOn/id

**Files:**
- Modify: `src/planning/proposal.ts:33,74-88` (normalise `id` and `dependsOn` entries via `parseId('draft')`)
- Modify: `src/cli/draftCommand.ts:93,99` (`ref`, list)
- Modify: `src/cli/registry.ts:58-59,286-293` (schema: integer OR `D<n>` string)
- Modify: `src/extension/ops/planningOutbox.ts:70,137,184-188`
- Test: `src/planning/proposal.test.ts`, `src/cli/draftCommand.test.ts`, `src/cli/registry.test.ts`, `src/cli/mcp/stdio.integration.test.ts`, `src/extension/ops/planningOutbox*.test.ts`

**Interfaces:**
- Consumes: `parseId`, `formatId`.
- Produces: `validateProposal` still returns `dependsOn?: number[]`, `id?: number` (numbers, de-duplicated) after accepting `3`, `"3"`, `"D3"`, `"d3"`. `draft propose` prints `{"ok":true,"file":…,"id":88,"ref":"D88"}` (`ref` absent when `id` is null). `draft list` prints `[{"id":88,"ref":"D88","status":…,"title":…}]`.

- [ ] **Step 1: Failing tests.**
  - proposal.test: `dependsOn:[1,'D2','d3','4']` → `[1,2,3,4]`; `dependsOn:['T2']` fails with message containing `D<n>`; `id:'D7'` → `7`; self-reference check still fires for `id:7, dependsOn:['D7']`; `dependsOn:[0]`, `[1.5]`, `[true]` still fail; max-entries check unchanged.
  - draftCommand.test: propose success JSON has `ref:'D<id>'` and keeps `ok`/`id`; null-id branch unchanged; list entries carry `ref`.
  - registry.test: `draft` schema accepts `dependsOn:['D2',3]`, `id:'D4'`; rejects `['X2']` (pattern `^[Dd]?[1-9][0-9]*$`).
  - outbox: rejection reasons read `no draft D<id>`, `draft D<id> belongs to another session`, `draft D<id> is <status>`; warnings `Karst: plan P<sessionId> outbox …`, `plan P<sessionId> draft rejected — …`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  - `proposal.ts`: helper `const asDraftNumber = (v: unknown): number | undefined => { if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : undefined; if (typeof v === 'string') { try { return parseId(v, 'draft').n; } catch { return undefined; } } return undefined; }`. Use for `id` and each `dependsOn` entry; keep the existing failure strings but say `positive integers or D<n> ids`. Reject a prefix of another kind (parseId already throws → undefined → fail).
  - `registry.ts`: `const draftRef: JsonSchema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[Dd]?[1-9][0-9]*$' }] }`; `proposalIdArray` items = `draftRef`, `id: draftRef`. Check `src/cli/jsonSchema.ts` supports `anyOf`; if not, extend its validator + `jsonSchema.test.ts` first (smallest change: add `anyOf` branch).
  - `draftCommand.ts`: `JSON.stringify({ ok: true, file, id, ref: formatId('draft', id) })`; list adds `ref: formatId('draft', id)`.
  - `planningOutbox.ts`: use `formatId('plan', sessionId)` / `formatId('draft', requestedId)`.
- [ ] **Step 4: PASS** — run the five test files above (integration: `npx vitest run --config vitest.integration.config.ts src/cli/mcp/stdio.integration.test.ts`).
- [ ] **Step 5: Commit** `feat(cli): draft ids carry D<n> refs; dependsOn accepts D<n>`.

---

### Task 4: Context shows prefixed ids and the session's own id

**Files:**
- Modify: `src/context/ticketContext.ts:589-594` (`ticketHeading`), `:633` area (self-line), `:181-190` `TicketContextParent` (+`id`), `:199` `TicketContextSubtaskParent` (+`id`), `:400-440` builders, `:840` ("Continuing from"), `:855-873` (Parent task), `:881` (Sub-tasks rows)
- Modify: `src/cli/context.ts` only if it hard-codes ids (check `grep -n "#" src/cli/context.ts`)
- Test: `src/context/ticketContext.test.ts` (+ snapshots if any: `npx vitest run src/context -u` only after reading the diff)

**Interfaces:**
- Consumes: `formatId`, `formatTicketRef`.
- Produces: heading `# Ticket: T583 · ABC-123 — title` (no key: `# Ticket: T583 — title`; no title: `# Ticket: T583 · ABC-123`). Facts-only render (`sections:'facts'`, the instruction layer) starts with ONE line: `You are working on T583 (ABC-123).` (no key: `You are working on T583.`); sub-task adds ` This is a sub-task of T570.` on the same line. Narrative/all renders do NOT repeat the line (heading carries the id). Sub-tasks row: `- T571 · KEY: title (stage: …)`; Parent task / Continuing-from heading uses `formatTicketRef(p.id, p.key)`.

- [ ] **Step 1: Failing tests** in `ticketContext.test.ts` using its existing fixture builder:
  - `all`: output contains `# Ticket: T<id> · KEY — title`.
  - `facts`: first line equals `You are working on T<id> (KEY).`; for a ticket with `subtaskParent` the first line also contains `sub-task of T<parentId>`; `narrative`: no `You are working on`.
  - Sub-task row with key and without key (`- T9: …`, never `#9`).
  - Parent task paragraph names `T<parentId> · PKEY`.
  - Follow-up parent (`## Continuing from`) names `T<parentId> · PKEY`.
  - Self line count: `render('all')` contains `You are working on` zero times.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.** `ticketHeading` uses `formatTicketRef(ctx.id, ctx.key)` joined with ` — ` + title (no more `'Untitled ticket'` case; id always present). Add to `TicketContextParent` and `TicketContextSubtaskParent` an `id: number` populated from `p.id` at `:400-440`. In `renderTicketContext`, after the `parts` init: 

```ts
if (!authored && operational) {
  const key = ctx.key?.trim();
  const self = `You are working on ${formatId('ticket', ctx.id)}${key ? ` (${key})` : ''}.`;
  parts.push(ctx.subtaskParent ? `${self} This is a sub-task of ${formatId('ticket', ctx.subtaskParent.id)}.` : self);
}
```
  The `key` local at `:638` (used for `karst context <key>` pointers) is unchanged: pointers keep working because Task 2 made `T<n>` resolvable, but leave the fallback `String(ctx.id)` as is. Sub-task row: `const ref = formatTicketRef(s.id, s.key);`. PR rows (`#${p.number}` at `:816,:836`) stay: they ARE PR numbers.
- [ ] **Step 4: PASS** — `npx vitest run src/context src/agent/seed.test.ts src/agent/entrySeed.test.ts`; update seed snapshots by reading each diff (only the heading/self-line should change).
- [ ] **Step 5: Commit** `feat(context): prefixed ids in headings, rows and the self-id line`.

---

### Task 5: Seeds per session kind + planning preamble + workflow command

**Files:**
- Modify: `src/planning/preamble.ts:43-47,88,104-112` (+ `PreambleInput` already has `sessionId`)
- Modify: `src/agent/workflowCommand.ts:335-340,198,213,230,248` (key wording)
- Test: `src/planning/preamble.test.ts`, `src/agent/workflowCommand.test.ts`, `src/agent/seed.test.ts`, `src/agent/entrySeed.test.ts`

**Interfaces:**
- Consumes: Task 4 facts self-line (reaches ticket, sub-task and review sessions because they all use `renderCtx('facts')` in `src/extension.ts:6239`; launch, resume (`composeResumeSeed`) and conflict seeds all take `factsContext`).
- Produces: planning instructions line 1: `You are in a karst PLANNING session P17: "title".`

- [ ] **Step 1: Failing tests.**
  - preamble: output contains `PLANNING session P<sessionId>: "<title>"`; contains `Cite drafts to the user as D<n>`; contains the example `{"ok":true,"id":3,"ref":"D3"}`; the `dependsOn` paragraph says `D<n>` (e.g. `"dependsOn":["D3"]`) and no longer contains `#N`; test asserts `not.toMatch(/#N/)`.
  - seed tests (one per kind, snapshot-free `toContain`): `buildSessionSeed({factsContext: renderTicketContext(ctx,undefined,{sections:'facts'}), …}).instructions` contains `You are working on T<id>`; sub-task variant contains `sub-task of T<parent>`; `composeResumeSeed` and `composeConflictSeed` instructions contain it; inline mode (`inlineInstructions:true` with `renderTicketContext(ctx)` as authored) kickoff contains the id exactly once via `# Ticket: T<id>`; the planning kickoff/instructions contain `P<id>` exactly once.
  - workflowCommand: the generated text contains `ticket key or T<n> id` (see Step 3).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
  - preamble: line 1 `` `You are in a karst PLANNING session ${formatId('plan', input.sessionId)}: "${title}".` ``; replace "the #N each propose prints and `draft list` shows" with "the D<n> each propose prints as `ref` and `draft list` shows"; examples `{"ok":true,"id":3,"ref":"D3"}`; "Cite drafts to the user as D<n>, never #N." Build `D<n>` text via `PREFIX.draft` (`${PREFIX.draft}<n>`) so no literal prefix is hard-coded outside entityId.ts. Keep the `"dependsOn"` rule: both integers and `D<n>` accepted.
  - workflowCommand: where the text says "ticket key", say "ticket key or `${PREFIX.ticket}<n>` id" (all five sites `:198,213,230,248,335`). Note `$ARGUMENTS` flows into `karst context $ARGUMENTS`, which Task 2 now resolves.
  - Check `docs/arch/prompt-metrics.md` `@arch:RESIDENT` budget numbers: run `awk -v id="[@arch:RESIDENT]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/arch/prompt-metrics.md` and confirm the +1 line per instruction layer fits; if a seed char-budget test (`SEED_BUDGETS`) fails, raise nothing — shorten wording instead.
- [ ] **Step 4: PASS** — `npx vitest run src/planning src/agent`.
- [ ] **Step 5: Commit** `feat(agent): sessions state their own T/P id; preamble cites D<n>`.

---

### Task 6: Host notifications and remaining entity-id text

**Files:**
- Modify: `src/extension/ops/planningProposalOps.ts:52,57,68,91-92,118,132-134`
- Modify: `src/store/planningProposals.ts:247`
- Modify: `src/extension/ops/{bootSweeps.ts:110,graphRecovery.ts:61,lifecycleOps.ts:189,fixBriefForTicket.ts:25,fixWatchdog.ts:298,subtaskAutostartOps.ts:94(+debug lines),messageDeliveryOps.ts(debug + :253)}`, `src/runtime/{spin.ts:66,livenessSweep.ts:161}`
- Modify: `src/extension.ts` (every `ticket #${…}`, `Ticket #${…}`, `?? \`#${ticketId}\``, ~45 sites; list with `grep -nE "#\\$\{(ticketId|r\.ticketId|graphRunTicketId|subtaskId|parentId)" src/extension.ts`)
- Test: `src/extension/ops/planningProposalOps.test.ts`, matching `*.test.ts` of each touched ops file, new `src/model/entityId.ratchet.test.ts`

**Interfaces:**
- Consumes: `formatId`, `formatTicketRef`.
- Produces (exact texts):
  - announce: `Plan P17 "bug reports" updated D88: "<title>" (description N chars, summary M chars).` / new draft: `Plan P17 "bug reports" proposes D88: "<title>" (…)`.
  - errors: `Draft D88 was not found.`, `Draft D88 is already <status>.`, `Couldn't <what> draft D88: …`, `Draft D88 was revised while you were editing; …`, `Draft D88 was discarded; T5, T6 <verb> on it.` (list = `formatId('ticket', n)` joined — the `pruned` ids are ticket ids; confirm in `planningProposals.ts` before converting).
  - Ticket texts: `Ticket T5: …` / `Could not start ticket T5: …`; where a key exists use `formatTicketRef(id, key)`; the `?? \`#${id}\`` fallbacks become `formatTicketRef(id, t.key)` (so keyless tickets show `T5`, keyed show `T5 · KEY`).

- [ ] **Step 1: Failing tests.** Update `planningProposalOps.test.ts` expectations to the exact announce text above (both `updated` and `proposes`), the not-found/already/revised/discarded messages. Add the ratchet (new file):

```ts
// src/model/entityId.ratchet.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SKIP_DIR = new Set(['ui', 'node_modules']);
// `#${…}` carrying a PR/revision/run number, not a ticket/draft/session id.
const ALLOWED = /#\$\{(pr\.number|p\.number|outcome\.revisionNumber|result\.revisionNumber|nodeRunId|processRunId|metrics\.instructionsHash)\}/;
const ENTITY = /#\$\{[^}]*(ticketId|sessionId|subtaskId|parentId|proposalId|\bid\b|requestedId|toTicketId|\bn\b)[^}]*\}/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!SKIP_DIR.has(e)) walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('entity-id ratchet', () => {
  it('no source text builds a #<entity id>; use entityId.ts', () => {
    const offenders = walk(ROOT).flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
        ENTITY.test(line) && !ALLOWED.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : []),
    );
    expect(offenders).toEqual([]);
  });
  it("no source concatenates '#' + an id", () => {
    const re = /['"]#['"]\s*\+/;
    const offenders = walk(ROOT).filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```
  Run it first: it lists every remaining offender, which is the worklist for this task. Allow-list edge cases ONLY by tightening `ALLOWED` with a per-line reason comment, never by skipping directories other than `ui` (follow-up D90).
- [ ] **Step 2: FAIL** (`npx vitest run src/model/entityId.ratchet.test.ts` lists offenders).
- [ ] **Step 3: Implement** the conversions per the list the ratchet prints. `planningProposalOps.ts:91`:

```ts
const sessionRef = formatId('plan', p.sessionId);
const verb = change === 'updated' ? 'updated' : 'proposes';
const text = `Plan ${sessionRef} "${session?.title ?? '?'}" ${verb} ${formatId('draft', p.id)}: "${title}" `
  + `(description ${description.length} chars, summary ${summary.length} chars).`;
```
  Mechanical: add `import { formatId, formatTicketRef } from '<rel>/model/entityId.js'` per file. Keep behaviour identical otherwise. In `extension.ts` (large; do in 3-4 sub-commits by region) keep unrelated `#${pr.number}` lines.
  Audit pass required by the ticket: `grep -nE "show(Information|Warning|Error)Message" src -r -g '!*.test.ts' -g '!src/ui/**'` and read each text mentioning ticket/draft/session; fix those the ratchet cannot see (texts using only a key, or `"Planning session"` wording).
  **Bind brief:** find where a created ticket's brief is composed from the draft on bind: `grep -rnE "onCreated|linkProposal|linkTicket|proposal.*brief|brief.*proposal" src -g '!*.test.ts' -g '!src/ui/**'` (the `onCreated` callback at `planningProposalOps.ts:~113` calls the link). Where a brief line cites the origin, make it `Planned in P<session> as D<draft>.` via `formatId`; if no origin line exists today, add exactly that one line to the appended brief (single line, tested). Add a test asserting the brief contains both `P<n>` and `D<n>`.
- [ ] **Step 4: PASS** — ratchet + each touched test file; then `npm run -s typecheck`.
- [ ] **Step 5: Commit** per region: `feat(ids): prefixed ids in notifications` / `refactor(ids): extension.ts ticket texts via formatTicketRef`.

---

### Task 7: Round-trip CLI test (acceptance)

**Files:**
- Test: `src/cli/ids.roundtrip.test.ts` (unit: in-memory `openStore(':memory:')`, fakes only; no child process so it stays `*.test.ts`)

- [ ] **Step 1: Write the test.**
  1. Create a ticket (reuse the store/ticket fixture helpers used in `src/cli/main.test.ts`), render `renderTicketContext(ctx, undefined, {sections:'facts'})`, extract `T\d+` from the first line, feed it to `resolveTicketByKey(store, extracted, slug)` → same ticket. Then `context`-render the sub-tasks section for a parent with one child; extract the child's `T<n>` and resolve it → the child.
  2. Draft: `runPropose` with `dependsOn:['D<existing>']` succeeds; parse the printed `ref`, feed it back as `dependsOn` of a second propose → accepted; `draft list` output contains the same `ref`.
  3. Wrong kind: `resolveTicketByKey(store,'D5',slug)` is `undefined`; `validateProposal` with `dependsOn:['T5']` fails and its message names `D<n>`; `parseId('D5','ticket')` message names `T<n>`.
- [ ] **Step 2: Run** `npx vitest run src/cli/ids.roundtrip.test.ts` → PASS (all code exists by now; if it fails, fix the code, not the test).
- [ ] **Step 3: Commit** `test(cli): round-trip prefixed ids agents are shown`.

---

### Task 8: Docs

**Files:**
- Create: `docs/arch/ids.md` (keyed block format; copy the AGENT INSTRUCTIONS header comment pattern from `docs/arch/cli.md`, namespace `arch`, key `arch:IDS-01`, ending `END_DOC_BLOCK: [@arch:IDS-01]`)
- Modify: `docs/glossary.md` blocks `[@gloss:GL-01]` (line 24; add an *Id* entry), `[@gloss:GL-11]` (459; note: commands accept `T<n>`/`D<n>` and bare numbers), `[@gloss:GL-15]` (575; cross-reference to GL-01 *Id*), `[@gloss:GL-19]` (679; quick-index rows `T<n>`, `D<n>`, `P<n>`)
- Modify: `docs/README.md` (link `arch/ids.md` in the arch list near line 28), `docs/arch/cli.md` (one-line pointer to `arch:IDS-01` and a bullet that id args go through `parseId`)

- [ ] **Step 1:** `ids.md` block `## [@arch:IDS-01] Every visible id goes through entityId.ts` containing the rules verbatim: prefixes and what each number is (`tickets.id`, `planning_proposals.id`, planning session id), `#N` = GitHub PR only, ticket key stays the provider's id (`T583 · ABC-123`), `parseId` acceptance table, the self-id line lives in the context header (facts block / heading, one line, `@arch:RESIDENT`), the ratchet test `src/model/entityId.ratchet.test.ts`, webview surfaces follow in D90.
- [ ] **Step 2:** edit the four glossary blocks (extract each with the awk recipe from CLAUDE.md first; edit inside the block; keep the `END_DOC_BLOCK` marker).
- [ ] **Step 3:** link from `docs/README.md` and `docs/arch/cli.md`.
- [ ] **Step 4: Verify** — `grep -n "arch:IDS-01" docs/arch/ids.md docs/arch/cli.md docs/README.md` shows all three; `awk -v id="[@arch:IDS-01]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/arch/ids.md` prints the block; `npm run -s inventory:extension` only if a doc test requires it (run `npx vitest run docs` / any docs-lint test that exists: `ls src/**/docs*.test.ts`).
- [ ] **Step 5: Commit** `docs: prefixed id format (arch:IDS-01, glossary)`.

---

### Task 9: Final verification

- [ ] `npm run -s typecheck`
- [ ] `npm run -s test:unit 2>&1 | tail -15` (once)
- [ ] `npm run -s test:integration 2>&1 | tail -15`
- [ ] `npx stryker run --mutate src/extension/ops/planningProposalOps.ts,src/extension/ops/planningOutbox.ts,<other changed src/extension files>` then `node scripts/mutationSummary.mjs | head -30`; add tests to kill survivors; score >= 85.
- [ ] Acceptance grep: `grep -rnE "#\\$\{|'#' \+" src -g '!*.test.ts' -g '!src/ui/**'` shows only PR/revision/run numbers (the ratchet test enforces it).
- [ ] No `src/ui/**` diffs: `git diff --stat develop -- src/ui` empty.
- [ ] Then `node "$KARST_CLI" phase implement …` is the NEXT command's job (execution), not this plan step.

---

## Self-review

- **Spec coverage:** 1 → T1; 2 → T6; 3 → T2 (ticket inputs, labels, subtask output), T3 (draft ref/list/dependsOn/registry), T4 (`context`, `context --md` share `renderTicketContext`); 4 → T4 (self-line, Sub-tasks/Parent rows), T5 (preamble, workflowCommand, per-kind seeds), T6 (bind brief); 5 → T8; acceptance bullets → T6 (notification, ratchet grep), T4/T5 (seed snapshots, context), T7 (round trip + wrong kind).
- **Known uncertainty (verify at execution):** exact location of the bind-brief composition (T6 gives the grep); whether `jsonSchema.ts` supports `anyOf` (T3 says extend it first); `graphRunTicketId(...)` returns a ticket id (confirm before converting). `message send --to` already takes keys; extend it to `T<n>` only if `resolveChild` goes through `resolveTicketByKey` (check `messageCommand.ts:86-110`; if it does not, route it through `parseId('ticket')` and add a test).
- **Type consistency:** `formatId`, `formatTicketRef`, `parseId`, `PREFIX`, `EntityKind` used identically across tasks; `TicketContextParent.id` / `TicketContextSubtaskParent.id` added in T4 and consumed only in T4.
