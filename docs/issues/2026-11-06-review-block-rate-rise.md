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
- Q2: The ticket mix does not explain it. The rise appears inside the same ticket type.
- Q3: The reviewer input changed. The reviewer prompt text and the model did not change. Claude Code, the loaded user context and the prompt tail did change. The `effort` parameter was `low` in nearly all runs. It was `medium` in 8 runs (1 in A, 7 in C).
- Q4: The findings are mostly correct, with a limit. A later fix is weak evidence, because a blocking finding forces a fix. The classes below rest on the reasons in the sample rows. 29 of 30 sampled findings are real. 1 is wrong. 10 are real but below the stated severity.
- Q5: No evidence that the earlier period missed bugs. The data for Nov 5 and 6 is too young to compare.
- Cause: Not isolated. Two changes fit the timing: (a) Nov 2, the user context change and the new "Intent" section in the prompt tail; (b) Nov 5 12:13, the Claude Code upgrade to 2.1.318, where thinking tokens rose about 12 times at the same `effort: low`. The study cannot separate these causes without a controlled re-run.
- Next step (proposal for a person): run a controlled 2 by 2 re-run of the same 5 diffs from Oct 30 to Nov 1. The two factors are the Claude Code version (2.1.316 and 2.1.319) and the prompt tail (with and without the Intent section), with the same user context. This tests both named causes. Then decide on any prompt or threshold change. Do not lower `blockingSeverity` now.

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

The user figure of 90 tickets in A is higher than 73 here, and the user averages (0.15 to 0.32) differ from the 0.26 here. This study counts only the first review per ticket with claude-opus-5-5. The study did not find the cause of the difference. It stays open. The trend is the same in both counts.

END_DOC_BLOCK: [@issue:RB-02]

## [@issue:RB-03] Q2: ticket mix

Source: merged PR diffs. 6 tickets in C have no merge sha. A merged diff can differ from the reviewed diff. The ticket asks for values per day. This study gives values per period, because a day has 8 to 34 tickets and the per-day values are noisy. The Q1 table has the per-day block rate.

| Measure | A | B | C |
|---|---|---|---|
| Median files changed | 8 | 8 | 7 |
| Median lines changed | 190 | 164 | 256 |
| Mean lines changed | 427 | 330 | 366 |
| Share touching src/extension | 30% | 12% | 30% |
| `fix` tickets | 37 of 73 | n/a | 21 of 41 |
| Blocked, `fix` tickets only | 11% (avg 0.16) | 38% | 48% (avg 0.86) |

