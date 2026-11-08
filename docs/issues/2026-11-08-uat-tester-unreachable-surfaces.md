<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: grep -F "## [@" docs/issues/2026-11-08-uat-tester-unreachable-surfaces.md
2. EXTRACT A BLOCK: awk '/^## \[@issue:UAT-REACH-Q1\]/,/END_DOC_BLOCK: \[@issue:UAT-REACH-Q1\]/' docs/issues/2026-11-08-uat-tester-unreachable-surfaces.md
-->
# UAT Tester: which surfaces it cannot reach

## [@issue:UAT-REACH-SUMMARY] Summary, data window and method

Date: 2026-11-08. This is a snapshot, not a rule. Ticket: T1025. No code, prompt, profile or setting changed.

**Data window.** The last 50 ticket ids, 977 to 1026, in the local store (`$KARST_DB`, opened read-only). 45 of these tickets have a Tester run with a coverage record. The ticket text counted 155 records on 43 tickets for a window of "last 50 tickets". This report counts 141 records on 45 tickets. The window differs, so the totals differ. The trend is the same.

**Labels.** MEASURED means a SQL query on the store gave the number. NOT MEASURED means an estimate or a judgement. The query text is in `[@issue:UAT-REACH-QUERIES]`.

| Question | Label |
|---|---|
| Q1 records by surface | MEASURED (counts). The surface label of each ticket is a manual judgement. |
| Q2 cause per surface | PARTLY MEASURED. Keyword counts on record titles are measured. The cause per surface is read from 9 sampled logs. |
| Q3 observations above info | MEASURED |
| Q4 cost per ticket | MEASURED |
| Q5 work to make surfaces reachable | NOT MEASURED (estimate from code size) |
| Q6 skip rule | NOT MEASURED. The cost of the candidate class is measured. |

**Headline.** 41 of 46 tickets with a Tester run kept no observation above `info`. 5 tickets kept one. The Tester cost 88.6 M tokens, which is 8.7 % of all tokens on these tickets. 61 of 142 runs ended `skipped` and used 25.2 M tokens. The four findings above `info` that mattered came from direct runs of code, not from a probe script.

**Recommended next ticket:** see `[@issue:UAT-REACH-NEXT]`.
END_DOC_BLOCK: [@issue:UAT-REACH-SUMMARY]

## [@issue:UAT-REACH-Q1] Q1 (MEASURED): coverage records by surface

Records: 141 `COVERAGE (reported)` rows on 45 tickets. The table counts each record by the word at the start of its title.

| Surface | Records | Tickets | SKIPPED | NOT RUN | PASS | PARTIAL |
|---|---|---|---|---|---|---|
| agent core / runtime lifecycle | 28 | 5 | 25 | 0 | 2 | 1 |
| ship / CI / autopilot engine | 21 | 8 | 21 | 0 | 0 | 0 |
| webview DOM | 20 | 5 | 16 | 4 | 0 | 0 |
| gate script / CI config | 20 | 8 | 20 | 0 | 0 | 0 |
| review / fix engine | 15 | 6 | 15 | 0 | 0 | 0 |
| CLI / MCP / doctor | 13 | 5 | 7 | 0 | 5 | 1 |
| docs only | 12 | 2 | 11 | 0 | 1 | 0 |
| hook state | 9 | 4 | 8 | 0 | 1 | 0 |
| docker sandbox | 3 | 2 | 3 | 0 | 0 | 0 |
| Total | 141 | 45 | 126 | 4 | 9 | 2 |

Ranking by tickets (the better measure, because one ticket can repeat a record 10 times): ship / CI / autopilot and gate script / CI config tie at 8 tickets. Agent core has the most records, but 3 tickets (T999: 10, T1013: 8, T1005: 5) make 23 of its 28. Ticket T1013 adds no command or UI, so no surface exists for the probe to reach.

END_DOC_BLOCK: [@issue:UAT-REACH-Q1]

## [@issue:UAT-REACH-Q2] Q2 (PARTLY MEASURED): cause per surface

**Title keywords (MEASURED, 126 non-PASS records).** 72 records say "not reachable", "unreachable", "cannot reach", "not observable" or "not applicable". 100 records name the probe, the harness or `uat:host`. Only 1 record names the fixture format. Titles are short, so the logs below decide the cause.

