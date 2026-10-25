# Dashboard → React migration: plan, defects, and the decisions to reverse

- **Date:** 2026-10-25
- **Scope:** `src/ui/dashboard/**` (webview side). The host contract (`messages.ts`,
  `state.ts`, `panel.ts`, `webviewSend.ts`) is frozen for the whole migration, as it
  was for the sidebar migration (`ui:REACT-VIEWS`).
- **Status:** plan, awaiting decisions D1–D3 (§6).

---

## 1. Where the dashboard actually is

| Fact | Evidence |
|---|---|
| The view is still vanilla: one 7,007-line, 418 KB `webview.html` (~2,000 lines of inline CSS, ~4,800 lines of script, ~205 render/handler functions). | `src/ui/dashboard/webview.html` |
| A React "island" mounts into a `#root` placed between `.stepper` and `.grid`. It renders **one** component: `SandboxStrip`. | `webview.html:2166`, `app/App.tsx` |
| The island was landed by #713 as "phase 1 foundation" plus the V1 sandbox strip feature, and the prerequisite report records the migration prerequisite as satisfied. | `docs/plans/2026-10-22-dashboard-sandbox-react-prerequisite-report.md` §4 |
| `ui:REACT-VIEWS` does not mention the island at all; it lists two vanilla-dashboard exceptions (usage-limit park actions, Close/Reopen) that "expire with the dashboard's migration". | `docs/ui/UI-INVARIANTS.md` |
| Vanilla still owns: `acquireVsCodeApi` (via the `webviewSend` bundle), the document `click` delegator (`SEND_BY_ACT` + pending), `vscode.setState` persistence of state **and** view state (selection, ship-wait, server filter, artifact view, scrolls), restore on reload. | `webview.html:5889`, `6216`–`6537`, `6992` |
| `webview.test.ts` is 6,677 lines / 369 tests, ~717 of the assertions read the **HTML source text** (regex/indexOf on `HTML`), not rendered behaviour. | `src/ui/dashboard/webview.test.ts` |
| The host re-pushes the full `DashboardState` every second while work runs (`live: true`). | `liveTick.ts` (`LIVE_TICK_MS`), `panel.ts:347,628,691` |

So the dashboard is ~98 % vanilla with a React subtree inside it. That is not a migrated view, and it is
not the "one app, one mount" pattern the other React views follow.

---

## 2. Defects in the current hybrid (bug fixes: allowed on the vanilla view now)

Ordered worst first.

**B1. Every Sandbox action is posted twice.** `SandboxStrip` buttons carry both
`onClick={() => send?.sandboxX?.()}` and `data-act="sandbox-x"`. React's root listener fires the
`onClick`; the native event then bubbles to the vanilla `document` click delegator, which
matches `[data-act]`, starts pending and calls `SEND_BY_ACT['sandbox-x']` again with a request id.
`sandbox-remove` / `sandbox-carry` / `sandbox-stash-update` are destructive or modal-confirmed
host-side, so the host is asked twice.
(`app/SandboxStrip.tsx:254–337`, `webview.html:6148–6153`, `6525–6533`)
Fix: one sender per click. Follow the sidebar precedent: the React button calls the runtime's
`karstBeginPending` / `karstSettle` with its own request id and the typed sender, and the vanilla
delegator ignores React-owned subtrees (`closest('[data-react-owned]')` → return). Regression test:
a render-integration test that clicks each strip button once and asserts exactly one posted message.

**B2. Vanilla mutates React-owned DOM.** Because of B1, `karstBeginPending` sets
`disabled`/`aria-busy`/classes on nodes React reconciles. React keeps the stale attribute until the
element remounts, or drops it on a remount mid-request. Fixed by the same ownership rule as B1.

**B3. The Sandbox strip has no pending/terminal state of its own** (`ui:PENDING-STATE`,
`ui:DISABLED-VS-BUSY`); it only "works" through B2. Fixed with B1.

**B4. The message buffer replays stale state.** `app/main.tsx` buffers host messages until the first
subscriber, then replays the buffer to *every* later subscriber and never clears it. Any
re-subscription (a remount, a bridge identity change — see B5) replays the first `state` push
over newer state. Fix: drain the buffer on first subscribe.

