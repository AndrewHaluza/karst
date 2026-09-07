# Session Seed Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the composed session seed with a stated, priority-ordered character budget so it never silently balloons past what an agent can usefully read, and always tells the agent when it was cut.

**Architecture:** `renderTicketContext` (src/context/ticketContext.ts) already owns the ticket prompt, brief, per-gate summaries, and findings list as separate fields it renders into one markdown blob; each of those fields gets its own char cap, truncated in place with a stated pointer (`... truncated -- run \`karst context <key>\` for the full state.`) when it overflows. `buildSessionSeed` (src/agent/seed.ts) gets a matching cap for the approach-method body (the other unbounded input — real approach bodies run 17k+ chars) with the same stated-truncation treatment; the marker, invocation, and guide-pointer sections are tiny fixed strings the seed always composes in full and are never truncated, which is what "marker is priority 1" means in practice — it never competes for space because nothing this ticket touches can make it big. Both truncation points take an injected `debug` callback (never a direct logger import, matching the host-agnostic module rule) so a truncation is visible in diagnostics; `extension.ts` binds it to `logger.debug` with a `[seed]` prefix.

**Tech Stack:** TypeScript, vitest, existing `Store`/`TicketContext` shapes. No new dependencies.

**Spec:** PROMPT-08-SEED-BUDGET (ticket text above). Budget values are DERIVED from ticket 05's committed baseline (`docs/arch/prompt-metrics.md`, "Committed baseline" section) since the `seedChars` metric itself has zero recorded rows (post-v57, pending) — see "Budget derivation" below. This is a documented derivation, not an invented number, per the ticket's "do not invent a number" constraint and the user's explicit choice of this approach when the pending-baseline conflict was raised.

## Budget derivation (do not re-derive without checking `docs/arch/prompt-metrics.md` first)

From `docs/arch/prompt-metrics.md`'s committed baseline (whole Cursor store, 443 tickets):

| field | p90 (chars) | max (chars) |
|---|---|---|
| description (ticket prompt) | 2,683 | 1,174,592 |
| brief | 999 | 148,974 |