**Logs (sampled).** The store keeps one `agent-tester-ticket-<id>.log` per ticket. It holds the findings text with the reason. Only T1005 keeps the full command echo. The sample: T994, T996, T998, T1004, T1005, T1013, T1018 (full text read), T987 and T1000 (findings read).

| Surface | Main cause | Evidence |
|---|---|---|
| webview DOM | Probe limit | The snapshot holds the last posted message of a webview and no DOM. T1004: "the probe sees only webview messages, not DOM". T998: `snapshot.webviews` was `[]` after `karst.editTicket`, so the form panel did not show in the recorder. The Tester did try. It built a fixture file, ran the command and waited for a message. |
| ship / CI / autopilot engine | Fixture-format limit, then probe limit | T996: the fixture rows cover only `stage_runs`, `process_runs`, `gate_runs` and `recovery_rounds`. There is no PR row, merge check, base head SHA or `autopilot:` manifest block. T1018: the snapshot shows no `gate_runs`, no merge line and no ship panel. In both tickets the Tester ran only a boot smoke. |
| review / fix engine | Fixture-format limit | T994: `fixtureFile.ts` accepts no `review_findings`. A `restart` sweep does not drive `evaluateReviewStall`. The Tester then replayed the pure function with Node and found a real design note on the 15-line window. |
| agent core / runtime lifecycle | Probe limit, then Tester did not try | The probe runs a fake agent core. T1013 has no command or UI for accounts. T999 has 14 of 26 records of the kind "not exercised". T1005 reached PASS with a launch seed, a Docker prelude and a live first turn, in 488 shell commands and 42.4 M tokens. |
| gate script / CI config | Not a probe surface | The change is a script, a workflow file or a test helper. The Tester contract forbids test runners. Direct runs of the gate CLI with stubs on T987 found 2 medium and 4 low findings. |
| docs only | Not a probe surface | T995 and T1003 correctly say "not applicable". The Tester read the artifact and found 5 low findings. |
| hook state | Probe limit (title only) | 5 of 8 non-PASS records say "not reachable". No log was read in detail. NOT MEASURED. |
| CLI / MCP / doctor | None. A direct run works. | T1000 and T1016 gave PASS by running the built CLI on a store copy. The probe is the wrong tool for this surface. |
| docker sandbox | Not sampled | 3 records, 2 tickets. NOT MEASURED. |

**Did the Tester use `--fixture-file`?** The final logs show a custom fixture on T998 (`fx.json`, with the note that `blocked` is not a valid fixture status). T994 and T1004 read the parser or schema and name its limit. T1005 mentions the flag 38 times, but none of its 488 echoed shell commands passes `--fixture-file` (6 commands use `uat:host`). Result: the flag was used at least once and was known on at least 3 tickets. "Tester did not try" is the main cause on no surface except part of agent core (T999). The fixture format is the limit on the ship and review engines. The evidence for the other tickets is the final log only, so this answer is not complete.

**Other causes found in the logs.** The harness failed before any probe on T1004: `verify-build` stopped on the settings bundle budget (391001 bytes against 385024). The `timeout` binary was missing on T1018, T1013. The worktree had no `node_modules` on T994, so no pure function could run with a test runner.
END_DOC_BLOCK: [@issue:UAT-REACH-Q2]

## [@issue:UAT-REACH-Q3] Q3 (MEASURED): runs with an observation above info

5 of 46 tickets kept an observation of severity `low` or higher. One ticket has a `high` and one has a `medium`.

| Ticket | Highest severity | Count | Path |
|---|---|---|---|
| T1000 | high (write command `pause` works in a planning-session env with `--db`) | 1 high, 6 low | Direct run of the built CLI on a store copy. No `uat:host`. |
| T987 | medium (2: layout chain narrowing, ledger-only edit skips the gate) | 2 medium, 4 low | Direct run of the gate CLI and ledger code with stubs. |
| T1005 | low | 3 low | Mixed. 6 `uat:host` commands and direct Docker checks. |
| T995 | low | 4 low | Direct. Read the doc and re-queried the store. |
| T1003 | low | 1 low | Direct. Read the report artifact. |

No run produced a finding above `info` from a `uat:host` probe script alone. The T1000 finding supports the idea that the Tester finds real defects when it reaches the changed code. It reached the code by a direct run. Of the tickets named in the ticket text, T993, T994 and T998 are in this window. They kept no observation above `info`.
END_DOC_BLOCK: [@issue:UAT-REACH-Q3]

