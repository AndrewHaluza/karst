# Inside Block Prototype Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production dashboard Inside block reproduce the approved structure and visual hierarchy in `docs/ui/inside-redesign-designer-handoff.html`, especially the attached Implementation example, without shipping any prototype controls.

**Architecture:** Keep `InsideStageView` as the host-owned source of truth and keep the webview presentation-only. Add only the small presentation fields the approved HTML needs, render the outer process ledger and each evidence kind with semantic HTML, and validate the real production renderer with deterministic fixtures. Do not reintroduce the deleted development preview command, toolbar, scenario selectors, width buttons, or fake live-operation actions.

**Tech Stack:** TypeScript, VS Code webview HTML/CSS/JavaScript, Vitest, existing Karst design tokens and injected agent identity icons.

## Global Constraints

- The visual source of truth is `docs/ui/inside-redesign-designer-handoff.html`; the attached expected screenshot is the Implementation-stage acceptance reference.
- Preserve the six presentation stages: `scope | impl | uat | review | ship | done`. Runtime `fix` remains projected into UAT or Review.
- The webview renders host-supplied facts. It may map closed status/evidence vocabularies to markup, but must not infer verdicts, counts, durations, identities, or token totals.
- Use existing `--k-*` design tokens and VS Code theme variables. Add no framework, dependency, CDN, raw palette, or duplicate design system.
- Escape every host-supplied string with `esc()` before interpolation.
- Keep actions as real buttons and disclosures as native `<details>/<summary>` where collapsing is required.
- Missing history is absence, never zero. Unsupported token usage is omitted or expressed as an explicit host-supplied note.
- Do not add `Stage / scenario`, `Repositories`, `300`, `360`, `430`, `normal`, `Start live operation`, `Complete`, or `Clear` anywhere in production or development UI.
- Preserve the current action capability boundary: the webview posts only opaque `actionId` values.
- Follow TDD. Each task is one independently reviewable commit; do not batch commits.

## File Structure

- Modify `src/model/inside/types.ts`: add explicit presentation fields needed for the prototype's visible status and Implementation footer.
- Modify `src/model/inside/agent.ts`: populate the Implementation session header, timeline rows, status copy, and footer from recorded execution evidence.
- Modify `src/model/inside/agent.test.ts`: pin the host-side claims that the renderer consumes.
- Modify `src/ui/dashboard/webview.html`: replace the current generic card styling/markup with the approved ledger anatomy and specialized evidence layouts.
- Modify `src/ui/dashboard/webview.test.ts`: test generated production markup, semantic behavior, responsive rules, and absence of prototype controls.
- Modify `src/ui/dashboard/renderFixtures.ts`: provide exact passed/running/switched-session fixtures used by renderer tests.
- Modify `src/ui/dashboard/renderFixtures.test.ts`: pin fixture fidelity and bounds.
- Modify `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md`: replace the deleted preview-command procedure with production-render fixture and Extension Development Host verification.

---

### Task 1: Lock the approved prototype as a production-render contract

**Files:**
- Modify: `src/ui/dashboard/renderFixtures.ts`
- Modify: `src/ui/dashboard/renderFixtures.test.ts`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: existing `InsideStageView`, `InsideProcessView`, `EvidenceRow`, and `InsideRenderFixture`.
- Produces: an exact completed Implementation fixture with a session id, two provider segments, phase rows, per-segment tokens, timestamps, terminal status, and footer facts.

- [ ] **Step 1: Write a failing fixture test for the attached expected state**

Add an exported `implementationPrototypeFixture()` to `renderFixtures.ts` and first write this test in `renderFixtures.test.ts`:

```ts
it('models the approved completed implementation session', () => {
  const fixture = implementationPrototypeFixture();
  const session = fixture.view.processes[0]!;

  expect(fixture.view).toMatchObject({
    stageKey: 'impl',
    title: 'Implementation',
    processes: [{ id: 'session', label: 'Session', status: 'pass' }],
  });
  expect(session.evidence).toMatchObject({
    kind: 'timeline',
    rows: [
      { label: 'started with', detail: 'Claude Code · Opus' },
      { label: 'Understand' },
      { label: 'Plan' },
      { label: 'switched core + model', detail: 'Codex · Sol', connector: 'switch' },
      { label: 'Implement' },
      { label: 'switched core + model', detail: 'Claude Code · Sonnet', connector: 'switch' },
      { label: 'Tests' },
      { label: 'Done' },
    ],
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts`

