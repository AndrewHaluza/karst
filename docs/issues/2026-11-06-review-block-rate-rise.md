<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/issues/2026-11-06-review-block-rate-rise.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:RB-01'):
  awk "/^## \[@issue:RB-01\]/,/END_DOC_BLOCK: \[@issue:RB-01\]/" docs/issues/2026-11-06-review-block-rate-rise.md
-->
# Review block rate rise, Oct 29 to Nov 6 (T995)

Research only. No prompt, reviewer definition, threshold or setting changed. Data: store `process_runs` + `review_findings`, first review per ticket, model claude-opus-5-5, blocking = critical, high or medium. Review transcripts: `~/.claude/projects/<worktree>/<uuid>.jsonl`.

## [@issue:RB-01] Summary and verdict

- Q1: The rise is real. It holds when UI-only and docs-only tickets are excluded.
- Q2: The ticket mix does not explain the rise. The share of `fix` tickets is 51% in A and 51% in C. With the A mix, the C block rate is still 54%, so the mix explains about 0 of the 33 points of the rise.
- Q3: The reviewer input changed. The reviewer prompt text and the model did not change. Claude Code, the loaded user context and the prompt tail did change. The `effort` parameter was `low` in nearly all runs. It was `medium` in 8 runs (1 in A, 7 in C).
- Q4: The findings are mostly correct, with a limit. A later fix is weak evidence, because a blocking finding forces a fix. The classes below rest on the reasons in the sample rows. 29 of 30 sampled findings are real. 1 is wrong. 10 are real but below the stated severity.
- Q5: No evidence that the earlier period missed bugs. Later fix-titled tickets that reference a ticket of the period: A 5 of 73, C 3 of 41. The reference is a text match, and the defect origin was not verified. C is 1 to 2 days old, so the comparison has little power.
- Store: this report is registered as a research artifact (karst `artifact add`, kind research). The docs file is the same file.
- Cause: Not isolated. Two changes fit the timing: (a) Nov 2, the user context change and the new "Intent" section in the prompt tail; (b) Nov 5 12:13, the Claude Code upgrade to 2.1.318, where thinking tokens rose about 12 times at the same `effort: low`. The study cannot separate these causes without a controlled re-run.
- Next step (proposal for a person, one step): run one controlled 2 by 2 by 2 re-run of the same 5 diffs from Oct 30 to Nov 1. The three factors are the Claude Code version (2.1.316 and 2.1.319), the loaded context (the Oct 30 user and repo CLAUDE.md and the current ones) and the prompt tail (with and without the Intent section). This covers both named causes, and all parts of cause (a). It has 8 cells and 40 runs, about $17 to $28 at $0.43 to $0.70 per run. Then decide on any prompt or threshold change. Do not lower `blockingSeverity` now.

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

Periods: A = Oct 29 to Nov 1 (73 tickets, 21% blocked, 0.26 avg, high 4, medium 15). B = Nov 2 to 3 (26, 35%, 0.50). C = Nov 5 to 6 (41, 54%, 1.10, high 21, medium 24). High findings rose about 5 times.

Second table, without UI-only and docs-only tickets:

| Period | n | Blocked % | Avg blocking |
|---|---|---|---|
| A | 69 | 22% | 0.28 |
| B | 24 | 38% | 0.54 |
| C | 41 | 54% | 1.10 |

The ticket figures (90 tickets, 19% blocked) match Oct 27 to Nov 1 in this table: 91 tickets, 17 blocked (19%), 0.23 average. They do not match Oct 29 to Nov 1, which has 73 tickets. The ticket text names the wrong start day. The daily averages of 0.15 to 0.32 in the ticket match the daily column here (0.11 to 0.29). The difference is small and has no known cause. The trend is the same in both counts.

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
| Blocked, other tickets | 11 of 36 (31%) | 4 of 10 (40%) | 12 of 20 (60%) |

Mix type B: `fix` 16, `feat` 5, `other` 3, `docs` 1, `Eval` 1. The block rate in B is 35% overall.

