# Inside block redesign — IMPLEMENTATION plan

Companion to `2026-08-09-inside-block-redesign-fixes.md` (the analysis). That
document says *what is wrong and why*. This one says *what to type*. Written to
be executed by a cost-efficient model: every task is self-contained, names its
files by path, its anchors by exact existing text, and its verification by exact
command. **Do not infer across tasks.** If a task's anchor text is not found
verbatim, STOP and report — do not search for something similar.

## How to execute a task

Every task has the same five fields. Follow them in order, no exceptions.

1. **Files** — the only files the task may touch. Touching another file is a
  defect; if you believe another file must change, stop and report.
2. **RED** — the test to write FIRST. Write it, run it, and **confirm it fails
  with the stated reason**. A test that passes before the fix is a wrong test:
   rewrite it, do not proceed.
3. **GREEN** — the production change.
4. **Verify** — the exact commands. All must pass.
5. **Commit** — the exact message. One commit per task. Never batch tasks.

Global commands, run before *and* after every task:

```
npm run typecheck
npx vitest run <the test file named in Verify>
```

Full suite (`npm test`) at the end of each workstream, not each task.

## Rules that override anything you might otherwise do

- **Tokens only.** No hex, `rgba()`, raw `px`/`rem`, radius, shadow or duration
literal may appear in any CSS you add. Use `--k-*`. If the token you need does
not exist, stop and report — do not invent a value. (UI-R04/R05)
- **The webview derives nothing.** Every string, label, count, duration and
status the webview renders is supplied by the host. If a task tempts you to
compute a label in `webview.html`, you have misread it.
- **No new dependency, no framework, no CDN.** CSP forbids it. (UI-R01)
- `esc()` **every interpolated value** in `webview.html`. No exceptions.
- **Do not delete a test to make it pass.** If a test must change, the task says
so explicitly and states the new assertion.
- **Absence is not zero.** A missing fact renders as absent, never as `0`.

---



# WORKSTREAM 0 — Functional defects

Nothing in the redesign is observable until these land. Do them first, in order.

---



## Task 0.1 — Fix the disclosure chevron (F1)

The single defect that explains the user's screenshot. Evidence is unreachable
on all six stages because the open-state key written by the click handler is
not the key the renderer looks up.

**Files**

- `src/ui/dashboard/webview.html`
- `src/ui/dashboard/webview.test.ts`

**RED**

In `webview.test.ts`, find the helper `clickChevron` (near line 1691). It
currently fabricates the event target:

```js
{ dataset: { chev: key } }
```

That is why the suite is green while the feature is broken — the test never
reads what the renderer emitted. Replace the helper so it locates the button in
the rendered HTML and uses **that element's own** `data-chev`:

