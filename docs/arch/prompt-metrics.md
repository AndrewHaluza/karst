# Prompt-effectiveness telemetry

Karst tunes prompts by intuition and has never measured whether one works. This
doc fixes the vocabulary: what is instrumented, where each number is read from,
and the committed baseline every later ticket in the Prompt-Engineering series
(06–12) cites. The telemetry itself already existed — `gate_runs`, process runs,
`node_runs`, `tokenUsage`, `stages.attempt` — it was simply never read as a prompt
signal. Related: `docs/arch/agent-cores.md` (the seams instrumented here),
`docs/arch/stages-and-gates.md` (the append-only evidence path),
`docs/arch/store-and-schema.md` (the v57 column + new-column checklist),
`docs/arch/cli.md` (the `guide` verb's argv-only content path).

## Contents

- Nothing in 06–12 tunes prompt wording before this baseline
- The metric set and where each number is read
- Storage: one `prompt_telemetry` blob, one late-fact setter, no new writer
- The guide-pull rate gates ticket 12
- Committed baseline — whole Cursor store (443 tickets, 12 projects)
- `karst stats --prompts` is a read over `queryPromptMetrics`

## Nothing in 06–12 tunes prompt wording before this baseline

The accumulated defensive wording in the tree (five stacked negations in
`workflow/agentScope.ts`'s orientation block, for example) is scar tissue from
bugs nobody could measure before or after. **Rewriting wording without a baseline
repeats exactly the mistake that produced the current state.** So: no ticket in
06–12 tunes prompt text until the table below exists in the code, and no ticket
re-tunes a metric it has not re-read from `queryPromptMetrics` since the last
change. This is a review gate, not a suggestion.

## The metric set and where each number is read

Recorded by the seams instrumented in ticket 05. "Source" is the stored evidence;
the value is DERIVED, never self-reported — an agent's claim about its own output
is never a metric input.

| Metric | Source (stored evidence) | Reads | Instrumented at |
|---|---|---|---|
| marker compliance rate | `process_runs` `session`/`fix` closure: `passed` vs `interrupted`/`stale` | % of impl/fix sessions that fired the marker vs ended silent | read-only (pre-existing) |
| silent-turn rate | existing needs-you detection (#320/#321) | prompt failing to elicit any output | read-only (pre-existing) |
| findings parse-failure rate | `process_runs(prompt_telemetry).parseTiers` on the `review` run | how often the salvage parser fell back, and to which tier (whole-doc → fenced → balanced) | `review/findings.ts` → `findingsLane.ts` |
| tester re-ask rate | `process_runs(prompt_telemetry).silenceNudges` on the `tester` run | `TESTER_SILENCE_NUDGE` fire count — output-contract compliance | `uat/tester.ts` |
| tester reformat-nudge rate | `process_runs(prompt_telemetry).reformatNudges` on the `tester` run | reformat-nudge fire count, kept SEPARATE from `silenceNudges` — how often a target answered in prose and needed a reshape (UAT-19); this is the rate the park's rollback trigger below reads | `uat/tester.ts` |
| wrong-checkout stop rate | `uat_findings` where `title LIKE 'UAT skipped: checkout is on%'` | orientation-block effectiveness | read-only (pre-existing) |
| **guide-pull rate, per core** | `process_runs('guide-pull')` pulls ÷ `process_runs('session')` seeded with the pointer | **gates ticket 12 — see below** | `cli/guideTelemetry.ts` + launch env |
| seed size | `process_runs(prompt_telemetry).seedChars` on the `session` run | budget baseline for ticket 08 | `agent/seed.ts` (`measureSeed`) → launch intent |
| fix-loop depth | `stages.attempt` on `fix` | did the fix brief actually work | read-only (pre-existing) |
| tokens per stage-pass | `token_usage` joined to passed `process_runs`, grouped by `provider` | cost per unit of progress, per core | read-only (pre-existing) |

The guide pointer's PRESENCE (`guidePointer` true) is the guide-pull DENOMINATOR:
a session seeded with the pointer is one whose agent was invited to run `karst
guide`. It is recorded per launch, and a `resume`/`switch` seed that carries no
pointer correctly contributes no denominator — that asymmetry is the whole
measurement, so it is measured, never assumed.

## Storage: one `prompt_telemetry` blob, one late-fact setter, no new writer

Every new fact rides the existing `openProcessRun` append-only evidence path
(schema v57, `docs/arch/store-and-schema.md`). `process_runs.prompt_telemetry` is a
single nullable JSON column — one column, not one-per-metric, because these facts
are read together as one rollup and never filtered per-metric in SQL. `openProcessRun`
remains the only opener; the findings tier and the tester nudge count (known only
AFTER their calls finish) merge onto the run through `setProcessRunPromptTelemetry`,
which carries the same single-late-fact allowance as `setProcessRunResultKind`. A
guide pull is its OWN attributed row (`process_id='guide-pull'`), never a mutation
of the session's row. NULL telemetry means never recorded — it is NEVER backfilled,
because a prompt-effectiveness baseline read out of invented numbers is the exact
mistake this exists to stop.

The metric ENGINE is `store/promptTelemetryQuery.ts` (`queryPromptMetrics`), a
vscode-free read over the shared registry, project-scoped. The host-agnostic seams
that emit (`findings.ts`) take an INJECTED callback and never import a store or
logger; the seams that already own a `Store` (`tester.ts`, the CLI `guide` verb)
write through the existing path. The `karst guide` command stays argv-only for its
CONTENT — attribution is a best-effort side effect at the `cli/main.ts` boundary
that can never block or corrupt the text the agent came to read.

## The guide-pull rate gates ticket 12

Karst already ships exactly one progressively-disclosed document: `karst guide`,
deliberately designed that way (it "costs ~40 tokens and saves the agent from
reading the extension's dist/" — 869edmcme). The pointer rides every fresh seed via
`renderGuideInstruction`. **Nobody had ever measured whether an agent runs it.**
This single number decides ticket 12 (progressive disclosure of approach bodies):

- **Pull rate high** → the pattern works; expanding it is justified.
- **Pull rate low** → deferral is a silent-drop mechanism on this codebase. Ticket
  12 becomes "compress the resident core" instead of "move content out". Do not
  scale a mechanism that is not working.

It is broken down **per core** (`claude` / `codex` / `opencode` / `antigravity`):
discovery and instruction-following differ, and a pattern that works on one may
not on the others. Grouped by `process_runs.provider`, the immutable identity
snapshot captured at launch.

## Committed baseline — whole Cursor store (443 tickets, 12 projects)

Read 2026-09-07 against the shared Cursor registry
(`globalStorage/karst.karst/karst.db`) at schema v56, via read-only `node:sqlite`.
Re-derive with `queryPromptMetrics(store, null)`; the throwaway that produced these
was deleted so a machine-specific path never ships into `dist/`.

### Ticket-text distribution (chars) — cites ticket 08 and ticket 11

| field | avg | p50 | p90 | max |
|---|---|---|---|---|
| description | 6,215 | 430 | 2,683 | **1,174,592** |
| brief | 2,317 | 0 | 999 | 148,974 |
| title | 41 | 38 | 72 | 122 |

The distribution is extremely long-tailed: the median ticket contributes ~110
tokens of description while the max is ~294k tokens — larger than any model's
context window. The tail is pasted machine output, not prose (ticket 11 removes it
at ingest). Tickets with description over 8k chars: 12; over 100k: 2. This table
is the RESIDENT-ticket-text floor; the `seedChars` metric below measures the
COMPOSED seed (context + approach method + guide + marker) and is distinct.

### Derivable prompt-effectiveness metrics (existing evidence)

| Metric | Baseline |
|---|---|
| marker compliance rate | **0.952** — 315 `session`/`fix` runs closed `passed` (marker fired) vs 16 `interrupted` (ended silent), 0 `stale`, 9 still running |
| fix-loop depth (`stages.attempt` on `fix`) | **0** across all 444 fix stage rows — the fix stage never re-attempts (each fix is a fresh recovery round, not an attempt bump). Flagged: the attempt-based reading is uninformative on this registry; a later ticket must redefine depth over `recovery_rounds`/`fix` runs or retire the metric. |
| wrong-checkout stop rate | **0** deterministic "UAT skipped: checkout is on" observations historically |
| tokens per passed run — opencode | **990,216** avg over 788 passed runs |
| tokens per passed run — codex | **3,053,096** avg over 15 |
| tokens per passed run — claude | **6,108,373** avg over 134 |
| tokens per passed run — antigravity | **16,736,314** over 1 (single-run, not a rate) |

The per-core cost spread (opencode ≈ 0.16× claude's tokens-per-pass) is the
"cost per unit of progress" baseline ticket 09's budgeting cites.

### Newly-instrumented metrics — PENDING

| Metric | State at this baseline |
|---|---|
| seed size (`seedChars`) | **0 rows** — the `prompt_telemetry` column did not exist pre-v57. Begins at the first post-ship launch. |
| findings parse-tier | **pending** — same reason. |
| tester re-ask rate | **pending** — same reason. |
| tester reformat-nudge rate | **pending** — same reason; also the UAT-19 park's rollback trigger, below. |
| **guide-pull rate, per core** | **0 pulls ÷ 0 seeded = pending** — never recorded, and the denominator column is absent pre-v57. |

Every newly-instrumented metric has **zero historical rows because it was never
measured** — that is the honest baseline, and it is exactly why this ticket exists.
The pre-instrumentation numbers (marker compliance, tokens-per-pass, ticket-text
distribution) are real and committed above; the post-instrumentation ones become
real the first session after this ships.

## UAT-19's park rollback trigger

UAT-19 turned the UAT stage's response to an all-unreadable Tester answer from a
PASS into a PARK — a stop, across every core, on a single observed run (ticket 451)
with the underlying rate genuinely **unmeasured**: `parseTiers` and `silenceNudges`
both read zero rows at this baseline, and `reformatNudges` (added by UAT-19) starts
at zero too. This is a real decision made without the rate that would normally
justify it — recorded here so the reversal condition is legible later rather than
re-litigated from scratch.

**Read `reformatNudges` ÷ tester runs, per core (`queryPromptMetrics` /
`karst stats --prompts`), after enough post-ship UAT runs to be a rate, not a
handful of anecdotes.** A reading worth acting on: one core's tester answers
unreadably (needs the reformat nudge) at a rate visibly higher than the others', OR
the reformat nudge itself frequently fails to recover a reformattable answer (a
second unreadable shape after the nudge, which the park then correctly catches, but
at a rate suggesting the PROMPT is unclear rather than the core misbehaving).

**Fallback: revert the park to advisory** (the pre-UAT-19 warn-and-continue in
`workflow/stages/uat.ts`) for the affected core, or globally if the rate is
uniformly high — never tune the reformat nudge's wording first per the baseline
rule above (no ticket tunes prompt wording before reading the metric it would be
tuning against). Do not ship a partial "P" fix — a probabilistic reformat-then-park
half-measure — in place of one of those two: either the park stands because the
rate shows it is catching genuine formatting failures rarely enough to be worth the
stop, or it is reverted because the rate shows it is not.

## The guide-pull gate, restated for ticket 12

Ticket 12 is explicitly BLOCKED until the per-core guide-pull rate is KNOWN. It is
not "high" or "low" yet — it is **pending**, because it was never measured and the
storage to measure it lands in this ticket. So ticket 12 stays blocked until at
least one post-ship session per core produces a nonzero seeded-vs-pulled
denominator. Do not scale progressive disclosure of approach bodies until the one
progressively-disclosed document karst already ships is proven to be pulled.

## `karst stats --prompts` is a read over `queryPromptMetrics`

The surface lands in ticket 433 (which owns the `karst stats` CLI); this ticket
provides the data layer so 433 only wires argv and formats. Both the baseline and
`--prompts` call `queryPromptMetrics(store, projectId)` — one read path, so the
committed table and the live view can never drift apart. A metric with no rows
renders as "pending", never as 0, from `queryPromptMetrics`' NULL discipline.