Expected: FAIL because `implementationPrototypeFixture` does not exist.

- [ ] **Step 3: Add the deterministic fixture**

Implement `implementationPrototypeFixture()` in `renderFixtures.ts` using only production view types. Use stable values matching the acceptance image: session `c7f1`, Claude Code/Opus start, Codex/Sol switch, Claude Code/Sonnet switch, phase timestamps, `46.1k input`, `12.2k output`, and `2 switches`. Do not give fixture actions real registry-shaped ids; retain the `fixture:` prefix.

```ts
export function implementationPrototypeFixture(): InsideRenderFixture {
  return {
    repositoryCount: 2,
    scenario: 'passed',
    stage: 'impl',
    view: {
      stageKey: 'impl',
      title: 'Implementation',
      dot: 'done',
      clock: 'completed',
      processes: [{
        id: 'session',
        kind: 'session',
        label: 'Session',
        status: 'pass',
        detail: 'session c7f1 · completed',
        duration: '19m',
        execution: { provider: 'claude', providerLabel: 'Claude Code', model: 'sonnet', modelLabel: 'Sonnet' },
        tokens: { state: 'measured', total: '58.3k', exact: '58,300' },
        evidence: { kind: 'timeline', rows: [
          { status: 'note', label: 'started with', detail: 'Claude Code · Opus', duration: '10:03–10:09' },
          { status: 'pass', label: 'Understand', detail: 'reported · 10:06:14', duration: '10:06' },
          { status: 'pass', label: 'Plan', detail: 'reported · 10:08:52', duration: '10:08' },
          { status: 'note', label: 'switched core + model', detail: 'Codex · Sol', duration: '10:09:04', connector: 'switch' },
          { status: 'pass', label: 'Implement', detail: 'reported · 10:15:47', duration: '10:15' },
          { status: 'note', label: 'switched core + model', detail: 'Claude Code · Sonnet', duration: '10:16:21', connector: 'switch' },
          { status: 'pass', label: 'Tests', detail: 'reported · 10:20:06', duration: '10:20' },
          { status: 'pass', label: 'Done', detail: 'done marker · 10:22:43', duration: '10:22' },
        ] },
      }],
      blurb: STAGE_BLURBS.impl,
    },
  };
}
```

If Task 2 introduces footer fields, update this fixture in Task 2 rather than encoding the footer as a fake evidence row.

- [ ] **Step 4: Add source-level guardrails against prototype controls**

In `webview.test.ts`, assert that production HTML and `package.json` do not contain the literal debug labels listed in Global Constraints and do not contain `karst.dev.openInsidePreview`, `insidePreview`, or `previewContext`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run src/ui/dashboard/renderFixtures.test.ts src/ui/dashboard/webview.test.ts
npm run typecheck
```

Expected: PASS.

Commit: `test(dashboard): lock the approved inside prototype contract`

---

### Task 2: Supply the visible session status and footer as host-owned facts

**Files:**
- Modify: `src/model/inside/types.ts`
- Modify: `src/model/inside/agent.ts`
- Modify: `src/model/inside/agent.test.ts`
- Modify: `src/ui/dashboard/renderFixtures.ts`

**Interfaces:**
- Consumes: recorded `ImplementationTimeline`, `PhaseMark[]`, execution segments, and token summary already passed to `implementationSessionProcess`.
- Produces: `InsideProcessView.statusLabel?: string` and `InsideProcessView.footer?: readonly string[]`; no formatted business fact is invented in the webview.

- [ ] **Step 1: Write failing model tests**

Add tests to `agent.test.ts` asserting:

```ts
expect(process.statusLabel).toBe('Completed');
expect(process.footer).toEqual([
  'session c7f1',
  '2 switches',
  '46.1k input · 12.2k output',
  'same session continues across switches',
  'advances only on explicit done marker',
]);
```

Also add status cases mapping `pending → Pending`, `run → Running`, `wait → Waiting`, `pass → Completed`, `fail → Failed`, `note → Note`, and `skip → Skipped`. Absence of an input/output split must omit that footer item; it must not render `0 input` or `0 output`.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run src/model/inside/agent.test.ts`

Expected: TypeScript/test failure because the fields are absent.

- [ ] **Step 3: Extend the presentation contract**

Add to `InsideProcessView`:

```ts
/** Visible status copy; status colour/glyph is never the only carrier. */
statusLabel?: string;
/** Host-formatted, non-interactive facts shown below the expanded process. */
footer?: readonly string[];
```

