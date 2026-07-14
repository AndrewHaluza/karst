# Fresh-install initialization & welcome flow — design

**Ticket:** 869e48tv6 — [FEAT] Implement initialization after fresh install
**Date:** 2026-07-14

## Problem

A brand-new Karst user gets no guidance. The extension shells out to external
CLIs (git, the agent CLI) it does not bundle, and needs a `karst.yml` manifest
before anything works. Today the only surfacing is a non-blocking dependency
toast at activation and a "Create karst.yml?" prompt that fires when a command
first hits a missing manifest. There is no tutorial, no consolidated setup
checklist, and no dependency model that anticipates additional AI-agent
providers (codex, gemini-cli, …).

## Goals

- On a **fresh install** (per-workspace: no `karst.yml`, not dismissed), auto-open
  a welcome panel that shows a setup checklist and a short how-to tutorial.
- **Check dependencies** (git + the configured agent CLI) with actionable
  install guidance, driven by a registry that extends to future providers
  without touching the check logic.
- **Navigate to configuration** — checklist/tutorial buttons jump to Settings,
  Create Ticket, etc.
- **Non-blocking** — unmet items are shown, never enforced. The rest of the
  extension stays usable.
- A **manual re-open command** (`karst.openGettingStarted`) so a dismissed panel
  can be reopened.

## Non-goals

- No gating/blocking flow — this is a welcome surface, not a required wizard.
- No native `contributes.walkthroughs` — we use a custom webview to match the
  existing manager pattern and show live dependency status.
