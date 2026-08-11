# Graph Engineering

The karst built-in IMPL approach: plan first, then execute the ticket's work as
a generated, compiled, supervised graph of nodes (agent sessions, trusted
commands, deterministic gates, structured joins) instead of one open-ended
agent session.

## How it works

1. **Bootstrap planner.** A fixed planner session (expert profile) researches
   the ticket and the repositories in scope, writes the plan and bounded task
   artifacts, and produces `graph.json` — the generated execution topology.
2. **Compile.** karst parses and validates `graph.json` with a strict compiler:
   unknown fields are rejected, every identifier is checked against a bounded
   grammar, every budget is a finite safe integer in range, and topology rules
   (join dominance, visit bounds, expert budget arithmetic) are enforced.
   A rejected document is returned to the same planner run with structured
   diagnostics, up to three compile attempts total.
3. **Execute.** Nodes run under karst's supervision — agent nodes in isolated
   workspaces, command nodes against the project's trusted allowlist,
   deterministic gate/join nodes as pure scheduler logic. Outcomes choose
   trusted edges; nothing advances without a deterministic signal.
4. **Finish.** When the graph reaches END, the ticket is parked at
   `completed-awaiting-impl-marker` and karst presents the guarded IMPL pass
   action for explicit confirmation.

## When to use

Tickets whose implementation splits into parallelizable, verifiable pieces —
independent repositories, separable concerns, or work that benefits from
deterministic verification gates between stages. Not for trivial single-file
changes, which the simpler single-session approaches handle with less
overhead.

## Configuration

The packaged defaults ship disabled (`enabled: false`). Enable the approach in
Settings → Approaches, then configure the `graph:` block — planner profile,
execution profiles, the trusted command allowlist, and the budget limits.
Tickets select it on the ticket form; every existing ticket that already uses
it remains runnable.

## Reference

- Planner contract: `skills/graph-planner/SKILL.md`
- Node base prompt: `skills/graph-node/SKILL.md`
