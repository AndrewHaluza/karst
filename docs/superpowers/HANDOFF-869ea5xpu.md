# Handoff — 869ea5xpu, [FEAT] Implement UAT stage to run actual testing

**Written:** 2026-07-30. **Worktree:** `.karst/worktrees/869ea5xpu-feat-implement-uat-stage-to-run-actual-testing`, branch `karst/feat/869ea5xpu-feat-implement-uat-stage-to-run-actual-testing`.

## State in one line

Design and implementation plan are complete, committed and user-approved. **No `src/` file has been touched.** The next action is Task 1 of the plan.

## What exists

| commit | what |
|---|---|
| `ee257c8` | `docs/superpowers/specs/2026-07-29-uat-stage-design.md` — **rev 5, normative.** Plus two historical companions in the same directory. |
| `afeafa8` | `docs/superpowers/plans/2026-07-30-uat-stage-phase-0-1.md` — 14 TDD tasks, Phase 0 + Phase 1. |

**Read the plan first, not the spec.** The plan is self-contained: exact file paths, real test code, real implementation code, and a commit per task. Reach for the spec only when a task's *reasoning* is unclear — and when spec and plan disagree, the spec wins and the plan is wrong.

Two files in `docs/superpowers/specs/` are historical and **must not be implemented from**: `2026-07-29-uat-review-triage.md` and `2026-07-30-uat-codex-review.md`. Both carry headers saying so.

## What to do next

Execute the plan, Task 1 → Task 14, in order. Tasks 3–8 have no dependencies on each other and could be parallelised across agents; Tasks 10–14 are a chain and must be sequential.

Two ways, both fine:

- **Subagent-driven** (`superpowers:subagent-driven-development`) — a fresh agent per task, review between. Recommended: each task is sized to one agent's context.
- **Inline** (`superpowers:executing-plans`) — batch with checkpoints.

Do not invoke `brainstorming` again. That gate is passed.

## Scope boundaries — do not widen these

The plan covers Phase 0 + Phase 1. Three things are deliberately out, by the spec's own phasing, not by trimming:

| out | why | where it goes |
|---|---|---|
| **Phase P** — P1/P7 (marker CAS + per-launch token), P2 (`starting` servers row), P3 (archive ordering), P4 (service logs out of the worktree), P5 (wire `openDiff`) | six pre-existing bugs on `main`, none caused by UAT, five exploitable or lossy today | its own ticket, ships independently and first |
| **Phase 1a** — the B8 env allowlist | it changes **review** gate behaviour on `main`, so it must be revertable by itself | its own ticket |
| **Phase 2** — boot, adopt-or-spin, the P6 lease, extractor→verifier→author, Playwright, the digest short-circuit | **blocked on an experiment that has not been run** — see below | after the experiment |

If a task tempts you toward one of these, stop and say so rather than absorbing it.

## The blocking experiment before Phase 2

The spec names one assumption as the design's riskiest and currently unvalidated: **authored Playwright steps must be runnable by the repository's own suite**. Everything in Phase 2 rests on it — it is what makes authored steps "ordinary maintained tests", what makes the review diff the sole control, and what makes UAT's signal survive into the next ticket.

Falsify it before Phase 2 is *planned*, not during. Half a day, zero karst code: take one real multi-service repo, hand-write one Playwright spec in `e2e/karst/`, run it twice — once against a karst-style alt-port stack under a config that spreads the repo's config minus `webServer` with the base URL injected, once via the repo's plain `npx playwright test`. Same file passing both unedited means the assumption holds. Needing edits means "steps become the repo's suite" is false and the whole A3/A4/B5 control column collapses — a Phase 2 design change, not a Phase 2 bug.

## Standing constraints from the user — these outrank the plan

Stated across earlier sessions and still in force:

