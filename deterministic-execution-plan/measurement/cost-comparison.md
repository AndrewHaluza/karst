# Slice-3 Entry-Gate Cost Comparison — single-agent `impl` vs the generated graph

> Status: **worked estimate**, not measurement. This document satisfies the
> Slice-3 entry gate named in
> `deterministic-execution-plan/03-slice-3-…md` (line 3) and the design's
> Premise and Measurement, Cost model obligation
> (`docs/superpowers/specs/2026-08-09-dynamic-impl-graph-runtime-design.md`,
> §Premise and Measurement).
>
> **Provenance:** the remediation record
> (`docs/plans/2026-08-10-graph-runtime-review-remediation.md`, "Cost model",
> line 929, and line 983) assigned this deliverable to "Task 16, item 2" of the
> pre-restructure roadmap. The restructured roadmap
> (`deterministic-execution-plan/00-ROADMAP.md`) kept the entry gate but
> dropped the producing task — the Slice-1 half survived as Slice-1 T8
> (`measurement/baseline.md`), the comparison did not. It is produced here by
> the executor at the principal's direction so the gate can be evaluated.
> Every graph-side figure is a **model estimate with stated assumptions**;
> the real evaluation is the post-Slice-3 measurement (Slice-3 T12) which runs
> the identical baseline queries on graph-approach tickets. Nothing in this
> document can substitute for that measurement, and the abandonment criterion
> of the design applies to it unchanged.
>
> Recorded: 2026-08-12. Supersedes nothing; superseded by
> `deterministic-execution-plan/measurement/post-slice-3.md` (Slice-3 T12).

## The representative ticket

`CLOSE-TICKET-WITH-DONE-TERMINALS` ("Close ticket with done terminals") —
chosen because it is the exact **median** of the Slice-1 baseline on
implementation wall time (19.8 min of the five recorded tickets) and
near-median on total tokens (122,721 of the five), and its task shape
(a bounded close-out: verify terminal state, confirm, summarize) is the shape
a generated graph maps onto naturally. Its single-agent record is the
**measured** single-agent side, from `measurement/baseline.md` (recorded
2026-08-11 against the real registry):

| Metric | Single-agent (measured) |
|---|---|
| Implementation wall time | 19.8 min |
| Total token cost | 122,721 |
| Human interventions (fix rounds) | 1 |
| UAT-pass-on-first-attempt | no (1 failed uat gate, attempt 1) |

## The generated-graph side — model and assumptions

The graph runtime does not exist yet, so its figures are an explicit model
built from the design's own cost-model premises: every node launches a fresh
session with no `--resume` (cached-prefix reuse is deliberately given up), and
artifacts bound transcript growth but **not** re-sent context (declared input
artifact instances are re-sent to every consuming node).

**Assumed topology for this ticket** (the planner's choice; stated so the
arithmetic is checkable — a 3-node linear graph):

```
entry → A(agent: inventory + verify done terminals) → B(gate: allowlisted
verification command) → C(agent: finalize close-out summary) → join → END
```

**Per-invocation token model** (inputs are what re-sent context costs):

| Invocation | Input composition (assumed) | Input | Output | Total |
|---|---|---|---|---|
| planner run (effort `high`, Decision 10) | ticket context ~12K + base prompt ~6K + instructions ~4K + repo state ~8K | 30K | 4K | 34K |
| agent node A | ticket context 12K (re-sent) + node base prompt 3K + instructions 2K + declared input artifacts 3K | 20K | 4K | 24K |
| gate node B | none — exit codes only, zero tokens | 0 | 0 | 0 |
| agent node C | ticket context 12K (re-sent) + node base prompt 3K + instructions 2K + input artifact (A's output) 3K | 20K | 4K | 24K |
| join | none | 0 | 0 | 0 |
| **Graph total** | | **70K** | **12K** | **82K** |

Wall time: planner ~3 min + A ~5 min + B ~0.5 min + C ~5 min ≈ **13.5 min**
serial (Slice 3 runs at `maxParallel: 1`).

## Comparison (four metrics, same definitions as the baseline)

| Metric | Single-agent (measured) | Graph (modeled) | Delta |
|---|---|---|---|
| Implementation wall time | 19.8 min | ≈ 13.5 min | ≈ −32% |
| Total token cost | 122,721 | ≈ 82,000 | ≈ −33% |
| Human interventions | 1 fix round | 0–1 (gate failure → deterministic block → graph-aware Resume) | parity |
| UAT-pass-on-first-attempt | no (failed 1 uat gate) | predicted yes (gate evidence is deterministic exit codes) | better |

## Sensitivity — where the estimate flips

The binding quantity is **agent-node count**, not wall time or run counts
alone: each agent node adds ~24K tokens (its fresh re-sent context + output).
A topology with **4 agent nodes → ≈ 130K** (parity with single-agent);
**5 agent nodes → ≈ 154K** (~26% more). The same holds for large declared
input artifacts: a node whose inputs total 20K instead of 3K costs ~44K.

This is the honest finding the comparison exists to surface: the design's
budgets are expressed as run counts and wall time (`maxNodeRuns`, `maxVisits`,
`maxExpertRuns`), and the cost model says those are the **right** control
surface for this representative ticket *provided the planner stays within
~4 agent nodes and input artifacts stay small* — both of which the compiler's
per-node `maxVisits`, the project `maxNodeRuns` ceiling, and the artifact
size bounds already constrain. The case that would break the model (wide
fan-out to many agent nodes, or large artifact inputs re-sent wholesale) is
exactly the case the post-Slice-3 measurement must watch for on real tickets.

## Decision-rule application (design, Premise and Measurement)

> "If the graph costs materially more for an equal outcome, budgets expressed
> as run counts and wall time are the wrong control surface, and the budget
> primitives are revisited before Slice 3 ships."

The modeled graph does **not** cost materially more for an equal outcome — it
models at or below the measured single-agent cost for the representative
ticket, and the failure mode (node-count blow-up) is already bounded by
compile-time ceilings that the entry gate's "revisit" would only tighten.
**Conclusion: the budget primitives stand; Slice 3 proceeds.** The real
verdict is deferred to the post-Slice-3 measurement on real tickets, per the
design's success and abandonment criteria.
