# Dynamic IMPL Graph Runtime Design

## Summary

Karst will ship a built-in graph-engineering implementation approach. It has no predefined execution graph. When a ticket enters the approach, a configurable expert planner researches the ticket and repositories, writes detailed plan/task artifacts, and generates a task-specific graph. Karst validates and freezes that graph, then executes every ready, non-conflicting node through deterministic scheduler logic.

The runtime is strictly internal to the existing `impl` ticket stage:

```text
scope → impl → uat → review → fix → ship → done
          │
          └── dynamic implementation graph
```

It does not replace or generalize the ticket stage machine. Graph completion never creates a stage verdict. The existing explicit `karst stage impl pass` marker remains authoritative.

Karst, not an LLM, owns routing. Models plan and perform bounded work; they do not choose unvalidated destinations, execute arbitrary generated shell, or infer deterministic outcomes that Karst can observe itself.

## Product Goals

- Generate a detailed implementation graph appropriate to each ticket rather than shipping fixed execution topology.
- Support agent, allowlisted command, deterministic gate, and synchronization join nodes.
- Support bounded branching, loops, retries, expert escalation, and immutable replanning revisions.
- Run independent work concurrently when declared repository/path scopes do not conflict.
- Configure reusable execution profiles and allow user-authored provider/model/effort overrides for individual generated nodes.
- Reuse the existing provider registry and shared live model catalog; never create graph-local provider/model lists.
- Use high-end models at high-leverage planning/diagnosis nodes, cheaper models for bounded implementation, and zero-token deterministic nodes wherever possible.
- Transfer explicit artifacts and evidence between fresh sessions instead of replaying prior transcripts.
- Persist enough identity and lineage for reload recovery, duplicate rejection, repeated visits, parallel branches, joins, retries, and graph revisions.
- Ship the approach inside the extension, permit disabling it, and expose its planner prompt for complete project-local customization.
- Keep compiler, scheduler, executors, persistence, adapters, and UI projections separate.

## Non-Goals

- Graphifying `scope`, `uat`, `review`, `fix`, `ship`, or `done`.
- Replacing the ticket stage machine or its verdict rules.
- A visual graph editor in the first release.
- AI-generated provider credentials, shell programs, callback addresses, stage commands, or executable condition code.
- An LLM orchestrator kept alive to choose the next node.
- Arbitrary user JavaScript/expressions inside gates.
- Automatic provider/model fallback.
- Dynamic absorption of UAT or Review into the graph.
- A third-party workflow engine such as Temporal or LangGraph.
- Distributed execution across machines.

## Built-In Approach Lifecycle

The built-in approach is named `karst-graph-engineering`. It ships no compatibility wrapper or predefined execution graph.

```text
IMPL launch
    │
    ▼
Bootstrap Graph Planner [expert profile]
    ├── research ticket and relevant repositories
    ├── write plan and bounded task artifacts
    └── write graph.json to its fixed run artifact directory
    │
    ▼
Karst compile + policy validation
    │
    ├── invalid/missing capability → recoverable graph block
    │
    ▼
Persist immutable graph revision 1
    │
    ▼
Schedule all ready non-conflicting nodes
    │
    ├── bounded outcomes choose trusted edges
    ├── joins synchronize parallel branches
    ├── loops observe visit/budget limits
    └── replan drains active work and creates revision N+1
    │
    ▼
Graph END
    │
    ▼
Existing explicit IMPL pass marker
```

The bootstrap planner is not a node in the graph it generates. It is a fixed, durable planning invocation owned by the approach runtime. Its provider/model/effort come from the `planner` execution profile and may be customized like every other profile.

The approach launches automatically when the ticket's normal IMPL session is opened. A successful plan compiles and begins execution without requiring a second manual launch. Projects may enable a `confirmGeneratedGraph` policy to pause after compilation for review, but automatic execution is the default so the graph remains an orchestration workflow rather than a sequence of dashboard clicks.

## Selection and Enablement

The graph-engineering approach ships in the VSIX and requires no network installation. It is enabled by default but is never statically selected or marked recommended.

- The existing ticket-form analyzer may recommend it when enabled.
- Without an analyzer recommendation, the user chooses an approach manually.
- An explicit user choice is never overwritten.
- Disabling removes it from analyzer candidates and new-ticket choices.
- Existing tickets already using it remain runnable.
- Re-enabling requires no reinstall and preserves project overrides.
- Personal approaches and agents remain independent.

