# Global dependency coverage — design + implementation plan

> **Status:** DONE 2026-07-16. Phases 1–4: `3247b16`, `ae84acc`, `1ce0e7f`,
> `7621164`. Phase 5: `60d2e59` (uat), `227f015` (readiness), `48c7be8`
> (service commands). Deviations from the plan as written are recorded under
> "What changed during implementation".

**Goal:** karst declares every external tool it needs in ONE registry, and every
surface (startup notice, status bar, welcome checklist, point-of-use guard)
derives from it — so a missing dependency is impossible to discover late, and
adding a dependency is a one-line change.

---

## Context: how this came up

Ticket 11 failed at ship with `could not run gh: spawnSync gh ENOENT`. gh is
genuinely not installed on this machine (`which gh` → not found). The reason was
visible only because of the ship fix in `8e6bf81`; before that it was a bare colon.

Fixed already (commit `9b5b7a4`, pushed): gh added to the startup preflight + the
welcome checklist, and `toGhResult` translates ENOENT into install guidance.

That fix was gh-shaped. The user's response: *"It should be not only regarding
ship stage, with gh only; but in general we're have some other deps, which are
required for proper work; let's define how we're able cover it globally."*

## The real inventory (from every spawn site in src/)

| Binary | Used for | Checked today? |
|---|---|---|
| `git` | worktrees, baseline, preflight (`runtime/preflight.ts`, `runtime/worktree.ts`, `runtime/baseline.ts`) | yes |
| `gh` | ship (`integrations/github.ts:68`) | yes, as of `9b5b7a4` |
| `npm` | worktree dep install (`runtime/worktree.ts:216`), uat gate (`stages/uat.ts:39`), review gates (`stages/review.ts:65`) | **NO — same latent bug as gh** |
| `claude` (per `manifest.agentProvider`) | interactive sessions | yes |
| arbitrary manifest commands | service start/install (`extension.ts:254`, `runtime/supervisor.ts:63`, both `shell:true`) | **unknowable — see below** |

### Three classes of dependency (they need different treatment)

1. **Fixed binaries karst itself spawns** — git, gh, npm. Known at compile time.
   These belong in the registry.
2. **Config-chosen binary** — the agent CLI, resolved from `manifest.agentProvider`
   (`agentDependency(provider)`). Registry entry resolved at runtime, not a constant.
3. **Arbitrary user shell strings** — service start/install commands from the
   manifest. You cannot honestly preflight `docker compose up`. OUT OF SCOPE for
   the registry; they fail at spin with the supervisor's own error. (Optional
   future: best-effort probe of argv[0] at spin time.)

### Orthogonal axis: installed ≠ ready

gh installed but not `gh auth login` fails ship identically to gh missing. karst
already admits it cannot check this for claude (`AGENT_AUTH_REMINDER` in
`init/status.ts`) — but for gh it CAN: `gh auth status` exits 0 only when logged
in. Modeled as an optional `ready` probe. See "Phase 5" (user chose the scope that
does not include this; left documented as the obvious next step).

## The structural defect (this is the actual bug)

Adding gh took FIVE edits:
- `runtime/deps.ts` — the `GH_DEPENDENCY` entry
- `init/status.ts` — the `SetupItem['id']` union (`'manifest'|'git'|'gh'|'agent-cli'`)
- `init/status.ts` — the checklist item itself
- `extension.ts` — probe call site #1 (`loadWelcomeState`)
- `extension.ts` — probe call site #2 (activation preflight)

...plus a **duplicated install message** hardcoded in `integrations/github.ts`
(`GH_MISSING`), because the fault card needed the text and had no way to reach the
registry.

Worse: `buildSetupStatus` derives `done` from the *missing set*, so a checklist
item whose binary is never probed silently claims to be installed. Forgetting one
of the five edits produces a checklist that lies.

This is the same disease as the "New `Manifest` field checklist" in CLAUDE.md:
N places or it silently drops. The registry is not the source of truth; every
surface re-hardcodes it.

## Decisions (confirmed with the user)

- **Persistent surface:** *"status bar + notification with link to open page with deps"*
  → a status bar item while anything is missing, AND the startup notification gets
  a button that opens the welcome/deps page (not just "Show Logs").
- **Scope:** Registry + guards + surface, **including npm** as a real dependency.
  (`ready`/auth checks explicitly NOT in this pass.)

---

## Design