## [@issue:UAT-REACH-Q4] Q4 (MEASURED): cost per ticket

Window: tickets 977 and up, 142 Tester runs, 46 tickets. Tokens are `token_usage.total_tokens` with `call_site = 'uat-tester'`. Cache reads are 91 % of the total, so "fresh" tokens (input plus output) are listed apart.

| Measure | Value |
|---|---|
| Tester tokens, all tickets | 88.6 M, which is 8.7 % of 1 013 M tokens on these tickets |
| Mean total tokens per ticket (45 tickets) | 1.97 M (1.05 M without T1005) |
| Median total tokens per ticket | 0.62 M |
| Mean fresh tokens per ticket | 33.9 k |
| Mean run length | 1.7 min (max 13.9 min) |
| Mean Tester time per ticket (sum of runs) | 3.2 min (median 2.2 min, max 57.9 min on T1005) |
| Runs per ticket | 3.1 on average |
| Models | 131 calls on `claude-sonnet-5-5` (41.5 M), 7 on `opencode-go/deepseek-v4.1-flash` (43.6 M), 4 on `claude-opus-5-5` (3.5 M) |

By result kind:

| `result_kind` | Runs | Tokens | Minutes |
|---|---|---|---|
| observed | 80 | 63.4 M | 165.1 |
| skipped | 61 | 25.2 M | 72.2 |
| execution-failed | 1 | 0 | 0.1 |

One run is `running` and 5 are `stale`. They have no end time, so the query leaves them out. An `observed` run can hold only `info` notes such as "host boots with the change", so `observed` does not mean a finding.
END_DOC_BLOCK: [@issue:UAT-REACH-Q4]

## [@issue:UAT-REACH-Q5] Q5 (NOT MEASURED): work to make the top surfaces reachable

Top 2 by the measure "reachable with bounded work": (1) engine state, which joins ship / CI / autopilot (8 tickets, 21 records) and review / fix engine (6 tickets, 15 records), 14 tickets and 36 records in total; (2) webview DOM (5 tickets, 20 records). Agent core ranks first by records, but a fake agent core is the cause, and T1013 has no surface at all. Gate scripts and docs are not probe surfaces. Sizes are estimates from the file sizes: `vscodeProbe.ts` 136 lines, `fixtureFile.ts` 210, `storeEvidence.ts` 21, `seed.ts` 57.

| Option | What changes | Estimate | Risk |
|---|---|---|---|
| A. Fixture rows for engine state | Add `prs`, `merge_checks`, `review_findings` to the allowed `rows` in `fixtureFile.ts` and `seed.ts`, with an `autopilot:` block in the scratch manifest. Add a test per table. | S to M: 1 to 2 days | Seed rows alone may not start the engine. T994 says `restart` does not run the review stall guard. Ship and conflict rounds need a `GhRunner` fake. |
| B. Snapshot fields for engine state | Add `gateRuns`, `processRuns`, `reviewFindings`, `mergeChecks` to `readTickets` in `storeEvidence.ts`. Keep the output byte-identical for the same input. | S: under 1 day | None. It is the read side of A and helps T1018 on its own. |
| C. Driver step for an engine round | A `step` type that calls the review or conflict round with a faked agent and `GhRunner`. | L: 3 to 5 days | Needs design. The faked core must return controlled findings with file and line. |
| D. Webview DOM read in the snapshot | Wrap the webview HTML on `createWebviewPanel` and `resolveWebviewView` with a script that serialises `document.body` and posts it back as a `dom` message. The script must patch `acquireVsCodeApi` before the app loads, because `app/main.tsx` owns the single call. Record the last DOM per panel. | M: 2 to 3 days | The webview is an iframe, so the extension host cannot read it. The wrapper must stay behind `KARST_UAT_PROBE=1` (`gating.test.ts`). T998 shows that `karst.editTicket` did not open a recorded panel, so a first step is to find why. |
| E. Click and input steps for a webview | `click`, `type` steps that post into the iframe. | M to L, after D | Needs D first. |
| F. Jsdom render outside VS Code | Render the webview in jsdom or Playwright with the visual-gate fixtures. | NOT NEEDED for the probe | The visual and integration gates already cover this ground, as the Testers say. |

Order: B, then A, then D. B and A cover 14 tickets. D covers 5 tickets, and the visual and jsdom gates already cover its DOM in part.
END_DOC_BLOCK: [@issue:UAT-REACH-Q5]