The complete canonical source is tracked under `.agents/skills/karst-graph-engineering/**`. The repository adds a narrow ignore exception for that package. The build copies it into extension output, and a parity/inclusion test proves the VSIX contains the same bytes reviewers see in Git.

## Configuration Model

Project configuration controls planner behavior, reusable execution profiles, trusted commands, scheduling limits, and approval policy. The V1 configuration shape is:

```yaml
approaches:
  - id: karst-graph-engineering
    label: Graph Engineering
    enabled: true
    planner:
      profile: expert
      prompt:
        artifact: skills/graph-planner/SKILL.md
    profiles:
      expert:
        provider: claude
        model: claude-opus-5
        effort: max
      worker:
        provider: claude
        model: claude-sonnet-5
        effort: low
      fast:
        provider: claude
        model: claude-sonnet-5
        effort: low
    commands:
      test:
        command: npm
        args: [test]
        cwd: repository
        access: write
        timeoutSeconds: 1800
      typecheck:
        command: npm
        args: [run, typecheck]
        cwd: repository
        access: write
        timeoutSeconds: 900
      build:
        command: npm
        args: [run, build]
        cwd: repository
        access: write
        timeoutSeconds: 1800
    graph:
      confirmGeneratedGraph: false
      maxParallel: 4
      maxNodeRuns: 40
      maxExpertRuns: 3
      maxReplans: 2
```

Package defaults and project overrides merge by profile/command key. Settings writes only the current tab/section onto the manifest as it exists on disk at save time.

### Execution policy resolution

Generated agent nodes reference a profile such as `expert`, `worker`, or `fast`. They cannot name a provider/model/effort. Users may override a pending node from the ticket's graph view.

Resolution precedence is:

1. user-authored ticket graph node override;
2. project execution-profile override;
3. packaged execution-profile default;
4. ticket/project agent fallback only for intentionally unset fields;
5. adapter default for unresolved optional model/effort.

The provider must be implemented. Models reuse the existing live provider-filtered catalog and bounded custom-ID behavior. An explicitly selected provider never inherits a known incompatible model.

Effort is optional and provider-capability-aware. Adapter capabilities declare whether interactive effort is supported and which values the UI suggests. A project/user explicit effort for an unsupported provider is a configuration failure; adapters never silently discard it. Provider-specific effort flags remain inside adapters and receive effort as one argv value.

The built-in defaults intentionally spend more on planning than execution:

| Profile | Provider | Model | Effort |
|---|---|---|---|
| `expert` / planner | Claude | `claude-opus-5` | `max` |
| `worker` | Claude | `claude-sonnet-5` | `low` |
| `fast` | Claude | `claude-sonnet-5` | `low` |

## Generated Graph Contract

The planner writes a versioned JSON document to the fixed artifact path assigned by Karst. The submission command accepts no arbitrary path. This valid graph demonstrates parallel implementation, a join, deterministic verification, and a bounded fix loop:

```json
{
  "version": 1,
  "title": "Implement provider-aware session switching",
  "rationaleArtifact": "architecture-notes",
  "entries": ["implement-api", "implement-web"],
  "artifacts": [
    {
      "id": "implementation-plan",
      "path": "artifacts/plan/PLAN.md",
      "producer": "$planner"
    },
    {
      "id": "architecture-notes",
      "path": "artifacts/plan/architecture.md",
      "producer": "$planner"
    },
    {
      "id": "api-task",
      "path": "artifacts/tasks/api.md",
      "producer": "$planner"
    },
    {
      "id": "web-task",
      "path": "artifacts/tasks/web.md",
      "producer": "$planner"
    },
    {
      "id": "fix-task",
      "path": "artifacts/tasks/fix.md",
      "producer": "$planner"
    },
    {
      "id": "api-result",
      "path": "artifacts/results/api.md",
      "producer": "implement-api"
    },
    {
      "id": "web-result",
      "path": "artifacts/results/web.md",
      "producer": "implement-web"
    },
    {
      "id": "fix-result",
      "path": "artifacts/results/fix.md",
      "producer": "fix-implementation"
    }
  ],
  "nodes": [
    {
      "id": "implement-api",
      "kind": "agent",
      "label": "Implement API changes",
      "profile": "worker",
      "instructionsArtifact": "api-task",
      "inputs": ["implementation-plan", "api-task"],
      "outputs": ["api-result"],
      "resources": {
        "reads": [{ "repo": "api", "paths": ["src"] }],
        "writes": [{ "repo": "api", "paths": ["src/api", "test/api"] }]
      },
      "outcomes": ["complete", "blocked", "replan"],
      "budget": { "maxVisits": 1 }
    },
    {
      "id": "implement-web",
      "kind": "agent",
      "label": "Implement web changes",
      "profile": "worker",
      "instructionsArtifact": "web-task",
      "inputs": ["implementation-plan", "web-task"],
      "outputs": ["web-result"],
      "resources": {
        "reads": [{ "repo": "web", "paths": ["src"] }],
        "writes": [{ "repo": "web", "paths": ["src/client", "test/client"] }]
      },
      "outcomes": ["complete", "blocked", "replan"],
      "budget": { "maxVisits": 1 }
    },
    {
      "id": "join-implementation",
      "kind": "join",
      "label": "Wait for implementation branches",
      "waitFor": ["implement-api", "implement-web"],
      "mode": "all",
      "outcomes": ["complete"]
    },
    {
      "id": "verify",
      "kind": "command",
      "label": "Run repository tests",
      "command": "test",
      "repositories": ["api", "web"],
      "outcomes": ["passed", "failed", "infrastructure-error"],
      "budget": { "maxVisits": 3 }
    },
    {
      "id": "fix-implementation",
      "kind": "agent",
      "label": "Fix deterministic verification failures",
      "profile": "worker",
      "instructionsArtifact": "fix-task",
      "inputs": ["implementation-plan", "api-result", "web-result"],
      "outputs": ["fix-result"],
      "resources": {
        "reads": [
          { "repo": "api", "paths": ["src", "test"] },
          { "repo": "web", "paths": ["src", "test"] }
        ],
        "writes": [
          { "repo": "api", "paths": ["src", "test"] },
          { "repo": "web", "paths": ["src", "test"] }
        ]
      },
      "outcomes": ["complete", "blocked", "replan"],
      "budget": { "maxVisits": 2 }
    }
  ],
  "edges": [
    { "id": "api-to-join", "from": "implement-api", "on": "complete", "to": "join-implementation" },
    { "id": "web-to-join", "from": "implement-web", "on": "complete", "to": "join-implementation" },
    { "id": "join-to-verify", "from": "join-implementation", "on": "complete", "to": "verify" },
    { "id": "verify-passed", "from": "verify", "on": "passed", "to": "END" },
    { "id": "verify-failed", "from": "verify", "on": "failed", "to": "fix-implementation" },
    { "id": "fix-to-verify", "from": "fix-implementation", "on": "complete", "to": "verify" }
  ],
  "budgets": {
    "maxNodeRuns": 20,
    "maxExpertRuns": 1,
    "maxReplans": 1
  }
}
```

Large prose and task instructions live in artifacts, not JSON fields. The graph holds bounded identifiers, paths, policies, and relationships.

### Node IDs and paths

Node, artifact, edge, profile, repository, and command IDs use a bounded safe identifier grammar. `$planner` is the one reserved artifact-producer sentinel and cannot be used as a user node ID. Artifact paths and resource paths are normalized project-relative paths with no absolute paths, empty/dot segments, or `..`. Resource paths denote exact files or directory subtrees rather than arbitrary glob expressions, making overlap validation deterministic.

## Node Model

```ts
type ApproachNode = AgentNode | CommandNode | GateNode | JoinNode;

type AgentOutcome = 'complete' | 'blocked' | 'replan';
type CommandOutcome = 'passed' | 'failed' | 'infrastructure-error';
type GateOutcome = 'matched' | 'not-matched';
type JoinOutcome = 'complete';
type ComparisonOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

type GatePredicate =
  | { kind: 'node-visits'; node: string; op: ComparisonOperator; value: number }
  | { kind: 'node-outcomes'; node: string; outcome: string; op: ComparisonOperator; value: number }
  | { kind: 'expert-runs'; op: ComparisonOperator; value: number }
  | { kind: 'artifact-exists'; artifact: string }
  | { kind: 'all'; predicates: GatePredicate[] }
  | { kind: 'any'; predicates: GatePredicate[] };

interface PathClaim {
  repo: string;
  paths: string[];
}

interface ResourceClaims {
  reads: PathClaim[];
  writes: PathClaim[];
}

interface NodeBudget {
  maxVisits: number;
}

interface AgentNode {
  id: string;
  kind: 'agent';
  profile: string;
  instructionsArtifact: string;
  inputs: string[];
  outputs: string[];
  resources: ResourceClaims;
  outcomes: AgentOutcome[];
  budget: NodeBudget;
}

interface CommandNode {
  id: string;
  kind: 'command';
  command: string;
  repositories: string[];
  outcomes: CommandOutcome[];
  budget: NodeBudget;
}

interface GateNode {
  id: string;
  kind: 'gate';
  policy: GatePredicate;
  outcomes: ['matched', 'not-matched'];
}

interface JoinNode {
  id: string;
  kind: 'join';
  waitFor: string[];
  mode: 'all';
  outcomes: ['complete'];
}
```

