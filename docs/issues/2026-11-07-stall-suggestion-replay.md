<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: grep -F "## [@" docs/issues/2026-11-07-stall-suggestion-replay.md
2. EXTRACT A BLOCK: awk '/^## \[@issue:STALL-REPLAY\]/,/END_DOC_BLOCK: \[@issue:STALL-REPLAY\]/' docs/issues/2026-11-07-stall-suggestion-replay.md
-->
# Stall suggestion: replay on stored findings

## [@issue:STALL-REPLAY] The suggestion prompt ran once on four stalled tickets

Date: 2026-11-07. This is a snapshot, not a rule. T1001 ran the `stall-suggestion` prompt once on each ticket, on a copy of the registry. The diff stat was not recorded for these runs, so the prompt read "(not recorded)". T995 is no longer stalled (its review passed and PR #966 is merged). A fixture test covers its recorded shape: `src/ui/dashboard/stateStall.test.ts`, one docs file, 12 review runs, an empty ticket type.

| Ticket | Rounds | Cause (likely) | Recommended option |
| --- | --- | --- | --- |
| T972 | 2 | A restore scope grew to proposal forms, and key ownership came from a non-empty field. | Narrow the proposal restore and fix key ownership once. |
| T973 | 7 | One ticket-level decision served many PR rollup states, and the budget key had no PR number. | One decision function and a PR-level budget key. |
| T990 | 1 | The finding is stale. The fix is merged in #960. | Confirm the merge and stop the loop. |
| T991 | 3 | A guard moved into shared gate code. Review wants a result only the PR can show. #961 is merged. | Close the loop. The work is merged. |

Other options: T972 keep the proposal restore and pin its rules. T973 limit auto-fix to one open PR. T990 replace the excerpt cap with one simple rule. T991 close it and file the flake re-run in a new ticket.

Limit: for T972 the `description` and `acceptanceCheck` of the option replace the full text. The user must read them in "Show what changes" before Apply.
END_DOC_BLOCK: [@issue:STALL-REPLAY]
