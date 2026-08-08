# Graph-Based IMPL Approach Runtime Design

## Summary

Karst will replace the planned two-phase-specific session handoff with a small, generic graph runtime scoped entirely inside the `impl` ticket stage. The first graph-backed approach is the built-in `karst-two-phase` package:

```text
Research & Plan → Implement → END
```

Karst, not an LLM, owns graph routing. Agent nodes report a bounded outcome for their current node; the scheduler validates durable run ownership, follows trusted compiled edges, and launches the next executor. The runtime spends no AI tokens itself.

The ticket stage machine remains unchanged:

```text
scope → impl → uat → review → fix → ship → done
```

Graph `END` means only that the selected implementation approach finished its internal work. It never creates a ticket-stage verdict or transition. The existing explicit `karst stage impl pass` marker remains the only completion path from `impl`.

## Goals

- Establish the smallest generic graph abstraction that runs a linear two-node approach now without creating a `TwoPhaseRunner` dead end.
- Keep graph execution strictly inside a selected `impl` approach.
- Configure provider, model, and supported effort independently by execution profile and by node.
- Use expensive models only at high-leverage nodes and cheaper models for bounded execution.
- Launch a fresh interactive session for each agent-node visit without inheriting the prior chat transcript.
- Let agents report bounded outcomes without naming their successor.
- Persist graph and node-run identity strongly enough for reload recovery, idempotency, repeated node visits, retries, and future loops.
- Pin topology for an active `impl` attempt while resolving provider/model/effort/prompt configuration at each launch.
- Ship a built-in, disableable two-phase approach with inspectable and overridable prompts.
- Reuse the existing provider registry, model catalog, adapter seam, token accounting, session generations, stage blockers, and loopback endpoint.
- Keep the compiler, scheduler, executors, persistence, adapters, and UI projections separate.

## Non-Goals for V1

- Changing or graphifying `scope`, `uat`, `review`, `fix`, `ship`, or `done`.
- A visual graph editor.
- Public arbitrary graph authoring.
- AI-generated topology or an AI router/orchestrator process.
- Parallel node execution, joins, human gates, subgraphs, or distributed workers.
- Deterministic command nodes in the shipped graph runtime.
- Absorbing UAT or Review into an implementation graph.
- Arbitrary condition code or model-authored destination node IDs.
- Automatic provider/model fallback.
- Sophisticated graph-budget UI.
- A third-party workflow runtime such as Temporal or LangGraph.

The internal graph representation and scheduler APIs must not preclude later command nodes, bounded branches, loops, joins, escalation, or parallel scheduling.

## Architecture Boundary

The selected ticket approach owns an internal graph only while the ticket is at `impl`:

```text
Ticket stage machine
        │
        └── impl
             │
             └── selected approach
                    │
                    ▼
             compiled graph
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     compiler    scheduler   node executor
                                │
                                ▼
                         provider adapter
```

The graph compiler imports no provider adapter or stage-machine transition. The scheduler evaluates graph edges but cannot transition ticket stages. The agent-node executor launches through the existing adapter seam but does not choose graph edges. UI modules project persisted state and do not define execution semantics.

Existing non-graph approaches retain their current single-session behavior.

## Resolved Planning Decisions

### A. Public schema

V1 keeps the existing ordered `workflow` authoring syntax and compiles it into a trusted internal graph. It does not expose public `graph.nodes` or `graph.edges` fields yet.

This package definition:

```yaml
workflow:
  - name: research-plan
    command: /two-phase:research-plan
    profile: expert
    prompt:
      artifact: skills/research-plan/SKILL.md

  - name: implement
    command: /two-phase:implement
    profile: worker
    prompt:
      artifact: skills/implement/SKILL.md
```

compiles to:

```text
entry = research-plan
research-plan --complete--> implement
implement     --complete--> END
```

The graph compiler itself accepts a graph-oriented definition and produces `CompiledApproachGraph`; the workflow compiler is a thin linear-definition adapter. A future public graph schema can feed the same compiler without replacing the runtime.

### B. Completion CLI

V1 introduces a node-scoped command conceptually equivalent to:

```text
karst node complete
karst node block --reason "bounded diagnostic"
```

The exact composed command continues to contain trusted extension-owned paths such as the CLI entry and registry DB. It accepts no ticket key, stage, attempt, graph ID, node ID, destination, provider, model, effort, callback address, timestamp, or launch generation in argv.

The terminal receives opaque `graphRunId`, `nodeRunId`, launch generation, ticket identity, and callback address through host-owned launch environment. The CLI uses those values to conditionally update only the currently running node-run row, then sends a wake-up notification. `complete` maps to the bounded `complete` outcome. `block` records a bounded reason and parks the graph; it does not select an edge.