### AgentNode

An agent node always launches a fresh interactive session. It receives current ticket context, its bounded instructions artifact, declared input artifacts/evidence, and relevant worktree locations. It receives no prior session ID or prior-node transcript.

The planner chooses a profile/capability tier. Only user/project configuration maps that tier to a provider/model/effort. A ticket graph view may override a pending node's mapping, but generated graph content cannot.

### CommandNode

A command node references a project-configured allowlist ID. The trusted definition supplies executable, fixed argv, cwd policy, access mode, timeout, and permitted environment names. The planner may select repository instances but cannot emit a command, add argv, insert shell operators, redirect streams, or invent environment values.

Karst executes the command directly without a shell and maps process results deterministically:

- exit code `0` → `passed`;
- non-zero exit code → `failed`;
- spawn, timeout, or infrastructure fault → `infrastructure-error`.

The node stores stdout/stderr in bounded artifact logs and never asks an LLM whether the command passed.

For a node that names multiple repositories, Karst runs the same trusted command definition once per repository worktree, up to the graph concurrency ceiling, and aggregates results deterministically: any infrastructure fault wins `infrastructure-error`, otherwise any non-zero exit wins `failed`, otherwise the node is `passed`. Command `access` is conservatively configured by the project; npm test/build/typecheck defaults use repository-wide `write` because tools may create caches, coverage, or generated files even when their purpose sounds read-only.

### GateNode

A gate evaluates a closed deterministic policy over persisted graph state and artifacts. V1 supports bounded policy primitives:

- node visit count comparison;
- node outcome count comparison;
- graph expert-run count comparison;
- artifact-exists predicate;
- `all`/`any` composition over those primitives.

Numeric comparisons use the closed operator set shown above. Gate output labels are always `matched` or `not-matched`; both require outgoing edges. Composite predicate depth and collection size are bounded by the graph parser. No JavaScript, shell, SQL, regular expression, or model-generated expression executes.

### JoinNode

A join is scheduler logic and spends no AI tokens. V1 `mode: all` consumes one durable arrival from every declared predecessor, then emits `complete`. Join nodes inside strongly connected loop components are rejected in V1 so repeated loop waves cannot be paired ambiguously. Parallel branches may join before entering a later loop.

## Edge and Activation Model

Edges are trusted compiled topology:

```ts
interface ApproachEdge {
  id: string;
  from: string;
  on: string;
  to: string | 'END';
}
```

Multiple edges with the same `(from, outcome)` are deliberate fan-out and activate all destinations. Different outcomes are conditional branches and activate only the matching destination set.

Every normal success/failure outcome declared by a command, gate, or join must have at least one outgoing edge. Agent `blocked`, agent `replan`, and command `infrastructure-error` are reserved control/fault outcomes: when no explicit edge handles them, Karst blocks or starts the replan protocol rather than stranding a token. Agent `complete` always requires an edge. This makes an omitted normal route a compile error while keeping environmental faults recoverable.

Agents report only their active node's bounded outcome. They never send node IDs or destinations. Command/gate/join executors produce outcomes deterministically.

The scheduler persists activation tokens. A token records the source node run, edge, destination, graph revision, and consumption status. Non-join nodes consume one token per visit. Join nodes consume one arrival from every declared predecessor as a set. Entry tokens have no source.

`END` tokens do not immediately cancel other work. A graph revision completes only when at least one END token exists and no unconsumed non-END token or active node run remains. A graph that can leave an execution branch stranded without an END/join path is rejected during compilation.

This token model gives repeated visits distinct identities and supports fan-out without treating the ticket as one globally active logical node.

## Graph Compilation and Validation

The planner output is untrusted data. Karst compiles it before any generated node runs.

Compilation validates at least:

- schema version, document size, collection sizes, and bounded strings;
- unique safe node/artifact/edge IDs;
- one or more existing entries;
- only supported node kinds and policy variants;
- every edge source/destination and source-allowed outcome;
- at least one reachable END path;
- no unreachable nodes or artifacts;
- no branch that can strand live execution without END or a join;
- join predecessor equality with incoming topology;
- no join inside a strongly connected component;
- declared loop nodes carry finite visit budgets;
- aggregate graph/expert/replan budgets do not exceed project maxima;
- every referenced profile, repository, command, prompt, and input artifact exists;
- every planner-produced artifact file exists at compile time and every node-produced output has one declared safe destination;
- command repositories satisfy the trusted command definition;
- normalized resource paths remain within declared repository roots;
- all resource claims are valid and every overlap is recorded for scheduler serialization;
- generated nodes cannot configure provider/model/effort directly;
- gate policies reference valid node/artifact IDs and bounded comparison values.