**B5. A new bridge per `App` render.** `App({ bridge = pageHostBridge() })` builds the bridge in a
default parameter; the provider's effect depends on `[bridge]`, so any re-render of `App`
unsubscribes, resubscribes, and (with B4) replays. Fix: build the bridge once in `main.tsx` and
pass it in.

**B6. Silent fallbacks hide wiring faults.** `main.tsx` substitutes a no-op `vscode` when the global
is missing, while `hostBridge.ts` throws for the same condition; `SandboxStrip` takes
`send?: Partial<DashboardSender> | null` and calls `send?.x?.()`, so a missing sender drops the
click silently. Fix: throw on a missing API, make `send` required and complete.

**B7. React reaches around itself for the agent icon.** `SandboxStrip` calls the injected global
`agentIconInto(el, core)` from an effect, which writes into a React-owned node. Fix: render the
canonical icon through an `Icon` component (sidebar's `Icon.tsx` is the precedent and the one
sanctioned raw-HTML site), keeping `ui:AGENT-CORE-IDENTITY`.

**B8. Dead vanilla code.** `renderSandbox()` toggles `#sandboxPanel`, which no longer exists
(`webview.html:4175–4179`, called from `render()` at `5818`). Delete it.

**B9. Docs record a state that is not true.** The prerequisite report says the prerequisite
"landed"; `ui:REACT-VIEWS` omits the island. Fix with the docs change in Phase 0.

B1–B8 are one bug-fix PR (Phase 0). None changes a baseline.

---

## 3. Architecture decisions to reverse or make explicit

**A1. "Phase 1 foundation" was a feature, not a migration step.** The ticket's guard ("if the
prerequisite has not landed, stop and report") was satisfied by landing a React mount *and* the
feature in the same change. The result is two renderers, two event systems and one shared state
blob with no ownership rule. Reverse by making the island an explicit, *recorded* strangler with
rules (§4) — or, if D1 goes the other way, by folding it into a full rewrite.

**A2. The test suite pins the implementation.** 717 source-text assertions will fail wholesale the
moment a function moves, and they prove nothing about what the user sees. Before any slice moves,
its region gets a **behavioural characterisation test** through `renderWebviewReady('dashboard')`
(DOM, `data-*` hooks, ARIA, posted messages) that passes on vanilla and must pass unchanged on
React. The slice PR then deletes the source-text tests it made obsolete. That test is the parity
oracle; without it "preserving behavior" is unverifiable.

**A3. Two writers to `vscode.setState`.** Vanilla persists `{state, sel, shipWait, srvFilter,
artView, artScrolls}`; the React provider reads `getState().state`. If React ever writes, it
clobbers the vanilla view state. Rule: **vanilla owns persistence until the switch-over slice**;
React reads only, and view state moves to React in one step at the end.

**A4. Full-snapshot pushes at 1 Hz.** Fine for `innerHTML` rebuilds; in React it re-renders every
component every second. Don't change the host. On the React side: select slices from the
snapshot and memoise components on their slice (structural compare where identity is new each
push). Keep focus/selection stable across pushes (the sidebar's documented "intentional
difference").

**A5. Vanilla exceptions must be re-homed, never carried.** The park actions (T690) and
Close/Reopen are re-implemented in their React slices, and their exception paragraphs are removed
from `ui:REACT-VIEWS` and `CLAUDE.md` in the same PR.

**A6. CSS lives in the HTML.** ~2,000 lines including the A37 "inside prototype" block. Each slice
moves the CSS for its region into the component's `.css` (the `ui:REACT-VIEWS` extraction rule) and
deletes it from `webview.html`.

**A7. Out of scope on purpose.** `messages.ts` (1,189 lines), `state.ts` (836), `panel.ts` (826)
exceed the file-size budget, but splitting them during the migration changes the contract the
parity tests rely on. Separate follow-up after switch-over.

---

## 4. Target architecture and the interop rules during the transition

End state (mirror the sidebar, the closest analogue — no host change, same DOM):

- `app/main.tsx` is the only page script owner: one `acquireVsCodeApi()` (`webviewSend` bundle
  publishes `vscode`/`karstSend` as today), mounts `<App/>` into `#root`, which covers the whole body.
- `DashboardAppProvider` holds the host snapshot **and** the view state (selected stage, ship-wait,
  server filter, artifact view + scrolls, overlay views) and owns persist/restore.
- Posting controls use the design-system runtime's pending primitives through one hook
  (`usePendingAction`), so request ids, spinner and watchdog stay the one shared implementation.
- Shared injected widgets (agent picker, server-logs view, xterm) are wrapped in one thin component
  each, owning a ref'd container — the only places that hand a DOM node to non-React code.
- `app/architecture.test.ts` guards: one acquisition, no host-module runtime imports, raw HTML only in
  `Icon.tsx`, no `document.querySelector`, no inline style.

Transition rules (recorded in `ui:REACT-VIEWS` in Phase 0, deleted at switch-over):

1. A React slice's root carries `data-react-owned`; the vanilla delegators (`click`, `input`,
   `keydown`) return early inside it, and vanilla never queries into it.