Repeated completion is an idempotent no-op. A completion whose node run is not current/running or whose launch generation does not match is rejected. The agent never names the next node.

### C. Durable identity

`phase_marks` is insufficient for a generic runtime. Insertion order plus phase name cannot unambiguously distinguish repeated visits, node retries, a launch that died before starting, or a topology-pinned graph run. V1 adds explicit `approach_graph_runs` and `approach_node_runs` persistence.

An approach graph run records:

- ticket id;
- fixed stage key `impl`;
- `impl` attempt at start;
- selected approach id;
- compiled topology version and fingerprint;
- a compact topology snapshot containing node IDs, kinds, allowed outcomes, and edges but no prompt bodies or transcripts;
- run status and timestamps.

A node run records:

- graph-run id;
- node id;
- monotonically increasing visit number for that node;
- execution status;
- bounded outcome/reason;
- launch generation;
- resolved provider/model/effort for observability;
- timestamps and bounded launch-failure evidence.

Node-run rows are append-only evidence except for lifecycle fields on the row representing that invocation. A retry creates another row rather than erasing the failed launch. Active nodes are derived from node-run statuses instead of a single `active_node_id` column, so persistence does not make future parallel nodes impossible.

### D. Topology pinning

The compact compiled topology snapshot is stored when the graph run starts. Every edge decision for that `impl` attempt uses that snapshot, even if the installed package or manifest later changes its workflow order.

Executable configuration is not snapshotted. Provider/model/effort/profile mappings and prompt overrides resolve from current trusted package/project state whenever a node launches or retries. If a topology-pinned node no longer has resolvable executable configuration, the same node red-blocks instead of silently skipping or changing topology.

### E. Context transfer

V1 makes fresh-session, no-transcript handoff a runtime invariant. A new agent node receives:

- freshly rendered ticket context;
- its effective node prompt;
- its declared artifact instructions and stable worktree paths;
- no previous interactive session id;
- no previous node transcript.

The built-in Research & Plan prompt writes a durable plan artifact in the ticket worktree. The Implement prompt reads that artifact. This supplies a useful artifact boundary without requiring a general structured-artifact schema in V1.

Internal node context types reserve a policy field with `previousTranscript: false`; V1 rejects `true`. A later artifact contract may add named inputs/outputs and focused task payloads without changing session identity or graph routing. Transcript chaining is therefore not the permanent handoff contract.

### F. Execution profiles

V1 introduces execution profiles because cost-tier mapping is a central product requirement and the resolution layer is small. Package defaults are:

```yaml
profiles:
  expert:
    provider: claude
    model: claude-opus-5
    effort: max

  worker:
    provider: claude
    model: claude-sonnet-5
    effort: low
```

Nodes reference a profile and may carry explicit provider/model/effort overrides. Projects may override profile mappings and individual nodes.

Launch-policy precedence is:

1. explicit project node override;
2. project execution-profile override;
3. packaged node override;
4. packaged execution-profile default;
5. ticket/project fallback only for fields the node/profile intentionally leaves unset;
6. adapter default for an unresolved optional model or effort.

An explicitly configured provider never inherits an incompatible model from another provider. Existing provider-aware catalog compatibility remains authoritative.

### G. Node kinds

V1 executes only interactive `agent` nodes. The internal types are discriminated by `kind`, and the scheduler delegates through a `NodeExecutor` boundary, so adding a deterministic `command` executor later does not alter edge resolution or persistence.

The compiler clearly rejects unsupported kinds. V1 does not implement a command node merely for theoretical completeness. The first verified approach will add it as a separately testable slice.

### H. Graph END semantics

Completing the final node transactionally marks its node run completed and the graph run completed. It does not call `transition`, set a `Verdict`, update `stage_current`, or dispose the final terminal before its command sequence finishes.

The final node prompt instructs the agent to run, in order:

1. `karst node complete`;
2. the existing `karst stage impl pass` marker.

At graph `END`, the scheduler launches no successor and leaves the final session alive long enough to fire the explicit stage marker. If the marker never occurs, the ticket remains at `impl` with a completed graph visible as awaiting explicit IMPL completion. Reload does not infer success from graph completion or the absence of a terminal.

## Internal Graph Model

The runtime is organized around graph concepts rather than two-phase names:

```ts
type AgentNodeOutcome = 'complete';

interface NodeExecutionReference {
  profile?: string;
  provider?: AgentProvider;
  model?: string;
  effort?: string;
}

interface PromptReference {
  artifact: string;
  overrideAgent?: string;
}

interface ApproachGraphDefinition {
  version: 1;
  entry: string;
  nodes: readonly ApproachNodeDefinition[];
  edges: readonly ApproachEdgeDefinition[];
}

interface AgentNodeDefinition {
  id: string;
  kind: 'agent';
  allowedOutcomes: readonly AgentNodeOutcome[];
  execution: NodeExecutionReference;
  prompt: PromptReference;
  context: { previousTranscript: false };
}

type ApproachNodeDefinition = AgentNodeDefinition;

interface CompiledAgentNode {
  id: string;
  kind: 'agent';
  allowedOutcomes: readonly AgentNodeOutcome[];
}

interface ExecutableAgentNode {
  nodeId: string;
  execution: NodeExecutionReference;
  prompt: PromptReference;
  context: { previousTranscript: false };
}

interface ApproachEdgeDefinition {
  from: string;
  on: AgentNodeOutcome;
  to: string | 'END';
}

interface CompiledApproachGraph {
  version: 1;
  entry: string;
  nodes: Readonly<Record<string, CompiledAgentNode>>;
  edges: Readonly<Record<string, Readonly<Record<string, string | 'END'>>>>;
  snapshot: string;
  fingerprint: string;
}
```

Compiled graphs use immutable serializable records, so the same canonical structure is hashed, persisted as the topology snapshot, and consumed by runtime functions. No runtime API accepts destinations from agent events.

`CompiledApproachGraph` contains topology only. `resolveExecutableNode(effectiveApproach, pinnedNodeId)` returns the current `ExecutableAgentNode` at launch or retry time. This keeps the stored edge graph stable while allowing trusted provider/model/effort/profile/prompt configuration to change between attempts.

Compilation validates:

- non-empty safe unique node IDs;
- an existing entry node;
- supported node kinds;
- an existing prompt artifact reference;
- every edge source and non-END destination;
- outcomes allowed by the source kind;
- no duplicate edge for `(source, outcome)`;
- at least one path from entry to `END`;
- no unreachable node in a V1 ordered workflow;
- resolvable packaged profiles and bounded node launch fields.

Cycles are valid in the internal graph model but cannot be authored through V1's ordered workflow syntax. Runtime visit identity and graph budgets are designed so a future explicit graph schema can expose loops safely.

## Configuration and Catalog Reuse

Provider choices come from the existing implemented-provider registry. Model choices come from the existing live provider-filtered catalog, with the same bounded custom-model behavior used elsewhere. No node-specific model list is introduced.

Effort is optional. Adapter capabilities declare whether interactive effort is supported and which common values can be suggested. Settings shows effort only where the selected provider supports it. A manifest that explicitly configures effort for an unsupported provider fails node launch configuration and red-blocks; adapters never silently drop it.

Provider-specific effort translation stays inside each adapter and receives effort as one argument value. No model, effort, or provider string is shell-interpolated.

The built-in two-phase defaults remain:

| Profile/node | Provider | Model | Effort |
|---|---|---|---|
| `expert` / Research & Plan | Claude | `claude-opus-5` | `max` |
| `worker` / Implement | Claude | `claude-sonnet-5` | `low` |

## Built-In Package and Enablement

`karst-two-phase` ships inside the VSIX and requires no network install. Its complete source under `.agents/skills/karst-two-phase/**` is force-added and made an explicit tracked exception to the repository's broad `.agents` ignore rule. The build copies this canonical package into `dist`/the VSIX, and a parity/inclusion test proves that the shipped bytes match the tracked source.

The built-in approach is enabled by default but is never a static default or recommended selection. Selection rules are:

- the existing ticket analyzer may recommend it when it is enabled;
- without an analyzer recommendation, the user manually chooses an approach;
- explicit user selections are never overwritten;
- disabling it removes it from analyzer candidates and new-ticket choices;
- existing tickets that already reference it remain runnable;
- re-enabling it requires no install and preserves prompt/config overrides.

Personal approaches and agents remain independent.

## Prompt Ownership and Overrides

Each agent node references a packaged prompt artifact rather than embedding large Markdown in topology. Settings → Agents shows effective approach-owned entries such as:

- `two-phase / research-plan`;
- `two-phase / implement`.

Users may inspect, partially edit, or completely replace the prompt. Saving creates a project-local override under the configured `agentsDir`; it never mutates the VSIX or packaged source. Reset removes only the exact Karst-created override after resolving its safe path.

Prompt resolution is:

1. project node prompt override;
2. packaged node prompt artifact;
3. `node-config-invalid` block if neither is available.