Compilation produces an immutable canonical topology/configuration document and SHA-256 fingerprint. The exact canonical bytes are persisted as a graph revision. Invalid graphs red-block planning with structured diagnostics; Karst never “fixes” unsafe topology silently.

## Parallel Scheduling and Resource Claims

The scheduler starts every ready node up to `maxParallel` whose declared resource claims do not conflict with active work.

Conflict rules are deterministic:

- read/read on the same path may run together;
- write/write overlap conflicts;
- write/read overlap conflicts;
- directory claims overlap descendants;
- repository-wide claims overlap every path in that repository;
- trusted commands inherit access and repository breadth from the allowlist, not planner prose;
- joins and pure gates claim no repository resources;
- a node waiting on dependencies is not ready and acquires no resources.

Same-repository agent writers may run concurrently when their normalized write/read subtrees are disjoint. Repository-wide commands wait until conflicting writers/readers complete.

### Why detailed plans still need scheduler conflict checks

The planner's detailed assignment is the primary source of parallelism. Karst does not serialize unrelated nodes merely because they belong to one graph. Runtime conflict checks preserve that plan under real execution conditions:

- agents may discover a shared file that the initial task list did not mention;
- formatters, generators, builds, tests, and Git operations often observe or mutate repository-wide state;
- two terminals share one ticket worktree and Git metadata;
- an extension crash can leave an old process alive while recovery considers another launch;
- a replan may change resource ownership while prior work is draining.

Therefore “not started in parallel” means declared or trusted resource claims overlap, the concurrency budget is full, or a dependency/join is incomplete. This reason is persisted and shown in graph state so deliberate serialization never looks like a scheduler defect.

V1 does not create a separate worktree per node. If later evidence shows path-disjoint same-repository agents cannot be made reliable in a shared worktree, per-node worktrees can be added behind the node executor without replacing graph topology, token, or scheduler semantics.

## Artifacts and Context Policy

Artifacts are the first-class communication channel between nodes. Every artifact has a safe id, project-relative path, producer, optional consumers, media type, and size limit. Planner-produced artifacts are registered when the graph revision is compiled; node outputs are registered when the node completes.

Agent context is assembled from:

- freshly rendered ticket context;
- the node's instructions artifact;
- declared input artifacts;
- declared command/failure evidence;
- relevant repository/worktree paths;
- optional current diff scoped to the node's repositories.

It explicitly excludes previous interactive transcripts. Fresh node visits never receive `--resume` for another node, even when the provider is identical.

Karst validates required output artifacts before accepting `complete`. Missing required output changes the node outcome to a recoverable artifact fault; it does not route `complete` on a prompt promise alone.

Prompt/completion text is never written to SQLite. Artifact paths and bounded metadata are stored; files remain in the ticket worktree/artifact directory.

## Completion CLI and Trust Boundary

Graph planner and agent sessions receive host-owned environment values:

- ticket id;
- graph run id;
- graph revision id;
- node run id;
- launch generation;
- fixed artifact root;
- loopback callback URL.

The node CLI has a separate closed parser from `stage`:

```text
karst node complete
karst node block --reason <text>
karst node replan --reason <text>
```

It accepts no ticket key/id, stage, attempt, graph/revision/node id, destination, profile, provider, model, effort, artifact root, callback address, timestamp, or launch generation in argv. Trailing argv is rejected.

The CLI conditionally updates only the `running` node-run row identified by host environment and matching launch generation. It validates the outcome against the pinned node definition, caps/collapses evidence text, commits durable state, then posts a wake-up. Duplicate or stale completion is an idempotent rejection.

The loopback notification is only a wake-up. The endpoint derives generation from its request target, returns a fast response, and schedules the graph coordinator. The coordinator rereads canonical state before selecting any edge.

The node parser never imports the ticket stage machine. Graph events cannot create a `Verdict`.

## Scheduler Runtime

Karst owns the execution loop:

1. Create a graph run in `planning` and a durable bootstrap planner node run.
2. Launch the planner through the agent-node executor using the current `planner` profile.
3. On planner completion, load the fixed graph artifact, compile it, and persist revision 1 plus entry tokens transactionally.
4. Reconcile tokens, dependencies, joins, resource claims, and budgets.
5. Create node-run rows in `ready`, then `launching`, before external work begins.
6. Dispatch by node kind through injected executors.
7. Record resolved profile/provider/model/effort and launch generation for agent runs.
8. Persist outcome/evidence before evaluating outgoing edges.
9. Consume the node's activation and create successor tokens in one transaction.
10. Continue scheduling every eligible node.
11. On END quiescence, mark the graph run completed and keep the explicit IMPL marker separate.

After END quiescence the graph status is `completed-awaiting-impl-marker`. If the last completing invocation is an agent node, its generated closing instructions run `karst node complete` and then the existing `karst stage impl pass` command; node completion leaves that terminal alive long enough to issue the marker. If END is reached by a command, gate, or join after all agent sessions have closed, the Inside view exposes the existing explicit “Complete implementation” action. That user action invokes the same guarded IMPL marker path. Neither route lets the scheduler infer or directly write a stage verdict.

Scheduler state is keyed by graph/revision/node-run IDs rather than only ticket id. The current `SessionManager` must be generalized from one terminal per ticket to terminal ownership by node run while retaining ticket grouping. This permits multiple parallel agent nodes for one ticket and prevents a newly launched node from adopting another node's terminal.

Cross-provider or same-provider node handoff always creates a fresh session generation. A node may be focused/reopened while it is the same running invocation, but a different node never resumes its conversation.

## Immutable Replanning

`replan` is a bounded agent outcome, not a topology mutation instruction.

When any node requests replan:

1. mark the active revision `draining`;
2. stop launching new nodes from that revision;
3. allow already running deterministic/agent nodes to finish and record evidence;
4. cancel remaining unconsumed tokens once active work quiesces;
5. launch the bootstrap planner with the original ticket context, prior plan/graph, completed artifacts, failures, diffs, resource conflicts, and replan reason;
6. validate a complete new graph document;
7. persist revision N+1 with `supersedes_revision_id` and bounded rationale;
8. create new entry tokens and resume scheduling.

Prior revisions, node runs, activations, artifacts, and outcomes remain immutable history. Provider/model/prompt/profile configuration still resolves at each new node launch. Project `maxReplans` prevents unbounded expert replanning.

If other work never quiesces, Stop/Resume controls resolve it; Karst does not infer cancellation success.

## Budgets and Escalation

Project maxima cap planner-generated budgets. V1 enforces:

- graph node-run count;
- graph expert-profile run count;
- graph replan count;
- node visit count;
- maximum concurrently active nodes;
- command timeout;
- artifact byte limits.

Exceeding a budget produces a bounded deterministic outcome when the topology declares a gate/edge for it; otherwise the graph blocks with `graph-budget-exhausted`. A loop without a finite node-visit budget is rejected.

Escalation is expressed through deterministic evidence and graph topology. A gate can count repeated command failures or worker visits and route to an `expert` agent node. Self-reported confidence may be stored in an artifact but is not a routing primitive.

Token usage remains measured once at `instrumentedAdapter`. Graph/node/profile attribution is added to the existing usage tracking metadata without storing prompts or completions. Token-count limits may be added later using this evidence; V1 does not attempt to kill a session at an estimated token boundary.

## Persistence

Graph execution requires explicit durable identity. `phase_marks` cannot distinguish generated topology revisions, parallel activations, repeated node visits, joins, or replanning. It remains historical UI evidence for legacy approaches but does not drive the graph runtime.

V1 adds the following focused tables:

### `approach_graph_runs`

- id;
- ticket id and project ownership through the ticket;
- fixed stage key `impl` and stage attempt;
- approach id;
- status (`planning`, `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`, `closed`, `stale`);
- active revision id;
- created/updated/completed timestamps;
- planner/expert/node/replan counters.

### `approach_graph_revisions`

- id and graph-run id;
- monotonic revision number;
- canonical graph JSON and fingerprint;
- planner artifact path;
- superseded revision id and bounded reason;
- status (`active`, `draining`, `superseded`, `completed`);
- created/superseded timestamps.

### `approach_node_runs`

- id, graph-run id, revision id, node id, node kind;
- monotonic visit number per revision/node;
- status (`ready`, `waiting-resource`, `launching`, `running`, `completed`, `blocked`, `failed-to-launch`, `stale`, `cancelled`);
- bounded outcome/reason/failure category;
- profile and resolved provider/model/effort;
- launch generation and process/session identity;
- instruction/evidence artifact paths;
- started/ended timestamps.