### The registry (`src/runtime/deps.ts`)

```ts
/** What the user loses when a dependency is absent — drives message AND guard. */
export type Capability = 'worktrees' | 'gates' | 'sessions' | 'ship';

export interface RequiredDependency {
  binary: string;
  label: string;
  install: string;
  enables: Capability;
  /** Installed != ready (e.g. `gh auth status`). NOT implemented this pass. */
  ready?: { args: readonly string[]; fix: string };
}
```

Capability → the user's own words, used to build every message:

| Capability | Sentence fragment | Dependency |
|---|---|---|
| `worktrees` | "create worktrees" | git |
| `gates` | "run the uat and review gates" | npm |
| `sessions` | "run agent sessions" | agent CLI (per provider) |
| `ship` | "open pull requests" | gh |

Message shape (ONE renderer, no duplicates):

> Karst can't open pull requests: the GitHub CLI (gh) isn't installed. Install it
> from https://cli.github.com, run `gh auth login`, then reload the window.

### Three consumers, zero hardcoding

1. **Startup check → status bar + notification.**
   `checkDependencies(registry, binaryExists)` at activation. While anything is
   missing: a status bar item (`⚠ Karst: 2 missing`, warning background) that
   click-opens the deps page and self-clears on recheck. The existing toast keeps
   firing but gains an **"Open setup checklist"** button (today it only offers
   "Show Logs" — dev-only, the exact thing the user objected to) .
2. **Welcome checklist** (`init/status.ts`) loops the registry; `id = binary`.
   DELETE the `'manifest'|'git'|'gh'|'agent-cli'` union — `manifest` stays a
   special first item, the rest are derived.
3. **`ensureCapability(cap, probe)`** — guard at each entry point. Returns the
   missing deps for that capability so the caller can refuse *before* doing work.

### Where the guards go

| Entry point | Capability | Why it matters |
|---|---|---|
| `karst.shipTicket` action | `ship` | Prevents burning a cheap-model PR description per repo, then failing. |
| `karst.openSession` | `sessions` | Terminal opens and dies with a shell error today. |
| `karst.spinTicket` | `worktrees`, `gates` (npm install) | Fails deep in the spin. |
| stage driver (`driveTicket`) | `gates` | A missing npm currently reads as a failing gate → unwinnable fix loop (same class as the lint bug fixed in `e962485`). |

**Guard placement note (host-agnostic invariant):** `shipTicket` is host-agnostic
with an injected `GhRunner`; do NOT default a probe to `binaryExists` inside it —
on a machine without gh that would break the unit tests. Either guard in the
extension's ship *action* (host layer) before calling `shipTicket`, or inject the
probe through opts and update `ship.test.ts`'s 6 fakes. Prefer the host-layer
guard: it keeps ship.ts's single recording path intact (the existing try/catch
already records the failure on the stage row → fault card).

---

## Implementation plan (TDD, one commit per phase)

### Phase 1 — Registry as source of truth
- `runtime/deps.ts`: add `Capability`, `enables` on `RequiredDependency`,
  `NPM_DEPENDENCY`, and a `dependencyRegistry(provider): RequiredDependency[]`
  returning git + npm + gh + `agentDependency(provider)`.
- `deps.test.ts` RED: registry contains all four; every entry has an `enables`;
  `requiredFor('ship')` returns only gh.
- Add `renderMissingDependency(dep)` → the single message string. Test it.

### Phase 2 — Every surface derives
- `init/status.ts`: `buildSetupStatus` loops the registry. `SetupItem.id` becomes
  `string` (or `'manifest' | (string & {})`); manifest stays the first item.
  RED: a registry entry not probed must NOT report done (guard against the lie).
- `integrations/github.ts`: DELETE `GH_MISSING`; `toGhResult` takes the message
  from the registry renderer (or the caller supplies it — keep github.ts free of
  install copy).
- `extension.ts`: both probe sites use `dependencyRegistry(provider)`.

### Phase 3 — Point-of-use guards
- `ensureCapability(cap, probe)` in deps.ts + tests.
- Wire the four entry points in the table above. Each shows the rendered message
  with an **"Open setup checklist"** button; ship additionally records the reason
  on the stage row so the fault card shows it (reuse the existing path).

### Phase 4 — Status bar
- `vscode.window.createStatusBarItem` with warning background while
  `missing.length > 0`; command → `karst.openWelcome`. Recheck triggers:
  activation, welcome open, after every guard, and a `karst.recheckDeps` command.
  No polling.