2. React never writes `vscode.setState` before switch-over (A3).
3. A slice PR deletes the vanilla renderer, its CSS and its source-text tests in the same PR —
   never two live implementations of one region.
4. No feature in a slice PR. Behaviour changes are limited to the sidebar's two documented ones
   (pending lasts until the host answers; focus survives a push).
5. Gates per slice: `typecheck`, `lint:react`, unit, integration, `test:visual:docker` with **no
   baseline or ledger edits**, conformance parity floor (`dashboard: 24` in `conformance.test.ts`).

---

## 5. Phases (one PR each unless split noted)

| # | Slice | Contents | Notes |
|---|---|---|---|
| 0 | **Fix the hybrid** | B1–B8; transition rules into `ui:REACT-VIEWS`; correct the prerequisite report (B9). | Bug-fix only; unblocks everything. |
| 1 | **Parity harness** | Characterisation tests per region via `renderWebviewReady('dashboard')` using `renderFixtures.ts` states: header, rail, inside, blocked banner, each grid panel, each overlay. Click-to-message assertions for every `SEND_BY_ACT` entry. | No production change. Oracle for all later slices. |
| 2 | **Shell** (merged into 3) | `RegionPortal` (React renders a migrated panel into its existing container via `createPortal`; that container gets `data-react-owned`), `useSlice` selector + memo. `#root` stays where it is. | Landed with its first consumer, not alone (no speculative infra). Wrapping `.grid` in `#root` was wrong: it would mark the still-vanilla panels React-owned and the vanilla delegators would skip them. |
| 3 | **Worktrees panel** (+ shell) | incl. base-branch control/popover and its input draft. | Leaf, low coupling. First `RegionPortal` consumer. |
| 4 | **Servers panel** | incl. shared-services rows, filter (read-only use of vanilla-owned `srvFilter` until 9). | |
| 5 | **Sub-tasks panel** | | |
| 6 | **Pull requests panel** | merge / dismiss / undismiss / refresh / CI rows and their pending maps. | Highest-risk grid panel (irreversible merge). |
| 7 | **Artifacts shelf + Captured artifacts panel** | panels only; the full-screen art view is 11. | |
| 8 | **Header** | identity, priority, links, agent popover (wrapped picker), "…" menu + gates, ship/wait chips, Detach, **Close/Reopen re-homed** (A5). | `#root` grows to header. |
| 9 | **Rail + blocked banner** | stepper rail, banner, **park actions re-homed** (A5). | |
| 10 | **Inside** | A37 prototype: tracks, pips, evidence, timeline, graph/DAG, ship preview, live clocks. Split 10a (stage track + process ledger), 10b (evidence), 10c (graph + ship preview). | Largest slice; 1 Hz pushes matter most here (A4). |
| 11 | **Overlay views** | ticket-data drawer, artifact index/detail, terminal (xterm wrapper), server logs (wrapper), env overrides. | Esc/Back/scroll restore are view state. |
| 12 | **Switch-over** | `#root` = body; React owns persist/restore (reads the vanilla envelope shape for upgrade); delete the vanilla script; readiness; drop the transition rules and both exceptions from `ui:REACT-VIEWS`/`CLAUDE.md`; delete what remains of `webview.test.ts`. | |
| 13 | **Follow-ups** | Split `messages.ts`/`state.ts`/`panel.ts` (A7); the deferred Sandbox V1 polish if any. | After switch-over only. |

