# Approach Execution Wiring — Design

**Date:** 2026-07-11
**Status:** approved (brainstorming → plan)

## Problem

karst ships installable, agent-agnostic **approaches** (rpi, gsd, tdd, direct…):
a neutral on-disk package (`<approachesDir>/<id>/approach.yml` + `prompts/*.md`)
fetched from git/npm, an AI recommender, and an onboarding install picker. The
user picks an approach per ticket and it is persisted to `ticket.approach`.

But nothing consumes it at run time. `ticket.approach` is written
(`src/ui/onboarding/actions.ts:142`) and read back only to pre-select a radio.
The implement session (`SessionManager.openSession`, `src/ui/session.ts`)
launches `claude` with **no prompt** — the agent starts bare, ignorant of the
chosen approach. The whole point of the feature ("the approach drives how a
ticket is built") is unwired.

## Goal

The approach the user picked for a ticket seeds its **implement** session: when
the interactive agent launches, its first prompt is the approach's entrypoint
document. One sentence: *resolve the entrypoint prompt body → seed the impl
terminal → silent bare-launch fallback when nothing is resolvable.*

## Scope decisions (locked)

- **Phase:** implement only. Scope/uat/review/ship keep their current prompts.
- **Injection:** entrypoint only — inject `prompts/<entrypoint>.md` verbatim as
  the session's initial prompt. Sibling prompt docs are inert this feature.
- **Model tiering:** deferred (separate feature). No `model` field added here.

## Architecture

Data flow at impl launch (`karst.openSession` command, `src/extension.ts:216`):

```
ticket.approach (id, persisted)
  → manifest approach lookup → entrypoint field
  → readPromptBody(approachesDir, id, "<entrypoint>.md")
  → InteractiveCommandOpts.initialPrompt
  → buildInteractiveCommand appends it as a positional arg
  → openSession launches: claude "<entrypoint body>" --settings <path>
```

Every resolution failure degrades to `null` = launch a bare session (today's
behavior). Impl is **never blocked** by a missing/broken approach package.

### Units

**U1 — `readPromptBody` (pkg.ts helper).** `src/approaches/pkg.ts`.
Read one file under a package's `prompts/`. Signature:
`readPromptBody(baseDir: string, id: string, promptName: string): string | null`.
`assertSafeId` on both `id` and `promptName` (existing traversal guard). Returns
`null` when the file is absent. Reuses `approachDir`.

**U2 — `resolveApproachPrompt` (new pure module).** `src/approaches/resolve.ts`.
Given the approaches base dir, the manifest's approach list, and a ticket's
approach id, return the entrypoint prompt body or `null`. Signature:
```ts
export function resolveApproachPrompt(
  baseDir: string,
  approaches: readonly ApproachDef[],
  approachId: string | null | undefined,
): string | null;
```
Returns `null` (never throws) when: `approachId` is null/empty; no manifest
approach with that id; the approach has no `entrypoint`; the package is not
installed; or the entrypoint file is absent. On a hit, returns the file body via
`readPromptBody(baseDir, id, "<entrypoint>.md")`. Pure — no fs beyond
`readPromptBody`, no vscode.

**U3 — `InteractiveCommandOpts.initialPrompt` (adapter API).**
`src/agent/adapter.ts` + `src/agent/claude.ts`. Add optional
`initialPrompt?: string` to `InteractiveCommandOpts`.
`ClaudeAdapter.buildInteractiveCommand` pushes it as a **positional** arg (after
`--settings`) when present and non-empty. Agent-agnostic: a second adapter
decides its own presentation. Empty/absent → args unchanged (bare launch).

**U4 — `openSession` threads the prompt.** `src/ui/session.ts`. Add an optional
`initialPrompt?: string` param to `openSession`; pass it into
`buildInteractiveCommand`. The existing-terminal focus path is unchanged — a
prompt only seeds a **fresh** launch (re-opening focuses, never re-seeds).

**U5 — call-site wiring (host glue).** `src/extension.ts:216-226`. Before
`sessions.openSession(...)`, resolve the prompt from the ticket's approach and
pass it. Wrap the resolve in a try/catch that yields `null` on any throw (e.g.
`approachesDirOrThrow` when no workspace) — mirrors the `listInstalledApproachIds`
no-folder guard already in the file. `t` (the ticket) and `currentManifest` are
already in scope at this call site.

## Error / edge behavior

| Situation | Behavior |
|---|---|
| Ticket has no approach | bare launch |
| Built-in approach (no package, e.g. `direct`) | bare launch |
| Approach chosen but package not installed | bare launch |
| Package installed, entrypoint file missing | bare launch |
| `approachesDir` unresolvable (no workspace) | bare launch (caught) |
| Re-open an already-open session | focus only, never re-seed |

No path resolves to a thrown error reaching the user. Worst case = the session
the user already gets today.

## Testing

- U1 `readPromptBody`: present file → body; absent → null; `../` id or name → throws.
- U2 `resolveApproachPrompt`: hit returns body; each null branch (no id, unknown
  id, no entrypoint, no package, no file) returns null; never throws.
- U3 adapter: `initialPrompt` present → positional arg appended after
  `--settings`; absent/empty → args unchanged.
- U4 `openSession`: fresh launch passes prompt through; re-open focuses without
  re-invoking `buildInteractiveCommand`.
- U5: host glue — no unit test (vscode seam); typecheck + build only.

## Out of scope (explicit — later features)

- Multi-stage prompt mapping (research→scope, plan→plan). Only impl, only entrypoint.
- Injecting sibling `prompts/*.md`; entrypoint `@`-mentions (paths won't resolve
  from the worktree cwd — inert until a package-materialize feature).
- Model tiering (`model` on `RunHeadlessOpts`).
- Settings source-recipe editing, approach uninstall, package↔manifest reconcile.

## Global constraints (inherited)

- Host-agnostic: no `vscode` outside `extension.ts`/`*host.ts`/`manifestResolve.ts`.
  U1–U4 are pure/injected, unit-tested with fakes; only U5 touches vscode.
- Immutable data; files <400 lines.
- ESM: `.js` import suffix; `noUncheckedIndexedAccess` (array access needs `!`/guard).
- Strict TDD RED→GREEN. Conventional commits.
- Reuse existing guards (`assertSafeId`) — no new traversal logic.