### `approach_graph_tokens`

- id, revision id;
- source node-run id or entry sentinel;
- edge id and destination node id/END;
- status (`pending`, `consumed`, `cancelled`);
- consuming node-run id;
- created/consumed timestamps.

### `approach_node_overrides`

- graph revision/node identity;
- user-selected provider/model/effort/profile override fields;
- updated timestamp.

All writes that complete a node, consume activations, create successor tokens, update counters, and change graph/revision status occur transactionally. Surrogate IDs permit retries and loops without destructive overwrites.

Large prompts, logs, plans, and output content remain files, never DB blobs. Canonical topology JSON is bounded and stored because reload must execute the exact validated revision even if the planner artifact or package later changes.

## Failure Semantics

Three classes remain distinct:

1. **Launch/configuration failure:** Karst could not execute a node. No graph outcome or edge is fabricated.
2. **Node execution outcome:** the node ran and produced a meaningful bounded outcome that topology may route.
3. **Ticket implementation-stage failure:** existing stage-machine semantics outside the graph.

Recoverable graph blocker kinds/categories include:

- `graph-plan-invalid`;
- `graph-capability-missing`;
- `graph-budget-exhausted`;
- `node-config-invalid`;
- `provider-unavailable`;
- `model-incompatible`;
- `effort-unsupported`;
- `instructions-missing`;
- `input-artifact-missing`;
- `output-artifact-missing`;
- `materialization-failed`;
- `session-launch-failed`;
- `command-infrastructure-error`;
- `resource-deadlock`.

The stage carries one new recoverable `BlockerKind`, `approach-graph-failed`, with a closed internal category and bounded reason identifying graph revision, node, kind, provider/model when applicable, and sanitized diagnostic. It renders as an error fault inside IMPL while remaining a blocker—not a failed verdict or new stage.

Resume rereads durable graph state and current configuration. Depending on the category it retries the same node, recompiles the planner artifact, resumes scheduling, or reruns the bootstrap planner. It never synthesizes node success, chooses fallback providers, or advances the stage.

## Reload, Multi-Window, and Stale Process Recovery

Graph reconciliation is project-scoped and runs on activation without requiring a dashboard.

- A running node owned by a live generation/process in another window is left alone.
- A node with no pid/generation evidence is never declared dead merely because this window cannot see its terminal.
- A demonstrably dead running/launching node is marked stale and the graph blocks for recoverable retry.
- A completed node whose successor tokens were committed is scheduled exactly once.
- Pending non-conflicting tokens resume scheduling.
- A draining revision waits for active work or continues replanning after quiescence.
- A blocked graph remains blocked until Resume/config change.
- A completed graph at `impl` remains awaiting the explicit stage marker.
- A ticket no longer at `impl` cancels unscheduled tokens and prevents new graph work without rewriting completed evidence.

Launch generations remain node-run-owned. Stale, duplicate, wrong-project, wrong-window, unknown-node, and out-of-order notifications cannot schedule work.

## Settings and Graph UI

No visual graph editor is required. Packaged planner prompts and user configuration remain editable.

Settings → Approaches provides:

- built-in enable/disable;
- bootstrap planner profile and prompt link;
- execution-profile provider/model/effort mappings;
- trusted command allowlist editor;
- concurrency and budget ceilings;
- generated-graph confirmation policy.

Settings → Agents exposes the complete effective bootstrap planner prompt and reusable base agent instructions. Editing creates project-local overrides under the configured `agentsDir`; Reset restores packaged content without mutating the VSIX.

The ticket Inside view projects the generated graph as an inspectable node/edge list or compact diagram with:

- active, ready, resource-waiting, completed, blocked, stale, and cancelled nodes;
- selected edge/outcome and replan lineage;
- provider/model/effort/profile per agent invocation;
- node visit counts and budgets;
- artifacts and deterministic command evidence;
- explicit reason a ready node is serialized rather than parallel;
- per-node overrides for pending agent nodes;
- graph confirmation/resume controls where configured.

The UI consumes persisted runtime state and does not define routing.

## Security Invariants