How much the mix explains: the `fix` share is 51% in A and 51% in C. If C had its own block rates by group (`fix`, other) and the A mix, the C rate would be 54%. The A rate is 21%. The mix explains about 0 of the 33 points of the rise. The mix of B (more `fix` tickets, 62%) gives at most a few points of the A to B step. Larger tickets in C (median lines 256 against 163) are the one mix change in the direction of more findings. The study did not test this. The 11 tickets without a diff limit the size values for C.

Verdict: the mix does not explain the rise. The block rate rose inside both groups.

END_DOC_BLOCK: [@issue:RB-03]

## [@issue:RB-04] Q3: reviewer input

Same in all periods: reviewer prompt text (hash 21e8a7e8), model claude-opus-5-5 and betas (19). The `effort` parameter is `low` in nearly all runs. The exception is in the table below.

| Item | A (Oct 29 to Nov 1) | C (Nov 5 to 6) |
|---|---|---|
| Claude Code version | 2.1.314, 2.1.316 | 2.1.318, 2.1.319 |
| Skills listed | 133 to 141 | 157 |
| Tools | 13 | 14 (Workflow added) |
| System prompt size | 5474 chars | 7437 chars |
| User CLAUDE.md loaded | 47 of 57 runs: none; others: older versions | All runs: writing-style rule (changed setting: writing-style rule) |
| Session-start hook output | present in some runs | absent |
| Repo CLAUDE.md | 12.5K to 12.6K chars | 12.6K chars (hash changed, size same) |
| Repo CLAUDE.md change of Nov 2 (ab9d723c15f) | loaded before the change in the runs before Nov 2 19:06 | loaded after the change in all runs |
| Prompt tail "Intent" section | 1 of 57 runs | 14 of 35 runs |
| Prompt tail "Ticket description" section | 0 | 5 runs (Nov 6, after #955) |
| Lane `effort` (parameter in the transcript) | `low`; `medium` in 1 run | `low`; `medium` in 7 runs, all Nov 6 |
| Mean output tokens per run | about 1800 | about 6700 |
| Mean thinking tokens per run | about 280 | about 3300 to 4000 |
| Mean cost per run | $0.43 | $0.70 |

The Q3 rows use the 118 runs whose transcript could be matched to a review run (57 of 73 in A, 35 of 41 in C, 26 in B). This study did not find a transcript for the other runs. The study did not check whether the matched runs are a fair sample of all runs.

Repo CLAUDE.md change ab9d723c15f (2 lines): it added one rule (a gate passes only when its exact command exits 0 in the ticket worktree). It removed the file-size guide and the "do not overengineer" guidance. Size is the same. The removed guidance could make the reviewer less lenient about extra code. This is a hypothesis. The study did not test it. The step B to C also loaded the same repo file in all runs (hash ebf53bc7), so this change cannot explain the step from B to C.

Block rate by prompt tail: no extra section 25% (n=87), Intent 50% (n=26), Ticket description 100% (n=5). The Ticket description group is only 5 runs and gives no reliable rate. Inside the "no extra section" group the rate still rose: A 20%, B 27%, C 44%.

Block rate by Claude Code version: 2.1.317 about 221 thinking tokens, 33% blocked (n=6); 2.1.318 about 3170 thinking tokens, 65% (n=20); 2.1.319 about 4416, 47% (n=15). These n are small. The 95% interval of each rate is wide (more than 30 points). The 2.1.319 rate is lower than the 2.1.318 rate, so the thinking tokens alone do not predict the block rate. The cut-over is clean at run 5759 (Nov 5 12:13).

Other files: `.karst/karst.yml` is untracked, so its history is not available. The file has `effort: low` for the review lane. 7 reviews on Nov 6 ran at `medium`, so the lane effort setting may have changed on Nov 6. This is an inference. It affects 7 of 41 runs in C and cannot explain the rise that began before Nov 6. The repo reviewer definition did not change after Oct 10. Extension version installed: karst.karst-1.0.0 (no change found).

Verdict: the input changed in four ways. The step A to B (21% to 35%) fits the user context change and the Intent section. The step B to C (35% to 54%) fits the Claude Code 2.1.318 upgrade. These are correlations. The causes are confounded.

END_DOC_BLOCK: [@issue:RB-04]

## [@issue:RB-05] Q4: finding sample

Random sample (seed 995) of 15 blocking first-review findings per period. Pool sizes: A 19, C 45. Each finding was checked against the PR history and the merged code. The "reason" column is the classifier's evidence from the code and the PR history. Basis "pre-fix code" means a later commit changed the code after the review. This is weak evidence, because a blocking finding forces a fix. A fix shows only that the finding was acted on. It does not show that the finding was right. The class and the "fits" column rest on the reason the classifier gave from the code, not on the fix alone. The stated-severity check is the weakest part.

Counts A: {'REAL-LOWER': 8, 'REAL': 6, 'WRONG': 1}. Counts C: {'REAL': 13, 'REAL-LOWER': 2}.

Period A:

| fid | ticket | stated | class | fits | reason |
|---|---|---|---|---|---|
| 1367 | UAT-A-TESTER-RUN-THAT-OBSERVED | medium | REAL-LOWER | low | reaskPrefix hardcoded karst's uat:host:docker (testerSkip.ts new file); fixed in PR #825 3rd commit 're-ask prompt names no karst-only script'. Harm is only a wasted re-ask; the park outcome would occur anyway. |
| 1439 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | contextNoteIndex listed=unreadNotesFor but collapsed still counted same host merges (bulletinNotes.ts:527); fixed in ab7f6a1f3 (11:16, after review 11:07). Only a wrong count in a kickoff note. |
| 1440 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | listed came from unreadNotesFor ignoring wasShown, so shown notes re-listed; fixed in ab7f6a1f3 (titles skip shownIds). Extra context noise, not a correctness break. |
| 1403 | REVAMP-THE-DASHBOARD-ARTIFACTS | medium | REAL-LOWER | low | history grew unbounded and persisted; fixed in 12401e5f3 (MAX_HISTORY=50, sameView compare) 10 min after review start. Bounded growth of small state; Back-walk UX issue. |
| 1465 | TEST-INTEGRATION-SUITES-USE | medium | REAL | medium | tryClaim isStale->rm->mkdir non-atomic; fixed in 82c1385f1 'serialise stale reclaim' (reclaim.lock mutex in portSlots.ts reclaimStale) 3 min after review start. Narrow race, real port collision. |
| 1360 | REFACTOR-MOVE-THE-TOP-LEVEL | medium | REAL | medium | Moved vscode-importing modules fell under src/extension/** mutate glob; PR commit bea0c77a8 (14:50, after review 14:46) added the excludes in stryker.config.json to fix it. Gate failure was real. |
| 1313 | VISUAL-LAYOUT-GATES-SKIP-WHEN | medium | REAL | medium | No-manifest base ref 'HEAD' gives empty diff so UI gates skip; fixed in 522335de5 'keep UI gates when there is no manifest base ref' (review.ts:462 now guards on opts.manifest) 7 min after review start. |
| 1407 | EVAL-REAL-CORE-CONTAINER-RUN | medium | REAL | medium | NET_ADMIN kept in the root host shell; fixed in 685e67d0f 'drop NET_ADMIN' (eval-lockdown.sh:49 setpriv --no-new-privs --bounding-set=-net_admin,...) 4 min after review start. |
| 1531 | FIX-SANDBOX-A-FIX-BRIEF-THAT | high | REAL-LOWER | medium | escalateUnsendable claimed pointer_failed_at for merely busy sessions and stopped delivery; fixed in b25e079ce 'keep sending after the Needs you escalation' 15 min after review. A Needs-you was raised, so stall is not silent. |
| 1464 | TEST-INTEGRATION-SUITES-USE | medium | REAL-LOWER | low | catch{} mapped any lease error to 'stopped' in runList.ts; fixed in 82c1385f1 'surface lease errors'. Needs EACCES/ENOSPC on tmpdir lock dir; only diagnostics lost. |
| 1479 | GATES-A-UNIT-INTEGRATION-FAILURE | high | REAL | high | failingTestIds skips file-level FAILs; judge could pass drift with an unparsed file failure. Fixed in d5e892e03 (allFailuresParsed in vitestDrift.mjs, used at vitestGate.mjs judge) 2 min after review start. Gate false pass. |
| 1510 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | REAL | medium | assertRebuildSafe checked only refs, not working tree; fixed in 8edb03134 'sandbox rebuild refuses a dirty sandbox working tree' (DIRTY_CHECK in sbxCloneReady.ts) 10 min after review. Data loss of uncommitted edits. |
| 1511 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | WRONG |  | rebuild intentionally keeps placement and bridge dir because the next Open AI Session recreates the sandbox; disposeSandboxOp has no controls() check either. Final sandboxSyncOps.ts:427 unchanged; no fix commit addressed it. |
| 1522 | FIX-RESOURCES-TAB-IS-BLIND-TO | medium | REAL-LOWER | low | sampleContainers mapped docker ENOENT (127) to daemon-down so non-docker hosts saw a banner; fixed in a662e3fce 'no docker is not degraded' (NOT_INSTALLED/no-docker) 4 min after review. Cosmetic false warning. |
| 1377 | TICKET-FORM-B-LAYOUT-SHELL | medium | REAL-LOWER | low | Ticket form is vanilla and the diff adds a layout feature, against the CLAUDE.md UI rule; resolved by docs commit 62cfb954e recording T862 exception ('review finding'). Process-rule violation, no runtime defect. |

Period C and the Q4 verdict are in block [@issue:RB-08].

END_DOC_BLOCK: [@issue:RB-05]

## [@issue:RB-08] Q4: sample C and verdict

Period C:

| fid | ticket | stated | class | fits | reason |
|---|---|---|---|---|---|
| 1911 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | high | REAL | high | Fixed by later PR-branch commit 5b680978757 "autopilot parks show the amber block"; first commit 814a665e2cf lacked it. |
| 2059 | FIX-THE-EXTENSION-TS-RATCHET | medium | REAL-LOWER | low | Observability only. Fixed by df6f2efec25: console.info replaced by writeSync to fd 1 because vitest hides passing-test console output. |
| 2063 | FIX-WORKTREES-AND-THE-GIT | high | REAL | high | Fixed by 2deeb5f9a02 "thin bundle works when the clone is behind a host commit" on the ticket branch (PR 959 still open); first commit e46fc6cc131 lacked it. |
| 1793 | CI-LAND-THE-CI-WORKFLOW-FROM-PR | medium | REAL | medium | release-ios.yml at cf39b500 (pre-review state) had no check-ios-scene/archive steps; commit 915ef598 "harden the release workflows after review" added both. |
| 1702 | FIX-A-TICKET-START-THAT-DOES-NOT | medium | REAL | medium | Original timeout path called markNotStarted unconditionally; later PR commit 15:18 "not-started never overwrites a live session" added isOpen/agentState guards (startOutcome.ts markNotStarted). |
| 1809 | PERF-LIMIT-PARALLEL-LOAD-IN-SBX | high | REAL | high | Gate sbx exec replaced NODE_OPTIONS; later PR 936 commit "gates extend the guest NODE_OPTIONS" / "session extends guest NODE_OPTIONS" (sbxRunner.ts:250) fixed it. |
| 1773 | FIX-SANDBOX-TOKEN-USAGE-AND | high | REAL | high | Sweep used plain stat/readFile; PR 929 commit "harden the sandbox transcript read" added claudeTranscriptRead.ts with O_NOFOLLOW/O_NONBLOCK, regular-file and size check. |
| 1774 | FIX-SANDBOX-TOKEN-USAGE-AND | medium | REAL | medium | Link ran inside the 180 s bounded step; PR 929 later moved it outside the launch limit and added TRANSCRIPT_LINK_TIMEOUT_MS (sbxRunner.ts:111). |
| 2046 | FIX-THE-MCP-ARTIFACT-TOOL-ALWAYS | medium | REAL | medium | Test asserted only not-unknown-command; PR 956 second commit "test exact routes" added per-verb handler-message assertions (command.test.ts describe async verbs). |
| 1673 | FIX-SBX-SANDBOXES-HAVE-NO-MEMORY | high | REAL | high | Queue reads were unscoped; PR 926 commit 3 "scope the memory queue to its project" added projectId filters (memoryQueue.ts:69,94). |
| 1910 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | high | REAL | high | Fixed by 5b680978757 "add host commands" on the ticket branch after the first commit 814a665e2cf; in the stated diff no command bound these operations. |
| 1733 | FIX-RESET-TIMER-RETURNS-TO-THE | high | REAL | high | PR 15 second commit (after review start) "keep onboarding on screen when the app resumes after a reset" fixed the stale HomePage timer state. |
| 1820 | FIX-AGENTS-THE-FINDINGS-OUTPUT | high | REAL | high | PR 935 commit "tester re-ask nudges follow" the output form was added after the first commit; nudges were form-independent in the first diff. |
| 2075 | FIX-A-TICKET-READS-NEEDS-YOU | high | REAL | high | Fixed by baf116640f2: markActivity now runs only when nextAgentState(payload) !== null; test "no-signal Notification does not cancel the deadline flip" added (PR 958 open). |
| 1904 | TEST-BRIDGE-A-CONFORMANCE-TEST | medium | REAL-LOWER | low | Scanner gap is real (fixed by PR 942 commit 2 for promises imports) but no file in scope uses the form; latent gap in a test guard only. |

Notes: sample A has 1 wrong finding (fid 1511: keeping the placement and the bridge dir is intended). Each sample was classified by one subagent, so the classes carry classifier bias. Sample A is 79% of its pool. 26 of 30 reasons cite a later fix or a later change. These classes are weak for that reason.

Verdict: the findings in C are not noisier than in A. In C, 13 of 15 are real at their severity. In A, 6 of 15 are real at their severity and 8 are real but lower. The sample does not show that wrong findings caused the rise in C. Because the fix basis is circular, treat this as low confidence. The comparison of A and C at the stated severity is indicative only.

END_DOC_BLOCK: [@issue:RB-08]

## [@issue:RB-06] Q5: missed bugs

Cohort: all first-review tickets of the period (A 73, C 41). A text match finds later tickets that name the key, the PR number or the parent ticket of the earlier ticket. The study read the title of each later ticket. It did not verify that the later ticket fixes a defect of the earlier ticket.

| Measure | A | C |
|---|---|---|
| Later tickets that reference a ticket of the period (distinct) | 7 | 5 (7 matches; ticket 966 matches 3 times) |
| Of these, tickets with a `fix` title | 5 | 3 |
| Of these, other tickets (`test`, `perf`, `ci`) | 2 | 2 |
| Fix-titled later tickets per ticket of the period | 5 of 73 (7%) | 3 of 41 (7%) |
| Ship or CI failure after review pass | 1 | 0 |
| Recovery rounds with source stage `ship` | 0 | 0 |

Fix-titled later tickets in A: 880, 870, 876, 993, 910. In C: 959, 985, 993. Ticket 993 references one ticket in A (892) and one in C (987), so it is in both lists. Some C references use PR numbers of another repository (iOS). `karst stats` shows 0 follow-ups for escaped defects, which is not a usable signal. The C tickets are 1 to 2 days old.

Verdict: no evidence that A missed bugs. The fix-titled follow-up rate is 7% in both periods. The comparison has little power, because C had 1 to 2 days to show follow-ups and the counts are small.

END_DOC_BLOCK: [@issue:RB-06]

## [@issue:RB-07] Proposals for a person

1. Record the Claude Code version and the lane effort in `process_runs` for each review. Today the version is found only in transcripts.
2. Run one controlled 2 by 2 by 2 re-run (not done here): 5 diffs from Oct 30 to Nov 1. Factors: Claude Code 2.1.316 against 2.1.319; Oct 30 user and repo CLAUDE.md against the current ones; prompt tail with and without the Intent section. This covers both named causes and every part of cause (a). Estimate: 8 cells, 40 runs, about $0.43 to $0.70 per run, so about $17 to $28 in total.
3. Decide on any prompt or `blockingSeverity` change only after step 2 (@arch:PRE-BASELINE). The sample shows the extra findings are mostly real.

END_DOC_BLOCK: [@issue:RB-07]