Keep both optional so other process reducers can adopt them incrementally without fabricated fallback values.

- [ ] **Step 4: Populate Implementation facts in the reducer**

In `implementationSessionProcess`, derive the visible label from the already-derived `status`, and build footer entries only from recorded timeline/session/token facts. Add a focused helper with this signature:

```ts
function implementationFooter(
  timeline: ImplementationTimeline | null,
  tokens: SessionTokensInput | null | undefined,
): readonly string[];
```

The helper must preserve this order: session id, switch count, input/output totals, continuity explanation, explicit-marker explanation. It must return no session-id item when none was recorded and no token item when the split is absent.

- [ ] **Step 5: Update the prototype fixture**

Set `statusLabel: 'Completed'` and the exact five footer items on `implementationPrototypeFixture()`. Do not encode these as timeline rows.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/model/inside/agent.test.ts src/ui/dashboard/renderFixtures.test.ts
npm run typecheck
```

Expected: PASS.

Commit: `feat(model): expose prototype session status and footer facts`

---

### Task 3: Rebuild the outer Inside ledger to match the approved HTML

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `InsideStageView`, `InsideProcessView.statusLabel`, identity, tokens, action, and footer.
- Produces: semantic `.inside-ledger`, `.inside-head`, `.inside-process`, `.process-summary`, and `.process-footer` markup.

- [ ] **Step 1: Write failing production-markup tests**

Use `renderWith(...)` and `implementationPrototypeFixture().view`, not regex over source alone. Assert:

```ts
expect(html).toContain('class="inside-ledger"');
expect(html).toContain('class="inside-head"');
expect(html).toContain('Inside impl');
expect(html).toContain('class="inside-process pass"');
expect(html).toContain('Session');
expect(html).toContain('Completed');
expect(html).toContain('session c7f1');
expect(html).toContain('same session continues across switches');
expect(html).not.toContain('class="act ');
expect(html).not.toContain('class="procs"');
```

Add a DOM-order assertion: label precedes detail; detail precedes right-side identity/tokens; footer follows evidence. Add a test proving status text remains visible when color styles are ignored.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`

Expected: FAIL because the current renderer emits `.act`, `.ahead`, `.proc`, and `.procs`.

- [ ] **Step 3: Replace only the Inside component markup**

Refactor `processRowHtml` and `renderInside` to emit the approved anatomy:

```html
<section class="inside-ledger" aria-labelledby="inside-title">
  <header class="inside-head">
    <strong id="inside-title">Inside impl</strong>
    <span class="inside-clock">completed</span>
  </header>
  <details class="inside-process pass" data-proc-id="impl:session" open>
    <summary class="process-summary">…</summary>
    <div class="process-evidence">…</div>
    <footer class="process-footer">…</footer>
  </details>
</section>
```

Use `view.stageKey` for the compact header (`Inside impl`, `Inside uat`) to match the prototype. Preserve `view.title` in an accessible title or label. Keep the existing viewing-stage bar outside the ledger header. Preserve opaque inside-action dispatch and disclosure-state restoration.

- [ ] **Step 4: Implement the prototype grid and borders with tokens**

Replace the current hover-card appearance with the prototype's quiet ledger:

- one border around the ledger;
- a hairline below the stage header;
- one hairline between top-level processes;
- process summary grid: status marker, flexible content, identity/tokens, terminal status/action;
- no filled hover card around every row;
- no oversized `+` disclosure button;
- compact typography and aligned mono metadata;
- focus-visible outline on the native summary.

Use existing spacing, border, radius, text, status, and surface tokens. Do not copy the prototype's raw hex values.

- [ ] **Step 5: Make completed evidence visible by default without breaking other disclosures**

The approved Implementation screenshot shows the timeline without a preliminary click. Add a closed presentation map in the renderer:

```js
const DEFAULT_OPEN_PROCESS_KINDS = new Set(['session']);
```

On first render, emit `open` for a session with non-empty evidence. Once the user toggles it, local disclosure state wins. Do not default-open repository-scaled gates, findings, PRs, or receipt evidence.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run src/ui/dashboard/webview.test.ts
npm run typecheck
```

Expected: PASS.

Commit: `feat(dashboard): render inside as the approved quiet ledger`

---

### Task 4: Render the Implementation timeline as the prototype's connected phase ledger

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/model/inside/agent.ts`
- Modify: `src/model/inside/agent.test.ts`

