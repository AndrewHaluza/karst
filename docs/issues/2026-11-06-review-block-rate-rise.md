<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/issues/2026-11-06-review-block-rate-rise.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:RB-01'):
  awk "/^## \[@issue:RB-01\]/,/END_DOC_BLOCK: \[@issue:RB-01\]/" docs/issues/2026-11-06-review-block-rate-rise.md
-->
# Review block rate rise, Oct 29 to Nov 6 (T995)

Time zone: all times in this report are UTC. Git commit times were local CET (UTC+1) and are converted to UTC. The Nov 2 18:06 time of `~/.claude/CLAUDE.md` is taken from the ticket text; its zone is not stated and the study did not use it.

Data cut: Nov 6 20:00 UTC. The store counts of Q1 and Q2 reproduce with this cut (first non-stale `claude-opus-5-5` review per ticket: A 73, C 41, 22 blocked). Reviews after the cut are not in the tables. The store at Nov 7 00:13 UTC has 47 tickets for Nov 5 to 6 with 27 blocked (57%), and it includes reviews of T995 itself, so the cut also keeps this ticket out of its own data.

Each verdict below is either MEASURED (number and source) or NOT MEASURED (reason and the free query). Projects: 5 of the 41 tickets in C belong to another project (mobile-app); see Q2.

Corrections after T995 merged (T1003): the review effort in [@issue:RB-04] and the next step in [@issue:RB-01] are wrong in the first version; [@issue:RB-09] corrects the effort and adds the run medians and the replays, and [@issue:RB-10] adds the sample of the medium period.

Research only. No prompt, reviewer definition, threshold or setting changed. Data: store `process_runs` + `review_findings`, first review per ticket, model claude-opus-5-5, blocking = critical, high or medium. Review transcripts: `~/.claude/projects/<worktree>/<uuid>.jsonl`.

## [@issue:RB-01] Summary and verdict