## [@issue:UAT-REACH-Q6] Q6 (NOT MEASURED): skip the Tester when no scenario is reachable?

**The host has the tool already.** `onSkip` (`[@arch:UAT-OBS-RUNS]`) can `reask` or `reask-then-park` after a skip. This reacts after the cost. It does not avoid it.

**Cost of a never-reachable class (MEASURED).** Docs-only (2 tickets, 12 records) and gate script / CI config (8 tickets, 20 records) took 10.1 M tokens and 38.4 minutes of Tester time. That is 11 % of the Tester tokens in the window.

**The class is not worthless.** Both classes gave findings above `info` through direct runs: T987 (2 medium, 4 low) and T995, T1003 (5 low). A path rule that skips all of them would lose T987.

**Proposed signal (not built).** The host can compute, before the run, a deterministic reachability label from the changed paths and the probe surface list:

1. If every changed path is under `docs/**`, skip the Tester and record `COVERAGE: NOT RUN (host: docs-only diff)`. This holds 2 tickets and loses 5 low findings in the window.
2. If a changed path is under `src/ui/**`, or in a file that registers a VS Code command, mark the run "probe-reachable".
3. For every other diff, let the Tester run but tell it in the prompt that the probe cannot reach the surface and that a direct run is the expected path. This matches the finding of Q3.

A rule of this kind decides on file paths. It cannot know whether an acceptance scenario is reachable, because that needs the content of the scenario. NOT MEASURED: how well a path rule predicts a SKIPPED record. A test on the 141 records and the diff of each ticket can measure it.

**Answer.** Do not skip by path now. The data does not show a class where the Tester gives no value. A skip rule for docs-only diffs is possible but small (3.4 M tokens in 50 tickets).
END_DOC_BLOCK: [@issue:UAT-REACH-Q6]

## [@issue:UAT-REACH-NEXT] Recommended next ticket

**One ticket: "UAT host: let a fixture seed engine state and let the snapshot show it".** Scope: options B and A of Q5, in this order.

1. Add `gateRuns`, `processRuns`, `reviewFindings` and `mergeChecks` to the probe snapshot (`storeEvidence.ts`).
2. Add `prs`, `merge_checks` and `review_findings` rows and an `autopilot:` manifest block to `--fixture-file`.
3. Done when: a fixture file reproduces the T996 conflict state (an open PR, a `conflicted` merge check, a base head SHA) and the T994 review history (several blocking rounds with file and line), and the snapshot shows the stored rows after a `restart`.

Why this one: it covers 14 tickets and 36 records, the most of any bounded option. The sampled Testers on T994, T996 and T1018 each named the missing rows as the cause. It costs less than a DOM read (D). The first step can fail: seed rows may not start the engine, so the ticket must end with a check on T994 and T996 first and stop if the engine does not run.

**Follow-up tickets, not in this recommendation:** a DOM read (option D) after a check of why `karst.editTicket` shows no panel on T998; a reachability hint in the Tester prompt (Q6, step 3); a re-run of this measurement after the change, with the queries below.
END_DOC_BLOCK: [@issue:UAT-REACH-NEXT]

## [@issue:UAT-REACH-QUERIES] Queries for each number

Run each with `sqlite3 -readonly "$KARST_DB"`. Tables: `uat_findings`, `process_runs`, `token_usage`, `tickets`.

