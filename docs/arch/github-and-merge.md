# GitHub: PRs, merge probes, and the merge action

Everything karst believes about a PR is re-probed state, never assumed. Related: `docs/arch/stages-and-gates.md` (the ship gate that reads this state), `docs/arch/worktrees-and-servers.md` (the branch the PR is opened from).

## Contents

- A merge probe's file list is PARSED output
- PR facts are re-probed state, never assumed
- The merge action trusts the re-probe, not the exit code
- A merged PR ends its repo's merge check
- Ship paths go through repoDisplayPath

## A merge probe's file list is PARSED output, and the format is not what it looks like

`git merge-tree --write-tree --name-only` prints the tree OID and the conflicted paths on CONSECUTIVE lines, then a blank line, then git's own chatter ("Auto-merging x", "CONFLICT (content): …"). It is not a uniformly blank-separated three-section document: splitting it as one made section 1 the chatter, and `mergeCheck.ts` reported "CONFLICT (content): Merge conflict in x" as a filename to the panel and into the agent's conflict brief. Any fixture for this must be VERBATIM git output (`mergeCheck.test.ts`, `mergeSync.test.ts`, `ship.test.ts` all carry one) — the invented layout is what let the bug pass its own tests.

## PR facts are re-probed state, never assumed

`prs`' v16 metadata (`head_ref`/`base_ref`/`created_at`/`merged_at`/`comments`) is CURRENT STATE like `status`, not evidence — one `gh pr view --json …` (`fetchPrDetail`) fills all of it, and `updatePrDetail` writes every field as COALESCE so a degraded probe never corrects a known fact to null. Three distinctions are load-bearing: `status:'unknown'` is dropped (never overwrites a real status), `comments: []` ("none") clears while `comments: null` ("gh did not say") keeps, and `merged_at` can never be un-set. Display strings are rendered host-side in `model/prPanelView.ts` (`''` for an absent fact — never a placeholder), because the webview cannot import a formatter. The merge verdict beside them is worded in `model/mergeCheckPanel.ts` — bounded facts (verdict, count, base ref, age) on the headline, the unbounded ones (conflicting paths, git's error prose) in a collapsed body — while `model/mergeCheckView.ts` keeps the one-line form the ship strip and `karst context` share; the two must not be merged, because the panel has room to say more and the CLI does not.

## The merge action trusts the re-probe, not the exit code

`workflow/mergePr.ts` runs `gh pr merge` and then re-reads the PR: gh refused but it reads merged → success; gh accepted but it does not → NOT success, with the state named. `gh pr merge` always gets an explicit method (bare would prompt on a tty that does not exist behind a webview) and never `--delete-branch`/`--auto` — the `worktrees` row and `archive.ts` restore both target that ref, and a queued merge cannot be reflected as merged now. The webview posts only `{type:'merge-pr', repo}`; the modal confirmation AND the method choice live in the host, so a crafted message can neither pick a strategy nor skip the confirmation of an irreversible action.

## A merged PR ends its repo's merge check, and that is enforced on READ

`merge_checks` is current state, but `syncMergeChecks` refreshes through `listSyncablePrs`, which drops merged PRs on purpose — so the last pre-merge verdict freezes the moment it stops being true, and nothing can ever overwrite it. Both `getMergeCheck` and `listMergeChecksByTicket` therefore filter on `PR_NOT_MERGED` (`store/mergeChecks.ts`), which fixes all four consumers — panel, ship strip, `karst context`, and `buildConflictBrief`'s refusal — at one seam. Read-filtered, never deleted-on-transition: a delete only fires on the transition and would leave every row already stranded in a user's DB, while a read recomputes from `prs.status`, which is itself re-probed. Scoped to the repo's CURRENT PR (`CURRENT_PR_ORDER`, exported from `store/prs.ts` and shared with `findTicketPr`), because `ship` inserts a fresh PR row rather than reusing a terminal one. No PR row at all is NOT a merged repo: `ship` records a check per worktree even when opening the PR failed.

## Ship paths go through `repoDisplayPath` + `PathContext`

Any path the ship stage prints goes through `repoDisplayPath` + `PathContext` (the manifest's `worktreePathDisplay`) — the PR panel rows (`PrView.repoDisplay`, set in dashboard `state.ts`) and the ship strip (`ShipPrView.repoDisplay`). One preference, one formatter; never a second local format.