Overrides survive extension upgrades. Settings labels the packaged source and active override.

## Scheduler and Agent-Node Executor

Karst is the scheduler:

1. Compile the selected approach when `impl` execution starts.
2. Persist a graph run with pinned topology before launching the entry node.
3. Create a node-run row in `launching` state.
4. Resolve current execution profile, node overrides, prompt, context, provider/model compatibility, and effort capability.
5. Materialize the approach for the selected adapter.
6. Launch a fresh session with graph/node/run identities and a new generation.
7. Mark the node run `running` with resolved launch metadata.
8. On a durable bounded completion, reread graph/node/ticket state and validate current ownership.
9. Mark the node run complete and select the trusted outgoing edge in one transaction.
10. If the destination is another node, create its pending invocation and schedule its executor.
11. If the destination is `END`, mark the graph run completed and launch nothing.

The scheduler interface is keyed by `graphRunId`/`nodeRunId`, not only ticket id. The V1 agent executor adapts that to today's one-interactive-terminal-per-ticket `SessionManager` and refuses concurrent nodes. A future parallel executor can widen session ownership without replacing compiler, scheduler, or persistence APIs.

The old terminal is disposed only after the completion transaction is durable and before a successor session is created. Cross-provider handoff never resumes the previous provider's session.

## Completion Transport and Trust Boundary

The node CLI is a separate parse path from `stage`. It imports graph-run persistence but never imports the ticket machine. Its argv grammar is closed and rejects trailing fields.

The node-run id and launch generation bind a completion to exactly one invocation. The CLI conditionally records completion first, then posts a wake-up to the existing loopback endpoint. The endpoint validates its launch-generation query target and schedules work after returning a fast response. The notification body cannot choose ticket, node, edge, provider, model, effort, topology, or destination.

If the extension host is unavailable after the DB commit, the durable completed node remains. Activation reconciliation observes it and schedules the trusted successor exactly once. If the DB update did not occur, a notification alone advances nothing.

## Failure Semantics and Recovery

Three failure classes remain distinct:

1. **Launch/configuration failure:** Karst could not execute a node. The graph red-blocks and no edge is selected.
2. **Node outcome failure:** a future executor ran and produced a meaningful bounded outcome such as command `failed`; graph topology may route it normally.
3. **Implementation-stage failure:** existing stage-machine semantics outside the graph.

V1 adds one recoverable `impl` blocker kind, `approach-node-failed`, with a closed internal category such as:

- `node-config-invalid`;
- `provider-unavailable`;
- `model-incompatible`;
- `effort-unsupported`;
- `prompt-missing`;
- `materialization-failed`;
- `session-launch-failed`.

The bounded reason identifies approach, node, kind, provider, model when present, and sanitized category/message. It is presented as an error/red fault inside the stage while remaining a blocker rather than a failed verdict; the existing ticket-level Needs You projection remains authoritative.

Resume:

1. validates the panel ticket and current `impl` block;
2. clears only `approach-node-failed`;
3. rereads the same active graph/node invocation from durable state;
4. creates a new node-run attempt for that node;
5. resolves the latest provider/model/effort/profile/prompt configuration;
6. retries without synthesizing completion or selecting an edge.

There is no silent fallback.

## Reload and Reconciliation

Activation reconciles graph runs globally for the current project, independently of dashboard visibility.

- `launching` or `running` node run with an owned live generation: adopt it and do nothing.
- `running` node run whose recorded process/session is demonstrably dead: mark it stale and retry only through the normal recoverable path; absence alone is not proof while another window may own it.
- completed node with a successor not yet launched: transactionally schedule the pinned successor once.
- blocked graph: preserve the block and wait for Resume.
- completed graph while ticket remains at `impl`: show awaiting explicit IMPL completion; never transition.
- ticket no longer at `impl`: close/reconcile the graph run without scheduling internal work.

No missing terminal, hook, or process is interpreted as node success.

## Context and Cost Discipline

Graph topology and model choice are independent. Nodes declare execution intent (`expert`, `worker`) and projects map intent to available cores. High-end models are expected at research, planning, decomposition, hard diagnosis, and deterministic escalation thresholds—not as the default executor merely because a graph exists.

V1 fresh sessions prevent cumulative transcript growth. The Research & Plan node writes focused artifacts; the Implement node reads them. Token usage continues to be measured once at `instrumentedAdapter`, with a graph/node call-site attribution added without storing prompts or completions.

Internal graph/run types reserve optional budgets such as maximum agent runs and maximum expert runs, but V1 does not expose or enforce a full budget UI. The scheduler counts node visits so future loop and expert-run limits can be added without reconstructing history from transcripts.