Ordering rationale: leaf panels first so the interop rules and the pending hook are proven on
low-risk regions; the header/rail/inside are coupled through `selectedStage` and `render()` and
move later; persistence moves last and once.

---

## 6. Decisions needed

- **D1 — Strangler slices vs one rewrite PR.** `CLAUDE.md` says "migrate one view per change". A
  single PR replacing 7,000 lines is unreviewable and cannot be visually bisected.
  **Recommendation: strangler slices** (§5), recorded as a time-boxed exception in `ui:REACT-VIEWS`
  with the transition rules of §4, expiring at Phase 12.
- **D2 — Pending mechanism.** Runtime primitives (`karstBeginPending`/`karstSettle`, sidebar) vs
  `useHostMutation` (settings, resources). **Recommendation: runtime primitives**, because the
  dashboard's host acks (`action-result`) and its watchdog already speak that contract.
- **D3 — Ship Phase 0 now?** B1 is a live double-post of destructive actions.
  **Recommendation: yes, as its own bug-fix PR before the rest of the plan is scheduled.**

---

## 7. Risks

- **Parity oracle gaps.** A region without a characterisation test can regress silently; Phase 1 must
  cover every `SEND_BY_ACT` key and every `data-region`.
- **Injected widgets** (agent picker, server-logs view, xterm) assume they own their container's
  `innerHTML`; their wrappers must never let React render children into the same node.
- **Visual drift from CSS moves.** Cascade order changes when CSS leaves the inline `<style>`; the
  `KARST_DASHBOARD_APP_CSS` marker sits near the top of the stylesheet, so moved rules may lose to
  later inline rules. Check specificity per slice in the docker visual run.
- **Upgrade restore.** Phase 12 must read the vanilla persisted envelope (and the pre-envelope shape
  vanilla already tolerates) so an open panel survives the update.

---

## 8. Log

- **Slice 3 (Worktrees + shell), 2026-10-25.** Accepted behaviour differences beyond the two sidebar ones, each a fix of a vanilla staleness: the "Rebase onto X / Change base" label follows the rebase switch immediately; the base popover keeps its position across pushes; toggles commit synchronously (`flushSync`). Interop rules learned, now pinned in `parity/interop.render.integration.test.ts`: a click inside a React region still closes the vanilla header popovers; a vanilla Escape that closes an overlay calls `preventDefault()` and React Escape handlers skip a `defaultPrevented` event; a React button that may be runtime-pending never changes its `className` (use a `data-*` attribute for transient looks).
- **Slice 4 (Servers), 2026-10-25.** `app/ServersPanel.tsx` renders into the existing `#srvCount`, `#srvOps` and `#servers` through three `RegionPortal`s. The panel root and its "Servers" caption stay static, because the region parity snapshot pins `.svpanel` without any `data-*`: `inReactIsland()` therefore also treats `.svpanel` as an island (until Phase 12). Transitional seam events (removed with the vanilla script): `karst:srvFilter` (React owns the filter, reads `getState().srvFilter` once, vanilla persists), `karst:openServerLogs` and `karst:openEnvOverrides` (the header buttons open surfaces that still live in the page script). Accepted differences: the copy confirmation flashes through `data-copied` (no `.ok` class); typing in the filter no longer re-renders the whole page; the filter starts from the persisted value at mount.
- **Slice 5 (Sub-tasks), 2026-10-25.** `app/SubtasksPanel.tsx` renders into `#subtaskCount`, the header after it (the Add button, via `RegionPortal inParent`) and `#subtasks`; the static root `#subtaskPanel` keeps its `hidden` toggle in a layout effect (transitional, snapshot pins the root without `data-*`), so `inReactIsland()` also treats `#subtaskPanel` as an island (until Phase 12). `renderSubtaskBlock` / `#subtaskWait` stay vanilla (header phase 8) and are now called from `render()` directly. The Add button is runtime-pending via `usePendingAction` and toggles `hidden` on the node, never its `className`. No behaviour differences beyond the two sidebar ones.