- Ticketing-provider config and approach-install are **not** checklist items
  (still reachable via the tutorial's Settings link).
- No verification of agent-CLI **auth** — only binary presence, as today.
  (A static reminder line covers the login gap.)

## Architecture

New `src/ui/welcome/` module mirroring the existing `onboarding`/`settings`
manager pattern (host-agnostic panel + pure state builder + actions factory +
validated message protocol), plus a pure `src/init/status.ts` and a generalized
dependency registry in the existing `src/runtime/deps.ts`.

The welcome panel follows the **settings** manager convention, not onboarding:
a single panel (no per-ticket keying), `loadState()` called fresh on every open
and every recheck (never cached), all real `vscode` bindings isolated to
`host.ts`. Business logic is unit-tested with fakes; `extension.ts` wiring stays
untested, matching current convention.

### New files

- **`src/init/status.ts`** — pure. `buildSetupStatus(input): SetupStatus` where
  `input = { manifestExists: boolean; missingDeps: RequiredDependency[]; provider: AgentProvider }`.
  Returns a 3-item checklist `SetupItem[]` (`{ id, label, done, detail }`):
  1. `manifest` — done when `manifestExists`.
  2. `git` — done when `git` not in `missingDeps`.
  3. `agent-cli` — done when the provider's binary not in `missingDeps`; `detail`
     always carries the auth-reminder line (see Checklist content).
  No `vscode`, no fs — inputs are injected so it is directly unit-testable.

- **`src/ui/welcome/state.ts`** — `WelcomeState` (the `SetupItem[]` checklist +
  a fixed `TutorialStep[]`) and a pure `buildWelcomeState(...)` that composes
  `buildSetupStatus` output with the static tutorial list.

- **`src/ui/welcome/messages.ts`** — protocol + `parseWelcomeMessage` (trust
  boundary, validates every discriminant like the other three webviews).
  - host→webview: `{ type: 'state'; state: WelcomeState }`
  - webview→host actions (`WelcomeActions`): `createManifest`, `recheckDeps`,
    `openSettings`, `createTicket`, `dismiss`, `requestState`.

- **`src/ui/welcome/actions.ts`** — `buildWelcomeActions(deps): WelcomeActionsFactory`.
  - `createManifest` → calls the extracted `scaffoldManifest()` (see below), then
    re-pushes state so the manifest item flips to done without closing the panel.
  - `recheckDeps` → re-runs `loadState()` and pushes state (lets the user install
    git/CLI in another terminal and refresh in place).
  - `openSettings` / `createTicket` → `executeCommand` passthroughs.
  - `dismiss` → sets the workspace dismiss flag (see Fix 1). Does NOT close the
    panel — only affects future auto-open.
  - `requestState` → push current state.

- **`src/ui/welcome/panel.ts`** — `WelcomeManager`: single panel, `open()` reveals
  the existing one or creates it; `loadState` getter injected. Same
  message-pump-never-dies try/catch + `logError` as `OnboardingManager`.

- **`src/ui/welcome/host.ts`** — real `createWebviewPanel('karst.welcome', …)`
  binding, palette-injected HTML, mirroring `makeOnboardingPanelHost`.

- **`src/ui/welcome/webview.html`** — checklist (each item: label, done/✗ state,
  action button when not done) + numbered tutorial (each step: label, one-line
  description, optional jump button). Vanilla postMessage, no framework, matching
  the other three webviews. Source edited here; `copy-assets.mjs` mirrors it into
  `dist/` (add to the copied-HTML list).

### Touched files

- **`src/runtime/deps.ts`** — add
  `AGENT_CLI_DEPENDENCIES: Partial<Record<AgentProvider, RequiredDependency>>`
  and a resolver `agentDependency(provider): RequiredDependency` that returns the
  mapped entry or a **generic honest fallback** for providers without confirmed
  install docs (Fix 4): `{ binary: provider, label: \`the ${provider} CLI\`,
  install: \`Install the ${provider} CLI and ensure '${provider}' is on your PATH, then reload the window.\` }`.
  Ship a real, confirmed entry for `claude` only; `codex` (and any future
  provider) resolves through the fallback until real docs are added. This map is
  **decoupled from `agent/registry.ts`** — a provider can be dependency-checked
  and get install guidance before it has a working adapter. `GIT_DEPENDENCY`,
  `checkDependencies`, `binaryExists` unchanged.

- **`src/extension/manifestResolve.ts`** — extract the "read template → mkdir →
  write → open in editor → info toast" block from `resolveManifest` into
  `export async function scaffoldManifest(): Promise<void>`. `resolveManifest`'s
  existing warning-prompt flow calls it on confirm; the welcome panel's
  `createManifest` calls it directly (the button IS the confirmation — no second
  prompt). One implementation, no behavior change to the toast path.

- **`src/extension.ts`** — wire `WelcomeManager`, register
  `karst.openGettingStarted`, generalize the existing dep toast to source its
  agent-CLI entry from `agentDependency(provider)`, and add the auto-open
  decision at the end of `activate()`.

- **`package.json`** — contribute the `karst.openGettingStarted` command
  (title e.g. "Karst: Getting Started").

## Auto-open & activation wiring

At the end of `activate()`, after the existing dep check:

```
const folder = vscode.workspace.workspaceFolders?.[0];
let autoOpenedWelcome = false;
if (folder) {                                    // Fix 2: no-folder guard
  const manifestExists = existsSync(manifestPathOrThrow());
  const dismissed = context.workspaceState.get<boolean>(WELCOME_DISMISSED_KEY);
  if (!manifestExists && !dismissed) {           // Fix 1: workspace-scoped
    welcome.open();
    autoOpenedWelcome = true;
  }
}
// Fix 3: suppress the dep toast when the panel already shows the same info.
if (missingDeps.length > 0 && !autoOpenedWelcome) {
  /* existing warning toast, unchanged */
}
```

- **Fix 1 — dismiss scoping.** The dismiss flag lives in
  `context.workspaceState` (key `karst.welcomeDismissed`), NOT `globalState`, so
  a fresh workspace re-triggers auto-open even if the extension was used (and the
  panel dismissed) in another workspace. Matches the chosen trigger semantics
  ("re-fires per new workspace").
- **Fix 2 — no-folder guard.** `manifestPathOrThrow()` throws without a workspace
  folder; auto-open is skipped entirely in that case (nothing to configure). The
  dep toast's own folderless behavior is unchanged.
- **Fix 3 — no double surface.** When the welcome panel auto-opens, the legacy
  dep toast is suppressed (the checklist already shows dependency status). The
  toast still fires on activations where the panel does not auto-open — e.g. a
  configured workspace that later lost `git` from PATH.

`karst.openGettingStarted` calls `welcome.open()` unconditionally (manual
re-entry, ignores the dismiss flag).

## Data flow

`loadState()` (injected into `WelcomeManager`) reads live on every call:
`existsSync(manifestPathOrThrow())` for the manifest item and
`checkDependencies([GIT_DEPENDENCY, agentDependency(provider)], binaryExists)`
for deps, then `buildWelcomeState(status, TUTORIAL_STEPS)`. Nothing is cached, so
`recheckDeps` and post-`createManifest` re-pushes always reflect disk/PATH truth.
The provider is read from the resolved manifest when present, else defaults to
`'claude'` (pre-manifest). All state is plain values crossing `postMessage`.

## Checklist content

1. **`karst.yml` exists** — button "Create karst.yml" (→ `scaffoldManifest`,
   opens the file in the editor) when missing; done otherwise.
2. **Git found** — status + install link from `GIT_DEPENDENCY` when missing.
3. **Agent CLI found** — checks the provider's binary (`agentDependency`); status
   + install link when missing. `detail` always includes the auth reminder:
   *"Karst can only check the CLI is installed, not logged in — run its login
   command once before starting a session."*

## Tutorial content (fixed `TutorialStep[]`)

Short numbered steps, each a one-line description + optional jump button:

1. Configure services & agent provider — button → Settings.
2. Create your first ticket — button → Create Ticket.
3. Pick repos + approach and launch the session — informational (no button).
4. Watch stage progress on the ticket dashboard — informational.
5. (Optional) Install an approach package for a curated method — button → Settings.

## Error handling

- `scaffoldManifest` keeps the existing try/catch → error toast on write failure;
  the welcome action surfaces the same failure via an `error` host message so the
  panel doesn't silently no-op.
- The `WelcomeManager` message pump wraps `routeWelcomeAction` in try/catch +
  `logError`, exactly like `OnboardingManager` — one bad message never kills the
  panel.
- `parseWelcomeMessage` rejects any malformed webview message (trust boundary).

## Testing

Matching the existing onboarding/settings test shape (fakes, no `vscode`):

- **`src/init/status.test.ts`** — `buildSetupStatus`: all-done, each item
  missing, provider defaulting, auth-reminder always present.
- **`src/ui/welcome/state.test.ts`** — `buildWelcomeState` composes checklist +
  tutorial correctly.
- **`src/ui/welcome/messages.test.ts`** — `parseWelcomeMessage` accepts valid
  discriminants, rejects malformed ones; `routeWelcomeAction` dispatches.
- **`src/ui/welcome/actions.test.ts`** — `createManifest` calls the injected
  scaffold + re-pushes; `recheckDeps` re-pushes; `dismiss` sets the injected flag
  setter; passthroughs invoke the injected command runner.
- **`src/ui/welcome/panel.test.ts`** — `open()` reveals-not-duplicates; pushes
  state on open; pump survives a bad message.
- **`src/runtime/deps.test.ts`** (extend) — `agentDependency` returns the real
  `claude` entry and the generic fallback for an unmapped provider.

Target ≥80% on the new non-vscode modules.

## Open risks

- **Two commands scaffold the manifest** (`resolveManifest` prompt + welcome
  button). Mitigated by the single `scaffoldManifest` implementation — no logic
  duplication, only two entry points.
- **codex/others install text is generic** until real docs land. Acceptable:
  honest generic guidance beats a fabricated command. Registry entry is a
  one-line add when docs are confirmed.