**Interfaces:**
- Consumes: `ProcessEvidenceView & { kind: 'timeline' }`, structural `connector`, row status, row label/detail/duration, and captured execution identity.
- Produces: always-legible timeline nodes, connector branches, identity segments, token pills, and right-aligned timestamps.

- [ ] **Step 1: Write failing renderer tests from the expected screenshot**

Render the prototype fixture and assert all eight timeline rows appear in order. Assert phase rows have pass markers, switch rows use the structural connector, provider icons come from the existing injected identity renderer, token pills are secondary, and timestamps occupy a dedicated cell. Assert the renderer never detects switches by matching label text.

- [ ] **Step 2: Write a failing reducer test for row roles**

The current generic `EvidenceRow` cannot distinguish a phase report from a session-start identity segment except by label. Extend it with an optional closed role:

```ts
role?: 'phase' | 'identity' | 'event';
```

Test that start/switch/resume rows are `identity`, reported phases are `phase`, and generic events are `event`. Keep `connector` as the sole relationship marker.

- [ ] **Step 3: Run and confirm RED**

Run:

```bash
npx vitest run src/model/inside/agent.test.ts src/ui/dashboard/webview.test.ts
```

Expected: FAIL because `role` and prototype timeline classes do not exist.

- [ ] **Step 4: Populate structural roles host-side**

Modify `timelineEvents` in `agent.ts` so every produced row sets `role`. No webview label parsing is permitted. Update `EvidenceRow` documentation in `types.ts` in the same commit if Task 4 owns that edit during execution.

- [ ] **Step 5: Add a dedicated timeline renderer**

Have `evidenceTimelineHtml` emit:

```html
<ol class="session-timeline">
  <li class="timeline-row role-phase pass">…</li>
  <li class="timeline-row role-identity connector-switch">…</li>
</ol>
```

Use a fixed marker column and CSS pseudo-element spine. Phase rows show the phase name first and `reported · <time>` second. Identity rows show the host-supplied event label, injected provider/core identity, optional token pill, and timestamp. The connector branch must be created from `connector`, never from `label`.

- [ ] **Step 6: Match the screenshot hierarchy**

Implement these exact visual relationships with tokens:

- green outlined check for completed phases;
- quiet hollow node for `started with`;
- branch/turn marker for provider switches;
- provider/core identity visually stronger than event prose;
- token count in a bordered mono pill;
- right-aligned timestamp column;
- continuous subtle vertical spine between related rows;
- no horizontal scrollbar at 300px.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run src/model/inside/agent.test.ts src/ui/dashboard/webview.test.ts
npm run typecheck
```

Expected: PASS.

Commit: `feat(dashboard): match the prototype implementation timeline`

---

### Task 5: Bring every evidence kind into the same prototype visual grammar

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/ui/dashboard/renderFixtures.ts`
- Modify: `src/ui/dashboard/renderFixtures.test.ts`

**Interfaces:**
- Consumes: the closed `EVIDENCE_KINDS` union and existing bounded fixture matrix.
- Produces: one shared evidence row grid plus explicit variants for gates, findings, commits, PRs, recovery, receipt, and generic rows.

- [ ] **Step 1: Add failing matrix assertions**

For every `EVIDENCE_KINDS` member, render a fixture and assert a distinct `evidence-<kind>` class, visible status text, factual detail, and action placement. Add explicit acceptance assertions:

- UAT order is Gates → causal Fix → Services → Tester.
- Review order is Gates → Services → Review with causal Fix immediately after its trigger.
- Ship remains Commit → Push → PR → Merge and conflicts render waiting, never failed.
- Done is a receipt and contains no run/retry controls.
- bounded repository/findings/gate rows retain host-supplied `Show N more` controls.

- [ ] **Step 2: Run and confirm RED**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts src/ui/dashboard/webview.test.ts`

Expected: at least the distinct structural/layout assertions fail.

- [ ] **Step 3: Consolidate shared evidence markup**

Create one helper for marker/label/detail/status/time/action cells. Keep one renderer function per closed evidence kind, but have each call the helper with an explicit layout mode. Delete empty CSS declarations such as `.pev-gates .erow{}`; every retained variant must materially affect layout or semantics.

- [ ] **Step 4: Implement prototype variants**

- Gates: label, visible pass/fail/skip word, duration, Open log action.
- Findings: file/finding context wraps, blocking state is prominent, Open file action remains reachable.
- Commits: repository and SHA are selectable; Open commit is secondary.
- PRs: repository/PR/merge facts align; waiting/conflict uses attention treatment; Open PR is visible.
- Recovery: connector spine visibly attaches Fix to the causal process.
- Receipt: plain delivered-fact list without duplicate status glyphs or executable controls.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run src/ui/dashboard/renderFixtures.test.ts src/ui/dashboard/webview.test.ts
npm run typecheck
```