```js
function clickChevron(html, stageKey, processId) {
  const m = html.match(new RegExp(`data-chev="([^"]*)"[^>]*aria-label="Show [^"]*"`, 'g')) || [];
  // Find the chevron that belongs to this process row by locating the row first.
  const rowAt = html.indexOf(`data-proc-id="${stageKey}:${processId}"`);
  if (rowAt < 0) throw new Error(`no process row for ${stageKey}:${processId}`);
  const chevAt = html.indexOf('data-chev="', rowAt);
  if (chevAt < 0) throw new Error(`no chevron for ${stageKey}:${processId}`);
  const chev = html.slice(chevAt + 'data-chev="'.length, html.indexOf('"', chevAt + 'data-chev="'.length));
  return chev;
}
```

Then add this test in the Inside block describe:

```js
it('emits a disclosure key that matches the open-state key the renderer looks up', () => {
  // The renderer asks openProcesses for `${stageKey}:${p.id}`; the button must
  // carry exactly that, or the chevron is inert and no evidence is reachable.
  const html = renderInsideFor('uat');       // use the suite's existing helper
  expect(clickChevron(html, 'uat', 'gates')).toBe('uat:gates');
});
```

Run it. It MUST fail with `expected "uat" to be "uat:gates"`. If it fails for
any other reason (e.g. `no process row for uat:gates`), that is expected too on
the first run — the `data-proc-id` attribute does not exist yet and is added in
GREEN below. Either failure is a valid RED.

**GREEN**

In `webview.html`, `processRowHtml(p, key, open)` (line ~1439). It is called at
line ~1492 as:

```js
procs.map((p) => processRowHtml(p, view.stageKey, openProcesses.has(`${view.stageKey}:${p.id}`)))
```

The `open` argument is already correct. Only `key` is wrong. Change the call
site to pass the composite key:

```js
procs.map((p) => processRowHtml(p, `${view.stageKey}:${p.id}`, openProcesses.has(`${view.stageKey}:${p.id}`)))
```

And in `processRowHtml`, add `data-proc-id` to the outer `.proc` div so tests
and future tasks can address a row:

```js
return `<div class="proc ${esc(p.status)}" data-proc-id="${esc(key)}"><div class="prow">…
```

Do **not** change the click handler at line ~2253 — it already stores
`btn.dataset.chev` verbatim, which is now the correct composite key.

**Verify**

```
npx vitest run src/ui/dashboard/webview.test.ts
npm run typecheck
```

**Commit**

```
fix(dashboard): pass composite stage:process key to the inside disclosure chevron

The chevron carried only the stage key while the renderer looked up
`${stageKey}:${processId}`, so aria-expanded was permanently false and no
evidence block on any of the six stages could ever be opened. The suite missed
it because clickChevron fabricated the dataset instead of reading the rendered
attribute; it now reads the DOM. UI-R09.
```

---



## Task 0.2 — Inside block must not go blank in `fix` (F2)

**Files**

- `src/ui/dashboard/webview.html`
- `src/ui/dashboard/webview.test.ts`

Background: `state.insideViews` is keyed by the six-key `InsideStageKey`
(scope/impl/uat/review/ship/done). `state.stageCurrent` is the seven-key runtime
`StageKey` and can be `fix`. Line ~1969 reads:

```js
const sel = selectedStage || state.stageCurrent || 'scope';
```

so on a ticket in `fix`, `insideViews['fix']` is `undefined` and
`renderInside` clears `#inside` — the whole block disappears. The host already
computes the correct projection and ships it as `state.presentedStage`
(`state.ts` line ~322); the webview simply never reads it.

**RED**

```js
it('falls back to the host-computed presented stage when the ticket is in fix', () => {
  const state = baseState({ stageCurrent: 'fix', presentedStage: 'uat' });
  const html = renderWith(state);          // suite's existing render helper
  expect(html).toContain('Inside uat');    // not empty
});
```

Must fail with the Inside container rendering empty.

**GREEN**

```js
const sel = selectedStage || state.presentedStage || state.stageCurrent || 'scope';
```

`presentedStage` first: it is the host's authoritative projection and is correct
for every stage, not only `fix`.

**Verify**

```
npx vitest run src/ui/dashboard/webview.test.ts src/ui/dashboard/state.test.ts
npm run typecheck
```

**Commit**

```
fix(dashboard): render the inside block from presentedStage, not stageCurrent

insideViews is keyed by the six-key presentation contract; stageCurrent can be
`fix`, which is not a key, so the entire Inside block rendered blank for any
ticket in a recovery round. The host already ships the projection.
```

> **Ordering constraint.** Task A5 removes the preview toolbar, which is
> currently the only other reader of `presentedStage`. 0.2 MUST land before A5,
> or A5 will look like it can delete the field.

---



## Task 0.3 — Real `serviceNames` and `assignmentFor` (F3)

`panel.ts` — the only production `buildDashboardState` call site — passes
`() => []` and `() => null`, so every service list is empty and every process
identity chip is absent in the real product. Both resolvers already exist.

**Files**

- `src/ui/dashboard/panel.ts`
- `src/ui/dashboard/panel.test.ts`

**RED**

In `panel.test.ts`, add:

```js
it('supplies real service names and process assignments to the inside views', () => {
  // manifest with one runnable repo scoped to the ticket, and processes.uatTester configured
  const state = pushAndCapture(/* suite's existing harness */);
  const uat = state.insideViews.uat;
  const tester = uat.processes.find((p) => p.id === 'tester');
  expect(tester?.configured).toEqual({ provider: 'codex', model: expect.any(String) });
  const services = uat.processes.find((p) => p.id === 'services');
  expect(services?.detail).not.toBe('');
});
```

Must fail: `configured` is `null` and the services detail is empty.

**GREEN**

In `panel.ts`, at the `buildDashboardState(...)` call (line ~269), replace the
two stub arguments. Add these imports at the top of the file:

```ts
import { resolveProcessAssignment } from '../../agent/processAssignment.js';
import { resolveProvider } from '../../agent/provider.js';
import { resolveModelForProvider } from '../../agent/models.js';
import { isRunnable } from '../../manifest/runnable.js';
```

Add a private method to the class (place it directly after `pushState`):

```ts
  /**
   * The runnable services in the ticket's scope, by repository NAME. Non-runnable
   * repositories are absent by construction (isRunnable is the only gate) — a
   * repo with no `service:` block has no process to name.
   */
  private serviceNamesFor(ticketId: number): string[] {
    const manifest = this.manifest?.();
    if (!manifest) return [];
    const scoped = new Set(getTicket(this.store, ticketId)?.selectedRepos ?? []);
    return manifest.repositories
      .filter((r) => scoped.has(r.name) && isRunnable(r))
      .map((r) => r.name);
  }

  /**
   * The provider/model karst is CONFIGURED to run for one inside process —
   * shown before any recorded segment exists. Never the recorded identity: a
   * process_runs snapshot is what actually ran and outranks this everywhere it
   * exists (model/inside/agent.ts).
   */
  private assignmentFor(
    ticketId: number,
    processId: 'session' | 'tester' | 'review',
  ): SessionConfiguredInput | null {
    const manifest = this.manifest?.();
    if (!manifest) return null;
    const ticket = getTicket(this.store, ticketId);
    if (processId === 'session') {
      // The implementation session has no process role: it is the ticket's own
      // agent, resolved by the launch precedence rule.
      const provider = resolveProvider(manifest, ticket?.provider ?? undefined);
      return { provider, model: resolveModelForProvider(provider, ticket?.model ?? null, manifest) ?? null };
    }
    const role = processId === 'tester' ? 'uat-tester' : 'review';
    const snapshot = resolveProcessAssignment(manifest, role, {
      provider: ticket?.provider ?? undefined,
      model: ticket?.model ?? undefined,
    });
    // NULL is configured ABSENCE (`enabled: false`), not "unknown" — the caller
    // renders it as a disabled process, never as a missing lookup.
    return snapshot ? { provider: snapshot.provider, model: snapshot.model ?? null } : null;
  }
```

Then the call site becomes:

```ts
      this.fixCapFor,
      (id) => this.serviceNamesFor(id),
      (processId) => this.assignmentFor(ticketId, processId),
      registry,
```

If `this.manifest` does not exist as a constructor-injected accessor on the
class, STOP and report — do not add a new dependency yourself; check whether the
existing `this.pathContext?.()`-style accessors include one for the manifest and
name it in your report.

**Verify**

```
npx vitest run src/ui/dashboard/panel.test.ts src/ui/dashboard/state.test.ts
npm run typecheck
```

**Commit**

```
fix(dashboard): resolve real service names and process assignments for inside

panel.ts passed `() => []` and `() => null`, so the only production call site
rendered every service list empty and every process identity chip absent, while
the model layer that consumes them was fully built and tested against fixtures.
```

---



## Task 0.4 — An inside action reports its real outcome (F4, UI-R13)

`dispatchInsideAction` in `panel.ts` returns `void` and discards
`InsideDispatchOutcome`, so the webview's `action-result` always says `ok:true`
— a rejected action renders as success.

**Files**

- `src/ui/dashboard/panel.ts`
- `src/ui/dashboard/messages.ts`
- `src/ui/dashboard/panel.test.ts`

**RED**

```js
it('reports a rejected inside action as a failure, not a success', () => {
  const posted = dispatchAndCapture('stale-action-id');
  expect(posted).toMatchObject({ type: 'action-result', ok: false });
});
```

**GREEN**

Change the signature (`panel.ts` line ~368):

```ts
  dispatchInsideAction(ticketId: number, actionId: string): { ok: boolean; message?: string } {
    const registry = this.registries.get(ticketId);
    if (!registry) return { ok: false, message: 'This action is no longer available.' };
    const outcome = dispatchInsideAction(/* unchanged args */);
    if (outcome.outcome === 'rejected') {
      this.logError(`karst: inside action rejected: ${outcome.reason}`, undefined);
      // The reason is host diagnostic prose and may name a path — never send it
      // to the webview. The user-facing message is a fixed string.
      return { ok: false, message: 'This action could not be run.' };
    }
    return { ok: true };
  }
```

Then in the message handler that calls it (`messages.ts`, the `inside-action`
case), post the returned result as the `action-result` for that `requestId`
instead of an unconditional `ok:true`. Locate it by searching `messages.ts` for
`inside-action`.

An unknown id must stay `ok:false` — a stale capability is not a success.

**Verify**

```
npx vitest run src/ui/dashboard/panel.test.ts src/ui/dashboard/messages.test.ts
npm run typecheck
```

**Commit**

```
fix(dashboard): report the real outcome of an inside action (UI-R13)

dispatchInsideAction discarded InsideDispatchOutcome, so a rejected action —
stale registry generation, failed target check — reported success to the user.
The rejection reason stays host-side; the webview gets a fixed string.
```

---



## Task 0.5 — A live `completed` event must not delete evidence (F5)

`overlayProcesses` (webview.html ~1466) replaces the snapshot's row with the
live one wholesale. Live progress events carry no `evidence`, so an already-open
evidence block vanishes the moment the operation completes.

**Files**

- `src/ui/dashboard/webview.html`
- `src/ui/dashboard/webview.test.ts`

**RED**

```js
it('keeps snapshot evidence when a live completed event has none', () => {
  const view = viewWithEvidence('uat', 'gates');       // 3 evidence rows
  const merged = overlayProcesses_forTest(view, { completed: { id: 'gates', status: 'pass', label: 'Gates' } });
  expect(merged.find((p) => p.id === 'gates').evidence.rows).toHaveLength(3);
});
```

**GREEN**

```js
  function overlayProcesses(view) {
    const live = liveOps[view.stageKey];
    if (!live || !live.completed) return view.processes;
    const id = live.completed.id;
    if (!view.processes.some((p) => p.id === id)) return view.processes.concat(live.completed);
    // A live event is a STATUS update, not a snapshot. It carries no evidence,
    // so overwriting the row wholesale deleted evidence already on screen. Keep
    // every field the event does not speak to; the next snapshot is
    // authoritative and retires the overlay entirely.
    return view.processes.map((p) => (p.id === id ? { ...p, ...live.completed, evidence: live.completed.evidence ?? p.evidence } : p));
  }
```

**Verify**

```
npx vitest run src/ui/dashboard/webview.test.ts
```

**Commit**

```
fix(dashboard): merge live inside progress onto the snapshot row, not over it

A `completed` event carries no evidence, so replacing the row wholesale deleted
an evidence block the user had open. A live event is a status update; the next
snapshot remains authoritative.
```

---



## Task 0.6 — The live header must honour status, detail and duration (F6)

Today the header renders a spinner plus a label for every live operation, so a
`wait` or `fail` operation reads as "still running".

**Files**

- `src/ui/dashboard/webview.html`
- `src/ui/dashboard/webview.test.ts`

**RED**

```js
it('renders a waiting live operation without a running spinner', () => {
  const html = renderWithLive('uat', { active: { label: 'Waiting for approval', status: 'wait' } });
  expect(html).not.toContain('class="spin"');
  expect(html).toContain(OP_GLYPH_WAIT);       // '⏸'
});
```

**GREEN**

Replace the `alive` expression in `renderInside`:

```js
    // A live operation is run/wait/fail only (progress.ts) — never a verdict.
    // The spinner means RUNNING; a wait or a fail gets its own glyph, or the
    // header claims progress that is not happening.
    const live = liveOps[view.stageKey];
    const lstatus = live && live.active ? (live.active.status || 'run') : '';
    const lglyph = lstatus === 'run'
      ? '<span class="spin" aria-hidden="true"></span>'
      : `<span class="eglyph" aria-hidden="true">${OP_GLYPH[lstatus] || '·'}</span>`;
    const alive = live && live.active
      ? `<span class="alive ${esc(lstatus)}">${lglyph}${esc(live.active.label || 'Running')}`
        + (live.active.detail ? `<span class="adetail">${esc(live.active.detail)}</span>` : '')
        + (live.active.duration ? `<span class="adur">${esc(live.active.duration)}</span>` : '')
        + `</span>`
      : '';
```

Add CSS beside the existing `.alive` rule — tokens only:

```css
  .alive .adetail{color:var(--k-fg-muted);margin-left:var(--k-space-2)}
  .alive .adur{color:var(--k-fg-muted);margin-left:var(--k-space-2);font-variant-numeric:tabular-nums}
```

If `--k-space-2` or `--k-fg-muted` is not defined in `model/designSystem.ts`,
STOP and report the missing token name; do not substitute a literal.

**Verify**

```
npx vitest run src/ui/dashboard/webview.test.ts
```

**Commit**

```
fix(dashboard): honour status, detail and duration on the live inside header

Every live operation rendered as a running spinner, so a `wait` (awaiting a
human) and a `fail` both read as progress. UI-R11.
```

---



## Task 0.7 — `shipFinishedEvent` must not append a phantom process (F7)

**Files**

- `src/workflow/progress.ts` (or wherever `shipFinishedEvent` is defined —
locate with `grep -rn 'shipFinishedEvent' src`)
- its existing `.test.ts` sibling

**RED**

```js
it('emits a completed event whose id exists in the ship snapshot', () => {
  const ev = shipFinishedEvent(/* existing fixture args */);
  expect(SHIP_PROCESS_IDS).toContain(ev.completed.id);
});
```

Where `SHIP_PROCESS_IDS` is derived in the test from
`shipProcesses(...)` in `src/model/inside/ship.ts` — do not hardcode the list.

**GREEN**

Change the emitted id to the ship process the event actually concerns (the
`pr` process for a PR outcome, `merge` for a landing). If the event genuinely
concerns no snapshot process, it must not be a `completed` process event at all
— convert it to a header-only `active`/`cleared` event.

If the correct mapping is not unambiguous from the call site, STOP and report
the call site rather than guessing: appending a row the snapshot will
immediately retire is exactly the bug.

**Verify**

```
npx vitest run src/workflow/progress.test.ts src/model/inside/ship.test.ts
```

**Commit**

```
fix(workflow): emit ship progress against a process the snapshot contains

shipFinishedEvent appended a row with an id no ship snapshot carries, so the
overlay showed a process that vanished on the next state push.
```

---



## Task 0.8 — Phase marks must be attributed to the current implementation run (F8)

`src/model/inside/agent.ts:332` filters `phase_marks` by
`implementation_run_id`, but `src/cli/phase.ts` never writes that column, so the
filter is inert and marks from a PREVIOUS run leak into the current timeline.

**Files**

- `src/cli/phase.ts`
- `src/store/phaseMarks.ts`
- `src/cli/phase.test.ts`
- `src/store/phaseMarks.test.ts`

**RED**

```js
it('attributes a phase mark to the ticket\'s open implementation run', () => {
  const runId = openImplementationRun(store, ticketId);
  runPhaseCommand(/* existing args */);
  expect(listPhaseMarks(store, ticketId)[0].implementationRunId).toBe(runId);
});
```

**GREEN**

The CLI must NOT accept a run id from argv — argv is attacker-reachable
(CLAUDE.md: the CLI parse paths are a security property). Resolve it
**server-side**, exactly like `attempt` and `markedAt` already are: inside the
store writer, look up the ticket's currently-open `implementation_runs` row and
stamp its id. Widen no parse path; add no argument to `parseStageArgs` or to
`phase.ts`'s parser.

Concretely, in `src/store/phaseMarks.ts`'s insert, add
`implementation_run_id` sourced from a `SELECT id FROM implementation_runs WHERE ticket_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`. NULL when
there is no open run — a mark made outside a run is a real state, not an error.

Keep the SQL driver-agnostic: positional `?` only, no named params, no
`.pluck()`. The CLI opens with `node:sqlite`.

**Verify**

```
npx vitest run src/cli/phase.test.ts src/store/phaseMarks.test.ts src/model/inside/agent.test.ts
npm run typecheck
```

**Commit**

```
fix(cli): attribute phase marks to the open implementation run, server-side

agent.ts filtered the timeline by implementation_run_id, but nothing ever wrote
it, so the filter was inert and a previous run's marks leaked into the current
timeline. Resolved in the store writer, not from argv — the phase verb's narrow
parse path is a security property.
```

---

**Workstream 0 gate.** Run `npm test` and `npm run typecheck`. Then launch the
Extension Dev Host (F5), open a ticket, and confirm by eye: the chevron opens
evidence on every stage; a ticket in `fix` shows a block. Do not start
Workstream A until both are true.

---



# WORKSTREAM A — Remove the debug harness

The user's second complaint verbatim: the prototype's debug switchers shipped
into the product. Remove them entirely — the harness is not to be hidden behind
a flag, it is to be deleted.

## Task A1 — Delete the preview toolbar markup

**Files**: `src/ui/dashboard/webview.html`

Delete the whole element beginning at line ~921:

```html
<div class="pvtoolbar hidden" id="previewToolbar">
```

through its closing `</div>`. This removes: the "Stage / scenario" select, the
"Repositories" select, the `300` / `360` / `430` / `normal` width buttons, and
the "Start live operation" / "Complete" / "Clear" buttons.

**Verify**: `grep -n 'pvtoolbar\|pvScenario\|data-pv-w\|data-pv-progress' src/ui/dashboard/webview.html` returns
matches only in the script block (removed in A2/A3) — none in markup.

## Task A2 — Delete the preview script block

**Files**: `src/ui/dashboard/webview.html`

Delete the JS in the range ~1267–1347: the fixture filter (`f.scenario === el('pvScenario').value`), the scenario/repo option population, the
`preview-mode` body-class toggle, the `[data-pv-w]` handler and the
`[data-pv-progress]` handler. Also delete the listener registration near line
~2346.

Leave `renderInside`, `overlayProcesses`, `liveOps` and the `inside-progress`
message handler untouched — those are production.

## Task A3 — Delete the preview CSS

**Files**: `src/ui/dashboard/webview.html`

Delete lines ~838–842, the `body.preview-mode[data-pv-w=…] .stepper{…}` rules
and their comment. **Note for the record:** these targeted `.stepper`, a
*sibling* of `#inside`, so they never resized the Inside block at all — the
harness could not have validated the responsive behaviour it was built to
validate. Do not port them to `#inside`; real responsive rules are Task B7.

Also delete the `.pvtoolbar` / `.pvlabel` rules.

## Task A4 — Delete the preview host modules

**Files**: delete `src/ui/dashboard/insidePreview.ts`,
`src/ui/dashboard/insidePreview.test.ts`, `src/ui/dashboard/insideFixtures.ts`,
`src/ui/dashboard/insideFixtures.test.ts`.

## Task A5 — Unregister the dev command

**Files**

- `src/extension.ts`
- `src/extensionActivation.test.ts`
- `package.json`

Delete: the `InsidePreviewHost` type import (line 19); the whole
`context.extensionMode === Development` block registering
`karst.dev.openInsidePreview` (lines ~3059–3125); the
`karst.insidePreviewAvailable` context-key set.

From `package.json`: the `karst.dev.openInsidePreview` command contribution and
its `menus.commandPalette` `when` clause.

From `extensionActivation.test.ts`: delete the tests at lines ~217–292 that
assert the registration exists. These tests are being removed because the
feature is being removed — that is the one legitimate reason to delete a test,
and it must be stated in the commit.

**Prerequisite**: Task 0.2 must already be committed. Before this task, the
preview toolbar is a reader of `state.presentedStage`; after 0.2 the production
renderer is the reader, so removing the toolbar does not orphan the field.

**Verify**

```
npm run typecheck
npm test
grep -rn 'insidePreview\|insideFixtures\|preview-mode\|pv-w' src package.json
```

The grep must return nothing.

**Commit** (one commit for A1–A5)

```
chore(dashboard): remove the inside preview debug harness from the product

The prototype's stage/scenario selects, 300/360/430 width buttons and
Start/Complete/Clear live-operation buttons shipped into the dashboard. They
were a design-time harness and were never a product surface. The width buttons
additionally targeted .stepper, a sibling of #inside, so they never resized the
component they existed to verify — real container rules land in the redesign.
Removes the dev command, its package.json contribution and its activation tests
along with the feature.
```

---



# WORKSTREAM C1 — Model/store prerequisites for the redesign

Do these before Workstream B: B renders what C produces, and rendering a field
that is always absent teaches nothing.

## Task C1 — Give `summarizeSegmentTokens` a SQL reader

`src/store/implementationRuns.ts:341-380` already defines
`summarizeSegmentTokens` with the right contract. Its doc comment says
"nothing writes them yet" — that comment is stale and must be corrected. What is
missing is a store query that feeds it.

**Files**: `src/store/implementationRuns.ts`, `src/store/implementationRuns.test.ts`

**RED**: a test that inserts two `token_usage` rows with distinct
`implementation_segment_id`s and asserts the reader returns one total per
segment, dropping rows whose `estimated` is 1.

**GREEN**: add `readSegmentTokenTotals(store, implementationRunId)` — a single
`GROUP BY implementation_segment_id`, positional `?` only, `estimated = 0` in
the WHERE. Wire it as the input to `summarizeSegmentTokens`. Update the stale
doc comment.

## Task C2 — Compute `estimatedCalls` truthfully

`state.ts:306-309` hardcodes `estimatedCalls: 0` while every reader's WHERE also
filters `estimated = 0`, so `estimated` is unrenderable by construction.

**Files**: `src/store/tokenUsage.ts`, `src/ui/dashboard/state.ts` + tests

**GREEN**: have `summarizeRecordedTokenUsageForProcess` return
`{ total, estimatedCalls }`, where `estimatedCalls` counts rows with
`estimated = 1` **without** adding their token counts to `total`. A measured
total and an estimate count are different facts and must never be summed.
`state.ts` then passes the real count through.

## Task C3 — Absence is a first-class state for tokens (decision 8)

`interactiveUsage` is `false` for `claude` and `antigravity` (verified:
`src/agent/claude.ts:103`, `src/agent/antigravity.ts:127`) and `true` for
`codex` and `opencode`. On the default provider, **no** per-segment token fact
will ever exist.

**Files**: `src/model/inside/agent.ts` + test

**GREEN**: `tokenView` must distinguish three states and the type must say so:

- **measured** — a total exists.
- **estimated** — only estimates exist; carries the `estimated` marker.
- **unavailable** — the provider does not report interactive usage. This is
NOT zero and NOT "0 tokens"; it renders as absent with a title explaining
that this agent core does not report per-session usage.

Never render `0` for a state the provider cannot measure.

**Commit each of C1/C2/C3 separately**, conventional `feat(store)` /
`fix(model)` as appropriate.

---



# WORKSTREAM B — The visual redesign

Only start after Workstream 0 is verified by eye and A is committed. The
contract is `docs/ui/inside-redesign-designer-handoff.md`; read §§4–11 before
the first edit. Judge every change against `docs/ui/UI-RULES.md` and cite the
rule id in the commit.

## Task B1 — Inject agent identity into the dashboard host

`injectAgentIdentity` has **no call site** for the dashboard, so the provider
brand tokens the redesign uses are not present in this webview.

**Files**: `src/ui/dashboard/panel.ts` (HTML assembly), `src/ui/designSystem.test.ts`

Add the injection alongside the existing `injectProviderIdentity` / `injectCsp`
calls, in the same order the other webviews use. Extend the discovery-based test
in `designSystem.test.ts` so a webview that omits the injection fails — do not
hardcode the dashboard's name.

## Task B2 — Per-kind evidence renderers

One generic `evidenceRowHtml` serves all eight `ProcessEvidenceView` kinds, and
**no CSS rule matches** `pev-`* anywhere in the file. Handoff Task 15 was
recorded `Pass` in `inside-redesign-tasks-1-16-review.md:30`; that record is
wrong and §11 of the analysis plan tracks correcting it.

**Files**: `src/ui/dashboard/webview.html` + `webview.test.ts`

Add a renderer per kind — `rows`, `gates`, `findings`, `timeline`, `commits`,
`prs`, `recovery`, `receipt` — dispatched on `p.evidence.kind`, plus the
matching `.pev-<kind>` CSS. Each kind's layout comes from the handoff; do not
invent one. Unknown kind falls back to the generic renderer (forward
compatibility), never throws.

One test per kind asserting its distinguishing structure.

## Task B3 — Native `<details>` / `<summary>` disclosure (decision 7)

The handoff's Task 14 Step 4 required native disclosure; a hand-rolled button
was substituted without a decision record, and F1 lived inside that
substitution. Convert `processRowHtml` to `<details><summary>`, keeping
`data-proc-id` and the composite key from Task 0.1 and preserving the persisted
open-state behaviour. Keyboard operability then comes from the element, not from
a handler (UI-R09).

## Task B4 — Kind-specific aggregate on the process row

`p.count` is already rendered (line ~1441). What is missing is the kind-specific
aggregate the handoff specifies (e.g. "3 of 4 gates", "2 findings"). Compute it
**host-side** in `model/inside/*.ts` and ship it as a field; the webview
concatenates nothing.

## Task B5 — `gatesProcess` duration and counts

`src/model/inside/gates.ts:379-432` computes counts that no renderer reads and
sets no `duration`. Add `duration`, and surface the counts through the B4 field.

## Task B6 — `servicesProcess` must not claim what it did not check

`gates.ts:439-450` states a services outcome it never verified. Make it report
the real check, or report `note` ("not checked") — never `pass`.

## Task B7 — Real responsive rules

Add `@container` (preferred) or `@media` rules for `.act` / `.proc` / `.erow` at
the handoff's breakpoints. The file currently has exactly one such rule, for
`.svpanel`. Cover 300 / 360 / 430 as the handoff specifies. Verify by resizing
the real panel in the Extension Dev Host — there is no harness now, and that is
correct.

## Task B8 — `OP_GLYPH.note` collides with the causal connector

`OP_GLYPH.note` is `↳`, the same glyph `econn` uses for "switch/resume". Change
`note` to a distinct glyph from the design system's closed set. Two meanings
must never share one glyph.

## Task B9 — Copy pass against handoff §11

Grepping the handoff's copy templates against `model/inside/*.ts` returns one
hit, and it is the legacy stage-clock string. §3.8 of the analysis plan lists
ten concrete mismatches; fix each at its host-side source, one commit for the
copy pass, citing the handoff section.

---



# WORKSTREAM S — Settings §7 process assignment states

The "Agent profile" control does not exist — Settings offers only a free-text
name override, so the handoff's Agent profile ≠ Agent core ≠ Model distinction
is unrenderable, and four validation states are missing. Build the control and
the four states per handoff §7. Independent of B; parallelisable.

# WORKSTREAM D — Retire the legacy inside path

`state.ts:459` still ships `inside: buildStageInside(...)`, and
`agent.ts:165-195` holds a dead `implInside` carrying a regressed driver copy at
line ~190. Delete both plus their now-unreachable helpers, after B renders
everything the legacy path did. Confirm with a grep that no consumer remains
before deleting.

# WORKSTREAM E — Orphan cleanup

`types.ts:300` declares `ai?: boolean`, which nothing writes; other orphan
columns are listed in analysis §2.5. Delete the declaration or write it —
decide per field, one commit each. Lowest priority.

---



# Global sequencing

```
0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 0.6 → 0.7 → 0.8      (gate: npm test + eyes-on)
A1..A5  (A5 requires 0.2)                            (gate: greps empty)
C1 → C2 → C3
B1 → B2 → B3 → B4 → B5 → B6 → B7 → B8 → B9
S (any time after 0.3)
D (after B)
E (last)
```



# Invariants that must not break

- The six-key `InsideStageKey` presentation contract stays six keys; `fix`
projects, it never becomes a seventh.
- Action messages carry an opaque `actionId` and nothing else — never a path, a
URL or a PR number.
- A conflict is a `wait`, never a `fail`.
- An unknown PR state is unmerged.
- Process identity is what RAN (`process_runs` snapshot), not current Settings;
`configured` is only shown where no snapshot exists.
- The registry is per-snapshot; a stale generation's id is rejected, not served.
- Nothing on the extension-host event loop blocks.



# When you are done

Do not fire `stage impl pass`. Report which tasks landed, which were stopped and
why, and paste the final `npm test` summary.