1. **Secrets are never plain text.** They live in the extension's secure storage (OS keychain via `src/extension/secretStore.ts`). `karst.yml` holds key *names* only. This is why `uat.secrets` gets strict list-of-strings validation while the rest of `schema.ts` is permissive — an ignored key there is a live credential committed to git.
2. **UAT credentials are separate, never inherited.** Configurable manually through the UI now, Infisical later. Karst never guesses which keys are dangerous — "user responsible to override if he want to make automated testing from another env".
3. **Karst runs on subscription auth** (Claude / Codex / Antigravity), never API keys. Do not add an API-key path.
4. **The DB stays agnostic.** Not every project has a test database; requiring one is not viable.
5. **`npm test` stays in UAT, first.** The user explicitly refused removing it: it is the conventional entry point and usually the cheapest suite. The bug was never that UAT runs `test` — it was that `test` was UAT's *only* gate.
6. **The review stage is being rethought separately.** Whether review keeps its `test` gate is out of scope here.

## Open decisions that belong to the user, not to you

Both are currently resolved in the spec and should not be reopened unilaterally:

- **`kind: command` gates** — rev 3 cut them, rev 4 un-cut them, rev 5 keeps them. Cutting makes UAT Node-only, which contradicts karst's repository-agnostic premise.
- **Consumer-scoped secrets** — touches constraint 1 above. Rev 5 keeps them.

## Gotchas that already cost time

- **`grep --include=*.ts` fails under zsh** with "no matches found". Quote the glob: `--include='*.ts'`.
- **`cd` inside a Bash tool call persists across calls.** A later `git add` with a repo-relative path then resolves against the wrong directory. Use absolute paths for git.
- **better-sqlite3 ABI is split.** `npm test` auto-rebuilds for Node via `pretest`; F5 copies the Electron prebuild. If a test dies on a native module load, run `npm test` rather than `npx vitest` alone.
- **Manifest fixture names.** The builder is `manifest(repositories, over?)` — repositories is *positional*. There is no `baseManifest`. `repo()` defaults to **non-runnable**; pass `service: svc()` for a runnable one. This tripped the plan's first draft in three places.
- **`writeManifest.test.ts` has no `writeAndRead` helper.** The round-trip guard is one existing test (line 102) building a `full: Manifest` literal. New manifest sections extend *that* test — a parallel test is not the guard CLAUDE.md names.
- **`db.test.ts` has 14 hardcoded `user_version` assertions across 29 occurrences**, not the 9 CLAUDE.md claimed. Task 5 corrects the CLAUDE.md line in the same commit as the schema bump.

## Facts about the codebase the plan depends on — verified, but re-check if surprised

- `setStage` is a bare `UPDATE … WHERE ticket_id = ? AND stage_key = ?`. Writing a row that does not exist is a **silent zero-row no-op**, not a throw, while `UPDATE tickets SET stage_current` still lands. Any future stage-key addition must seed rows at `createTicket`, in the migration, *and* at boot reconcile.
- `transition(null)` **throws** (`machine.ts:55-59`). Nothing in the tree parks anything today — that is what `parkGateStage` (Task 6) builds.
- `countFixAttempts` currently **sums** `uat` + `review` (`fixAttempts.ts:21-23`). Per-stage storage exists; the policy does not. Task 8's interleaved test fails against today's code, which is the point.
- `worktreeFor` is `listWorktreesByTicket(store, id)[0]?.path` and `dashboard.ts:88` is `ORDER BY path` — so a multi-repo ticket gets gates on whichever repository sorts first alphabetically. Deterministic, which makes it worse rather than better. Task 12 replaces it.
- `openDiff` has **no production implementation** (`review.ts:113` defaults to `() => {}`; no `vscode.diff` call exists in `src/`). Four of the design's mitigations rest on it. That is P5, in Phase P.

## Unfinished side item

**B9 is partially verified.** All three adapters return `env: {}` (`claude.ts:135`, `codex.ts:440`, `antigravity.ts:142`), so an exported provider API key reaches the agent CLI. Credential stores confirmed on disk: `~/.claude.json` → `oauthAccount`; `~/.codex/auth.json` → `tokens` + `auth_mode` + an explicit `OPENAI_API_KEY` field; `~/.gemini/oauth_creds.json`. **Still unverified:** each CLI's actual precedence when both an env key and a stored subscription credential are present. Not doable from disk state — needs vendor docs or a throwaway key.

Does not block this ticket. The spec files B9 as a standing karst issue outside UAT scope, and B8's allowlist covers repository children, which is UAT's actual surface.

## The stage marker

Fire **only** when this stage's work is genuinely complete — the plan executed, not merely written:

```
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket 869ea5xpu
```
