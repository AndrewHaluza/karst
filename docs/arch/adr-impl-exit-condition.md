# ADR: Deterministic exit condition for impl stage

**Status:** CLOSED — no change to the invariant.  
**Date:** 2026-09-08  
**Ticket:** PROMPT-14-IMPL-EXIT-CONDITION

## Context

Karst has two kinds of stage, and only one can be inconsistent:

| Stage | Decided by | Consistency |
|---|---|---|
| uat, review, ship | gate exit codes | 100% by construction |
| impl, fix | agent voluntarily firing a marker | unenforced |

Every stage-following consistency problem lives at the impl/fix boundary. The invariant being evaluated:

> **impl→uat is an explicit marker, never inferred from the Stop hook**  
> — `docs/arch/stages-and-gates.md`

This invariant exists because a session ends for many reasons that are not completion: crash, user interrupt, context limit, unanswered question. Infer "done" from "stopped" and every one of those advances the ticket.

## Measurement

Ticket 05 (PROMPT-05-EFFECTIVENESS-TELEMETRY) established a marker compliance baseline against the shared Cursor registry (schema v56, 443 tickets, 12 projects):

| Metric | Value |
|---|---|
| **Marker compliance rate** | **0.952** (315 passed / 331 finished) |
| Sessions ended silent (interrupted) | 16 |
| Sessions ended stale | 0 |
| Sessions still running | 9 (excluded from denominator) |

**Compliance is high.** 95.2% of impl/fix sessions fire the done marker. The remaining 4.8% (16 sessions) ended `interrupted` — likely crashes or user interrupts — which is exactly the population the invariant is designed to protect against.

## Ticket 15 dependency

The prompt references ticket 15 ("makes a forgotten marker distinguishable from a pending question using hook data karst already receives and discards"). **Ticket 15 does not exist in the codebase** — the series jumps from 14 to 17. This ADR cannot be gated on a ticket that was never created. The measurement from ticket 05 is sufficient.

## Options evaluated

### 1. Do nothing beyond ticket 15 — RECOMMENDED

With 95.2% compliance, the gap is too small to justify amending a binding invariant. The 16 silent sessions are the exact population the invariant protects (crashes, interrupts, context limits). Closing this ticket with the measurement recorded is the correct outcome.

**Decision: Adopt this option.**

### 2. Session-end nudge — no invariant change

A nudge at Stop ("session ending, stage unmarked — if done, run X") would cost one turn of tokens per firing and address the 4.8% gap without changing the invariant. However:

- The gap is small enough that the cost may exceed the benefit
- Without ticket 15's signal, the nudge would fire on every Stop, including genuine crashes/interrupts where the agent cannot respond
- The nudge is not justified until the numbers show the boundary is actually leaking at a higher rate

**Decision: Defer.** Re-evaluate if compliance drops below 0.90.

### 3. Fire marker on detected denial — invariant question

Firing the marker when the agent attempts it but is sandbox-blocked is arguably evidence, not inference. But it means trusting parsed agent tool calls to move a stage, and tool content is agent-authored input. This creates a new class of invariant violation (parsed agent text advancing state) without addressing the core problem (sessions that end silently).

**Decision: Reject.** The mechanism does not match the failure mode.

### 4. Deterministic exit condition for impl — speculative gates

Run uat gates speculatively: gates green + session ended = impl was done. The marker degrades from sole mechanism to optimization.

This is the strongest option mechanically but:

- It requires the uat gate scripts to be runnable at impl completion time (may not be ready)
- It conflates "gates pass" with "implementation is done" (a gate may pass on incomplete work that happens to compile)
- The invariant's reason remains valid: session ending alone decides nothing; the 95.2% compliance shows the current mechanism works
- Amending a binding invariant requires the problem to be measured, not theorized

**Decision: Reject.** Not justified at 95.2% compliance.

## Decision

**CLOSE this ticket.** The marker compliance baseline of 0.952 is high. The 4.8% gap is the population the invariant protects against (crashes, interrupts), not evidence of leakage. No change to the `impl→uat is an explicit marker, never inferred from the Stop hook` invariant.

Re-evaluate if:
- Compliance drops below 0.90 (measured quarterly via `karst stats --prompts`)
- Ticket 15 is created and its signal shows a non-trivial "forgotten marker" population
- The speculative-gates option (4) can be gated on session-close evidence without requiring agent cooperation

## References

- `docs/arch/stages-and-gates.md` — the invariant
- `docs/arch/prompt-metrics.md` — the baseline (marker compliance: 0.952)
- `src/store/promptTelemetryQuery.ts` — `queryMarkerCompliance()` implementation
- Ticket 05 (PROMPT-05-EFFECTIVENESS-TELEMETRY) — baseline source