Verdict: the size and type mix is almost the same in A and C. The block rate within `fix` tickets rose from 11% to 48%. The mix explains little of the rise.

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
| Prompt tail "Intent" section | 1 of 57 runs | 14 of 35 runs |
| Prompt tail "Ticket description" section | 0 | 5 runs (Nov 6, after #955) |
| Lane `effort` (parameter in the transcript) | `low`; `medium` in 1 run | `low`; `medium` in 7 runs, all Nov 6 |
| Mean output tokens per run | about 1800 | about 6700 |
| Mean thinking tokens per run | about 280 | about 3300 to 4000 |
| Mean cost per run | $0.43 | $0.70 |

The Q3 rows use the 118 runs whose transcript could be matched to a review run (57 of 73 in A, 35 of 41 in C, 26 in B). This study did not find a transcript for the other runs. The study did not check whether the matched runs are a fair sample of all runs.

Block rate by prompt tail: no extra section 25% (n=87), Intent 50% (n=26), Ticket description 100% (n=5). Inside the "no extra section" group the rate still rose: A 20%, B 27%, C 44%.

Block rate by Claude Code version: 2.1.317 about 221 thinking tokens, 33% blocked (n=6); 2.1.318 about 3170 thinking tokens, 65% (n=20); 2.1.319 about 4416, 47% (n=15). The cut-over is clean at run 5759 (Nov 5 12:13).

Other files: `.karst/karst.yml` is untracked, so its history is not available. The file has `effort: low` for the review lane. 7 reviews on Nov 6 ran at `medium`, so the lane effort setting may have changed on Nov 6. This is an inference. It affects 7 of 41 runs in C and cannot explain the rise that began before Nov 6. The repo reviewer definition did not change after Oct 10. Extension version installed: karst.karst-1.0.0 (no change found).

Verdict: the input changed in four ways. The step A to B (21% to 35%) fits the user context change and the Intent section. The step B to C (35% to 54%) fits the Claude Code 2.1.318 upgrade. These are correlations. The causes are confounded.

END_DOC_BLOCK: [@issue:RB-04]

## [@issue:RB-05] Q4: finding sample

Random sample (seed 995) of 15 blocking first-review findings per period. Pool sizes: A 19, C 45. Each finding was checked against the PR history and the merged code. Basis "pre-fix code" means a later commit changed the code after the review. This is weak evidence, because a blocking finding forces a fix. A fix shows only that the finding was acted on. It does not show that the finding was right. The class and the "fits" column rest on the reason the classifier gave from the code, not on the fix alone. The stated-severity check is the weakest part.

Counts A: {'REAL-LOWER': 8, 'REAL': 6, 'WRONG': 1}. Counts C: {'REAL': 13, 'REAL-LOWER': 2}.

Period A:

| fid | ticket | stated | class | fits | basis |
|---|---|---|---|---|---|
| 1367 | UAT-A-TESTER-RUN-THAT-OBSERVED | medium | REAL-LOWER | low | pre-fix code |
| 1439 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | pre-fix code |
| 1440 | FIX-KICKOFF-SAYS-8-UNREAD-NOTES | medium | REAL-LOWER | low | pre-fix code |
| 1403 | REVAMP-THE-DASHBOARD-ARTIFACTS | medium | REAL-LOWER | low | pre-fix code |
| 1465 | TEST-INTEGRATION-SUITES-USE | medium | REAL | medium | pre-fix code |
| 1360 | REFACTOR-MOVE-THE-TOP-LEVEL | medium | REAL | medium | pre-fix code |
| 1313 | VISUAL-LAYOUT-GATES-SKIP-WHEN | medium | REAL | medium | pre-fix code |
| 1407 | EVAL-REAL-CORE-CONTAINER-RUN | medium | REAL | medium | pre-fix code |
| 1531 | FIX-SANDBOX-A-FIX-BRIEF-THAT | high | REAL-LOWER | medium | pre-fix code |
| 1464 | TEST-INTEGRATION-SUITES-USE | medium | REAL-LOWER | low | pre-fix code |
| 1479 | GATES-A-UNIT-INTEGRATION-FAILURE | high | REAL | high | pre-fix code |
| 1510 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | REAL | medium | pre-fix code |
| 1511 | FIX-SBX-SANDBOX-OPENS-WITH-AN | medium | WRONG |  | pre-fix code |
| 1522 | FIX-RESOURCES-TAB-IS-BLIND-TO | medium | REAL-LOWER | low | pre-fix code |
| 1377 | TICKET-FORM-B-LAYOUT-SHELL | medium | REAL-LOWER | low | pre-fix code |

Period C:

| fid | ticket | stated | class | fits | basis |
|---|---|---|---|---|---|
| 1911 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | high | REAL | high | pre-fix code |
| 2059 | FIX-THE-EXTENSION-TS-RATCHET | medium | REAL-LOWER | low | pre-fix code |
| 2063 | FIX-WORKTREES-AND-THE-GIT | high | REAL | high | pre-fix code |
| 1793 | CI-LAND-THE-CI-WORKFLOW-FROM-PR | medium | REAL | medium | pre-fix code |
| 1702 | FIX-A-TICKET-START-THAT-DOES-NOT | medium | REAL | medium | pre-fix code |
| 1809 | PERF-LIMIT-PARALLEL-LOAD-IN-SBX | high | REAL | high | pre-fix code |
| 1773 | FIX-SANDBOX-TOKEN-USAGE-AND | high | REAL | high | pre-fix code |
| 1774 | FIX-SANDBOX-TOKEN-USAGE-AND | medium | REAL | medium | pre-fix code |
| 2046 | FIX-THE-MCP-ARTIFACT-TOOL-ALWAYS | medium | REAL | medium | pre-fix code |
| 1673 | FIX-SBX-SANDBOXES-HAVE-NO-MEMORY | high | REAL | high | pre-fix code |
| 1910 | AUTOPILOT-ENGINE-AUTO-FIX-MERGE | high | REAL | high | pre-fix code |
| 1733 | FIX-RESET-TIMER-RETURNS-TO-THE | high | REAL | high | pre-fix code |
| 1820 | FIX-AGENTS-THE-FINDINGS-OUTPUT | high | REAL | high | pre-fix code |
| 2075 | FIX-A-TICKET-READS-NEEDS-YOU | high | REAL | high | pre-fix code |
| 1904 | TEST-BRIDGE-A-CONFORMANCE-TEST | medium | REAL-LOWER | low | pre-fix code |

Notes: sample A has 1 wrong finding (fid 1511: keeping the placement and the bridge dir is intended). Both samples were classified by one subagent each, so the classes carry classifier bias. Sample A is 79% of its pool.

Verdict: the findings in C are not noisier than in A. In C, 13 of 15 are real at their severity. In A, 6 of 15 are real at their severity and 8 are real but lower. The sample does not show that wrong findings caused the rise in C. Because the fix basis is circular, treat this as low confidence. The comparison of A and C at the stated severity is indicative only.

END_DOC_BLOCK: [@issue:RB-05]

## [@issue:RB-06] Q5: missed bugs

Cohort: tickets whose review passed. A: 72 tickets, all merged. C: 37 tickets, 35 merged.

| Measure | A | C |
|---|---|---|
| Later tickets that mention the key or PR number (fix tickets not separated from other tickets) | 6 | 5 |
| Ship or CI failure after review pass | 1 | 0 |
| Recovery rounds with source stage `ship` | 0 | 0 |

The reference match is crude. Some matches are not fixes. `karst stats` shows 0 follow-ups for escaped defects, which is not a usable signal. The C cohort is 1 to 2 days old.

Verdict: no evidence that A missed bugs. The data can not show whether C finds bugs that A missed.

END_DOC_BLOCK: [@issue:RB-06]

## [@issue:RB-07] Proposals for a person

1. Record the Claude Code version and the lane effort in `process_runs` for each review. Today the version is found only in transcripts.
2. Run the optional controlled re-run (not done here): 5 diffs from Oct 30 to Nov 1, Claude Code 2.1.316 against 2.1.319. Estimate: about $0.43 to $0.70 per run, so about $2 to $4 per arm.
3. Decide on any prompt or `blockingSeverity` change only after step 2 (@arch:PRE-BASELINE). The sample shows the extra findings are mostly real.

END_DOC_BLOCK: [@issue:RB-07]