- The graph runtime exists only inside `impl`.
- Graph END and node completion cannot import or invoke the ticket stage machine.
- `stage`, `node`, and graph-planner submission remain separate closed CLI paths.
- Generated graph data cannot supply provider/model/effort, credentials, callback addresses, stage ids, timestamps, attempts, launch generations, raw shell, SQL, JavaScript, or arbitrary condition code.
- Agent completion cannot supply ticket, graph, revision, node, edge, destination, provider, model, effort, artifact root, callback URL, timestamp, or launch generation in argv.
- Free-form reasons are evidence only, collapsed/capped, and never routing labels.
- Commands resolve through trusted allowlist IDs and execute fixed argv without a shell.
- Artifact/resource paths are normalized and contained within declared roots.
- Edges and outcomes come from the pinned validated revision.
- Duplicate/stale/out-of-order events are idempotently rejected.
- Terminal exit or disappearance never implies success.
- Provider-specific flags stay inside adapters.
- Model and effort are individual argv values, never shell interpolation.
- Token accounting remains once at the adapter seam and stores no prompt/completion text.

## Verification Strategy

### Generated graph parsing and compilation

- document/string/collection bounds;
- safe unique IDs and contained paths;
- valid agent/command/gate/join nodes;
- unknown kind/profile/repository/command/artifact rejection;
- missing/multiple entries as allowed by schema;
- unknown edge source/destination/outcome;
- fan-out and conditional branching;
- unreachable and stranded branch rejection;
- valid END paths;
- loop budget requirement;
- join topology and join-in-cycle rejection;
- gate policy/operator validation;
- resource overlap validation;
- canonical fingerprint stability;
- generated provider/model/effort rejection.

### Profiles, commands, prompts, and delivery

- package/project profile merge and exact precedence;
- user node overrides;
- shared model catalog/custom IDs;
- effort-capability UI and adapter translation;
- trusted command direct argv, cwd, timeout, access, and environment;
- planner/base prompt override/reset/upgrade preservation;
- built-in enable/disable and analyzer/manual selection;
- complete tracked package source and VSIX byte parity.

### Scheduler and node executors

- bootstrap planner launch and graph submission;
- automatic scheduling after compilation;
- agent fresh-session/no-resume context;
- command exit/outcome mapping;
- gate deterministic outcomes;
- join waits for all inputs;
- fan-out launches all ready non-conflicting nodes;
- conditional outcome chooses only matching edges;
- loops create distinct visits and stop at budgets;
- expert escalation from deterministic counters;
- END quiescence without stage mutation;
- final explicit IMPL marker remains required.

### Parallel resource behavior

- read/read parallelism;
- disjoint same-repository path writes in parallel;
- overlapping write/write and read/write serialization;
- repository-wide command waits for writers;
- maxParallel enforcement;
- persisted waiting reason;
- stale process ownership prevents duplicate conflicting launch;
- no false claim that a dependency-waiting node is resource blocked.

### Completion/event safety

- valid complete/block/replan;
- agent cannot name destination;
- stale/duplicate/wrong-project/wrong-window/out-of-order rejection;
- unknown outcome rejection;
- durable completion before wake-up;
- callback without DB commit advances nothing.

### Replanning and recovery

- replan drains active work and stops new launches;
- revision N+1 supersedes without rewriting history;
- replan budget enforcement;
- reload during planning, compilation, parallel execution, join wait, loop, drain, block, and graph completion;
- dead process becomes stale, absent evidence remains untouched;
- Resume uses latest profile/provider/model/effort/prompt/command configuration;
- no terminal interpreted as success.

### Compatibility and project invariants

- existing non-graph approaches still launch unchanged;
- existing manifests do not require manual migration;
- ticket stage graph remains unchanged;
- project scoping prevents cross-window/cross-project scheduling;
- token usage recorded once at adapter seam;
- typecheck, focused Vitest suites, full `npm test`, and build pass.

## Architectural Rationale

The built-in approach is a planner plus a trusted runtime, not a predefined workflow. This adapts topology to task shape while keeping routing deterministic and auditable.

Execution profiles separate capability intent from vendors, so projects can move `expert` and `worker` work across Claude, Codex, Agy, OpenCode, and future adapters without regenerating topology.

Allowlisted commands keep deterministic verification cheap and authoritative. An LLM may decide that a configured `test` capability belongs in the plan; it cannot invent the executable that runs.

Artifacts prevent token cost from growing with cumulative transcripts. Fresh sessions consume only ticket context, bounded instructions, declared inputs, relevant repository state, and failure evidence.

Immutable revisions reconcile adaptability with recovery. Replanning is permitted and recorded, but a running revision never changes underneath the scheduler.

Resource-aware scheduling honors detailed planning by running all independent work concurrently. Its conservative serialization rules remain necessary because shared worktrees, Git state, generators, commands, stale processes, and newly discovered shared files are real execution constraints that a plan alone cannot enforce.

The result is a scalable implementation approach without turning Karst into a general workflow engine or weakening the ticket stage machine.