## Settings and Ticket Form

No graph editor is added. Settings → Approaches renders the built-in ordered nodes:

```text
Research & Plan
  profile / provider / model / effort
  prompt link

Implement
  profile / provider / model / effort
  prompt link
```

Users primarily customize enablement, profiles, per-node overrides, and prompts. The UI reuses host-supplied provider/model catalog data. Saves remain tab-scoped and merge onto the manifest currently on disk; changing one node/profile cannot revert another tab or prompt edit.

The ticket form lists enabled approaches and displays a compact effective-node summary for the selected approach. The existing analyzer receives enabled approach descriptions and may recommend one; it never generates or mutates topology.

## Security Invariants

- Graph execution exists only at `impl` and cannot call the stage machine through node completion.
- `stage` and `node` keep separate closed CLI parsers.
- The agent cannot supply ticket, stage, stage attempt, graph run, node run, node id, next destination, provider, model, effort, topology, timestamp, callback address, or launch generation in node-completion argv.
- The only agent-selected semantic is a bounded command verb/outcome accepted by the active compiled node.
- Free-form reason text is evidence only, collapsed/capped, and never used as a routing label.
- Topology and edge destinations come from the pinned trusted compiled snapshot.
- Node launch configuration comes from trusted package/project state, never completion payloads.
- Stale, duplicate, unknown, and out-of-order completion attempts cannot schedule work.
- Terminal exit/closure never implies success.
- Graph `END` never implies stage pass.
- Provider-specific launch flags remain inside adapters.
- Model and effort values are passed as individual argv values, never shell-interpolated.
- Token recording remains at the adapter seam and stores no prompt/completion text.

## Verification Strategy

Automated coverage must include:

### Compilation

- a valid two-node linear graph;
- missing entry;
- duplicate or unsafe node IDs;
- unknown edge source/destination;
- invalid outcome for source kind;
- duplicate `(source, outcome)` edge;
- valid `END` edge and at least one terminal path;
- ordered workflow compilation to deterministic linear topology;
- unsupported node-kind rejection;
- stable topology snapshot/fingerprint.

### Configuration

- packaged profiles/defaults;
- project profile and node overrides with exact precedence;
- ticket/project fallback only for unset fields;
- shared provider and model catalog reuse;
- provider/model compatibility and custom model IDs;
- supported custom effort and unsupported-effort blocking;
- packaged prompt and project prompt override/reset;
- disabled built-in filtering without stranding existing tickets.

### Runtime and event safety

- automatic entry-node launch;
- resolved provider/model/effort forwarded to adapter;
- fresh no-resume session per node;
- valid completion follows trusted edge;
- agent cannot choose destination;
- old terminal disposed before successor launch;
- cross-provider handoff gets a new generation;
- final completion reaches graph `END` without stage mutation;
- stale generation, duplicate, unknown, out-of-order, wrong-project, and wrong-window completion rejection;
- repeated node visits create distinct node-run evidence.

### Failure and recovery

- provider unavailable;
- incompatible/invalid model;
- unsupported effort;
- missing prompt;
- materialization and terminal-launch failures;
- bounded red blocker details;
- Resume retries the same node with latest configuration;
- Resume does not synthesize completion;
- reload after completion commit but before successor launch;
- reload while a node is active, blocked, or graph-complete;
- no terminal interpreted as success;
- topology changes mid-attempt do not alter pinned routing.

### Compatibility and delivery

- existing non-graph approaches and manifests require no migration;
- ticket stage graph remains unchanged;
- built-in approach analyzer/manual-selection rules;
- complete `.agents/skills/karst-two-phase/**` source tracked in the PR;
- build output/VSIX contains byte-matching bundled package;
- token accounting occurs once at the adapter seam;
- typecheck, focused Vitest suites, full `npm test`, and build pass.

## Future Evolution

The next graph-backed slice can add a deterministic `CommandNode` executor and bounded `passed`/`failed` outcomes to express:

```text
Research & Plan [expert]
        ↓
Implement [worker]
        ↓
Verify [command]
   ┌────┴────┐
 passed    failed
   │          ↓
  END      Fix [worker]
              └──→ Verify
```

Repeated command failure can later route to an expert escalation node using durable visit counts. Parallel branches will require widening the session/UI ownership layer, but graph/node-run identity, active-node derivation, compiler edges, and executor dispatch are deliberately not keyed to one global logical node.

The V1 objective remains narrow: ship a durable, token-conscious Karst-owned graph scheduler for `Research & Plan → Implement`, not a general workflow platform.