- Keep the vscode binding thin (CLAUDE.md invariant): the decision of *what to
  show* is a pure function (`buildDepsIndicator(missing) => {text, tooltip} | null`)
  in a vscode-free module + tests; `extension.ts` only binds it.

### Phase 5 — done, with three deviations
- **uat's missing-script trap** (`60d2e59`): `TestResult.exitCode` is now
  `number | null`, `makeNpmTestRunner` checks for the script, null passes and the
  artifact says "did not run". Also deleted `RunUatOpts.command`, which no caller
  passed and the default runner ignored.
- **`ready` probes** (`227f015`) — but **`gh auth token`, not `gh auth status`**.
  status validates the token against the API, so it fails when the user is merely
  offline, and this probe REFUSES to ship: blocking an offline user with "you're
  not signed in" sends them to re-run a login that already works. A local probe
  has one failure cause, which is what lets the message name it. Cost: a revoked
  token reads as ready and ship fails with gh's own error (today's behaviour).
  The probe discards output — `gh auth token` prints a secret to stdout.
- **Service commands** (`48c7be8`) — the argv[0] preflight was the wrong fix.
  The real defect was at the spawn: Node reports ENOENT as an async `'error'`
  event, `startHot` had no listener, and an `'error'` event with no listener
  THROWS — an uncaught exception in the extension host naming neither the service
  nor the command. Fixed where it happens, which also covers commands a preflight
  could never parse (shell strings, pipes, env prefixes). No argv[0] probe.

### Still open
- Gates are hardcoded npm scripts; they should be manifest-configured.
- `runUat`/`runReview` use blocking `spawnSync`.
- `splitCommand` is duplicated in `spin.ts` and `baseline.ts`.

## What changed during implementation

- **`buildSetupStatus` takes a `probe`, not a `missingDeps` list.** The plan kept
  the precomputed set and added a test that an unprobed item mustn't claim done.
  That test can't be written honestly against that shape — the lie is in the
  signature. Probing each item's own binary makes it unrepresentable instead.
  `SetupItem.id` is now `string` (= the binary; `'manifest'` stays special), and
  the webview only ever keyed off `'manifest'`, so nothing there needed touching.
- **The guard is a `guardCapability(capability, silent?)` closure in `activate`**,
  injected into `makeDashboardActions` as a 7th param. Host layer, as planned —
  `ship.ts` never learns what PATH is.
- **The driver guard warns once** (`gateToolsWarned`). The activation sweep drives
  every parked ticket; N identical toasts add nothing to the first.
- **The status bar names a single missing tool** rather than always counting
  ("Karst: the GitHub CLI missing"), and `refreshDepsStatus` is the one probe the
  preflight also consumes, so activation probes PATH once, not twice.
- **`karst.recheckDeps` is a contributed command** in `package.json` — a status
  bar item pointing at an unregistered command silently does nothing.

## Verification
- `npm test` — **921 passing / 98 files** at `48c7be8` (887/97 before this work).
- `npx tsc --noEmit` clean; `npm run build` clean.
- Still unverified: no manual run in the Extension Dev Host. On this machine gh
  is genuinely absent, so the status bar, the ship refusal, and the checklist row
  should all be live on F5 — that is the cheap E2E to do first.
- **`gh auth token` was never run against a real gh** (gh isn't installed here).
  If that subcommand is missing or behaves differently than assumed, an installed
  and signed-in gh reads as not-ready and the ship guard refuses. Check it first
  on a machine that has gh: `gh auth token >/dev/null; echo $?` must print 0.
- Manual: with gh absent, ship must refuse with the actionable message and never
  call the model; the status bar must show the warning; the welcome checklist must
  list gh + npm; installing gh + `karst.recheckDeps` must clear both.

## Environment gotchas (bit me this session)
- **The Bash cwd silently reset to `/Users/nd/Work/projects/karst` (main) mid-session.**
  File edits used absolute worktree paths and were fine, but one `npm test` ran
  against main and reported a stale 837/92. ALWAYS `cd` to the worktree first:
  `/Users/nd/Work/projects/karst/.karst/worktrees/869e48tv6-feat-implement-initialization-after-fresh-install`
- `npx vitest` skips the `pretest` Node ABI rebuild → NODE_MODULE_VERSION crash.
  Use `npm test -- <file>`.
