# PM — Ship stage should track merge conflicts

**Ticket**: `869e7bwaf` · **Slug**: `869e7bwaf-ship-merge-conflicts`
**Research**: GO (High confidence) — `../research/RESEARCH.md`

---

## Problem

Ship opens one PR per hot repo and advances the ticket to `done`. It never asks whether the branch can merge into its base. A ticket therefore reaches `done` carrying a PR that nobody can merge, and karst displays no signal at all. The conflict is discovered by a human at merge time — after the agent session that held all the context is gone.

Karst's premise is that stage state is trustworthy. Today "shipped" means "a PR exists", not "this can land".

## Goal

During ship, determine whether each worktree branch merges cleanly into its base ref, record the result (including conflicting files), and surface it everywhere ship state is already surfaced.

## Resolved decision — conflict is state, not a verdict

Research flagged one open question: does a detected conflict block `ship → done`?

**Decision: annotation only. A conflict does NOT fail the ship stage.**

Rationale:
1. Acceptance criteria say "no breaking change to existing ship-stage consumers". Blocking changes the outcome of every conflicted ship from `done` to parked.
2. `graph.ts` gives `ship` no `failed` edge. A blocking conflict parks the ticket at `ship` with no route out except a retry — and a retry cannot fix a conflict, only a human rebase can. That is a trap, not a gate.
3. The ticket asks the system to *track* conflicts. Resolution and gating are separate product decisions.

Escalation to a blocking gate stays available later (it needs a `ship.failed` edge first) and is explicitly out of scope here.

## User stories

- **US1** — As a developer watching the board, I see that a shipped ticket's PR conflicts with its base, and which files conflict, without opening GitHub.
- **US2** — As a developer, I can tell "checked, no conflict" apart from "we could not check". A failed check never displays as clean.
- **US3** — As an agent reading `karst context`, I receive current conflict state for each PR, so I can act on it inside the session that still has the context.
- **US4** — As a developer re-running ship after a rebase, I see the conflict state refresh rather than a stale earlier result.

## Acceptance criteria

| # | Criterion | Verifying test |
|---|---|---|
| A1 | Branch with a real conflict → recorded `conflicted` with the conflicting file list | `mergeCheck.test.ts` (fake runner, exit 1 + paths) |
| A2 | Cleanly mergeable branch → recorded `clean`, empty file list | `mergeCheck.test.ts` (exit 0) |
| A3 | Failed/indeterminate check → recorded `unknown` with a reason; never `clean` | `mergeCheck.test.ts` (exit 128, spawn error, timeout) |
| A4 | Re-running ship overwrites the prior result for that `(ticket, repo)` | `mergeChecks.test.ts` upsert |
| A5 | Existing ship-stage consumers keep working unchanged | full `npm test` green; new field optional |
| A6 | A conflict does not change the stage outcome — ship still passes to `done` | `ship.test.ts` |

## Out of scope

- Auto-rebase, auto-merge, or any conflict *resolution*.
- Blocking the `ship → done` transition on conflict (needs a `ship.failed` edge).
- Polling GitHub's `mergeable` field.
- Background/periodic re-checking outside a ship invocation.

## Success metric

Zero tickets reach `done` with unknown mergeability: every ticket that ships has a `merge_checks` row per hot repo with a definite `clean` / `conflicted` / `unknown` + reason.
