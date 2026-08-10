# Dynamic IMPL Graph Runtime — Review 3 (independent)

- **Date:** 2026-08-09T22:49:51Z
- **Model:** claude-opus-5 (Claude Code, single reviewer)
- **Target:** [2026-08-09-dynamic-impl-graph-runtime-design.md](./2026-08-09-dynamic-impl-graph-runtime-design.md)
- **Method:** full read of the design; prior review indexes skimmed only to exclude duplicates. Findings below are ones neither REVIEW nor REVIEW-2 raise.
- **Findings:** 9 (4 High, 3 Medium, 2 Low)

## Verdict

The design is internally coherent and unusually disciplined about trust boundaries — untrusted planner output, closed CLI parsers, capability-authenticated completion, transactional single-winner claiming. Those parts are ready to build against.

Two concerns dominate. First, the design is a second product inside karst — 8 tables, a new CLI surface, a new transport, a scheduler, and a merge engine — and the document never argues the value hypothesis or defines how success would be measured. Second, two review rounds have produced 103 findings, all implementation-level; a third paper review has clearly reached diminishing returns.

Recommendation: resolve the premise-level items below (#1, #3, #5), apply the cheap structural fixes (#2, #6), then start Slices 1–2 and let running code surface the rest.

## High

### H1. The integration engine contradicts karst's own retired-`merge`-stage doctrine

The v25 decision retiring the `merge` stage rests on "a landing is not work karst performs." This design has karst snapshot each node's actual diff and merge N change sets into the canonical ticket worktrees under a physical-repository exclusive lock, with `integration-conflict` as a first-class blocker kind.

That is karst performing landings, just intra-ticket rather than at the PR boundary. The distinction may well be defensible — karst owns both sides of an intra-ticket integration, there is no remote and no teammate, and the conflict is one it created by fanning out. But the document never states it, so the tension will be re-litigated during implementation, probably as a partial retreat that leaves the scheduler half-designed.

**Action:** state the distinction explicitly in Architectural Rationale, or drop isolated-workspace concurrent writers and serialize all writing agents on the canonical worktree (which removes the merge engine, the change-set snapshot protocol, and `integration-conflict` entirely).

### H2. No planner → compiler repair loop

Compilation is strict: fork dominance and join post-dominance, SCC aggregate visit bounds, unknown-field rejection, causal artifact binding, finite-safe-integer range checks, reserved sentinels, contained normalized paths. An LLM emitting a novel JSON schema against that on the first attempt is not a high-probability event.

The only specified path for a rejected graph is `graph-plan-invalid` → recoverable red block → human. The recovery table offers "rerun a new planner run, subject to planner/replan budget" but never says the compiler's structured diagnostics are given to that run. So the default first-run experience of the flagship approach is a red block with a schema error.

**Action:** add a bounded compile-repair loop inside a single `PlannerRun` — 2–3 attempts, structured compiler diagnostics fed back as planner input, each attempt counted against the planner-run ceiling, exhaustion falling through to the existing red block. Cheap, and it changes the first-run posture materially.

### H3. The design destroys prompt caching, and there is no cost model

Every node launches a fresh session with no `--resume`, re-rendering ticket context, the instructions artifact, and declared inputs. Artifacts bound *transcript* growth, which is the stated rationale — but they do not bound *re-sent context*, and a cold session pays full input price where a continued session pays cache-hit price.

Forty cold sessions can plausibly cost more than one long cached session doing the same work. The document asserts the economics ("high-end models at high-leverage nodes, cheaper models for bounded implementation, zero-token deterministic nodes") without a single number, and budgets are expressed purely as run counts and wall time — neither of which is a cost control.

**Action:** produce a worked cost comparison on one representative ticket — single-agent `impl` versus the generated graph — before Slice 3 commits to the executor design. If the graph is materially more expensive for equal outcome, the budget primitives are the wrong control surface and should be reconsidered while it is still cheap to do so.

### H4. Node workspaces are invisible to every existing karst reaper

`removeWorktree`, `stopServersUnder`, `reapStaleServers`, `ensureKarstExcluded` and `KARST_EXCLUDE_RULES` all key on registered `worktrees` rows and the `/.karst/` prefix. A node workspace is a new physical entity — independent working tree, index, HEAD/refs namespace, writable Git metadata — created per node, per repository, per visit, up to `maxParallel` at once.

Karst has already leaked two ~1 GB trees with live processes inside them (869ed2n50), and the response to that was a single removal choke point plus a global activation sweep. Node workspaces sit outside all of it:

- no disk ceiling covers them (`maxAggregateArtifactBytes` is artifacts only);
- no exclude rule makes their contents unstageable;
- no sweep reaps ones left by a dead window;
- `approach_resource_leases` records the lease but not the workspace as a removable physical object;
- teardown on ticket archival / worktree removal is unspecified.

**Action:** give workspaces a registry table with a canonical path, make `removeWorktree` the choke point for their removal as it is for worktrees, add a workspace disk ceiling to the hard-limit list, and add them to the activation reap sweep.

## Medium

### M1. No success criteria and no kill criterion

Product Goals enumerate capabilities, not outcomes. Nothing in the document states how one would tell that a generated graph beat plain single-agent `impl`, nor what result would justify abandoning the approach. For six delivery slices of work, that is the most expensive omission in the document.

**Action:** define the measurement in Slice 1 and record baselines before Slice 3: on N real tickets — implementation wall time, total token cost, count of human interventions, and UAT-pass-on-first-attempt rate, graph versus non-graph.

### M2. Packaged default `maxParallel: 4` ships before Slice 5 enables it

The configuration example and the effective merged V1 shape both show `maxParallel: 4`. Slice 3 mandates `maxParallel: 1`, and Slice 5 states "only here may `maxParallel > 1` be enabled." So the shipped default is untrue for four slices, and any project that inspects effective configuration is told it has parallelism it does not have.

**Action:** packaged default is `1`; Slice 5 raises it to 4 as part of its own change.

### M3. Windows path semantics are committed to without a platform

Validation pins alternate data streams, reserved device names, drive/UNC escapes, trailing dots and spaces, and inconsistent case/Unicode-normalization aliases. Repository evidence is darwin-arm64 only (the `bin/darwin-arm64-140` prebuild path and the whole ABI section). Committing to Windows filesystem semantics with no Windows runtime under test produces a spec claim that no test can honestly discharge.

**Action:** scope the claim to pure-string unit tests over the normalizer with no Windows runtime support asserted, or state that the graph runtime is unsupported on Windows in V1.

## Low

### L1. `karst-graph-node` has no consumer in the runtime spec

Settings ships two stable editable prompt identities, `karst-graph-planner` and `karst-graph-node`. The planner one is wired: the `planner.prompt.artifact` field references it and its hash is frozen per launch. The node one appears nowhere in Artifacts and Context Policy, whose assembly list is ticket context, instructions artifact, declared inputs, evidence, workspace paths, and optional diff — no base prompt.

**Action:** either state where the node base prompt composes in, how it interacts with `instructionsArtifact`, and that its bytes are covered by the frozen prompt hash; or drop the second prompt identity from the package.

### L2. `GatePredicate` cannot inspect command evidence

Escalation is described as "a gate can count repeated command failures or worker visits and route to an `expert` agent node." With the V1 primitives that is only expressible as `node-outcomes(verify, failed, gte, 2)`. There is no predicate over *which* repository failed, over exit codes, or over artifact content — `artifact-exists` is existence only.

Adequate for V1, but the planner prompt will be authored against whatever the document implies is possible.

**Action:** state the limitation next to the primitive list so generated graphs are not written against a capability that does not exist.

## Relationship to prior reviews

The highest-value items already raised remain valid and are not restated here. In particular: REVIEW C1 (a `claimed` token that never reaches `consumed` stalls the scheduler permanently), REVIEW-2 H8 (a lost completion wake-up never reschedules because no periodic coordinator tick is defined), REVIEW-2 H15 (agent self-reported `blocked`/`replan` are the only unvalidated routing outcomes — the one real breach of karst's deterministic-verdict rule), and REVIEW-2 C1 (the graph configuration YAML does not round-trip through the existing manifest pipeline).

Those four plus H1–H4 above are the set worth resolving before implementation planning starts.