Expected: PASS.

Commit: `feat(dashboard): align all inside evidence with the prototype grammar`

---

### Task 6: Finish responsive, keyboard, motion, and visual-fidelity verification

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`
- Modify: `src/ui/designSystem.test.ts`
- Modify: `docs/superpowers/verification/2026-08-08-inside-preview-matrix.md`

**Interfaces:**
- Consumes: production renderer and deterministic fixture matrix.
- Produces: verified layouts at 300, 360, 430, and normal widths without a shipped preview harness.

- [ ] **Step 1: Add failing responsive contract tests**

Assert container queries exist for 430, 360, and 300 widths and that narrow layouts:

- keep marker and process name first;
- move identity/tokens below rather than hiding them;
- wrap PR/file detail;
- preserve the timeline marker/spine cell;
- keep action buttons visible;
- never set horizontal scrolling on the Inside root.

Add tests for native summary focus, `prefers-reduced-motion`, and an unanimated but still visible running state.

- [ ] **Step 2: Run and confirm RED**

Run:

```bash
npx vitest run src/ui/dashboard/webview.test.ts src/ui/designSystem.test.ts
```

Expected: FAIL on the new prototype-grid selectors and motion contract.

- [ ] **Step 3: Implement the final responsive rules**

At normal width, use the four-column prototype grid. At 430px move identity/tokens to a second row. At 360px collapse status metadata below the process label while keeping the action at the end. At 300px reduce only spacing; do not remove status, name, disclosure, or action. Use `overflow-wrap:anywhere` on unbounded paths/branches, not on compact status or timestamp cells.

- [ ] **Step 4: Update verification documentation**

Remove instructions for `Karst: Open Inside Preview (Development)`. Replace them with:

1. run `npm run build`;
2. launch the Extension Development Host;
3. open a real ticket dashboard for each stage state available;
4. use VS Code's panel resizing for 300/360/430/normal widths;
5. compare Implementation completed state to the attached screenshot and `docs/ui/inside-redesign-designer-handoff.html`;
6. record screenshots for Implementation completed, UAT failed+Fix, Ship waiting/conflicted, and Done receipt.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
npm run typecheck
npm run build
npm test
rg -n "Stage / scenario|Start live operation|karst\.dev\.openInsidePreview|insidePreview|previewContext" src package.json
git diff --check
```

Expected: typecheck/build/tests PASS; `rg` returns no matches; `git diff --check` returns no output.

- [ ] **Step 6: Perform visual acceptance**

In the Extension Development Host, capture the four screenshots named in Step 4. The completed Implementation state must visibly match these prototype traits: `Inside impl` header; `Session` row with terminal status and execution identity; timeline visible without clicking; phase checks and switch branches; aligned right timestamps; token pills; and the session footer. Confirm none of the debug controls appears.

- [ ] **Step 7: Commit**

Commit: `test(dashboard): verify inside prototype fidelity across widths`

---

## Final Acceptance Gate

Before handing the branch back, verify every item:

- [ ] Production resembles the approved HTML structure, not merely its data vocabulary.
- [ ] The attached Implementation screenshot can be recognized directly in the production block.
- [ ] The timeline is visible by default and can still be collapsed with native keyboard semantics.
- [ ] All seven statuses have a non-color carrier.
- [ ] All eight evidence kinds have intentional markup and styling.
- [ ] No prototype/debug control, command, host module, or fake operation remains.
- [ ] No business truth is derived from prose in the webview.
- [ ] No untrusted string bypasses `esc()`.
- [ ] No component-level horizontal scrolling occurs at 300, 360, 430, or normal width.
- [ ] `npm run typecheck`, `npm run build`, and `npm test` pass.
- [ ] A code-review agent reviews the final diff before the ticket stage is advanced.

## Delegation Order

Execute Tasks 1–6 serially because each task consumes the presentation contract established by the previous one. Use a fresh implementation agent per task, then a code-review agent after each commit. Do not parallelize Tasks 2–5: they overlap `types.ts`, `agent.ts`, and `webview.html`, and parallel edits would create conflicting definitions of the same visual contract.