Plus a direct measurement of the largest known approach method body in this repo, `.agents/skills/karst-rpi-implement/SKILL.md` = 17,360 chars (the ticket's own "639 lines... exceeds 10k tokens" complaint).

Caps chosen as roughly 1.5–3× the p90 (generous headroom for a normal ticket, real truncation only for the long tail) and roughly half the largest known approach body (forces the exact case the ticket complains about to shrink):

| section | cap (chars) | rationale |
|---|---|---|
| ticket prompt | 4,000 | ~1.5× description p90 (2,683) |
| current-stage evidence: per-gate summary excerpt | 1,000 | existing gate `summary` excerpts are short by construction; caps a pathological one |
| current-stage evidence: findings list | 2,000 | bounds an unbounded findings array the same way `DEFAULT_MAX_TESTER_OBSERVATIONS` bounds tester observations |
| brief | 3,000 | ~3× brief p90 (999) |
| attachments list | 1,500 | bounds an unbounded attachment list |
| approach method | 8,000 | ~half the measured 17,360-char rpi-implement body |

Sum of caps ≈ 19,500 chars, plus marker/invocation/guide (~700 chars uncapped, always small) ≈ 20,200 chars ≈ 5,000 tokens — comfortably under the ticket's own "10k tokens before the agent reads a line of code" complaint. Repos/worktrees/servers/PRs sections are NOT capped: they are ticket-scoped structural lists (one line per repo/worktree/server/PR the ticket actually has), not free text, so they cannot grow the way prompt/brief/findings text can — matching the ticket's scope, which lists only "brief, gate summaries, findings list" as ticketContext's unbounded fields needing the same treatment.

## Global Constraints

- Truncation is ALWAYS stated, never silent: any truncated section gets the exact suffix `` ... truncated -- run `karst context <key>` for the full state. `` appended, where `<key>` is the ticket's key (or `#<id>` when the ticket has no key).
- The marker instruction is NEVER truncated (§5.4 invariant — it must survive intact in every seed).
- `renderTicketContext` and `buildSessionSeed` stay vscode-free / host-agnostic: no direct `logger` import; both take an optional injected `debug?: (msg: string) => void` callback, called only when a truncation actually happens.
- `extension.ts` is the one binding site: passes `logger.debug` as the callback, prefixed `[seed]`.
- No behavior change to the render order of `renderTicketContext`'s sections — only caps applied to existing fields in place.

---

### Task 1: Truncation helper module

**Files:**
- Create: `src/agent/seedBudget.ts`
- Test: `src/agent/seedBudget.test.ts`

**Interfaces:**
- Produces: `export function truncateToBudget(text: string, maxChars: number, ticketKey: string): { text: string; truncated: boolean }` — returns the input unchanged (`truncated: false`) when `text.length <= maxChars`; otherwise returns `text` cut to `maxChars` characters with the stated pointer suffix appended (`truncated: true`). The cut point is `maxChars` characters of original content (not counting the appended pointer), so the returned string's content length is `maxChars` plus the pointer's length — the cap bounds the SOURCE text, not the final rendered length, which is what makes the caps in the derivation table additive and predictable.
- Produces: `export const SEED_BUDGETS = { ticketPrompt: 4000, gateSummary: 1000, findings: 2000, brief: 3000, attachments: 1500, approachMethod: 8000 } as const;`
- Produces: `export function truncationPointer(ticketKey: string): string` — returns `` ... truncated -- run \`karst context ${ticketKey}\` for the full state. ``

- [ ] **Step 1: Write the failing test**

```typescript
// src/agent/seedBudget.test.ts
import { describe, it, expect } from 'vitest';
import { truncateToBudget, truncationPointer, SEED_BUDGETS } from './seedBudget.js';

describe('truncateToBudget', () => {
  it('returns text unchanged when under budget', () => {
    const result = truncateToBudget('short text', 100, 'PROJ-1');
    expect(result).toEqual({ text: 'short text', truncated: false });
  });

  it('returns text unchanged when exactly at budget', () => {
    const text = 'x'.repeat(10);
    const result = truncateToBudget(text, 10, 'PROJ-1');
    expect(result).toEqual({ text, truncated: false });
  });

  it('cuts to budget and appends the stated pointer when over budget', () => {
    const text = 'x'.repeat(20);
    const result = truncateToBudget(text, 10, 'PROJ-1');
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('x'.repeat(10) + truncationPointer('PROJ-1'));
  });

  it('names the ticket key in the pointer', () => {
    expect(truncationPointer('PROJ-9')).toBe(
      ' ... truncated -- run `karst context PROJ-9` for the full state.',
    );
  });

  it('exposes the derived per-section budgets', () => {
    expect(SEED_BUDGETS).toEqual({
      ticketPrompt: 4000,
      gateSummary: 1000,
      findings: 2000,
      brief: 3000,
      attachments: 1500,
      approachMethod: 8000,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/seedBudget.test.ts -v`
Expected: FAIL — `Cannot find module './seedBudget.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agent/seedBudget.ts
/**
 * Per-section character caps for the composed session seed, derived in
 * docs/superpowers/plans/2026-09-07-seed-budget.md from ticket 05's committed
 * ticket-text baseline (docs/arch/prompt-metrics.md) — the `seedChars` metric
 * itself has zero recorded rows, so these are NOT read off that metric.
 * Re-derive from the same doc before changing any of these numbers.
 */
export const SEED_BUDGETS = {
  ticketPrompt: 4000,
  gateSummary: 1000,
  findings: 2000,
  brief: 3000,
  attachments: 1500,
  approachMethod: 8000,
} as const;

/**
 * The stated truncation pointer (§ "Truncation is always stated, never
 * silent"). A silently shortened seed is worse than a long one — the agent
 * must know to pull the rest via `karst context <key>`.
 */
export function truncationPointer(ticketKey: string): string {
  return ` ... truncated -- run \`karst context ${ticketKey}\` for the full state.`;
}

/**
 * Cut `text` to `maxChars` characters of original content and append the
 * stated pointer when it overflows; returns it unchanged otherwise. The cap
 * bounds the SOURCE text, not the final string (the pointer is additional).
 */
export function truncateToBudget(
  text: string,
  maxChars: number,
  ticketKey: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + truncationPointer(ticketKey), truncated: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/seedBudget.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/seedBudget.ts src/agent/seedBudget.test.ts
git commit -m "feat: add seed truncation budgets and stated-pointer helper"
```

---

### Task 2: Bound `renderTicketContext`'s unbounded fields (prompt, brief, gate summaries, findings, attachments)

**Files:**
- Modify: `src/context/ticketContext.ts:443-450` (prompt/brief), `:452-495` (gate summaries/findings), `:531-541` (attachments)
- Test: `src/context/ticketContext.test.ts`

**Interfaces:**
- Consumes: `truncateToBudget`, `SEED_BUDGETS` from `./seedBudget.js` (Task 1); `TicketContext` (existing).
- Produces: `export function renderTicketContext(ctx: TicketContext, debug?: (msg: string) => void): string` — same signature plus one new optional trailing param. Every existing call site (`buildSessionSeed`'s caller in `extension.ts`, the `karst context` CLI) keeps compiling unchanged since the param is optional.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/context/ticketContext.test.ts, inside describe('buildTicketContext', ...)
describe('seed budget truncation', () => {
  it('truncates an oversized prompt with the stated pointer, and reports it via debug', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'PROJ-9', title: 'Big', description: 'x'.repeat(10_000) });
    const ctx = buildTicketContext(store, undefined, id);
    const seen: string[] = [];
    const md = renderTicketContext(ctx, (m) => seen.push(m));
    expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
    expect(md.match(/x/g)!.length).toBe(4000);
    expect(seen.some((m) => m.includes('prompt'))).toBe(true);
  });

  it('truncates an oversized brief with the stated pointer', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'PROJ-9', title: 'Big' });
    setTicketBrief(store, id, 'y'.repeat(10_000));
    const ctx = buildTicketContext(store, undefined, id);
    const md = renderTicketContext(ctx);
    expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
    expect(md.match(/y/g)!.length).toBe(3000);
  });

  it('does not truncate a prompt under budget', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'PROJ-1', title: 'Small', description: 'short prompt' });
    const ctx = buildTicketContext(store, undefined, id);
    const md = renderTicketContext(ctx);
    expect(md).not.toContain('truncated --');
    expect(md).toContain('short prompt');
  });
});
```

Adjust the exact helper names (`createTicket`, `setTicketBrief`) to match whatever fixtures the top of `ticketContext.test.ts` already uses (see its existing `describe('buildTicketContext', ...)` block for the real fixture helpers before writing this — do not guess).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context/ticketContext.test.ts -v`
Expected: FAIL — assertions on truncation text/length fail (prompt/brief render in full, no pointer text present)

- [ ] **Step 3: Write minimal implementation**

In `src/context/ticketContext.ts`, add the import:

```typescript
import { truncateToBudget, SEED_BUDGETS } from '../agent/seedBudget.js';
```

Change the function signature and the prompt/brief block:

```typescript
export function renderTicketContext(ctx: TicketContext, debug?: (msg: string) => void): string {
  const parts: string[] = [`# Ticket: ${ticketHeading(ctx)}`];
  const key = ctx.key ?? `#${ticketHeading(ctx)}`;

  const promptRaw = ctx.prompt?.trim();
  if (promptRaw) {
    const { text: prompt, truncated } = truncateToBudget(promptRaw, SEED_BUDGETS.ticketPrompt, key);
    if (truncated) debug?.(`[seed] truncated ticket prompt to ${SEED_BUDGETS.ticketPrompt} chars`);
    parts.push(`## Prompt\n${prompt}`);
  }

  const briefRaw = ctx.brief?.trim();
  if (briefRaw) {
    const { text: brief, truncated } = truncateToBudget(briefRaw, SEED_BUDGETS.brief, key);
    if (truncated) debug?.(`[seed] truncated context brief to ${SEED_BUDGETS.brief} chars`);
    parts.push(`## Context brief\n${brief}`);
  }
```

In the gate-summary loop (inside `if (ctx.stage)`), cap each excerpt:

```typescript
        if (g.summary) {
          const { text: summary, truncated } = truncateToBudget(g.summary, SEED_BUDGETS.gateSummary, key);
          if (truncated) debug?.(`[seed] truncated gate summary for ${g.name} to ${SEED_BUDGETS.gateSummary} chars`);
          for (const line of summary.split('\n')) lines.push(`      ${line}`);
        }
```

Cap the findings list as one joined block (bounds total list size, not per-item):

```typescript
    if (s.findings.length > 0) {
      const findingsBlock = s.findings
        .map((f) => {
          const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
          return `  - [${f.severity}] ${f.title}${loc}`;
        })
        .join('\n');
      const { text: bounded, truncated } = truncateToBudget(findingsBlock, SEED_BUDGETS.findings, key);
      if (truncated) debug?.(`[seed] truncated findings list to ${SEED_BUDGETS.findings} chars`);
      lines.push('- findings:', bounded);
    }
```

Cap the attachments block:

```typescript
  if (ctx.attachments.length > 0) {
    const rowsBlock = ctx.attachments
      .map((a) => {
        const note = a.kind === 'video' ? ' (not agent-readable)' : '';
        return `- ${a.kind}: ${a.path} — "${a.name}"${note}`;
      })
      .join('\n');
    const { text: bounded, truncated } = truncateToBudget(rowsBlock, SEED_BUDGETS.attachments, key);
    if (truncated) debug?.(`[seed] truncated attachments list to ${SEED_BUDGETS.attachments} chars`);
    parts.push(`## Attachments\n${bounded}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/context/ticketContext.test.ts -v`
Expected: PASS (all tests in the file, including the new `describe('seed budget truncation', ...)` block)

- [ ] **Step 5: Commit**

```bash
git add src/context/ticketContext.ts src/context/ticketContext.test.ts
git commit -m "feat: bound ticket prompt, brief, gate summaries, findings, and attachments with stated truncation"
```

---

### Task 3: Bound `buildSessionSeed`'s approach-method section

**Files:**
- Modify: `src/agent/seed.ts:22-50`
- Test: `src/agent/seed.test.ts`

**Interfaces:**
- Consumes: `truncateToBudget`, `SEED_BUDGETS` from `./seedBudget.js` (Task 1).
- Produces: `export function buildSessionSeed(contextMarkdown, approachPrompt, invocation?, markerInstruction?, guideInstruction?, ticketKey?: string, debug?: (msg: string) => void): string | undefined` — two new optional trailing params, so every existing call keeps compiling. When `ticketKey` is omitted, truncation still applies using `'this ticket'` as the pointer's key placeholder (never skips truncation just because the caller forgot the key).

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/agent/seed.test.ts
describe('buildSessionSeed budget', () => {
  it('truncates an oversized approach method with the stated pointer', () => {
    const bigMethod = '# Big approach\n' + 'z'.repeat(20_000);
    const seed = buildSessionSeed(CONTEXT, bigMethod, undefined, undefined, undefined, 'PROJ-9');
    expect(seed).toContain('truncated -- run `karst context PROJ-9` for the full state.');
    // 8000-char budget + the untruncated "# Big approach\n" heading text before the z-run
    expect(seed!.match(/z/g)!.length).toBe(8000);
  });

  it('never truncates the marker instruction, even with a huge context and method', () => {
    const bigContext = 'c'.repeat(50_000);
    const bigMethod = 'm'.repeat(50_000);
    const marker = 'FIRE THE MARKER: run `karst stage impl pass`';
    const seed = buildSessionSeed(bigContext, bigMethod, undefined, marker, undefined, 'PROJ-9');
    expect(seed).toContain(marker);
  });

  it('reports truncation via the injected debug callback', () => {
    const bigMethod = 'z'.repeat(20_000);
    const seen: string[] = [];
    buildSessionSeed(CONTEXT, bigMethod, undefined, undefined, undefined, 'PROJ-9', (m) => seen.push(m));
    expect(seen.some((m) => m.includes('approach method'))).toBe(true);
  });

  it('does not truncate a method body under budget', () => {
    const seed = buildSessionSeed(CONTEXT, '# Small\nGo look.', undefined, undefined, undefined, 'PROJ-9');
    expect(seed).not.toContain('truncated --');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/seed.test.ts -v`
Expected: FAIL — no truncation applied, full 20,000-char method present, no pointer text

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agent/seed.ts
import { seedCharLength, seedHasGuide } from './promptTelemetry.js';
import { truncateToBudget, SEED_BUDGETS } from './seedBudget.js';

export function buildSessionSeed(
  contextMarkdown: string | null | undefined,
  approachPrompt: string | null | undefined,
  invocation?: string | null,
  markerInstruction?: string | null,
  guideInstruction?: string | null,
  ticketKey?: string,
  debug?: (msg: string) => void,
): string | undefined {
  let method = approachPrompt?.trim();
  const context = contextMarkdown?.trim();
  const inv = invocation?.trim();
  const marker = markerInstruction?.trim();
  const guide = guideInstruction?.trim();

  if (method) {
    const key = ticketKey ?? 'this ticket';
    const { text, truncated } = truncateToBudget(method, SEED_BUDGETS.approachMethod, key);
    if (truncated) debug?.(`[seed] truncated approach method to ${SEED_BUDGETS.approachMethod} chars`);
    method = text;
  }

  const sections: string[] = [];
  if (inv) sections.push(inv);
  if (context) sections.push(context);
  if (method) sections.push(`# Approach\n\n${method}`);
  if (guide) sections.push(guide);
  if (marker) sections.push(marker);
  if (sections.length === 0) return undefined;
  return sections.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/seed.test.ts -v`
Expected: PASS (all tests in the file, including the pre-existing ones — the two new trailing params are optional so they stay green)

- [ ] **Step 5: Commit**

```bash
git add src/agent/seed.ts src/agent/seed.test.ts
git commit -m "feat: bound the approach-method section of the session seed with stated truncation"
```

---

### Task 4: Wire the ticket key and debug logging through `extension.ts`

**Files:**
- Modify: `src/extension.ts` (both `buildSessionSeed` call sites, ~line 6144 and ~line 6234 per the current file; re-grep `buildSessionSeed(` before editing since line numbers shift)

**Interfaces:**
- Consumes: `buildSessionSeed(..., ticketKey?, debug?)` (Task 3), `renderTicketContext(ctx, debug?)` (Task 2), existing `logger` import already used at `extension.ts:3414`.

- [ ] **Step 1: Locate both call sites**

Run: `grep -n "buildSessionSeed(\|renderTicketContext(" src/extension.ts`

- [ ] **Step 2: Wire `renderTicketContext`'s debug callback**

At the `renderTicketContext(buildTicketContext(...))` call, add the debug callback:

```typescript
const ticketContextMd = renderTicketContext(
  buildTicketContext(
    localStore,
    currentManifest(),
    ticketId,
    context.globalStorageUri.fsPath,
  ),
  (msg) => logger.debug(msg),
);
```

- [ ] **Step 3: Wire `buildSessionSeed`'s ticket key and debug callback at BOTH call sites**

Each of the two `buildSessionSeed(...)` calls (the initial one and the post-materialization rebuild) gains two trailing args:

```typescript
const initialPrompt = buildSessionSeed(
  ticketContextMd,
  approachPrompt ?? delegation,
  invocation,
  markerInstruction,
  renderGuideInstruction(buildCliGuidePrefix(context)),
  t.key ?? String(ticketId),
  (msg) => logger.debug(msg),
);
```

```typescript
seedPrompt = buildSessionSeed(
  ticketContextMd,
  approachPrompt ?? delegation,
  invocation,
  markerInstruction,
  renderGuideInstruction(buildCliGuidePrefix(context)),
  t.key ?? String(ticketId),
  (msg) => logger.debug(msg),
);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: Run the full unit suite**

Run: `npm run test:unit`
Expected: all tests PASS, including Tasks 1–3's new tests

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire ticket key and debug logging into the bounded session seed"
```

---

### Task 5: End-to-end oversized-ticket RED/GREEN test (the ticket's own TDD requirement)

**Files:**
- Test: `src/agent/seed.test.ts` (or a new `src/agent/seedBudget.e2e.test.ts` if `seed.test.ts` is getting long — either is fine, keep it close to `buildSessionSeed`)

**Interfaces:**
- Consumes: `buildSessionSeed` (Task 3), `renderTicketContext` + `buildTicketContext`-style fixture (Task 2) — or a hand-built oversized `TicketContext`-shaped markdown string, whichever the existing test file's fixtures make easier; do not add a new fixture helper if `CONTEXT`-style literals already suffice.

This task is the ticket's own stated RED/GREEN acceptance test: an oversized-ticket fixture whose composed seed (a) fits a sane overall ceiling, (b) keeps the marker instruction intact, (c) carries the truncation pointer.

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/agent/seed.test.ts
describe('oversized ticket end-to-end budget (PROMPT-08 acceptance)', () => {
  it('a ticket with a huge prompt, brief, and approach method still produces a bounded, marker-intact seed', () => {
    const hugeContext =
      `# Ticket: PROJ-9 — Oversized\n\n## Prompt\n${'p'.repeat(50_000)}\n\n` +
      `## Context brief\n${'b'.repeat(50_000)}`;
    const hugeMethod = '# rpi-implement\n' + 'm'.repeat(50_000);
    const marker = 'Run `karst stage impl pass --ticket PROJ-9` when done.';

    const seed = buildSessionSeed(
      hugeContext,
      hugeMethod,
      '/karst:rpi PROJ-9',
      marker,
      'Run `karst guide` to learn the CLI.',
      'PROJ-9',
    );

    expect(seed).toBeDefined();
    // (a) fits: total seed stays well under the ticket's own "10k tokens"
    // complaint (~40,000 chars at ~4 chars/token).
    expect(seed!.length).toBeLessThan(40_000);
    // (b) the marker instruction survives verbatim.
    expect(seed).toContain(marker);
    // (c) the truncation pointer is present (context wasn't bounded by
    // buildSessionSeed itself in this fixture, but the approach method was).
    expect(seed).toContain('truncated -- run `karst context PROJ-9` for the full state.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/seed.test.ts -v`
Expected: FAIL before Task 3 lands (or PASS trivially if run after Task 3 — run this task's Step 1 test BEFORE Task 3's Step 3 implementation if executing the whole plan in strict task order matters to you; if Tasks 1–4 are already committed by the time you reach this task, this step instead documents the acceptance criterion and Step 2 becomes a confirming run, which is fine — the point of this task is the acceptance test existing and passing, not re-litigating RED for code already proven in Task 3)

- [ ] **Step 3: No new implementation needed**

Task 3 already provides the truncation; this task only asserts the ticket's three acceptance properties hold end-to-end. If it fails, the bug is in Task 3's implementation — fix there, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/seed.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/seed.test.ts
git commit -m "test: add PROMPT-08 acceptance test for the bounded session seed"
```

---

### Task 6: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `npm run test:unit`
Expected: all PASS

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 4: Confirm no other `buildSessionSeed`/`renderTicketContext` call sites were missed**

Run: `grep -rn "buildSessionSeed(\|renderTicketContext(" src --include="*.ts" | grep -v ".test.ts"`
Expected: only the CLI's `karst context` call to `renderTicketContext` (no debug callback needed there — it's a one-shot CLI print, not a live session) and the two `extension.ts` sites from Task 4.

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: verification pass for the bounded session seed"
```

(Skip this commit if Step 4 found nothing to fix.)

---

## Self-Review

**Spec coverage:**
1. `buildSessionSeed` takes a budget with per-section allocation and priority order → Task 1 (budgets), Task 3 (approach-method cap in `buildSessionSeed`), Task 2 (ticket-prompt/brief/evidence caps in `renderTicketContext`, which `buildSessionSeed` composes). Marker/invocation/guide are the priority-1/2/4 sections and are never capped because they're small fixed strings — documented in Global Constraints.
2. Truncation always stated → `truncationPointer` (Task 1), applied at every truncation site (Tasks 2–3).
3. Same treatment inside `renderTicketContext` for brief/gate-summaries/findings → Task 2.
4. Budget value from ticket 05's baseline, not invented → "Budget derivation" section, sourced from `docs/arch/prompt-metrics.md`'s committed numbers plus a direct file measurement.
5. Behind existing debug logging → injected `debug` callback (Tasks 2–3), bound to `logger.debug` in `extension.ts` (Task 4).
6. TDD RED/GREEN with oversized fixture → Task 5.

**Placeholder scan:** no TBD/TODO, every step has real code or a real grep/run command.

**Type consistency:** `truncateToBudget` returns `{ text: string; truncated: boolean }` everywhere it's used (Tasks 2, 3, 5). `SEED_BUDGETS` keys (`ticketPrompt`, `gateSummary`, `findings`, `brief`, `attachments`, `approachMethod`) are used identically across Tasks 1–3. `renderTicketContext(ctx, debug?)` and `buildSessionSeed(..., ticketKey?, debug?)` signatures match between their Task 2/3 definitions and their Task 4 call sites.
