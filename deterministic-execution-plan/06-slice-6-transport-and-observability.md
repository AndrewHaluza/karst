# Slice 6 — Optional Transport and Observability Extensions

**Entry gate:** Slice 5 exit gate holds.
**Ships:** an optional ACP transport where a core supports it, per-invocation interactive usage reporting, and structured diagnostics with richer graph projection.

**Binding constraint for the whole slice:** it changes **no scheduler semantics**. A diff to `coordinator/claim.ts`, `conflicts.ts`, `lineage.ts`, `replan.ts`, or the marker guard in this slice is a defect unless a task below names it explicitly (none does).

## Task 1 — ACP as an optional preferred transport

**Files:** `src/approaches/graph/transport/acpTransport.ts` + tests.

**Changes:** ACP implements the same `AgentTransport` interface and is selected only when the core supports it. It may launch, stream, request permissions, cancel, and report lifecycle for **one host-selected node run**. It may **not** generate or mutate topology, activate edges, choose destinations, delegate graph work to peers, supply canonical outcomes outside the guarded completion protocol, or replace artifacts as the inter-node communication contract.

An ACP `session-ended` event maps to **termination evidence only, never to an outcome**. ACP endpoints must be loopback-bound with no remote callback addresses. V1 does not require ACP: a core without it keeps `SupervisedCLITransport`.

**Tests (RED first):** an ACP session's end does not produce an outcome; a peer-delegation attempt is refused; a non-loopback ACP endpoint is refused; the same outcome/routing boundary tests that pass for `SupervisedCLITransport` pass unchanged for ACP.

## Task 2 — Per-invocation interactive usage reporting

**Files:** `src/ui/usage/*`, `src/store/tokenUsage.ts` queries (+ tests).

**Changes:** break graph spend down per invocation in the usage UI, rolling up to profile by **joining through the node/planner run** — the resolved profile is recorded on the run, and no `token_usage` column is added for it. Aggregation stays SQL `GROUP BY` off the existing indexes, never an in-memory rollup. A transport that cannot report usage still records `unknown`, never a fabricated zero. An invalid usage query returns a **named error**, never an empty table that would read as "you spent nothing".

**Tests (RED first):** a graph run's spend rolls up per profile through the join; `unknown` renders as unknown and never as 0; an invalid query is a named error.

## Task 3 — Structured diagnostics

**Files:** `src/approaches/graph/diagnostics.ts`, `src/logging/logger.ts` call sites (+ tests).

**Changes:** bounded structured diagnostics keyed by project, ticket, stage attempt, graph, revision, planner/node run, and generation, over the closed event categories already covered at V1 — compile, claim, defer, launch, completion rejection, integration, recovery, replan, block, close.

Debug logging follows the repository's rules exactly: `logger.debug()` behind the `debug` gate; module prefixes `[graph]` for the coordinator, `[graph:node]` for executors, reusing `[agent:<name>]` and `[runtime]` where those modules already own the line; host-agnostic modules receive `debug` as an **injected callback**, never by importing the logger; entry, decision branch, and exit points each carry a line. **Never logged:** secrets, capabilities, tokens, full prompts (redact to `<prompt:<n> chars>`), repository contents. Untrusted CLI/agent prose is bounded before it reaches a debug line and still passes the standard redaction pipeline at capture.

Inside's "Copy diagnostic" / "Open log" never include completion capabilities, prompt/completion text, secrets, or unredacted command output.

**Tests (RED first):** every closed category emits with its full key set; a capability, a prompt body, and a secret-shaped value are each absent from every emitted line; an injected-debug module does not import the logger (import-graph test); diagnostics are bounded under an adversarially long agent reason.

## Task 4 — Richer graph projection

**Files:** `src/model/inside/graph.ts`, `src/ui/dashboard/webview.html` (+ tests).

**Changes:** the node/edge list or compact diagram showing active, ready, resource-waiting, completed, blocked, stale, and cancelled nodes; selected edge/outcome and replan lineage; provider/model/effort/profile per invocation; visit counts and budgets; artifacts and deterministic command evidence; the explicit serialization reason; per-node overrides for `ready`/`blocked`/`failed-to-launch` agent nodes before claiming; confirmation and resume controls.

The projection stays a **pure function of persisted rows** and defines no routing. Product composition (a graph diagram) is allowed and stays local, unprefixed classes — it must not re-create an existing semantic primitive under another name (UI-R07/R08). Every graph-derived string is escaped through the one audited escaper; ANSI/control sequences and unsafe link schemes are stripped; the webview CSP stays authoritative; contrast is verified in light, dark, and high contrast (UI-R29).

**Tests (RED first):** the injection fixture renders escaped at every new surface; the projection is pure; an override control is absent for an active node and present for a blocked one.

## Slice verification

```bash
npm run typecheck
npm test
git diff --stat <slice-5-tag>..HEAD -- src/approaches/graph/coordinator src/workflow/graphMarkerGuard.ts
```

Expected: full suite green; the coordinator/marker diff is **empty** — this slice adds transport and observability only. `99-INVARIANT-CHECKLIST.md` sections **C**, **F**, **H**, and **K (observability leaks nothing)** pass.
