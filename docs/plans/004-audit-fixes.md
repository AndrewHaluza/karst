# Plan 004 — Audit Fixes (audit-2026-07-16)

Fix plan for the five findings in `docs/audit-2026-07-16.md` (PR #8), after re-verifying every
surface against `karst/audit-fixes-codebase-audit-fixes`.

## Verification summary

All five findings reproduce on this branch. `extension.ts` has since grown 1376 → **1386** lines.

Research turned up three corrections to the audit's suggested fixes:

| # | Audit said | Reality |
|---|-----------|---------|
| 1 | Restrict CLI to `impl`/`fix` | The narrowing already exists as `markerStageFor` (`src/agent/markerStage.ts:11`) — its whole range is `'impl' \| 'fix'`. Reuse it; don't invent a second list. |
| 2 | Add a confirm modal | `installCommandFor` (`src/approaches/fetch.ts:558`) already exists, is documented as "for the picker to display before the user confirms installation", and **has zero callers**. The affordance was built and never wired. |
| 4 | `script-src ${cspSource}` | Would break all five webviews. Every script is inline (`<script>` at `dashboard:164`, `onboarding:317`, …); there are **no external resources at all** — no `<link>`, no `<img>`, no `url()`, no `fetch()`. `cspSource` has nothing to grant. Use a nonce. |
| 1 | Restrict to `impl`/`fix`, keep `pass\|fail` | The `fail` branch is dead once narrowed — neither `impl` nor `fix` has a `failed` edge, so every parseable `fail` throws in the machine. Real surface is `stage <impl\|fix> pass`. |

---

## Phase 1 — #1 CLI stage narrowing (High)

**Files:** `src/cli/stage.ts`, `src/cli/stage.test.ts`, `src/agent/markerStage.ts`

The invariant break is real: `parseStageArgs` accepts all seven `STAGE_KEYS`, so
`stage ship pass` forces a `passed` verdict on a gate that never ran.

The fix is smaller than the audit thought. `markerStageFor` is *already* the authority on which
stages an agent may mark — it returns `'fix'` for a fix-stage ticket and `'impl'` for everything
else, and it is the only thing feeding `buildCliStagePrefix` on the live-seed path
(`extension.ts:879`). Every producer is already narrow. Only the consumer isn't.

1. Export `MARKER_STAGES = ['impl', 'fix'] as const` from `markerStage.ts`, and re-express
   `markerStageFor` in terms of it so the two can never drift.
2. In `parseStageArgs`, validate against `MARKER_STAGES` instead of `STAGE_KEYS`. Error message
   must name the rejected key and the allowed set.
3. Keep `composeStageCommand`'s `StageKey` param type but narrow it to `MarkerStage`, so a bad
   prefix fails at compile time in the extension rather than at runtime in the agent's shell.
4. **Reject `fail` at parse.** The CLI's honest surface is `stage <impl|fix> pass` — see below.

### The `fail` branch is dead after narrowing

Verified no producer emits a `fail` marker: `composeStageCommand` hardcodes `'pass'` in its argv
array, and it is the sole input to `renderDoneMarkerInstruction` (`agent/workflowCommand.ts:40`).
No template, prompt, or asset instructs an agent to run `stage <x> fail`. Gate failures reach the
machine through driver exit codes (`workflow/driver.ts:49`), never the CLI.

Stronger: once parsing narrows to `{impl, fix}`, **every `fail` invocation that still parses is
guaranteed to throw one layer down.** Neither marker stage has a `failed` edge —

```
impl: { passed: 'uat' }      // no failed edge
fix:  { passed: 'review' }   // no failed edge
```

— and a missing edge throws (`machine.ts:42`). So `stage impl fail` and `stage fix fail` are
unreachable-by-construction, not merely unused.

Letting them parse and die in the machine yields `no failed edge from stage 'impl' (ticket 7)`:
accurate, but it explains the graph to someone who mistyped a verdict. Rejecting at parse costs
zero capability (there is no reachable `fail` transition to lose) and can say what the CLI actually
takes. Drop the branch; keep `Verdict`'s `failed` kind untouched — the driver still needs it.

**Tests (RED first):**
- `stage ship pass` → throws; likewise `uat`, `review`, `scope`, `done`.
- `stage impl fail` / `stage uat fail <reason>` → throws at parse, naming `pass` as the only verdict.
- `stage impl pass` / `stage fix pass` → still parse.
- **Rewrite `stage.test.ts:33-45`** — it currently asserts `uat`/`review` self-report *works*, and
  the fail-reason case at `:41` covers a path that no longer exists. Those tests encode the bug.

---

## Phase 2 — #2 Install confirm (Medium)

**Files:** `src/ui/settings/actions.ts`, `src/extension.ts`, `src/ui/settings/actions.test.ts`

`realRunCommand` (`extension.ts:323`) runs `karst.yml`'s `source.command` through `shell: true`
with no prompt. A cloned repo's manifest executes arbitrary shell on approach install.

**Chokepoint is single.** Only `src/ui/settings/actions.ts:117` reaches `installApproach`;
onboarding has no install path (verified — no `installApproach` reference under `src/ui/onboarding/`).
So one gate covers the surface.

**Where the gate goes.** Not in `fetch.ts` — `installNpmSource` is sync, and threading an async
confirm through it would churn the installer for a UI concern. Not in `extension.ts` either — that
file can't load under vitest, so the gate would be untested. Put it in `settings/actions.ts`, which
is vscode-free and already tested:

```ts
// deps
confirmInstallCommand(cmd: string): Promise<boolean>;

// installApproach, before deps.installApproach(def)
const cmd = installCommandFor(def);
if (cmd !== null && !(await deps.confirmInstallCommand(cmd))) return;
```

`extension.ts` supplies the modal, mirroring the hard-delete confirm at `extension.ts:1066`
(`showWarningMessage(msg, { modal: true }, 'Install')`). The modal must show the **exact command
string** verbatim, not a summary.

**Tests:** confirm-declined → `installApproach` never called, no error posted (a decline is not a
failure); confirm-accepted → installs; non-npm source (`installCommandFor` → `null`) → no prompt.

---

## Phase 3 — #3 + #4 Webview hardening (Medium + Low)

Land together; both are webview trust-boundary work.

### #3 — onboarding URL guard

`src/ui/onboarding/messages.ts:108` gates `open-ticket-link` on a non-empty string only, while
`src/ui/dashboard/messages.ts:77` guards the same message with `/^https?:\/\//`. Both drive
`vscode.env.openExternal` (`extension.ts:439`, `1341`).

Not reachable today (`state.ticketUrl` is always host-constructed `https://app.clickup.com/...`),
but the asymmetry is the bug. Rather than copy the regex a third time, **extract
`isHttpUrl(v: unknown): v is string` into a shared module** (`src/ui/shared/url.ts`) and use it from
all three sites (`dashboard` `open-pr`, `dashboard` `open-ticket-link`, `onboarding`
`open-ticket-link`). A copied guard is what let this diverge once already.

**Tests:** `file:///etc/passwd`, `javascript:alert(1)`, `vscode://…`, `''`, non-string → rejected;
`https://app.clickup.com/t/abc` → accepted. Mirror the dashboard's existing cases.

### #4 — CSP

**The audit's suggested policy is wrong and would white-screen every panel.** All five webviews are
100% inline — no `<link>`, no `<img>`, no `url()`, no `@font-face`, no `fetch()`. `script-src
${cspSource}` grants a source no script actually loads from, and blocks the inline blocks that *are*
the UI.

Correct policy:

```
default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>';
```

`'unsafe-inline'` on styles is unavoidable (inline `<style>` blocks + two `style="…"` attributes)
and is not the risk surface; script is.

**Nonce lifetime is the design question.** The marker-replace pattern (`injectPalette`,
`palette.ts:54`) runs once at `makePanelHost` (`extension.ts:1221`) and the resulting HTML is reused
for every panel — so a nonce injected there would be shared across panels and the whole extension
session. Move CSP injection to **per-panel-creation** (`createPanel` / each `host.ts` open), with a
fresh `randomBytes(16).toString('base64')` per load. Add `injectCsp(html, nonce)` in a vscode-free
module beside `palette.ts`, marker-driven (`<!--KARST_CSP-->`) for consistency and testability.

Touches all five: `dashboard` (via `makePanelHost`), plus `sidebar/host.ts:33`,
`settings/host.ts:21`, `welcome/host.ts:18`, `onboarding/host.ts:21`.

**Tests:** `injectCsp` emits the meta tag with the nonce and tags the `<script>`; two calls produce
different nonces; no-marker HTML is a no-op (matches `injectPalette`'s contract).
**Manual gate: open all five panels in the Extension Dev Host.** A CSP regression is invisible to
vitest and fatal at runtime — no unit test substitutes for this.

---

## Phase 4 — #5 `extension.ts` split (High, structural)

**File:** `src/extension.ts` (1386 lines; `activate()` spans 141-1127 ≈ 990 lines)

Separate PR. No security impact, largest diff, and it should land *after* 1-3 so those fixes are
small reviewable diffs against a stable file rather than being lost in a 1000-line move.

The real cost isn't style: this file imports `vscode`, so it cannot load under vitest — the largest
function in the codebase has **no direct test**, and the fixes in phases 2 and 3 both add host
wiring to it.

Extract per-concern registration, each taking already-built `context`/`store`/hosts as parameters,
mirroring `src/ui/*/actions.ts`:

- `registerTicketCommands` — create/edit/archive/unarchive/delete/search/filter (`1038-1098`)
- `registerSpinCommands` — spin/teardown (`964-1037`)
- `registerPanelCommands` — dashboard/session/settings/welcome (`785-800`, `1099-1125`)
- `wireDriver` — stage driver + error plumbing

Existing seams to pull through first — `makePanelHost` (`1220`), `makeTerminalHost` (`1245`),
`makeDashboardActions` (`1283`), `buildCliStagePrefix` (`1210`) are already standalone functions
below `activate()` and can move to modules with no behavior change.

**Constraint: pure moves only.** No behavior change in the same commit. Anything that looks like a
bug during the split gets its own commit.

---

## Follow-ups (out of scope here)

Surfaced by review of the phase 1-3 work; neither is in the audit.

### The marker CLI is a speed bump, not a sandbox

Phase 1 closes what finding #1 describes: the CLI can no longer be used to fake a
gate verdict. It does **not** make forging one impossible, and nobody should read it
that way.

- **No ticket binding.** `stage impl pass --ticket <key>` takes an arbitrary key —
  nothing ties the invocation to the session's own ticket. An injected agent can
  advance *someone else's* ticket impl→uat. Low impact (the uat gate still runs
  deterministically), but it is the same class as #1: a narrowing that lives in
  prompt convention rather than code.
- **The CLI is not the only writer.** The agent has `node` and the db path, so
  `node -e` + `node:sqlite` writes `stage_current` directly, bypassing
  `parseStageArgs` entirely.

The second is the reason not to over-invest in the first: a determined injected
agent is not stopped by argv validation. The value of phase 1 is that the
*documented, obvious* path no longer forges verdicts by accident or by a single
injected line — real defence needs the agent's write access to the store
constrained, which is a design change, not a patch.

### `extension.ts` keeps growing

Phases 2 and 3 each added host wiring to it (the confirm modal, the CSP
injection). It is the file every fix lands in, which is the argument for phase 4
rather than against it.

## Order

1. **Phase 1** — smallest real invariant break; ~3 lines + a test inversion.
2. **Phase 2** — closes the silent-exec path; wires code that already exists.
3. **Phase 3** — webview hardening, both trust-boundary; one PR.
4. **Phase 4** — the split, separately, after the above have landed.

Phases 1-3 are independent and could go in parallel; they touch disjoint files.

## Gates

Per phase: `npm test` + `npm run typecheck` green, TDD RED→GREEN, conventional commits.
Phase 3 additionally requires the manual five-panel check in the Extension Dev Host.