- Q1: MEASURED. First-review block rate: A (Oct 29 to Nov 1) 21% (15 of 73 tickets), C (Nov 5 to 6) 54% (22 of 41). Without UI-only and docs-only tickets: A 22% (n=69), C 54% (n=41). Without the 11 C tickets that have no merged diff: C 47% (n=30). Source: RB-02. The ticket figures (19% over 90 tickets) match Oct 27 to Nov 1 (17 of 91), not Oct 29 to Nov 1; the reason is not confirmed.
- Q2: MEASURED (source RB-03). The mix does not explain the rise. Of the 33 points (21% to 54%): type 0 to 4 points (the `fix` share is 51% in A and 51% in C; at the A type mix C would have 46% to 54%), size 0 points (at the A size mix C would have 56%; reviewed diffs are a median of 150 lines in A and 181.5 in C), intent 4 points (at the A intent mix C would have 50%). If the three effects added, the mix explains at most 8 points (about a quarter). The rate rose inside every size band, among `fix` tickets (11% to 48%) and among tickets without intent (21% to 50%).
- Q3: MEASURED as a list of input differences (RB-04): Claude Code version (2.1.314 and 2.1.316 in A, 2.1.318 and 2.1.319 in C), loaded user context, repo CLAUDE.md, prompt tail with the Intent section (1 of 57 A runs, 14 of 35 C runs), and review effort (corrected in [@issue:RB-09]: the active preset, Claude Code MAX, runs the review lane at `effort: medium`, not the `low` in `.karst/karst.yml`; every karst-reviewer Opus session after Nov 6 11:39 UTC ran at medium, which is 84 sessions on Nov 6 counted over all rounds, while the report's 7 or 8 counts first reviews only; why the sessions switched at that time is unknown). The reviewer prompt text (hash 21e8a7e8) and the model did not change, but the assembled prompt did change: its tail now has an Intent section (and, in 5 runs, a Ticket description section) that most A prompts do not have. NOT MEASURED: which difference changes the block rate. A free query cannot measure it. The replays in [@issue:RB-09] tested the Claude Code version and the loaded context, not the prompt tail.
- Q4: MEASURED (source RB-05, RB-08). Each of the 30 sampled findings was classified against the ticket-branch code at the review start. Wrong: 0 of 29 decided (A 0 of 14, C 0 of 15; 1360 in A is UNDECIDED, because it needs a Stryker run). Real at the stated severity: A 6 of 14 (43%), C 6 of 15 (40%). Real but below the stated severity: A 8, C 9. Right severity low (would not block): A 7 of 14, C 3 of 15. 6 of the 9 stated highs in the C sample are medium at most. The extra blocks in C are real defects; the rise is not explained by false findings. Both periods rate about half of the findings above their right severity. A second sample of 20 findings from the medium period ([@issue:RB-10]) is 13 real at the stated severity, 3 real at medium, 3 real at low and 1 not a code defect.
- Q5: MEASURED, with low power. Fix-titled later tickets that reference a ticket that passed review: A 5 of 70, C 3 of 38 (text match; source RB-06). C is 1 to 2 days old. No verdict on missed bugs.
- Forced-high rule: MEASURED (source RB-04). Code form (highs without a file): A 0 of 4, C 1 of 21. Prompt form ("ALWAYS high" for an unmet intent scenario or spec requirement; `conformance.ts`): it applies to the 15 C tickets with intent, which have 14 of the 21 C highs (4 name a scenario by text match). The other 7 C highs are on tickets without intent (0.27 per ticket against 0.06 in A), so the rule does not explain the rise in highs there.
- Cause: not isolated. The report names two candidates that match the timing: (a) from Nov 2, the user context and the Intent section; (b) Nov 5 12:13 UTC, the Claude Code upgrade to 2.1.318 (store cut-over at run 5759). Replays of 5 merged diffs (RB-09) show that the CLI version (2.1.317, 2.1.319) and the local configuration do not produce the rise at low on Nov 5. The source is probably remote, but there is no direct proof. The extension build per run is NOT MEASURED (the store does not record it; free query: none).
- Next step (decision for a person): decide the review effort in the preset by cost and stall rate. No decision is stated here. Do not lower `blockingSeverity` now.

END_DOC_BLOCK: [@issue:RB-01]

## [@issue:RB-02] Q1 table: first review per ticket

| Day | n | Blocked % | Avg blocking | critical | high | medium |
|---|---|---|---|---|---|---|
| Oct 27 | 9 | 11% | 0.11 | 0 | 0 | 1 |
| Oct 28 | 9 | 11% | 0.11 | 0 | 0 | 1 |
| Oct 29 | 15 | 27% | 0.27 | 0 | 1 | 3 |
| Oct 30 | 11 | 27% | 0.27 | 0 | 0 | 3 |
| Oct 31 | 13 | 15% | 0.15 | 0 | 0 | 2 |
| Nov 1 | 34 | 18% | 0.29 | 0 | 3 | 7 |
| Nov 2 | 18 | 33% | 0.39 | 0 | 2 | 5 |
| Nov 3 | 8 | 38% | 0.75 | 0 | 2 | 4 |
| Nov 5 | 20 | 55% | 1.05 | 0 | 11 | 10 |
| Nov 6 | 21 | 52% | 1.14 | 0 | 10 | 14 |

Periods: A = Oct 29 to Nov 1 (73 tickets, 21% blocked, 0.26 avg, high 4, medium 15). B = Nov 2 to 3 (26, 35%, 0.50). C = Nov 5 to 6 (41, 54%, 1.10, high 21, medium 24). High findings rose from 4 to 21 (0.05 to 0.51 per ticket, about 9 times).

Second table, without UI-only and docs-only tickets:

| Period | n | Blocked % | Avg blocking |
|---|---|---|---|
| A | 69 | 22% | 0.28 |
| B | 24 | 38% | 0.54 |
| C | 41 | 54% | 1.10 |

11 of the 41 tickets in C have no merged diff, so the study could not classify them as UI-only or docs-only. They stay in the C row. Without them, C has 30 tickets with 47% blocked (14 of 30), against 22% in A. The rise holds in both views.

The ticket figures (90 tickets, 19% blocked) match Oct 27 to Nov 1 in this table: 91 tickets, 17 blocked (19%), 0.23 average. They do not match Oct 29 to Nov 1, which has 73 tickets. The ticket text probably names the wrong start day, but the study did not confirm this. The later days compare as follows (ticket against this study): Nov 2 35% and 0.40 against 33% and 0.39; Nov 3 38% and 0.75 against 38% and 0.75; Nov 5 52% and 1.00 against 55% and 1.05; Nov 6 52% and 1.14 against 52% and 1.14. These agree within 3 points. The user counts may also include other models or repeat reviews. The daily averages of 0.15 to 0.32 in the ticket do not match the daily column here exactly (0.11 to 0.29 for Oct 27 to Nov 1). The difference is small and its cause is unknown. The trend is the same in both counts.

END_DOC_BLOCK: [@issue:RB-02]

## [@issue:RB-03] Q2: ticket mix

Source: merged PR diffs and the conventional commit prefix of the merge subject. A merged diff can differ from the reviewed diff. 11 of 41 tickets in C have no merged diff and no type. They are counted as type `none` and are not in the size values. In A and B every ticket has a merged diff.

Per day (median files and lines are over tickets with a merged diff):

| Day | n | Median files | Median lines | `fix` share | Touch src/extension | Blocked |
|---|---|---|---|---|---|---|
| Oct 29 | 15 | 8 | 359 | 47% | 33% | 27% |
| Oct 30 | 11 | 12 | 315 | 45% | 36% | 27% |
| Oct 31 | 13 | 7 | 134 | 23% | 15% | 15% |
| Nov 1 | 34 | 7 | 121 | 65% | 29% | 18% |
| Nov 2 | 18 | 8 | 137 | 50% | 6% | 33% |
| Nov 3 | 8 | 7 | 164 | 88% | 25% | 38% |
| Nov 5 | 20 (15 with diff) | 12 | 295 | 55% | 25% | 55% |
| Nov 6 | 21 (15 with diff) | 6 | 139 | 48% | 19% | 52% |

Per period:

| Measure | A | B | C |
|---|---|---|---|
| Tickets with a merged diff | 73 of 73 | 26 of 26 | 30 of 41 |
| Median files changed | 8 | 8 | 7 |
| Median lines changed | 163 | 146 | 256 |
| `fix` tickets | 37 of 73 (51%) | 16 of 26 (62%) | 21 of 41 (51%) |
| Blocked, `fix` tickets | 4 of 37 (11%) | 6 of 16 (38%) | 10 of 21 (48%) |
| Blocked, other tickets | 11 of 36 (31%) | 3 of 10 (30%) | 12 of 20 (60%), of which 11 have no type |

Mix type B: `fix` 16, `feat` 5, `other` 3, `docs` 1, `Eval` 1. B has 9 blocked tickets of 26 (35%), the same count as Q1.

Project: all tickets in A and B belong to the project of this repository (extention). 5 of the 41 tickets in C belong to another project (mobile-app, an iOS app); 2 of them were blocked. Without them C has 36 tickets with 20 blocked (56%), against 21% in A. The rise holds. The study did not split the other results (size, type, Q3 inputs) by project. Those 5 tickets also have no merged diff in this repository, so they are among the 11 untyped C tickets.

How much the mix explains: the `fix` share is 51% in A and 51% in C. The 11 tickets in C without a type hide the real share, and 8 of the 11 were blocked. The study gives a bound:

| Assumption for the 11 untyped C tickets | `fix` rate in C | Other rate in C | C rate at the A mix |
|---|---|---|---|
| All are `fix` | 18 of 32 (56%) | 4 of 9 (44%) | 50% |
| None is `fix` | 10 of 21 (48%) | 12 of 20 (60%) | 54% |
| Only the 30 typed tickets | 10 of 21 (48%) | 4 of 9 (44%) | 46% |

MEASURED: the A rate is 21%. The C rate is 54% for all 41 tickets and 47% for the 30 typed tickets. The A type mix gives C a rate of 46% to 54%. The gap to the actual rate is 0 to 4 points (4 if all 11 are `fix`, 0 if none is, 1 for the typed tickets). This covers the `fix` or other type only.

Size and intent: MEASURED with the reviewed diff. The size of a ticket is the diff that the reviewer saw: the develop tip at the review start, three-dot to the last ticket-branch commit before the review start (`git diff --shortstat <develop>...<snapshot>`). The 5 other-project tickets in C have no branch here and have no size. Cohort: first non-stale `claude-opus-5-5` review per ticket, data cut Nov 6 20:00 UTC (see the note at the top). Median files and lines: A 7 and 150 (n=73), B 7 and 133 (n=26), C 6 and 181.5 (n=36). Block rate by size band (lines changed in the reviewed diff):

| Band | A: tickets, blocked | C: tickets, blocked |
|---|---|---|
| up to 100 lines | 23, 2 (9%) | 12, 6 (50%) |
| 101 to 400 lines | 31, 5 (16%) | 19, 11 (58%) |
| over 400 lines | 19, 8 (42%) | 5, 3 (60%) |
| All with a size | 73, 15 (21%) | 36, 20 (56%) |

At the A size mix, C would have a block rate of 56%, against 56% actual (0 points). The block rate rose in every band (by 41, 42 and 18 points). The reviewed diffs in C are not larger in files, and 181 lines against 150 lines is a small step.

Intent (a ticket attribute in `tickets.intent`; the "Intent" section of the prompt tail exists only for such tickets):

| Group | A: tickets, blocked | B: tickets, blocked | C: tickets, blocked |
|---|---|---|---|
| No intent | 71, 15 (21%) | 15, 4 (27%) | 26, 13 (50%) |
| Intent | 2, 0 | 11, 5 (45%) | 15, 9 (60%) |

At the A intent mix (71 of 73 tickets without intent), C would have a block rate of 50%, against 54% actual (4 points). Among tickets without intent the rate rose from 21% to 50%, so the Intent section is not needed for the rise. The Q3 Intent rate (50% against 25%) is mostly a ticket mix effect, because intent tickets are rare in A (2 of 73) and common from Nov 2 (11 of 26 in B, 15 of 41 in C).

How much the mix explains: MEASURED. Type 0 to 4 points, size 0 points, intent 4 points, from a rise of 33 points (21% to 54%). If the three effects added, the mix would explain at most 8 of the 33 points (about a quarter). The study did not test a joint adjustment, because the cells are too thin (for example 5 C tickets over 400 lines). The three tests are separate and they use different ticket counts. Each one shows a rise inside its own strata.

Verdict Q2: MEASURED. The mix of type, size and intent does not explain the rise. At least about three quarters of it remains with the ticket mix held fixed in each of the three views. Not covered: other mix factors (for example, the area of the code that a ticket changes).

END_DOC_BLOCK: [@issue:RB-03]

## [@issue:RB-04] Q3: reviewer input

Same in all periods: reviewer prompt text (hash 21e8a7e8), model claude-opus-5-5 and betas (19).

| Item | A (Oct 29 to Nov 1) | C (Nov 5 to 6) |
|---|---|---|
| Claude Code version | 2.1.314, 2.1.316 | 2.1.318, 2.1.319 (2.1.317 also appears in 6 runs; the study did not record their period) |
| Skills listed | 133 to 141 | 157 |
| Tools | 13 | 14 (Workflow added) |
| System prompt size | 5474 chars | 7437 chars |
| User CLAUDE.md loaded | 47 of 57 runs: none; others: older versions | All runs: writing-style rule (changed setting: writing-style rule) |
| Session-start hooks | one hook in all runs; a second hook (mode loading) in 65 of 77 runs of versions 2.1.314 and 2.1.316 | one hook; the second hook in none of 41 runs |
| Repo CLAUDE.md | 12.5K to 12.6K chars | 12.6K chars (hash changed, size same) |
| Repo CLAUDE.md change of Nov 2 (ab9d723c15f) | loaded before the change in the runs before Nov 2 18:06 UTC | loaded after the change in all runs |
| Prompt tail "Intent" section | 1 of 57 runs | 14 of 35 runs |
| Prompt tail "Ticket description" section | 0 | 5 runs (Nov 6, after #955) |
| Lane `effort` (parameter in the transcript) | `low` in 56 of 57 matched runs; `medium` in 1 | `low` before Nov 6 11:39 UTC; `medium` in every karst-reviewer Opus session from Nov 6 11:39 UTC (see [@issue:RB-09]) |
| Mean output tokens per run | about 1800 | about 6700 |
| Mean thinking tokens per run | about 280 | about 3300 to 4000 |
| Mean cost per run | $0.43 | $0.70 |

The Q3 rows use the 118 runs whose transcript could be matched to a review run (57 of 73 in A, 35 of 41 in C, 26 in B). This study did not find a transcript for the other runs. The study did not check whether the matched runs are a fair sample of all runs.

Repo CLAUDE.md change ab9d723c15f (committed Nov 2 18:06 UTC): it added one rule (a gate passes only when its exact command exits 0 in the ticket worktree). It removed the file-size guide and the "do not overengineer" guidance. Size is the same. The removed guidance could make the reviewer less lenient about extra code. This is a hypothesis. The study did not test it. All C runs loaded the new repo file (hash ebf53bc7). B has runs on both sides of the change: Nov 2 runs before 18:06 UTC used the old file, and Nov 3 runs used the new file. The change can therefore contribute to the step A to B and to part of the step B to C. The study did not split the B block rate by the repo file hash.

Forced-high rule: the review code forces a kept missing intent or spec requirement to severity high (`src/workflow/review/requirements.ts`, `conformance.ts`). High findings rose from 4 in A to 21 in C. Commit 868d4ae7a14 (Nov 5 11:28 UTC, #919) stopped the forced high when the plan or spec cannot be used. It lowers the number of forced highs, so it cannot explain the rise. The rule has two forms. The code form (`requirements.ts`) forces a kept requirement finding to high. The prompt form (`conformance.ts`, "ALWAYS high" for an intent scenario or a spec requirement that is not implemented) applies to every ticket that has an intent or a spec, and the model sets the severity itself. MEASURED, code form: highs with no file (the form of a requirement finding; the store keeps no requirement field): A 0 of 4, C 1 of 21. MEASURED, prompt form: 14 of the 21 C highs are on the 15 tickets with intent (A: 0 of 4 highs, 2 tickets with intent; B: 3 of 4). Of these 14, 4 name a scenario in the title or detail (text match; the study did not read them as unmet requirements). So the prompt form can account for at most 14 of the 21 C highs, and 4 by the text match. The other 7 C highs are on tickets without intent (A: 4 highs on 71 tickets; C: 7 highs on 26 tickets, 0.27 per ticket against 0.06). The forced-high rule does not explain the rise in those.

Block rate by prompt tail: no extra section 25% (n=87), Intent 50% (n=26), Ticket description 100% (n=5). The Ticket description group is only 5 runs and gives no reliable rate. Inside the "no extra section" group the rate still rose: A 20%, B 27%, C 44%.

Block rate by Claude Code version: 2.1.317 about 221 thinking tokens, 33% blocked (n=6); 2.1.318 about 3170 thinking tokens, 65% (n=20); 2.1.319 about 4416, 47% (n=15). These n are small. The 95% interval of each rate is wide (more than 30 points). The 2.1.319 rate is lower than the 2.1.318 rate, so the thinking tokens alone do not predict the block rate. The cut-over is clean at run 5759 (Nov 5 12:13).

Other files: `.karst/karst.yml` is untracked, so its history is not available; its `effort: low` entry is not the active review effort. The review lane runs at `medium` from Nov 6 11:39 UTC, and why it switched is unknown (corrected in [@issue:RB-09]). The repo reviewer definition did not change after Oct 10. The installed extension folder is karst.karst-1.0.0 at all times, so its version string cannot tell the builds apart. The study did not compare the extension build or its code between the periods. Extension build: NOT MEASURED. The store does not record the build of a review run. The commits under `src/workflow/review` in the period (UTC) are: Oct 29 18:21 5a44314a865; Oct 30 19:44 8ac1ce2a2be and 20:19 c9493b41223; Oct 31 13:18 6bb2c6bdd03; Nov 1 12:50 52caa6d7b9d; Nov 5 11:28 868d4ae7a14; Nov 5 23:13 f97e84ac378 and 23:26 12c75d0a26a; Nov 6 08:11 b6c38d2e51a, 08:25 4ccfe517ece and 15:13 d09208d39f6. The study draws no conclusion from these dates, because a merged commit does not show which build ran. There is no free query.

Verdict: MEASURED, the input changed in five ways: the Claude Code version, the loaded user context, the repo CLAUDE.md, the prompt tail sections, and the review effort (see [@issue:RB-09]; the effort correction does not remove the rise). NOT MEASURED: which change moves the block rate. The block rates by group above are correlations, and the causes are confounded.

END_DOC_BLOCK: [@issue:RB-04]

## [@issue:RB-05] Q4: finding sample, period A

Q4 is MEASURED against the reviewed code. Random sample (seed 995) of 15 blocking first-review findings per period. Pool sizes: A 19, C 45. For each finding, one subagent read the code at the snapshot: the last first-parent commit of the ticket branch made before the review started (`git rev-list -1 --first-parent --before=<review start> <branch> --not <base_sha>`), with `git show <snapshot>:<file>` and `git diff <base_sha> <snapshot>`. The subagent did not use later commits to decide a class. It ran no code. The classes are:

- REAL: a real defect at the stated severity.
- REAL-LOWER: a real defect, but its right severity is below the stated one. The right severity is in the table.
- WRONG: the claim is false at the snapshot.

Severity scale given to the classifier: critical = data loss, security breach or crash in normal use; high = wrong result or gate bypass in a likely path; medium = real defect in an edge path or with contained impact; low = cosmetic, diagnostics or process rule. A finding with a right severity of low does not block (blocking = critical, high, medium).

Snapshot selection: the first pick by commit date chose a develop commit that was merged into the branch for tickets 908, 954 and 964. Those rows use the first-parent commit (908: 3b64aeb, 954: 4d001de, 964: 4df3df0). The pick by first parent is not proven for every ticket; it is a rule and not a check against the real reviewer input.

Period A (fids are `review_findings.id`):

| fid | ticket | stated | class | right severity | evidence at the snapshot |
|---|---|---|---|---|---|
| 1313 | VISUAL-LAYOUT-GATES-SKIP-WHEN | medium | REAL | medium | `review.ts:464` passes 'HEAD' when there is no manifest. The diff HEAD..HEAD is empty, so the UI gates are skipped. |
| 1360 | REFACTOR-MOVE-THE-TOP-LEVEL | medium | UNDECIDED | | The moved files import vscode and fall in the `stryker.config.json` mutate glob. Whether the score drops below 85 needs a Stryker run. |
| 1367 | UAT-A-TESTER-RUN-THAT-OBSERVED | medium | REAL-LOWER | low | `testerSkip.ts:29` hardcodes `npm run uat:host:docker`, but the text also offers another route. The re-ask can still succeed. |
| 1377 | TICKET-FORM-B-LAYOUT-SHELL | medium | REAL-LOWER | low | `webview.html:328-362` adds a layout shell to a vanilla view. This breaks a process rule, not runtime behaviour. |
| 1403 | REVAMP-THE-DASHBOARD-ARTIFACTS | medium | REAL-LOWER | low | `overlayStack.ts:242` appends to history with no cap. The entries are small tuples. |
| 1407 | EVAL-REAL-CORE-CONTAINER-RUN | medium | REAL | medium | `entrypoint.sh:9-10` runs the host as root with NET_ADMIN, so the core can flush the output rules while the config says enforced. |
| 1439 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | `bulletinNotes.ts:527-528`: the listed and collapsed counts include host merges. Only text in the agent context is wrong. |
| 1440 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | `listed` ignores wasShown, and `shownEarlier` counts the same notes again. Count and doc drift only. |
| 1464 | TEST-INTEGRATION-SUITES-USE | medium | REAL | medium | `runList.ts:181-183` maps every lease error (EACCES, ENOSPC) to `stopped`, with no debug line and no failed result. |
| 1465 | TEST-INTEGRATION-SUITES-USE | medium | REAL | medium | `portSlots.ts:85-95`: isStale, rmSync, mkdir is not atomic. A second process can delete a fresh claim, and both lease the same slot. |
| 1479 | GATES-A-UNIT-INTEGRATION-FAILURE | high | REAL | high | `vitestDrift.mjs:21` keeps only ids with ' > '. An unparsed file-level FAIL plus one drift id exits 0 (`vitestGate.mjs:101`). |
| 1510 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | REAL | medium | `sbxCloneReady.ts:60-77` checks only ref commits, not the dirty tree. A rebuild can delete uncommitted edits. |
| 1511 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | REAL-LOWER | low | The placement part of the claim is wrong (a rebuild must not flip the placement). Only the bridge dir is left. |
| 1522 | FIX-RESOURCES-TAB-IS-BLIND-TO | medium | REAL-LOWER | low | `containerSampler.ts:104,119` maps exit 127 (no docker) to daemon-down. The result is a false banner. |
| 1531 | FIX-SANDBOX-A-FIX-BRIEF-THAT | high | REAL-LOWER | medium | `fixDeliveryWiring.ts:158` counts a busy session as stuck and claims `pointer_failed_at`. Needs you is raised, so it is a stall, not a wrong result. |

Counts A: REAL 6, REAL-LOWER 8, WRONG 0, UNDECIDED 1. Of the 14 decided findings, 7 have a right severity of low and would not block (1367, 1377, 1403, 1439, 1440, 1511, 1522).

Period C and the Q4 verdict are in block [@issue:RB-08].

END_DOC_BLOCK: [@issue:RB-05]

## [@issue:RB-08] Q4: sample C and verdict

Period C. Method and classes are in [@issue:RB-05]. Two rows (1733, 1793) belong to the other project (mobile-app, iOS). Their code is in the repo `tatto-timer`, and the snapshot is the last first-parent commit of the ticket branch there before the review start.

| fid | ticket | snapshot | stated | class | right severity | evidence at the snapshot |
|---|---|---|---|---|---|---|
| 1673 | FIX-SBX-SANDBOXES-HAVE-NO-MEMORY | 4d001de | high | REAL-LOWER | medium | `memoryQueue.ts:78`: list, claim and requeue have no project filter. It needs two project windows and low memory. |
| 1702 | FIX-A-TICKET-START-THAT-DOES-NOT | 05982716 | medium | REAL | medium | `startOutcome.ts:108` calls `markNotStarted` on timeout, and no `sessions.isOpen` exit comes before it. |
| 1733 | FIX-RESET-TIMER-RETURNS-TO-THE | 7c9199b | high | REAL | high | `HomePage.vue:469-480` `handleResume` pushes the result page from the in-memory COMPLETED state after a reset. |
| 1773 | FIX-SANDBOX-TOKEN-USAGE-AND | 56f535cc | high | REAL-LOWER | medium | `extension.ts:5927` sweep uses plain stat and read on a bridge path. It needs a hostile agent, and the result is a metering DoS. |
| 1774 | FIX-SANDBOX-TOKEN-USAGE-AND | 56f535cc | medium | REAL | medium | `sbx create` runs inside the 180 s bounded step. A `.catch` does not stop a hang. |
| 1793 | CI-LAND-THE-CI-WORKFLOW-FROM-PR | b9e55b2 | medium | REAL | medium | `release-ios.yml:105-131` goes from archive to export and upload without the scene checks that the local script runs. |
| 1809 | PERF-LIMIT-PARALLEL-LOAD-IN-SBX | 4df3df0 | high | REAL-LOWER | medium | `sbxRunner.ts:217` calls `limitArgs()` with no nodeOptions, so the heap flag replaces the guest NODE_OPTIONS. It needs an existing value. |
| 1820 | FIX-AGENTS-THE-FINDINGS-OUTPUT | de30b6ad | high | REAL-LOWER | medium | `tester.ts:405-464`: the silence, wrap-up and reformat nudges still demand the JSON array. Re-ask path only. |
| 1904 | TEST-BRIDGE-A-CONFORMANCE-TEST | cb14dc8f | medium | REAL-LOWER | low | The conformance scanner misses `fs.chmod` through the namespace form. No file uses it now, so it is a ratchet gap. |
| 1910 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | 814a665e | high | REAL | high | `setAutopilotOverride`, `approveOneMore` and `stopAutopilot` have no non-test caller, but the ticket requires the host commands. |
| 1911 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | 814a665e | high | REAL-LOWER | medium | Only the store reads `stopped_reason` and `paused_reason`. The ticket requires the amber Needs you block. The note still shows the reason. |
| 2046 | FIX-THE-MCP-ARTIFACT-TOOL-ALWAYS | d398193f | medium | REAL-LOWER | low | `command.test.ts:28` asserts only not-unknown-command. A wrong route throws a different error and passes. Test gap. |
| 2059 | FIX-THE-EXTENSION-TS-RATCHET | 0fc08895 | medium | REAL-LOWER | low | `ratchet.test.ts:368` `console.info` is hidden by the vitest `silent: 'passed-only'` setting. Diagnostics only. |
| 2063 | FIX-WORKTREES-AND-THE-GIT | e46fc6cc | high | REAL | high | `cloneSyncClass.ts:44-46` sets an empty bundle range when the tip is an ancestor, and git refuses it. The state is reachable. |
| 2075 | FIX-A-TICKET-READS-NEEDS-YOU | 8fa12eb9 | high | REAL-LOWER | medium | `dispatch.ts:746` `markActivity` runs for every non-Stop event. The bridge forwards no `notification_type`, so `idle_prompt` clears the quiet state. The medium-period re-read ([@issue:RB-10]) sets the right severity to medium. |

Counts C: REAL 6, REAL-LOWER 9, WRONG 0, UNDECIDED 0. Four rows depend on runtime behaviour that the classifier did not run (1733, 1774, 2063, 2075).

Comparison (MEASURED, sample of 15 per period, 29 decided):

| Measure | A | C |
|---|---|---|
| Decided findings | 14 | 15 |
| REAL | 6 (43%) | 6 (40%) |
| REAL-LOWER | 8 (57%) | 9 (60%) |
| WRONG | 0 | 0 |
| Stated high, of which REAL | 2, 1 | 9, 3 |
| Right severity low (would not block) | 7 of 14 (50%) | 3 of 15 (20%) |

Q4 verdict: MEASURED. No sampled finding is wrong: 0 of 29 decided. The upper 95% bound for the wrong rate is about 10% for both periods together and about 20% for each period alone, so a small wrong rate is not excluded. The findings in C are real defects at about the same rate as in A (40% against 43% at the stated severity). About half of the findings in both periods are rated above their right severity, and 6 of the 9 stated highs in C are medium at most. The sample gives no sign that C has more false or low-value findings. A has more findings that would not block at their right severity (50% against 20%). So on this sample the rise in blocks is not noise. A lower `blockingSeverity` would hide real defects of medium right severity: 8 of the 15 C findings are real at medium or higher.

Limits: one subagent per period classified the rows, by reading code only, with the severity scale in [@issue:RB-05]. Snapshots follow a rule and are not proven to be the reviewer input. 1360 is UNDECIDED. Samples are small: 14 and 15 of pools of 19 and 45. The C pool is 45 and the sample is a third of it. The classifier saw the stated severity of each finding, so it may be anchored.

END_DOC_BLOCK: [@issue:RB-08]

## [@issue:RB-06] Q5: missed bugs

Cohort: tickets of the period with a validated review run (A 70, C 38). Tickets that never passed review are not in the cohort. A text match finds later tickets that name the key, the PR number or the parent ticket of the earlier ticket. The study read the title of each later ticket. It did not verify that the later ticket fixes a defect of the earlier ticket.

| Measure | A | C |
|---|---|---|
| Later tickets that reference a ticket of the period (distinct) | 7 | 5 (7 matches; ticket 966 matches 3 times) |
| Of these, tickets with a `fix` title | 5 | 3 |
| Of these, other tickets (`test`, `perf`, `ci`) | 2 | 2 |
| Fix-titled later tickets per ticket of the cohort | 5 of 70 (7%) | 3 of 38 (8%) |
| Ship or CI failure after review pass | 1 | 0 |
| Recovery rounds with source stage `ship` | 0 | 0 |

Fix-titled later tickets in A: 880, 870, 876, 993, 910. In C: 959, 985, 993. Ticket 993 references one ticket in A (892) and one in C (987), so it is in both lists. Some C references use PR numbers of another repository (iOS). `karst stats` shows 0 follow-ups for escaped defects, which is not a usable signal. The C tickets are 1 to 2 days old.

Verdict: no decision. MEASURED: the fix-titled follow-up rate is 7% in A and 8% in C. The text match does not verify the defect origin, C had 1 to 2 days to show follow-ups, and the counts are small.

END_DOC_BLOCK: [@issue:RB-06]

## [@issue:RB-07] Proposals for a person

1. Record the Claude Code version and the review effort in `process_runs` for each review. Today the version is found only in transcripts, and the effort is not recorded where a free query can reach it.
2. Decide the review effort in the preset by cost and stall rate. No decision is stated here. Do not lower `blockingSeverity` now: Q4 shows that the extra C findings are real defects (0 of 29 wrong, 8 of 15 real at medium or higher), and the medium-period sample ([@issue:RB-10]) does not show that low would miss them either. A severity calibration change (about half of the findings are rated above their right severity in both periods) is a separate question for a person.

END_DOC_BLOCK: [@issue:RB-07]

## [@issue:RB-09] Correction: review effort, run medians and replays

Correction of RB-01 and RB-04. The first version of this report read `.karst/karst.yml`, found `effort: low` for the review lane, and inferred that the lane effort may have changed on Nov 6, with `medium` in 7 or 8 runs. That reading is wrong about the active setting. The active preset is Claude Code MAX, whose review lane is `review: claude-opus-5-5, effort: medium`. The reviewer session transcripts show `medium` for all karst-reviewer Opus sessions after Nov 6 11:39 UTC: 84 sessions on Nov 6, counted over all rounds. The report figure counts first reviews only, so the two counts describe the same switch. It is not known why the sessions switched at that time. The switch affects part of C only, so it does not explain the Nov 2 step or the Nov 5 step.

Runs table. Cohort: all review runs, model claude-opus-5-5, project 1 (extention). Each message is counted one time, by message id.

| Period | Effort | Median output tokens | Blocked | Blocking findings per run | Runs |
|---|---|---|---|---|---|
| Oct 27 to Nov 3 | low | about 1,800 | 24% | 0.31 | 172 |
| Nov 5 to Nov 6 11:39 UTC | low | about 5,500 to 7,700 | 58% | 1.14 | 84 |
| Nov 6 11:39 UTC and later | medium | about 16,700 | 72% | 1.76 | 83 |

Source: store `process_runs` and `review_findings`, with message usage deduplicated by message id from the transcripts under `~/.claude/projects/<worktree>/<uuid>.jsonl`; the run counts in all three rows come from planning session P17, which read the store and the transcripts. Limit: these rows include repeat rounds, and the medium row has more of them than the low rows. The rows are therefore NOT a controlled comparison of effort; the medium row also mixes in the Nov 5 to 6 period effects named in RB-01.

The report has no token median: the Q3 token rows are means per run, so the same-message-twice correction does not change them. The median above counts each message once.

Replays. The same 5 merged diffs (the review sessions of Nov 3, at `low`) ran again on 2026-11-06 and 2026-11-07 with the stored prompts, `effort: low`, one run each. Columns: original transcript / Claude Code 2.1.317 / 2.1.319 / 2.1.319 with a clean configuration (no user settings, hooks, plugins, skills, MCP servers or project CLAUDE.md). Output tokens:

| Ticket | Original | 2.1.317 | 2.1.319 | 2.1.319, clean config |
|---|---|---|---|---|
| 941 | 3,461 | 11,910 | 10,561 | 13,034 |
| 945 | 3,178 | 10,814 | 7,241 | 8,278 |
| 947 | 1,550 | 5,997 | 5,297 | 9,337 |
| 948 | 1,042 | 7,285 | 5,388 | 7,786 |
| 950 | 1,686 | 7,354 | 6,313 | 6,359 |

The original value comes from the transcript, deduplicated by message id. The replay values come from the CLI result usage.

Conclusion (estimate): the rise at `low` on Nov 5 does not come from the Claude Code version or from the local configuration. Both CLI versions reproduce the higher output on the Nov 3 diffs, and a clean configuration reproduces it at least as strongly. The source is probably remote, but there is no direct proof (the CLI talks to the API and the study did not observe the server). Most of the replay output is not visible text or tool input, so hidden thinking is a probable part of it.

END_DOC_BLOCK: [@issue:RB-09]

## [@issue:RB-10] Q4: sample of 20 medium-period findings

Sample: seed 20261107, 20 blocking findings, at most 2 per ticket, T995 excluded. Pool: 117 blocking findings in 53 blocking runs on 13 tickets (period: Nov 6 11:39 UTC and later, `effort: medium`). The 20 rows cover 11 tickets. Classes and severity scale are in [@issue:RB-05].

| fid | class | right severity | basis |
|---|---|---|---|
| 2061 | REAL | stated | code at review time |
| 2361 | REAL | stated | code at review time |
| 2010 | REAL | stated | fix commit |
| 2093 | REAL | stated | code at review time |
| 2334 | REAL | stated | code at review time |
| 2266 | REAL | stated | code at review time |
| 2293 | REAL | stated | code at review time |
| 2045 | REAL | stated | code at review time |
| 2058 | REAL | stated | code at review time |
| 2167 | REAL | stated | code at review time |
| 2214 | REAL | stated | fix commit |
| 2343 | REAL | stated | code at review time |
| 2353 | REAL | stated | code at review time |
| 2086 | REAL-LOWER | medium | fix commit |
| 2075 | REAL-LOWER | medium | code at review time |
| 2255 | REAL-LOWER | medium | fix commit |
| 2056 | REAL-LOWER | low | code at review time |
| 2188 | REAL-LOWER | low | code at review time |
| 2304 | REAL-LOWER | low | code at review time |
| 2116 | not a code defect | n/a (stated high) | code at review time |

Counts: REAL at the stated severity 13, REAL-LOWER at medium (still blocks) 3, REAL-LOWER at low (does not block) 3, not a code defect 1. 2116 was stated high: it asks a person to read the CI log, which a diff cannot show, so it is not a code defect.

Limits: one reader classified the findings. The classification used the code at review time where a commit was available, and the fix commit with the finding detail otherwise; no finding was run. For 2010, 2086, 2214 and 2255 the code was not read at review time, and the evidence is the fix commit. Two findings (2093 and 2361) are about code that an earlier fix round added.

Verdict: the sample shows the quality of the medium findings (13 of 20 real at the stated severity, 3 more real at medium). It does not show that `low` would miss them: the study did not run the same diffs at `low`, and the replays in [@issue:RB-09] measure output, not findings. It gives no support for lowering `blockingSeverity`.

END_DOC_BLOCK: [@issue:RB-10]