```sql
-- Surface map (manual judgement, from ticket title and record text)
create temp table surf(tid integer, surface text);
insert into surf values
 (998,'webview DOM'),(1004,'webview DOM'),(1011,'webview DOM'),(1014,'webview DOM'),(1015,'webview DOM'),
 (978,'review/fix engine'),(988,'review/fix engine'),(994,'review/fix engine'),(1001,'review/fix engine'),(1010,'review/fix engine'),(1008,'review/fix engine'),
 (977,'hook state'),(983,'hook state'),(984,'hook state'),(993,'hook state'),
 (979,'ship/CI/autopilot engine'),(985,'ship/CI/autopilot engine'),(990,'ship/CI/autopilot engine'),(996,'ship/CI/autopilot engine'),
 (1007,'ship/CI/autopilot engine'),(1018,'ship/CI/autopilot engine'),(1019,'ship/CI/autopilot engine'),(1023,'ship/CI/autopilot engine'),
 (981,'gate script / CI config'),(982,'gate script / CI config'),(986,'gate script / CI config'),(987,'gate script / CI config'),
 (991,'gate script / CI config'),(992,'gate script / CI config'),(1020,'gate script / CI config'),(1022,'gate script / CI config'),
 (980,'CLI / MCP / doctor'),(989,'CLI / MCP / doctor'),(1000,'CLI / MCP / doctor'),(1002,'CLI / MCP / doctor'),(1016,'CLI / MCP / doctor'),
 (999,'agent core / runtime lifecycle'),(1005,'agent core / runtime lifecycle'),(1009,'agent core / runtime lifecycle'),
 (1012,'agent core / runtime lifecycle'),(1013,'agent core / runtime lifecycle'),
 (1006,'docker sandbox'),(1017,'docker sandbox'),(995,'docs only'),(1003,'docs only');

-- Q1: records, tickets and verdict per surface (last 50 ticket ids)
select s.surface, count(*) records, count(distinct f.ticket_id) tickets,
  sum(f.title like 'COVERAGE (reported): SKIPPED%') skipped, sum(f.title like 'COVERAGE (reported): NOT RUN%') notrun,
  sum(f.title like 'COVERAGE (reported): PASS%') pass, sum(f.title like 'COVERAGE (reported): PARTIAL%') partial
from uat_findings f join surf s on s.tid = f.ticket_id
where f.title like 'COVERAGE (reported)%' and f.ticket_id in (select id from tickets order by id desc limit 50)
group by 1 order by 2 desc;

-- Q1: total records and tickets (141 and 45)
select count(*), count(distinct ticket_id) from uat_findings f join surf s on s.tid = f.ticket_id where f.title like 'COVERAGE (reported)%';

-- Q2: title keywords, non-PASS records (72 "unreachable"; 100 name probe/harness; 1 names fixture)
select sum(title like '%not reachable%' or title like '%unreachable%' or title like '%cannot reach%'
        or title like '%not observable%' or title like '%could not reach%' or title like '%not applicable%'),
       sum(title like '%uat:host%' or title like '%probe%' or title like '%harness%'),
       sum(title like '%fixture%')
from uat_findings where title like 'COVERAGE (reported)%' and ticket_id >= 977;

-- Q3: runs with a finding above info, with their coverage record
select f.process_run_id, f.ticket_id, f.severity, f.title from uat_findings f
where f.ticket_id >= 977 and f.severity in ('low','medium','high','critical') order by f.ticket_id, f.id;

-- Q3: tickets with no finding above info (41 of 46)
select count(*) from (select ticket_id from process_runs where process_id = 'tester' and ticket_id >= 977 group by 1)
where ticket_id not in (select ticket_id from uat_findings where severity in ('low','medium','high','critical') and ticket_id >= 977);

-- Q4: tokens per ticket, mean total and fresh
select round(avg(tot)), round(avg(fr)) from (select ticket_id, sum(total_tokens) tot, sum(input_tokens + output_tokens) fr
  from token_usage where call_site = 'uat-tester' and ticket_id >= 977 group by 1);

-- Q4: minutes per ticket (mean 3.2, median 2.2)
select round(avg(m), 1) from (select ticket_id, sum((julianday(ended_at) - julianday(started_at)) * 1440) m
  from process_runs where process_id = 'tester' and ticket_id >= 977 and ended_at is not null group by 1);

-- Q4: by result kind
select p.result_kind, count(*), round(sum(u.total_tokens) / 1e6, 1), round(sum((julianday(p.ended_at) - julianday(p.started_at)) * 1440), 1)
from process_runs p left join (select process_run_id, sum(total_tokens) total_tokens from token_usage group by 1) u on u.process_run_id = p.id
where p.process_id = 'tester' and p.ticket_id >= 977 and p.ended_at is not null group by 1;

-- Q4: share of all tokens (8.7 %)
select round(100.0 * (select sum(total_tokens) from token_usage where call_site = 'uat-tester' and ticket_id >= 977)
  / (select sum(total_tokens) from token_usage where ticket_id >= 977), 1);
```

Logs for Q2 and the fixture check: `grep -c -- '--fixture-file' "$(dirname "$KARST_DB")"/artifacts/<id>/agent-tester-ticket-<id>.log`. Echoed commands (lines that start with `$ `) exist only in the T1005 log.

Known limits: the surface map is manual. Only the last Tester log per ticket is kept, so an earlier run on the same ticket can hide.
END_DOC_BLOCK: [@issue:UAT-REACH-QUERIES]
