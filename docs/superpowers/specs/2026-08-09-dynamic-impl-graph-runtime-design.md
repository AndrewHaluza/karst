# Dynamic IMPL Graph Runtime Design

## Summary

Karst will ship a built-in graph-engineering implementation approach. It has no predefined execution graph. When a ticket enters the approach, a configurable expert planner researches the ticket and repositories, writes detailed plan/task artifacts, and generates a task-specific graph. Karst validates and freezes that graph, then executes every ready, non-conflicting node through deterministic scheduler logic.

The runtime is strictly internal to the existing `impl` ticket stage:

```text
scope → impl → uat → review → fix → ship → done
          │
          └── dynamic implementation graph
```

It does not replace or generalize the ticket stage machine. Graph completion never creates a stage verdict. The existing explicit `karst stage impl pass` marker remains authoritative, but for a ticket with an active graph run that marker is accepted only after the matching graph run has durably reached `completed-awaiting-impl-marker`. The marker and graph close occur in one guarded transaction.

Karst, not an LLM, owns routing. Models plan and perform bounded work; they do not choose unvalidated destinations, execute arbitrary generated shell, or infer deterministic outcomes that Karst can observe itself.

## Product Goals

- Generate a detailed implementation graph appropriate to each ticket rather than shipping fixed execution topology.
- Support agent, allowlisted command, deterministic gate, and synchronization join nodes.
- Support bounded branching, loops, retries, expert escalation, and immutable replanning revisions.
- Run independent work concurrently while isolating every writing agent in node-owned execution workspaces; declared scopes guide scheduling and actual change sets are verified before integration.
- Configure reusable execution profiles and allow user-authored provider/model/effort overrides for individual generated nodes.
- Reuse the existing provider registry and shared live model catalog; never create graph-local provider/model lists.
- Use high-end models at high-leverage planning/diagnosis nodes, cheaper models for bounded implementation, and zero-token deterministic nodes wherever possible.
- Transfer explicit artifacts and evidence between fresh sessions instead of replaying prior transcripts.
- Persist enough identity and lineage for reload recovery, duplicate rejection, repeated visits, parallel branches, joins, retries, and graph revisions.
- Ship the approach inside the extension, permit disabling it, and expose its planner prompt for complete project-local customization.
- Keep compiler, scheduler, executors, persistence, adapters, and UI projections separate.
- Fail closed across projects, windows, processes, graph revisions, stage attempts, and agent transports.

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
- Agent-to-agent chat, peer delegation, or ACP/A2A-owned graph routing.

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
Guarded explicit IMPL pass action
```

The bootstrap planner is not a node in the graph it generates. It is a fixed, durable `PlannerRun` owned by the approach runtime and persisted before revision 1 exists. Its provider/model/effort come from the `planner` execution profile and may be customized like every other profile. Initial planning and replanning use the same planner-run protocol with distinct immutable run identities.

The approach launches automatically when the ticket's normal IMPL session is opened. A successful plan compiles and begins execution without requiring a second manual launch. Projects may enable a `confirmGeneratedGraph` policy to pause after compilation for review, but automatic execution is the default so the graph remains an orchestration workflow rather than a sequence of dashboard clicks.

## Selection and Enablement

The graph-engineering approach ships in the VSIX and requires no network installation. A host-owned `BUILT_IN_APPROACHES` registry overlays packaged definitions with project overrides by approach ID. Absence of a project entry means packaged defaults and enabled; `enabled: false` is a small persisted tombstone, not a copied package definition. Packaged upgrades may add or change defaults without overwriting explicit project fields.

- Create/edit starts with no approach unless the ticket already has an explicit persisted choice.
- The ticket-form analyzer is the only mechanism allowed to select an approach automatically.
- Analyzer output may set the picker only when there is no persisted choice and the user has never touched the picker in the current form session.
- After the picker is touched, later analysis is recommendation-only and never changes selection.
- Without analyzer selection, the user chooses an approach manually; there is no “recommended or first approach” fallback.
- An explicit or persisted user choice is never overwritten.
- Disabling removes it from analyzer candidates and new-ticket choices.
- Existing tickets already using it remain runnable.
- Re-enabling requires no reinstall and preserves project overrides.
- Personal approaches and agents remain independent.

The complete canonical source is tracked under `.agents/skills/karst-graph-engineering/**`. Before implementation planning, every ignored `.agents` package is inventoried: the abandoned `karst-two-phase` package is deleted or archived outside the shipped package namespace, and every remaining canonical shipped source is tracked. The repository adds narrow ignore exceptions only for canonical packages. The build copies the graph package into extension output, and a parity/inclusion test proves the VSIX contains the same bytes reviewers see in Git. CI fails when a canonical shipped package is ignored or untracked.

## Configuration Model

Project configuration controls planner behavior, reusable execution profiles, trusted commands, scheduling limits, and approval policy. The following shows the effective merged V1 shape; a project file may contain only the fields that differ from packaged defaults:

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
      maxActivations: 200
      maxGraphWallSeconds: 86400
      maxAgentWallSeconds: 7200
      maxAgentIdleSeconds: 1800
      maxArtifactBytes: 104857600
      maxAggregateArtifactBytes: 536870912
```

The built-in package ships profile/prompt/policy defaults but no repository-specific executable command definitions. The `test`, `typecheck`, and `build` entries above are project examples. The planner may emit a `CommandNode` only for an enabled command ID present in the effective project configuration.

Package defaults and project overrides merge by profile/command key. An omitted nested field inherits the packaged value. Reset removes only the explicit override. Disabling a packaged profile or command uses an explicit `enabled: false` tombstone; deletion never depends on an empty object. Settings writes only the current tab/section onto the manifest as it exists on disk at save time and never serializes the complete built-in definition.

### Execution policy resolution

Generated agent nodes reference a profile such as `expert`, `worker`, or `fast`. They cannot name a provider/model/effort. Users may override any non-active agent node selected for a future launch or retry, including `ready`, `blocked`, and `failed-to-launch`; override writes use a status/version compare-and-set and fail once launch claiming begins.

A ticket node override is scoped to `(graph revision, node ID)` and applies to every future unclaimed visit or retry of that node in that revision until cleared. It never mutates an active/frozen launch and does not automatically carry into a replanned revision, whose node identity/topology may mean something different. V1 has no one-visit-only override.

Resolution precedence is:

1. user-authored ticket graph node override;
2. project execution-profile override;
3. packaged execution-profile default;
4. ticket/project agent fallback only for intentionally unset fields;
5. adapter default for unresolved optional model/effort.

The provider must be implemented. Models reuse the existing live provider-filtered catalog and bounded custom-ID behavior. Model syntax, provider compatibility, and launch availability are separate facts: a custom ID may be syntactically valid without appearing in the catalog; a catalogued model may still be unavailable to the installed CLI or account. An explicitly selected provider never inherits a known incompatible model. When availability cannot be proven before launch, a bounded adapter-classified launch error produces `model-unavailable`; it never selects another model.

Graph agent transports disable or override core-level automatic model fallback for each launch and verify the effective provider/model from structured lifecycle data when the core exposes it. If a core cannot prevent a configured fallback and cannot prove which model actually ran, it lacks the `exact-model` graph capability and the node red-blocks before spending tokens. Silent fallback is forbidden even when it originates in a user's global core configuration.

Effort is optional and model-capability-aware. Adapter capabilities return suggested values for the selected model and whether a bounded custom value is allowed. A project/user explicit effort unsupported by the selected provider/model is a configuration failure; adapters never silently discard it. Provider-specific translation remains inside adapters and receives effort as one string value.

Initial adapter bindings are explicit:

| Core | Interactive binding | Suggested values | Validation |
|---|---|---|---|
| Claude Code | `--effort <value>` | `low`, `medium`, `high`, plus model-advertised `xhigh`/`max`/`ultracode` | selected model must advertise the value |
| Codex | `--config model_reasoning_effort=<value>` | `minimal`, `low`, `medium`, `high`, model-advertised `xhigh` | Responses-capable selected model must advertise the value |
| Agy | `--effort <value>` | values discovered with the model catalog | selected model entry must advertise the value |
| OpenCode | `--variant <value>` | model-specific variant IDs exposed by catalog discovery | effort is the selected model variant; no universal value list is assumed |

These bindings follow the current official [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), [Codex configuration reference](https://developers.openai.com/codex/config-reference/), [Agy CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md), and [OpenCode CLI/model documentation](https://dev.opencode.ai/docs/cli/). Adapter capability tests, rather than this prose alone, pin the supported installed-CLI behavior.

The packaged Claude Opus `max` and Claude Sonnet `low` defaults must validate against the packaged catalog/capability metadata. Unsupported cores expose no effort field. Custom values are retained and attempted only when that adapter explicitly supports custom variants; otherwise Save is rejected. Interactive and headless capability declarations are separate so support in one mode never implies support in the other.

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
      "producer": "$planner",
      "consumers": ["implement-api", "implement-web", "fix-implementation"],
      "mediaType": "text/markdown",
      "maxBytes": 262144,
      "required": true
    },
    {
      "id": "architecture-notes",
      "path": "artifacts/plan/architecture.md",
      "producer": "$planner",
      "consumers": [],
      "mediaType": "text/markdown",
      "maxBytes": 262144,
      "required": true
    },
    {
      "id": "api-task",
      "path": "artifacts/tasks/api.md",
      "producer": "$planner",
      "consumers": ["implement-api"],
      "mediaType": "text/markdown",
      "maxBytes": 131072,
      "required": true
    },
    {
      "id": "web-task",
      "path": "artifacts/tasks/web.md",
      "producer": "$planner",
      "consumers": ["implement-web"],
      "mediaType": "text/markdown",
      "maxBytes": 131072,
      "required": true
    },
    {
      "id": "fix-task",
      "path": "artifacts/tasks/fix.md",
      "producer": "$planner",
      "consumers": ["fix-implementation"],
      "mediaType": "text/markdown",
      "maxBytes": 131072,
      "required": true
    },
    {
      "id": "api-result",
      "path": "artifacts/results/api.md",
      "producer": "implement-api",
      "consumers": ["fix-implementation"],
      "mediaType": "text/markdown",
      "maxBytes": 262144,
      "required": true
    },
    {
      "id": "web-result",
      "path": "artifacts/results/web.md",
      "producer": "implement-web",
      "consumers": ["fix-implementation"],
      "mediaType": "text/markdown",
      "maxBytes": 262144,
      "required": true
    },
    {
      "id": "fix-result",
      "path": "artifacts/results/fix.md",
      "producer": "fix-implementation",
      "consumers": [],
      "mediaType": "text/markdown",
      "maxBytes": 262144,
      "required": true
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
      "forkFrom": "$entry",
      "waitFor": ["implement-api", "implement-web"],
      "mode": "all",
      "outcomes": ["complete"],
      "budget": { "maxVisits": 1 }
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
    "maxExpertRuns": 2,
    "maxReplans": 1
  }
}
```

Large prose and task instructions live in artifacts, not JSON fields. The graph holds bounded identifiers, paths, policies, and relationships.

### Node IDs and paths

Node, artifact, edge, profile, repository, and command IDs use a bounded safe identifier grammar. `$planner` and `$entry` are reserved sentinels and cannot be used as user node IDs. Unknown object fields are rejected rather than ignored. Every numeric value is a JSON number that must be a finite safe integer inside its field's explicit inclusive minimum/maximum; strings, fractions, negatives, `NaN`, and overflow are never coerced.

Artifact paths are normalized relative to the runtime-owned artifact root; resource paths are normalized relative to their declared repository root. Neither accepts absolute paths, empty/dot segments, or `..`. Windows validation additionally rejects drive/UNC escapes, alternate data streams, reserved devices, trailing dots/spaces, and inconsistent case/Unicode-normalization aliases. Resource paths denote exact files or directory subtrees rather than arbitrary glob expressions, making declared overlap deterministic. Physical scheduling and integration domains are keyed by canonical worktree realpath plus Git common-directory identity, not manifest repository name, because multiple repository entries may intentionally share one `repoPath`.

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

interface ArtifactDef {
  id: string;
  path: string;
  producer: '$planner' | string;
  consumers: string[];
  mediaType: 'text/markdown' | 'application/json' | 'text/plain';
  maxBytes: number;
  required: boolean;
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
  budget: NodeBudget;
}

interface JoinNode {
  id: string;
  kind: 'join';
  forkFrom: '$entry' | string;
  waitFor: string[];
  mode: 'all';
  outcomes: ['complete'];
  budget: NodeBudget;
}
```

### AgentNode

An agent node always launches a fresh interactive session in node-owned execution workspaces created from the canonical ticket integration heads observed when its activation is claimed. A workspace must have an independent working tree, index, HEAD/refs namespace, and writable Git metadata; an ordinary linked Git worktree sharing mutable common metadata is insufficient for concurrent writers unless the provider additionally sandboxes Git operations. A local clone/workspace provider may share immutable object storage but not writable refs/index state. Those per-repository base commits/digests are stored on the node run; sibling fan-out activations released by the same predecessor share the same base. Because predecessor completion includes integration, later dependent/loop nodes start from the already integrated state. The node receives current ticket context, its bounded instructions artifact, declared immutable input artifact instances/evidence, and only its isolated workspace locations. It receives no prior session ID or prior-node transcript.

The planner chooses a profile/capability tier. Only user/project configuration maps that tier to a provider/model/effort. A ticket graph view may override a non-active node's mapping before launch/recovery claiming, but generated graph content cannot.

On reported completion, the node enters `completing`; it does not release ownership. Karst asks the transport supervisor to terminate the interactive process tree, verifies termination, snapshots the actual diff for each physical repository, and rejects out-of-claim mutations as `resource-claim-violated`. Valid change sets are integrated into the ticket's canonical worktrees in deterministic node-run order under a physical-repository exclusive lock. Merge conflicts produce `integration-conflict` and preserve the isolated workspace plus canonical worktree for diagnosis; they never route `complete`. A process whose termination cannot be proven produces `termination-unknown`, retains its isolation/lock lease, and is never automatically retried.

### CommandNode

A command node references a project-configured allowlist ID. The trusted definition supplies executable, fixed argv, cwd policy, access mode, timeout, and permitted environment names. At graph compilation Karst resolves the executable to an absolute host path, derives the physical resource domain, and pins a fingerprint of executable path, argv, cwd policy, environment-name allowlist, access, timeout, and command-definition version into the revision. Changing a command definition requires recompilation or a new graph revision. The planner may select repository instances but cannot emit a command, add argv, insert shell operators, redirect streams, or invent environment values.

Karst executes the command directly without a shell and maps process results deterministically:

- exit code `0` → `passed`;
- non-zero exit code → `failed`;
- spawn, timeout, or infrastructure fault → `infrastructure-error`.

The node stores redacted, bounded stdout/stderr in immutable artifact logs and never asks an LLM whether the command passed. Command processes receive an explicit minimal environment; they never inherit `process.env`. Values come from host-owned safe variables, and provider credentials, graph/node capabilities, callback secrets, editor tokens, and unrelated repository secrets are excluded. Command logs are sensitive evidence and are never automatically attached to issue reports or unrelated node contexts.

For a node that names multiple repositories, Karst runs the same trusted command definition once per repository worktree, with each subprocess consuming the shared external-process ceiling, and aggregates results deterministically: any infrastructure fault wins `infrastructure-error`, otherwise any non-zero exit wins `failed`, otherwise the node is `passed`. Command `access` is conservatively configured by the project; npm test/build/typecheck examples use repository-wide `write` because tools may create caches, coverage, or generated files even when their purpose sounds read-only.

### GateNode

A gate evaluates a closed deterministic policy over persisted graph state and artifacts. V1 supports bounded policy primitives:

- node visit count comparison;
- node outcome count comparison;
- graph expert-run count comparison;
- artifact-exists predicate;
- `all`/`any` composition over those primitives.

Numeric comparisons use the closed operator set shown above. Gate output labels are always `matched` or `not-matched`; both require outgoing edges. Composite predicate depth and collection size are bounded by the graph parser. No JavaScript, shell, SQL, regular expression, or model-generated expression executes.

### JoinNode

A join is scheduler logic and spends no AI tokens. V1 supports structured fork/join regions. `forkFrom` identifies either the synthetic entry fork or one fan-out source node. Every execution of that fork creates a unique `fork_instance_id`; all descendant branch tokens carry its lineage. A `mode: all` join consumes exactly one arrival from every `waitFor` predecessor with the same fork instance, then emits `complete`.

The compiler requires the fork to dominate every branch, the join to post-dominate the declared branch region, and every declared branch to reach its predecessor without a conditional path that can omit that arrival. Join regions are acyclic, cannot overlap ambiguously, and cannot contain the join in a strongly connected component. These restrictions make V1 join pairing decidable. Loops may exist before a fork or after its join; each later fork visit creates a new lineage instance. Graphs needing conditional partial joins must replan into explicit gates/structured regions rather than relying on a join that may wait forever.

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

The scheduler persists activation tokens. A token records the source node run, edge, destination, graph revision, fork-lineage stack, and claim/consumption status. Non-join nodes consume one token per visit. A non-join node reached by distinct activations runs once per activation; fan-in that must synchronize uses an explicit join. Join nodes consume one correlated arrival from every declared predecessor as a set. Synthetic entry tokens have no source and share the root fork instance.

Claiming is transactionally single-winner across windows. In one `BEGIN IMMEDIATE` transaction Karst conditionally changes a token from `pending` to `claimed`, creates or reserves its node-run visit, reserves graph/node/expert/concurrency budgets, acquires durable physical-resource leases, and stores the claiming run. Scheduling continues only when exactly one row changed. External launch occurs after commit. Completion transactionally changes the claimed token to `consumed`, records the effective outcome, updates counters, and inserts successor tokens with a uniqueness constraint on `(source_node_run_id, edge_id, fork_instance_id)`. A launch retry reuses the reserved node-run/visit and increments a launch-attempt counter; it does not create another logical visit.

`END` tokens do not immediately cancel other work. A graph revision completes only when at least one END token exists and no pending/claimed non-END token, unsatisfied structured join, completing process, integration operation, or active node run remains. Compile-time structured checks reject known stranded regions; if persisted runtime state nevertheless becomes quiescent with an unsatisfied activation, Karst blocks with `graph-topology-deadlock` rather than declaring END.

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
- structured fork dominance, join post-dominance, branch completeness, lineage, and predecessor equality;
- no join region inside a strongly connected component or conditional partial join;
- every schedulable node, including gates and joins, carries a finite visit budget; SCCs also have a finite aggregate visit bound;
- aggregate graph/expert/replan budgets do not exceed project maxima;
- graph expert budget is not lower than expert/planner runs already spent and reserves one additional planner run for every permitted replan;
- every referenced profile, repository, command, prompt, and input artifact exists;
- every planner-produced artifact file exists at compile time and every node-produced output has one declared safe destination;
- command repositories satisfy the trusted command definition and each effective command fingerprint/resource claim is pinned;
- normalized resource paths remain within declared repository roots;
- all resource claims are valid and every overlap is recorded for scheduler serialization;
- generated nodes cannot configure provider/model/effort directly;
- gate policies reference valid node/artifact IDs and bounded comparison values.

Compilation produces an immutable canonical topology/configuration document and SHA-256 fingerprint. Canonical bytes use RFC 8785 JSON Canonicalization Scheme over the validated/default-expanded document, encoded as UTF-8. The exact bytes and pinned command fingerprints are persisted as a graph revision. Provider/model/effort and prompt bytes remain deliberately late-bound per agent launch and their resolved values/hashes are recorded on that invocation. Invalid graphs red-block planning with structured diagnostics; Karst never “fixes” unsafe topology silently.

## Parallel Scheduling and Resource Claims

The scheduler starts every ready node up to the shared external-process ceiling whose declared resource claims and physical integration domains do not conflict. Each agent session and each per-repository command subprocess consumes one execution slot; gates and joins consume none.

Conflict rules are deterministic:

- read/read on the same path may run together;
- write/write overlap conflicts;
- write/read overlap conflicts;
- directory claims overlap descendants;
- repository-wide claims overlap every path in that repository;
- trusted commands inherit access and repository breadth from the pinned allowlist definition, not planner prose;
- joins and pure gates claim no repository resources;
- a node waiting on dependencies is not ready and acquires no resources.

Writing agents never share a mutable workspace or writable Git metadata. Path-disjoint agents may run concurrently in isolated node workspaces created from the same pinned integration base. Their change sets integrate serially under physical-repository locks after actual-diff validation. Read-only nodes may share a snapshot only when the executor enforces read-only access. Repository-wide commands run against the canonical integrated ticket worktree and wait for all conflicting integrations/readers; commands with `write` access take the physical repository exclusively.

### Why detailed plans still need scheduler conflict checks

The planner's detailed assignment is the primary source of parallelism. Karst does not serialize unrelated nodes merely because they belong to one graph. Isolation and runtime checks preserve that plan under real execution conditions:

- agents may discover a shared file that the initial task list did not mention;
- formatters, generators, builds, tests, and Git operations often observe or mutate repository-wide state;
- multiple manifest repository names may share one physical worktree and Git metadata;
- an extension crash can leave an old process alive while recovery considers another launch;
- a replan may change resource ownership while prior work is draining.

Therefore “not started in parallel” means declared or trusted resource claims overlap, isolated workspace or integration capacity is unavailable, the shared process budget is full, a durable physical-domain lease is held, or a dependency/join is incomplete. This reason is persisted and shown in graph state so deliberate serialization never looks like a scheduler defect. Ready ordering is deterministic by activation creation time and token ID, with bounded aging so a wide-resource node cannot starve behind repeatedly generated narrow loop work.

Resource claims are scheduling and validation declarations, not a security sandbox. The node executor compares the captured change set with declared writes; any expansion requires a `replan` or a future explicit claim-expansion protocol after conflicts drain. V1 never silently widens a running node's claim. Durable leases remain held until the supervised process tree is confirmed terminated and its change set is either integrated, preserved behind a blocker, or explicitly discarded by the user.

## Artifacts and Context Policy

Artifacts are the first-class communication channel between nodes. `ArtifactDef` describes a logical artifact; every production creates an immutable `ArtifactInstance` keyed by graph revision, producer planner/node run, visit, and fork lineage. The instance stores logical artifact ID, content-addressed runtime-owned snapshot path, SHA-256, byte size, media type, producer identity, and creation time. Loop visits and replans therefore never overwrite prior evidence.

Karst creates a private per-run artifact root outside repository diffs with restrictive permissions. Before launch, every required output staging destination must be absent. At submission/completion it walks every existing path component without following links, rejects symlinks/reparse points and non-regular or multiply linked output files, applies platform-safe canonical containment, validates declared type/size, and atomically copies bytes into immutable content-addressed storage. Consumers read only the snapshot whose hash was recorded; the mutable staging path is never authoritative. `graph.json`, planner artifacts, command logs, and diff/change-set artifacts use the same snapshot protocol.

Agent context is assembled from:

- freshly rendered ticket context;
- the node's instructions artifact;
- declared input artifacts;
- declared command/failure evidence;
- relevant isolated workspace or canonical repository paths appropriate to the executor;
- optional current diff scoped to the node's repositories.

It explicitly excludes previous interactive transcripts. Fresh node visits never receive `--resume` for another node, even when the provider is identical.

Karst resolves each input to the newest successful artifact instance in the activation's causal lineage. Planner artifacts are roots. `artifact-exists` gates inspect causal instances, not any historical file with the same logical ID. Ambiguous or missing bindings block rather than selecting globally “latest.”

Karst validates required output artifacts before accepting an effective `complete`. The agent-authored `complete` remains immutable reported evidence, but missing/unsafe output leaves effective outcome null and moves the node/graph to recoverable `output-artifact-missing` or `artifact-unsafe`; no edge is emitted.

Prompt/completion text is never written to SQLite. Prompt hashes, immutable artifact paths, and bounded metadata are stored. Artifacts and logs are sensitive by default, excluded from unrelated node context and issue reporting, and displayed only through explicit user actions.

## Completion CLI and Trust Boundary

Graph planner and agent sessions receive host-owned environment values:

- writable registry path and manifest/project identity required by the CLI;
- ticket id;
- graph run id;
- planner run id, or graph revision and node run id;
- launch generation;
- fixed artifact root;
- loopback callback URL.
- a node/planner-run-specific completion capability.

The completion capability is a CSPRNG-generated bearer secret of at least 256 bits. SQLite stores only its cryptographic hash. The plaintext exists only in that supervised process environment; it is never placed in argv, callback URLs, logs, diagnostics, artifacts, UI state, or issue reports.

Planner submission and node completion have separate closed parsers from each other and from `stage`:

```text
karst graph submit
karst node complete
karst node block --reason <text>
karst node replan --reason <text>
```

`karst graph submit` accepts no path or outcome; it reads and snapshots the fixed planner artifact assigned by the host. Node commands accept only the closed verb and bounded reason shown. Neither parser accepts ticket key/id, stage, attempt, graph/revision/node/planner-run id, destination, profile, provider, model, effort, artifact root, callback address, timestamp, capability, or launch generation in argv. Trailing argv is rejected.

The CLI fails closed unless project identity and a compatible schema version are present. It never falls back to an unscoped ticket lookup. It conditionally updates only the `running` planner/node-run row identified by host environment and matching project, ticket, stage attempt, graph, revision when applicable, run ID, generation, status, and capability hash. Node completion validates the outcome against the pinned node definition and caps/collapses evidence text. Planner submission snapshots `graph.json` and planner artifacts, then marks only that planner run submitted. Durable state commits before a wake-up. Duplicate, stale, wrong-project, wrong-attempt, or wrong-capability completion is an idempotent rejection.

The loopback notification is only a wake-up. The endpoint derives bounded routing identity from its host-created target, returns a fast response, rate-limits malformed/stale requests, and schedules the graph coordinator. No bearer capability appears in the URL. The coordinator rereads canonical state before selecting any edge.

The graph/node parsers never import the ticket stage machine. Graph events cannot create a `Verdict`.

## Agent Transport Boundary

Graph semantics depend on an injected `AgentTransport`, not directly on provider CLI construction:

```ts
interface AgentTransport {
  capabilities(): AgentTransportCapabilities;
  start(request: AgentNodeLaunch): Promise<SupervisedAgentSession>;
  terminate(session: SupervisedAgentSession): Promise<TerminationProof>;
}
```

Existing provider CLI adapters remain supported through a supervised CLI transport. The supervisor persists an owner nonce before spawn, then records process group/PID, process start identity, provider session ID, and generation immediately after spawn. ACP may be added as an optional preferred transport when a core supports it. ACP can launch, stream, request permissions, cancel, and report lifecycle for one host-selected node run. It cannot generate or mutate topology, activate edges, choose destinations, delegate graph work to peers, supply canonical outcomes outside the guarded completion protocol, or replace artifacts as the inter-node communication contract. V1 does not require ACP.

Transport termination must produce positive process/session lifecycle evidence. Terminal disposal alone is insufficient. An ambiguous `launching` crash becomes `launch-unknown`; unknown termination becomes `termination-unknown`. Neither is automatically retried or releases physical-resource leases.

## Scheduler Runtime

Karst owns the execution loop:

1. Create one graph run for the ticket/project/`impl` attempt and a durable bootstrap `PlannerRun` before external work.
2. Launch the planner through the agent-node executor using the current `planner` profile.
3. On guarded planner submission, snapshot the fixed graph/artifacts, compile them, and persist revision 1 plus synthetic root fork and entry tokens transactionally.
4. Reconcile tokens, dependencies, joins, resource claims, and budgets.
5. Atomically claim an activation, reserve its node run/budgets/leases, and move the run through `ready` to `launching` before external work begins.
6. Dispatch by node kind through injected executors.
7. Freeze the current node override plus resolved profile/provider/model/effort/prompt hash and launch generation for that launch attempt.
8. For agents, accept reported outcome as evidence, terminate the supervised session, snapshot outputs/change sets, validate claims, and integrate changes before deriving an effective outcome.
9. Persist effective outcome, consume the claimed activation, create idempotent successor tokens, update counters, and release proven-safe leases in one transaction.
10. Continue scheduling every eligible node.
11. On END quiescence, mark the graph run completed and keep the explicit IMPL marker separate.

Graph planner and node seeds never contain the generic IMPL done-marker instruction or `cliStagePrefix`. No node is authorized to issue a stage marker as part of its completion sequence.

After END quiescence the graph status is `completed-awaiting-impl-marker`. The Inside view exposes an explicit “Complete implementation” action; a user may also invoke the normal marker from a separately refreshed trusted IMPL session. Both use one `GraphImplMarkerGuard`. In the same transaction that calls the existing transition path, the guard requires the current project/ticket/stage attempt, exactly one active graph run in `completed-awaiting-impl-marker`, and no pending/claimed activations, unsatisfied joins, completing/integrating/active node runs, or held ambiguous-process leases; it then marks the graph `closed`. Any earlier marker is rejected without mutation. Non-graph approaches retain their current marker behavior. The graph status is an entry condition, not a verdict, and the scheduler never writes or infers `passed`.

Scheduler state is keyed by graph/revision/node-run IDs rather than only ticket id. The current ticket-level session assumptions must be generalized across `SessionManager`, lifecycle hooks, launch generations, provider session IDs, recovery, and waiting state. Graph hooks carry host-generated node-run identity in their endpoint route, never in an agent-authored body or cwd inference. Ticket-level agent state becomes a projection over active node runs; existing ticket session fields remain only for legacy approaches.

Cross-provider or same-provider node handoff always creates a fresh session generation. A node may be focused/reopened while it is the same running invocation, but a different node never resumes its conversation.

## Immutable Replanning

`replan` is a bounded agent outcome, not a topology mutation instruction.

When one or more nodes request replan:

1. elect exactly one initiator with a conditional `active → draining` transaction; only the winner increments accepted replan count;
2. stop launching new nodes from that revision;
3. persist later replan requests as bounded evidence without launching another planner;
4. allow already running deterministic/agent nodes to finish, terminate/snapshot them, and record artifacts/evidence, but suppress all successor creation once the revision is draining;
5. cancel pending activations and finish/cancel claimed activations once active work quiesces;
6. allocate exactly one new `PlannerRun` transactionally with quiescence and the next planner-run counter;
7. launch the bootstrap planner with the original ticket context, prior plan/graph snapshots, completed artifacts, failures, diffs, resource conflicts, and the elected plus secondary replan reasons;
8. validate a complete new graph document;
9. persist revision N+1 with `supersedes_revision_id` and bounded rationale;
10. create a new root fork/entry tokens and resume scheduling.

Prior revisions, planner runs, node runs, activations, artifact instances, and outcomes remain immutable history. Provider/model/effort/prompt configuration still resolves at each new agent launch and is frozen for that attempt. Pinned command definitions change only through recompilation/new revision. Project and product hard `maxReplans` prevent unbounded expert replanning. `maxExpertRuns` explicitly includes bootstrap and replan planner runs plus graph agent runs resolved to the `expert` profile.

If other work never quiesces, Stop/Resume controls resolve it; Karst does not infer cancellation success.

## Budgets and Escalation

Project maxima cap planner-generated budgets. V1 enforces:

- graph node-run count;
- graph expert-profile run count;
- graph replan count;
- node visit count;
- total created/pending activation count;
- maximum concurrently active external processes;
- graph, planner, agent, and idle wall time;
- command timeout;
- repositories per command;
- per-artifact, per-log, and aggregate artifact bytes across revisions;
- bounded scheduler actions per reconciliation tick.

Product hard ceilings apply even when project configuration requests more. V1 constants are: `maxParallel <= 8`, `maxNodeRuns <= 200`, `maxExpertRuns <= 10`, `maxReplans <= 5`, `maxVisits <= 20` per node, `maxActivations <= 1000`, graph lifetime `<= 72h`, planner/agent wall time `<= 8h`, idle time `<= 2h`, command timeout `<= 2h`, repositories per command `<= 20`, per artifact `<= 100 MiB`, per log `<= 10 MiB`, aggregate graph artifacts `<= 1 GiB`, and scheduler work `<= 100` state transitions per tick. All duration/count/size fields use finite safe-integer parsing. Exceeding any hard or configured limit blocks without routing.

Every logical node visit, including zero-token gate and join visits, counts toward `maxNodeRuns` and its node's `maxVisits`. Every planner invocation counts toward both the planner-run and expert-run ceilings. `maxParallel` counts external processes, not logical nodes.

Exceeding a budget produces a bounded deterministic outcome when the topology declares a gate/edge for it; otherwise the graph blocks with `graph-budget-exhausted`. A loop without a finite node-visit budget is rejected.

Escalation is expressed through deterministic evidence and graph topology. A gate can count repeated command failures or worker visits and route to an `expert` agent node. Self-reported confidence may be stored in an artifact but is not a routing primitive.

Token usage remains measured once at the agent seam. `instrumentedAdapter` continues to own headless accounting; an `instrumentedAgentTransport` owns interactive lifecycle usage and records provider-reported totals when available, with graph/planner/node/profile attribution and closed call-site IDs. A transport that cannot report usage records `unknown`, never a fabricated zero. No caller double-counts. V1 limits financial exposure deterministically through expert/agent run and wall-time ceilings; provider-reported hard cost caps may be used when supported, but Karst does not kill a session at an estimated token boundary or claim an unenforceable universal token cap.

## Persistence

Graph execution requires explicit durable identity. `phase_marks` cannot distinguish generated topology revisions, parallel activations, repeated node visits, joins, or replanning. It remains historical UI evidence for legacy approaches but does not drive the graph runtime.

V1 adds the following focused tables:

### `approach_graph_runs`

- id;
- ticket id and project ownership through the ticket;
- fixed stage key `impl` and stage attempt;
- approach id;
- status (`planning`, `awaiting-confirmation`, `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`, `closed`, `stale`);
- active revision id;
- created/updated/completed timestamps;
- planner/expert/node/replan counters.

### `approach_planner_runs`

- id and graph-run id;
- nullable target revision number and monotonic planner-run number;
- kind (`bootstrap`, `replan`);
- status (`ready`, `launching`, `running`, `submitted`, `blocked`, `launch-unknown`, `stale`, `cancelled`);
- selected profile and resolved provider/model/effort/prompt hash;
- launch attempt, generation, process/session identity, owner nonce, and completion-capability hash;
- submitted graph/artifact snapshot IDs and bounded reason;
- started/submitted/ended timestamps.

### `approach_graph_revisions`

- id and graph-run id;
- monotonic revision number;
- canonical graph JSON and fingerprint;
- immutable planner graph/artifact snapshot IDs;
- pinned command-definition fingerprints and derived physical resource domains;
- superseded revision id and bounded reason;
- status (`active`, `draining`, `superseded`, `completed`);
- created/superseded timestamps.

### `approach_node_runs`

- id, graph-run id, revision id, node id, node kind;
- monotonic visit number per revision/node;
- status (`ready`, `waiting-resource`, `launching`, `running`, `completing`, `integrating`, `completed`, `blocked`, `failed-to-launch`, `launch-unknown`, `termination-unknown`, `stale`, `cancelled`);
- reported outcome, nullable effective outcome, bounded reason/failure category;
- profile and resolved provider/model/effort/prompt hash;
- launch attempt, generation, process/session identity, owner nonce, and completion-capability hash;
- instruction/input/output artifact-instance IDs and change-set identity;
- started/ended timestamps.

### `approach_graph_tokens`

- id, revision id;
- source node-run id or entry sentinel;
- edge id and destination node id/END;
- fork instance and bounded fork-lineage identity;
- status (`pending`, `claimed`, `consumed`, `cancelled`);
- claiming/consuming node-run id;
- created/consumed timestamps.

### `approach_artifact_instances`

- id, graph run/revision, logical artifact id;
- producer planner/node run and fork lineage;
- content-addressed snapshot path, SHA-256, media type, byte size;
- sensitivity and created timestamp.

### `approach_resource_leases`

- graph/node-run owner;
- canonical physical worktree/Git domain;
- access mode and normalized claimed paths;
- status (`held`, `released`, `ambiguous-process`);
- acquired/released timestamps.

### `approach_node_overrides`

- graph revision/node identity;
- user-selected provider/model/effort/profile override fields;
- row version and updated timestamp.

Foreign keys, closed-value `CHECK`s, and unique indexes enforce the state model. Required uniqueness includes one graph run per ticket/stage attempt (with the selected approach ID recorded), one revision number per run, one planner-run number per run, one node visit per revision/node, one claimant per token, one successor per `(source node run, edge, fork instance)`, and at most one active revision per graph run. Every graph write joins through the ticket and requires current project plus stage attempt. Token claim, visit allocation, budget reservation, lease acquisition, and launch-state transition occur in one immediate transaction and proceed only after affected-row checks. Replan election and graph close use the same compare-and-set discipline. Correctness never depends on an in-memory single-flight or one open window.

All writes that finalize a node, consume claimed activations, create successor tokens, update counters, and change graph/revision status occur transactionally. Surrogate IDs permit retries and loops without destructive overwrites.

Large prompts, logs, plans, and output content remain immutable files, never DB blobs. Canonical topology JSON is bounded and stored because reload must execute the exact validated revision even if the planner artifact or package later changes.

The additive schema migration is idempotent and atomic under a cross-window migration lock. All graph tables, indexes, constraints, and the new `user_version` commit in one transaction. Graph-writing host and CLI paths require an explicit compatible schema range and fail closed on both older and newer unsupported schemas. Tests cover concurrent open, interrupted/partial prior state, and retry.

## Module and Dependency Boundaries

Implementation follows one-way dependencies:

```text
pure graph schema/parser
        ↓
pure compiler/canonicalizer
        ↓
driver-agnostic graph store + transactional operations
        ↓
coordinator/scheduler
        ↓
injected planner/agent/command/gate/join/integration executors
        ↓
provider adapters and AgentTransport implementations

persisted stores → read-only UI projections
extension.ts     → composition/wiring only
```

The compiler never imports stores, providers, VS Code, or the ticket stage machine. The store never launches processes. Executors never choose edges. Provider adapters never contain graph transitions. UI actions call coordinator/store services and do not mutate graph semantics locally. Only extension composition imports VS Code. The guarded IMPL marker service is the sole graph/stage integration point; graph/node CLI handlers may import driver-agnostic graph-store operations but never the workflow machine.

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
- `model-unavailable`;
- `effort-unsupported`;
- `instructions-missing`;
- `input-artifact-missing`;
- `output-artifact-missing`;
- `artifact-unsafe`;
- `materialization-failed`;
- `session-launch-failed`;
- `launch-unknown`;
- `termination-unknown`;
- `command-infrastructure-error`;
- `resource-claim-violated`;
- `integration-conflict`;
- `graph-topology-deadlock`.

The stage carries one new recoverable `BlockerKind`, `approach-graph-failed`, with a closed internal category and bounded reason identifying graph revision, deterministic primary node, kind, provider/model when applicable, and sanitized diagnostic. Parallel faults are all persisted on their planner/node runs; the stage block projects the earliest failure by durable event order while Inside lists every blocking run. The first graph fault stops new launches and drains already active work so additional evidence is recorded without multiplying damage. It renders as an error fault inside IMPL while remaining a blocker—not a failed verdict or new stage.

Resume is graph-aware. Generic `stageResume` must not clear `approach-graph-failed` by itself; it returns/routes a typed graph recovery action. The coordinator atomically claims recovery, rereads current configuration, and clears the visible stage block only after retry/recompile/replan has durably entered a recoverable state. It never synthesizes node success, chooses fallback providers, or advances the stage.

Recovery is category-specific:

| Category | Resume action |
|---|---|
| provider/model/effort/prompt configuration | retry the same reserved visit using the latest late-bound configuration and a new launch attempt |
| planner graph invalid or planner artifacts missing | rerun a new planner run, subject to planner/replan budget |
| command definition changed | compile a new revision before execution |
| launch failure with proven no process | retry the same reserved visit |
| `launch-unknown` or `termination-unknown` | require positive process resolution or explicit user cleanup; never automatic retry |
| output/artifact/resource-claim fault | replan or explicit retry after corrected artifacts/claims |
| integration conflict | preserve isolated workspaces and canonical worktrees, then route to replan/expert diagnosis or explicit user resolution |
| budget exhaustion | require configuration change within hard caps and explicit Resume |

The red fault deep-links to the exact node/profile/prompt/command editor. Overrides are editable for blocked or failed-to-launch nodes before recovery claiming begins.

## Reload, Multi-Window, and Stale Process Recovery

Graph reconciliation is project-scoped and runs on activation without requiring a dashboard.

- A running node owned by a live generation/process in another window is left alone.
- A node with no pid/generation evidence is never declared dead merely because this window cannot see its terminal.
- `ready → launching` persists owner nonce and leases before spawn; `launching → running` persists PID/process-start/session identity immediately after spawn.
- A crash before spawn is provably retryable; a crash after possible spawn but before identity is `launch-unknown` and blocks.
- A demonstrably dead running node is marked stale and the graph blocks for recoverable retry; unknown process-tree death retains leases and becomes `termination-unknown`.
- A completed node whose successor tokens were committed is scheduled exactly once.
- Pending non-conflicting tokens resume scheduling.
- A draining revision waits for active work or continues replanning after quiescence.
- A blocked graph remains blocked until Resume/config change.
- A completed graph at `impl` remains awaiting the explicit stage marker.
- A ticket no longer at `impl` cancels unscheduled tokens and prevents new graph work without rewriting completed evidence.

Launch generations and completion capabilities remain planner/node-run-owned. Stale, duplicate, wrong-project, wrong-window, wrong-attempt, wrong-capability, unknown-node, and out-of-order notifications cannot schedule work. Coordinator correctness comes from durable conditional claims, so multiple windows may reconcile concurrently without duplicate external work.

## Settings and Graph UI

No visual graph editor is required. Packaged planner prompts and user configuration remain editable.

Settings → Approaches provides:

- built-in enable/disable;
- bootstrap planner profile and prompt link;
- execution-profile provider/model/effort mappings;
- trusted command allowlist editor;
- concurrency and budget ceilings;
- generated-graph confirmation policy.

The package owns two stable editable prompt identities:

| Settings agent ID | Packaged path | Project override path |
|---|---|---|
| `karst-graph-planner` | `.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md` | `<agentsDir>/karst-graph-engineering/graph-planner.md` |
| `karst-graph-node` | `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` | `<agentsDir>/karst-graph-engineering/graph-node.md` |

The package root `.agents/skills/karst-graph-engineering/SKILL.md` is the approach entry descriptor and remains visible in the packaged-source view. Settings → Agents exposes the complete effective planner and node-base prompts with precedence `project override → packaged prompt`. Editing writes only the stable project override. Reset deletes only that override; it never mutates VSIX bytes. Extension upgrades replace packaged bytes while preserving overrides. Built-in prompt rows are editable through this override mechanism; third-party approach-contributed agents retain their existing read-only behavior unless their package explicitly declares the same supported override contract.

The ticket Inside view projects the generated graph as an inspectable node/edge list or compact diagram with:

- active, ready, resource-waiting, completed, blocked, stale, and cancelled nodes;
- selected edge/outcome and replan lineage;
- provider/model/effort/profile per agent invocation;
- node visit counts and budgets;
- artifacts and deterministic command evidence;
- explicit reason a ready node is serialized rather than parallel;
- per-node overrides for ready, blocked, or failed-to-launch agent nodes before launch/recovery claiming;
- graph confirmation/resume controls where configured.

Background execution emits bounded structured diagnostics keyed by project, ticket, stage attempt, graph, revision, planner/node run, and generation. Closed event categories cover compile, claim, defer, launch, completion rejection, integration, recovery, replan, block, and close. Inside provides “Copy diagnostic”/“Open log” without including completion capabilities, prompt/completion text, secrets, or unredacted command output.

The UI consumes persisted runtime state and does not define routing. Every graph-derived label, reason, artifact name, and log line is rendered as text or through one audited HTML/attribute escaper; ANSI/control sequences and unsafe link schemes are removed, and the webview CSP remains authoritative.

## Security Invariants

- The graph runtime exists only inside `impl`.
- Graph END and node completion cannot import or invoke the ticket stage machine; the sole integration is the graph-aware IMPL marker guard after durable quiescence.
- An active graph approach's IMPL marker is impossible before the matching project/ticket/stage attempt is `completed-awaiting-impl-marker`.
- Project identity is mandatory and graph/marker writes never fall back to unscoped ticket lookup.
- `stage`, `node`, and graph-planner submission remain separate closed CLI paths.
- Generated graph data cannot supply provider/model/effort, credentials, callback addresses, stage ids, timestamps, attempts, launch generations, raw shell, SQL, JavaScript, or arbitrary condition code.
- Agent completion cannot supply ticket, graph, revision, node, edge, destination, provider, model, effort, artifact root, callback URL, timestamp, capability, or launch generation in argv.
- Free-form reasons are evidence only, collapsed/capped, and never routing labels.
- Commands resolve through pinned trusted allowlist IDs, an absolute executable, fixed argv, and a minimal explicit environment without a shell or agent secrets.
- Artifact paths are canonically contained, link-safe, immutable snapshots; resource safety uses physical worktree/Git domains rather than repository aliases.
- Writing agents run in isolated workspaces with independent writable Git metadata; actual diffs must fit declared claims before deterministic integration.
- No resource lease is released while process termination is unknown.
- Edges and outcomes come from the pinned validated revision.
- Every completion requires a run-specific unforgeable capability; duplicate/stale/out-of-order events are idempotently rejected.
- Token claiming, visit allocation, budget accounting, successor creation, replan election, and graph close are transactionally single-winner across windows.
- A draining or superseded revision may accept evidence but can never emit successors.
- Terminal exit or disappearance never implies success.
- Generated strings and logs are bounded, redacted, escaped, treated as sensitive, and excluded from unrelated context/reporting by default.
- Product hard runtime, activation, disk, concurrency, and expert-run ceilings cannot be raised by generated or project configuration.
- Schema migrations and graph CLI compatibility are atomic and fail closed.
- Provider-specific flags stay inside adapters.
- Model and effort are individual argv values, never shell interpolation.
- ACP is transport-only and cannot own routing, outcomes, topology, or peer delegation.
- Token accounting remains once at the headless-adapter or interactive-transport seam and stores no prompt/completion text.

## Verification Strategy

### Generated graph parsing and compilation

- document/string/collection bounds;
- safe unique IDs and contained paths;
- valid agent/command/gate/join nodes;
- unknown kind/profile/repository/command/artifact rejection;
- missing/multiple entries as allowed by schema;
- unknown edge source/destination/outcome;
- fan-out and conditional branching;
- unreachable node/artifact and structurally stranded region rejection;
- valid END paths;
- loop budget requirement;
- structured fork lineage, dominance/post-dominance, conditional-partial-join, and join-in-cycle rejection;
- gate policy/operator validation;
- finite safe-integer and unknown-field rejection;
- repository-alias physical-domain/resource overlap validation;
- RFC 8785 canonical fingerprint stability;
- generated provider/model/effort rejection.

### Profiles, commands, prompts, and delivery

- package/project profile merge and exact precedence;
- built-in registry absence/default, enable tombstone, field reset/delete, and upgrade merging;
- user node overrides including blocked retry and launch-claim CAS;
- shared model catalog/custom IDs;
- distinct model syntax, compatibility, and launch-availability failures;
- core-level fallback disabled/detected; inability to prove exact model blocks;
- Claude/Codex/Agy/OpenCode effort-capability UI and exact adapter translation;
- packaged Claude Opus max and Sonnet low defaults validate;
- trusted command absolute executable/direct argv, cwd, timeout, access, pinned fingerprint, and minimal environment;
- planner/base prompt override/reset/upgrade preservation;
- analyzer-only automatic selection, untouched/touched create/edit behavior, and no first fallback;
- complete tracked package inventory, abandoned two-phase retirement, ignored/untracked CI failure, and VSIX byte parity.

### Scheduler and node executors

- durable bootstrap/replan planner identity, capability-authenticated fixed-path submission, and duplicate rejection;
- automatic scheduling after compilation;
- agent fresh-session/no-resume context;
- optional ACP transport obeys the same outcome/routing boundary;
- command exit/outcome mapping;
- gate deterministic outcomes;
- join waits for correlated fork-instance inputs;
- fan-out launches all ready non-conflicting nodes;
- conditional outcome chooses only matching edges;
- loops create distinct visits and stop at budgets;
- expert escalation from deterministic counters;
- END quiescence without stage mutation;
- graph node/planner seeds contain no stage marker;
- `stage impl pass` rejects before quiescence and closes exactly once afterward in the guarded transaction.

### Parallel resource behavior

- read/read parallelism;
- disjoint writers run in isolated node workspaces and integrate deterministically;
- actual out-of-claim diff blocks before integration;
- overlapping integration and repository-wide commands serialize by physical domain;
- repository aliases sharing `repoPath` conflict correctly;
- integration conflict preserves work and blocks/replans;
- shared external-process ceiling counts agents and per-repository command processes;
- persisted waiting reason;
- stale/unknown process ownership retains leases and prevents conflicting launch;
- no false claim that a dependency-waiting node is resource blocked.

### Completion/event safety

- valid complete/block/replan;
- agent cannot name destination;
- stale/duplicate/wrong-project/wrong-window/out-of-order rejection;
- unknown outcome rejection;
- durable completion before wake-up;
- node-specific capability validation;
- callback without DB commit advances nothing;
- concurrent windows claim one token/node visit and create one successor set;
- graph-derived UI/log injection fixtures remain escaped and bounded.

### Artifacts and integration

- symlink/reparse, hardlink, non-regular, pre-existing output, traversal, Windows alias, oversize, and type mismatch rejection;
- graph/planner/node/command artifacts snapshot immutably with hashes;
- loop/replan visits retain distinct artifact instances;
- consumers resolve only causal-lineage instances;
- agent process terminates before snapshot/integration/lease release;
- ambiguous termination blocks and does not retry;
- command logs are redacted and excluded from issue reports/unrelated context.

### Replanning and recovery

- concurrent replan requests elect one initiator and one planner run;
- draining completions record evidence but create no successors;
- revision N+1 supersedes without rewriting history;
- replan budget enforcement;
- reload during planning, compilation, parallel execution, join wait, loop, drain, block, and graph completion;
- dead process becomes stale, absent evidence remains untouched;
- graph-aware Resume claims recovery before clearing the stage block;
- Resume uses latest provider/model/effort/prompt for the same reserved visit;
- changed trusted command configuration requires recompilation/new revision;
- launch-unknown and termination-unknown require positive resolution;
- no terminal interpreted as success.

### Compatibility and project invariants

- existing non-graph approaches still launch unchanged;
- existing manifests do not require manual migration;
- ticket stage graph remains unchanged;
- project scoping prevents cross-window/cross-project scheduling;
- graph migrations are atomic/idempotent and old/new incompatible CLIs fail closed;
- token usage recorded once at the headless-adapter or interactive-transport seam, with unknown rather than false zero;
- non-graph approaches retain existing launch, marker, settings, and session behavior through every delivery slice;
- typecheck, focused Vitest suites, full `npm test`, and build pass.

## Delivery Strategy

This design is implemented through sequenced vertical plans, not one cross-cutting “big bang.” Every slice leaves existing non-graph approaches releasable and keeps migrations forward-compatible:

1. **Package and configuration foundation:** tracked built-in package registry, enable tombstone/merge semantics, stable prompt overrides, analyzer-only selection, shared model/effort capabilities, command schema, and VSIX parity.
2. **Durable planning and compilation:** atomic schema migration, graph/planner/revision/artifact stores, planner submission capability, pure parser/compiler, structured fork/join validation, canonical fingerprints, and read-only Inside projection behind a feature flag.
3. **Sequential execution and guarded completion:** atomic activation claims, agent/command/gate/join executors with `maxParallel: 1`, supervised transport, immutable artifacts/change sets, canonical integration, graph-aware Resume, and transactional IMPL marker guard.
4. **Loops, recovery, and immutable replan:** repeated visits, causal artifact binding, budget enforcement, crash matrix, stale/unknown process handling, replan election/drain, and revision N+1.
5. **Safe parallel execution:** isolated node workspaces, physical-domain leases, fork lineage, deterministic integration, fairness, concurrent fault projection, and multi-window race coverage; only here may `maxParallel > 1` be enabled.
6. **Optional transport and observability extensions:** ACP transport when supported, interactive usage reporting, structured diagnostics, and richer graph projection without changing scheduler semantics.

The implementation-planning handoff produces one parent roadmap plus a detailed executable plan per slice. A later slice cannot weaken a prior slice's stage, project, capability, artifact, or transaction invariants.

## Architectural Rationale

The built-in approach is a planner plus a trusted runtime, not a predefined workflow. This adapts topology to task shape while keeping routing deterministic and auditable.

Execution profiles separate capability intent from vendors, so projects can move `expert` and `worker` work across Claude, Codex, Agy, OpenCode, and future adapters without regenerating topology.

Allowlisted commands keep deterministic verification cheap and authoritative. An LLM may decide that a configured `test` capability belongs in the plan; it cannot invent the executable that runs.

Artifacts prevent token cost from growing with cumulative transcripts. Fresh sessions consume only ticket context, bounded instructions, declared inputs, relevant repository state, and failure evidence.

Immutable revisions reconcile adaptability with recovery. Replanning is permitted and recorded, but a running revision never changes underneath the scheduler.

Resource-aware scheduling honors detailed planning by running all independent work concurrently in isolated workspaces. Isolation is necessary because Git state, generators, commands, stale processes, repository aliases, and newly discovered shared files are real execution constraints that a plan alone cannot enforce. Actual diff validation and deterministic integration turn the plan's claims into checked evidence instead of trusting them as containment.

The result is a scalable implementation approach without turning Karst into a general workflow engine or weakening the ticket stage machine.
