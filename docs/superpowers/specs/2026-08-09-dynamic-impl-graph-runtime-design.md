# Dynamic IMPL Graph Runtime Design

> **Review:** [2026-08-09-dynamic-impl-graph-runtime-REVIEW.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW.md) — 2026-08-09T18:42:00Z, model: opencode-go/mimo-v2.5, 6 parallel reviewers, 49 findings (3 Critical, 14 High, 16 Medium, 8 Low, 8 Informational) (the report's own header states 42/1 Informational; the file contains 49 headed findings, 8 Informational)
> **Review 2:** [2026-08-09-dynamic-impl-graph-runtime-REVIEW-2.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW-2.md) — 2026-08-09T22:09:00Z, model: opencode-go/deepseek-v4-flash, 6 parallel reviewers, 61 findings (1 Critical, 15 High, 26 Medium, 15 Low, 4 Informational)
> **Review 3:** [2026-08-09-dynamic-impl-graph-runtime-REVIEW-3.md](./2026-08-09-dynamic-impl-graph-runtime-REVIEW-3.md) — 2026-08-09T22:49:51Z, model: claude-opus-5, independent single reviewer, 9 non-duplicate findings (4 High, 3 Medium, 2 Low)
> **Findings ledger:** [2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md](./2026-08-09-dynamic-impl-graph-runtime-FINDINGS-LEDGER.md) — disposition of all 119 review findings.
>
> **Citation convention.** Current-state facts cite a file and a **symbol** (`store/tickets.ts`, `deleteTicket`), not a line range. Line numbers drift with every unrelated commit and this document outlives many of them; a stale number reads as a false claim about the repository, which is how this document's original citations for the `token_usage` detachment columns, `deleteTicket`, and `SessionManager`'s terminals map came to point at the wrong lines — each had drifted by six to thirteen lines. Two line citations survive deliberately because they name a single constant whose line is the fact being cited (`src/store/migrations.ts:9`, `store/db.ts:22`); both were re-verified against the tree at this revision. The review reports, the remediation plan, and the findings ledger keep their original citations untouched — they are records of what was true when they were written, not live documents, exactly as `REVIEW.md`'s own miscount is left as written.

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

The approach launches automatically when the ticket's normal IMPL session is opened. A successful plan compiles and begins execution without requiring a second manual launch. The packaged `confirmGeneratedGraph` default is `true`: the first graph run of a project pauses after compilation for review — the one point where the user can read the generated topology before any token is spent executing it — and a project that trusts the flow sets it `false` for automatic execution, keeping the graph an orchestration workflow rather than a sequence of dashboard clicks.

## Selection and Enablement

The graph-engineering approach ships in the VSIX and requires no network installation. One pure projection, `withBuiltInApproaches(manifest: Manifest): Manifest`, is the built-in overlay seam: host-agnostic, no fs and no vscode, it overlays the packaged built-in definitions onto `manifest.approaches` **by id** — a project entry wins field-by-field over packaged defaults, and the overlay never discards project fields. It sits between manifest load and the approach consumers in the Module and Dependency Boundaries diagram, and its consumers are exactly three: the ticket form (`ui/ticketForm/state.ts`), Settings (`ui/settings/actions.ts`), and launch resolution. No consumer may learn about built-ins any other way; a second resolution path for any single consumer is a defect.

Absence of a project entry means packaged defaults and enabled; `enabled: false` is a small persisted tombstone, not a copied package definition. Packaged upgrades may add or change defaults without overwriting explicit project fields.

`listInstalledIds()` includes every **enabled** built-in id. This is what makes the disk-install-based machinery resolve the built-in: `setApproachEnabled`'s install guard (`enabled && approach.source && !installed`) and `toApproachRows`' install filter (`source === undefined || installedIds.has(id)`) both pass for a sourceless built-in only because it counts as installed. A built-in disabled by tombstone is omitted from `listInstalledIds()`, so Settings' enable guard behaves exactly as it does for an uninstalled sourced approach. Two current facts make the seam necessary: `setApproachEnabled` (`ui/settings/actions.ts`, `setApproachEnabled`) errors `Unknown approach "<id>"` for an id absent from `manifest.approaches`, and `syncApproachEnabled` (`actions.ts`, `syncApproachEnabled`) returns early for the same reason — without the overlay, enabling or syncing the built-in would silently no-op.

**Non-finding (REVIEW-1 H12):** `reconcileApproachEnabled` (`actions.ts`, `reconcileApproachEnabled`) is called only from the install and uninstall handlers with that approach's own id, and its guard `enabled && approach.source && !installed` exempts sourceless approaches, so it cannot disable the built-in on any install/uninstall event. Recorded here so a future reader looking for the finding finds its disposition.

- Create/edit starts with no approach unless the ticket already has an explicit persisted choice.
- The ticket-form analyzer is the only mechanism allowed to select an approach automatically.
- Analyzer output may set the picker only when there is no persisted choice and the user has never touched the picker in the current form session.
- After the picker is touched, later analysis is recommendation-only and never changes selection.
- `defaultApproach`'s existing `recommended ?? approaches[0]` rule is unchanged; the built-in ships `recommended: false`, so it is never the silent default. `state.test.ts`'s default-selection assertions and `webview.test.ts`'s analyzer-badge assertions remain valid and unchanged.
- An explicit or persisted user choice is never overwritten.
- Disabling removes it from analyzer candidates and new-ticket choices.
- Existing tickets already using it remain runnable.
- Re-enabling requires no reinstall and preserves project overrides.
- Personal approaches and agents remain independent.

The analyzer-gating mechanism is a host-side `pickerTouched: boolean` flag on ticket-form state. It is set on any user interaction with the picker, is never cleared within a form session, and gates the analyzer's `setApproach`: the analyzer may set the selection only when `!pickerTouched && ticket.approach === null`. Two built-ins both marked `recommended: true` in a future release are impossible: `validateApproaches` (`manifest/schema.ts`, `validateApproaches`'s recommended check`) already throws on more than one recommended approach, and the overlay cannot produce that state because packaged definitions carry `recommended: false`.

The complete canonical source is tracked under `.agents/skills/karst-graph-engineering/**`. The `karst-two-phase` retirement is a **build-time/CI step**, never a runtime activation step: before implementation planning, every ignored `.agents` package is inventoried, the abandoned `karst-two-phase` package is deleted or archived outside the shipped package namespace as a one-time repository commit, and every remaining canonical shipped source is tracked. The repository adds narrow ignore exceptions only for canonical packages. The build copies the graph package into extension output, and a parity/inclusion test proves the VSIX contains the same bytes reviewers see in Git. CI fails when a canonical shipped package is ignored or untracked.

## Configuration Model

Project configuration controls planner behavior, reusable execution profiles, trusted commands, scheduling limits, and approval policy. The following shows the effective merged V1 shape; a project file may contain only the fields that differ from packaged defaults:

```yaml
approaches:
  - id: karst-graph-engineering
    label: Graph Engineering
    enabled: false          # Slice 1 ships disabled; Slice 3 flips it (Decision 31)
    graph:
      planner: { profile: expert, prompt: { artifact: skills/graph-planner/SKILL.md } }
      profiles:
        expert:
          provider: claude
          model: claude-opus-5
          effort: high
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
      limits:
        confirmGeneratedGraph: true
        maxParallel: 1
        maxNodeRuns: 40
        maxExpertRuns: 5
        maxReplans: 2
        maxActivations: 200
        maxGraphWallSeconds: 86400
        maxAgentWallSeconds: 7200
        maxAgentIdleSeconds: 1800
        maxArtifactBytes: 104857600
        maxAggregateArtifactBytes: 536870912
```

The built-in package ships profile/prompt/policy defaults but no repository-specific executable command definitions. The `test`, `typecheck`, and `build` entries above are project examples. The planner may emit a `CommandNode` only for an enabled command ID present in the effective project configuration. `planner`, `profiles`, `commands`, and `limits` are not hoisted to the top level of the approach entry: one nested `graph:` key keeps `SECTION_FIELDS.approaches` unchanged and confines the validator work to one function. The budget block is named `limits` (not `graph`) so that `graph.graph` never occurs. A project that sets `limits.maxExpertRuns` below `limits.maxReplans + 1` is a configuration error caught at manifest validation with a named message, never at compile time; the packaged defaults (5 and 2) can never produce it.

### Manifest pipeline obligations

The nested block survives the existing manifest pipeline only if the implementation extends it in every place the repository's new-manifest-field rule names. Current-state facts that make each obligation necessary:

- `src/manifest/types.ts` — add `graph?: GraphApproachConfig` to `ApproachDef` (today it has exactly 8 fields — `id`, `label`, `description?`, `entrypoint?`, `source?`, `recommended?`, `workflow?`, `enabled?` — none of them graph).
- `src/manifest/schema.ts` — extend `validateApproaches` (line 89) to validate and default the block. It currently constructs a fresh object and therefore **drops** unknown keys, which is why an unextended validator destroys every graph field on the first load→save cycle.
- `src/manifest/write.ts` — the `approaches` overlay at line 158 passes the validated array through whole, so **no separate overlay entry is needed** once the validator preserves the block; adding a redundant overlay would be a defect.
- `src/manifest/fixtures.ts` — add the block to the shared test builders (the single place every manifest suite reads its fixtures from).
- `src/ui/settings/sections.ts` — `SECTION_FIELDS.approaches` stays `['approaches']`; this is exactly why the nested shape was chosen.
- A `writeManifest` round-trip test proving a full graph block survives load → save → load byte-identically.

### Merge and tombstone rules

The `approaches:` array merges **by `id`**, never by position: a project entry with the built-in's id overlays the packaged definition field-by-field, and two entries are never merged positionally. Packaged defaults and project overrides merge per profile/command key; an omitted nested field inherits the packaged value; a reset removes only the explicit override; disabling a packaged profile or command uses an explicit `enabled: false` tombstone, and deletion never depends on an empty object.

Disabling the approach itself writes `{id, label, enabled: false}` — a small persisted tombstone, not a copied package definition. The `label` is injected by the registry-aware writer from the packaged definition, because `validateApproaches` (`manifest/schema.ts`, `validateApproaches`'s label check`) calls `requireString(a.label)` and a labelless tombstone **fails manifest load**. Packaged upgrades may add or change defaults without overwriting explicit project fields.

A project entry that carries `graph:` for an approach id that is not the built-in is accepted by the validator (the block is generic) but consumed by no runtime — accepted and inert. A project file containing both an old flat shape and the nested `graph:` block is refused at load, never guessed — mirroring the manifest's existing both-keys refusal for `services:`/`repositories:`. A tombstone for an id with no packaged definition and no prior entry is refused with a named error: the registry-aware writer has no label to inject.

### Settings write algorithm

Settings Save serializes only the **delta** against the packaged built-in definition — tombstones and explicit overrides — never the merged effective object. Otherwise a Save resurrects the full built-in definition into the manifest (the stale-baseline/clobber failure class). The webview mirrors the delta rule and `webview.test.ts` pins it against the host's implementation, per UI-R34; the webview cannot import the host's TS.

### Command allowlist vocabularies

The trusted command definition's policy fields use closed vocabularies:

- `cwd`: closed set `repository` | `worktreeRoot`. No arbitrary subdirectory in V1.
- `access`: closed set `read` | `write`.
- `env`: a project-authored map of bounded `NAME: value` string pairs, merged onto the host-owned minimal environment set. The project author already supplies the executable and argv, so authoring `NODE_ENV=test` grants no new capability.
- `timeoutSeconds`: finite safe integer, `1..7200`.

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

**Catalog effort metadata.** `ModelOption` (`agent/modelCatalog.ts`, `ModelOption`, today exactly `{id, label, providers}`) gains one optional field, `efforts?: readonly string[]`. The same field is mirrored into the published `model-catalog.json` at the repository root, and the existing `modelCatalog.test.ts` "matches the published model feed exactly" test pins the two copies — adding a model or an effort value means editing both files, exactly as it does today. A model with no `efforts` array accepts **no** effort value; an explicitly configured effort that the selected model does not advertise is a configuration failure at Save, never silently discarded. A custom model id typed by the user that is not in the catalog has no `efforts`, so it accepts no effort — intended conservative behavior, not a bug. A feed that supplies `efforts` for a model the bundled catalog lacks wins per the existing precedence, and the effort validates against the feed entry. An adapter whose CLI exposes no effort flag does not render the field at all, per the "unsupported cores expose no effort field" rule.

Initial adapter bindings are explicit:

| Core | Interactive binding | Suggested values | Validation |
|---|---|---|---|
| Claude Code | `--effort <value>` | `low`, `medium`, `high`, plus model-advertised `xhigh`/`max`/`ultracode` | selected model must advertise the value |
| Codex | `--config model_reasoning_effort=<value>` | `minimal`, `low`, `medium`, `high`, model-advertised `xhigh` | Responses-capable selected model must advertise the value |
| Agy | `--effort <value>` | values discovered with the model catalog | selected model entry must advertise the value |
| OpenCode | `--variant <value>` | model-specific variant IDs exposed by catalog discovery | effort **is** the selected model variant; a profile setting both `model` and `effort` for OpenCode is rejected at Save. The bundled OpenCode catalog is deliberately empty and the feed tier is opt-in with no default URL, so OpenCode effort is unresolvable on a default install — a project pointing a profile at OpenCode must configure a feed first |

These bindings follow the current official [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), [Codex configuration reference](https://developers.openai.com/codex/config-reference/), [Agy CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md), and [OpenCode CLI/model documentation](https://dev.opencode.ai/docs/cli/). Adapter capability tests, rather than this prose alone, pin the supported installed-CLI behavior.

The packaged Claude Opus `high` and Claude Sonnet `low` defaults must validate against the packaged catalog/capability metadata. Unsupported cores expose no effort field. Custom values are retained and attempted only when that adapter explicitly supports custom variants; otherwise Save is rejected. Interactive and headless capability declarations are separate so support in one mode never implies support in the other.

For the `opencode` provider, effort **is** the model variant: a profile that sets both `model` and `effort` for OpenCode is rejected at Save with a named error. Switching a profile's provider requires editing `model` and `effort` together, because the two fields are a single choice per provider and a stale pair is semantically conflicting, not merely invalid.

The built-in defaults intentionally spend more on planning than execution:

| Profile | Provider | Model | Effort |
|---|---|---|---|
| `expert` / planner | Claude | `claude-opus-5` | `high` |
| `worker` | Claude | `claude-sonnet-5` | `low` |
| `fast` | Claude | `claude-sonnet-5` | `low` |

`claude-opus-5` and `claude-sonnet-5` are both present in `BUNDLED_CATALOG`, so the model ids resolve today; the residual work is the `efforts` metadata plus the adapter capability tests, both required in Slice 1 before the VSIX ships.

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

Budget arithmetic for the example: **every node in it resolves to the `worker` profile, so its expert-node term is zero.** The formula is `spentPlannerRuns + permittedReplans + (bootstrapUnspent ? 1 : 0) + Σ(maxVisits over expert-resolved agent nodes)` = `0 + 1 + 1 + 0` = `2`, which is what the example declares. The earlier value of `4` was justified by "up to 2 expert node visits" that this example does not contain; a graph that *does* route to an `expert` node adds that node's `maxVisits` to the term and must raise `maxExpertRuns` accordingly. The packaged project default of `5` sits above both cases by design, leaving headroom for a graph with expert escalation without requiring every graph to declare it.

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

A command node references a project-configured allowlist ID. The trusted definition supplies executable, fixed argv, cwd policy, access mode, timeout, and permitted environment names. At graph compilation Karst resolves the executable to an absolute host path and pins a fingerprint of executable path, argv, cwd policy, environment-name allowlist, access, timeout, and command-definition version into the revision. The physical resource domain for each command repository — canonical worktree realpath plus Git common-directory identity — is a registry and filesystem fact, not a pure function of the graph document, so it is resolved by the store/scheduler layer and **passed into compilation as an injected resolved map**; the compiler stays pure and imports no stores. Changing a command definition requires recompilation or a new graph revision. The planner may select repository instances but cannot emit a command, add argv, insert shell operators, redirect streams, or invent environment values.

Karst executes the command directly without a shell and maps process results deterministically:

- exit code `0` → `passed`;
- non-zero exit code → `failed`;
- spawn, timeout, or infrastructure fault → `infrastructure-error`.

The node stores redacted, bounded stdout/stderr in immutable artifact logs and never asks an LLM whether the command passed. Command processes receive an explicit minimal environment; they never inherit `process.env`. The exact environment names are `PATH`, `HOME`, `TMPDIR`, and `LANG`, merged with the project-authored `env` map from the allowlist entry (`NAME: value` string pairs). The loopback URL, the artifact root, every capability, provider credentials, callback secrets, editor tokens, and unrelated repository secrets are excluded. Command logs are sensitive evidence and are never automatically attached to issue reports or unrelated node contexts.

For a node that names multiple repositories, Karst runs the same trusted command definition once per repository worktree, **serially within the node** — each subprocess consumes one execution slot at a time, never concurrently — and aggregates results deterministically: any infrastructure fault wins `infrastructure-error`, otherwise any non-zero exit wins `failed`, otherwise the node is `passed`. Because per-repository subprocesses run serially, a command node naming more repositories than `maxParallel` is legal and simply takes longer: `repositories per command ≤ 20` can never make a node unschedulable, and no compile check is added for it. Command `access` is conservatively configured by the project; npm test/build/typecheck examples use repository-wide `write` because tools may create caches, coverage, or generated files even when their purpose sounds read-only.

### GateNode

A gate evaluates a closed deterministic policy over persisted graph state and artifacts. V1 supports bounded policy primitives:

- node visit count comparison;
- node outcome count comparison;
- graph expert-run count comparison;
- artifact-exists predicate;
- `all`/`any` composition over those primitives.

Numeric comparisons use the closed operator set shown above. Gate output labels are always `matched` or `not-matched`; both require outgoing edges. Composite predicate depth and collection size are bounded by the graph parser. No JavaScript, shell, SQL, regular expression, or model-generated expression executes. V1 limitation: gate predicates see visit counts, outcome counts, expert-run counts, and artifact existence only — not exit codes, not which repository failed, and not artifact content; the planner prompt must not be authored against a capability that does not exist.

### JoinNode

A join is scheduler logic and spends no AI tokens. V1 supports structured fork/join regions. `forkFrom` identifies the synthetic entry fork or one fan-out source node. Every execution of that fork creates a unique `fork_instance_id`; all descendant branch tokens carry its lineage. A `mode: all` join consumes exactly one arrival from every `waitFor` predecessor with the same fork instance, then emits `complete`.

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

Agent `blocked` and `replan` are the **one deliberate exception** to karst's never-route-on-agent-self-report rule: they are budget-bounded self-reports and cannot advance a stage. A `replan` is honored only when the activation's causal lineage contains at least one observable precondition — a failed deterministic command/gate outcome, a `resource-claim-violated`, or an `integration-conflict`; a `replan` with no such evidence (including one whose lineage contains only its own prior `blocked`) is recorded as evidence and treated as `blocked`.

The scheduler persists activation tokens. A token records the source node run, edge, destination, graph revision, fork-lineage stack, and claim/consumption status. Non-join nodes consume one token per visit. A non-join node reached by distinct activations runs once per activation; fan-in that must synchronize uses an explicit join. Join nodes consume one correlated arrival from every declared predecessor as a set. Synthetic entry tokens have no source and share the root fork instance.

Claiming is transactionally single-winner across windows. In one `BEGIN IMMEDIATE` transaction Karst conditionally changes a token from `pending` to `claimed`, creates or reserves its node-run visit, reserves graph/node/expert/concurrency budgets, acquires durable physical-resource leases, and stores the claiming run. Scheduling continues only when **exactly the expected number of rows changed — 1 for a single activation, `|waitFor|` for a join firing**. A join firing is one all-or-nothing transaction: it conditionally claims all correlated arrivals, creates the join visit, and inserts the successor token, aborting with no partial claim if any arrival is not claimable — a join whose arrivals are split across two windows' completion transactions sees only committed tokens, so it claims all `|waitFor|` arrivals or none, and retries next tick. External launch occurs after commit. Completion transactionally changes the claimed token to `consumed`, records the effective outcome, updates counters, and inserts successor tokens with a uniqueness constraint on `(source_node_run_id, edge_id, fork_instance_id)`. A launch retry reuses the reserved node-run/visit and increments a launch-attempt counter; it does not create another logical visit.

**Lock liveness.** WAL is already enabled at `store/db.ts:22` — an existing fact, not a new requirement. A contended `BEGIN IMMEDIATE` in the extension host **aborts immediately** rather than waiting on a busy timeout, because a synchronous wait blocks the shared event loop; the aborted claim counts nothing, mutates nothing, and is retried on the next reconciliation tick, within the ≤100-transitions-per-tick cap. Separately, the CLI's `writableStore` shim currently issues plain `BEGIN` with no busy timeout (`src/cli/writableStore.ts`, its `transaction` shim`); for graph verbs it is upgraded to `BEGIN IMMEDIATE` plus a bounded busy timeout, so a concurrent completion surfaces as a retry rather than an unhandled `SQLITE_BUSY`.

**Coordinator sweep.** A bounded periodic reconciliation rides the existing background PR sweep in `extension.ts` — the same precedent that lets `settleShipGates` observe a merge no window performed. The invariant is plain: a completion that committed to the database is always eventually scheduled, even when its wake-up hit a dead port, because the sweep re-reads canonical state and never depends on the callback. This is what makes a lost completion wake-up harmless by construction.

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
- a bounded execution count for every fork source per revision, with every join's `maxVisits` at least that bound — a join budgeted below its fork's multiplicity strands the later instances in `graph-topology-deadlock`, a statically computable condition, so it is rejected at compile rather than deadlocked at runtime;
- every schedulable node, including gates and joins, carries a finite visit budget; SCCs also have a finite aggregate visit bound;
- aggregate graph/expert/replan budgets do not exceed project maxima;
- the compile-time expert-budget rule is exactly `spentPlannerRuns + permittedReplans + (bootstrapUnspent ? 1 : 0) + Σ(maxVisits) over agent nodes whose profile resolves to 'expert' ≤ maxExpertRuns`; it is re-checked at replan compile against the graph-run-scoped counters, and failing it is a compile error, not a runtime block;
- every referenced profile, repository, command, prompt, and input artifact exists;
- every planner-produced artifact file exists at compile time and every node-produced output has one declared safe destination;
- command repositories satisfy the trusted command definition and each effective command fingerprint/resource claim is pinned;
- normalized resource paths remain within declared repository roots;
- all resource claims are valid and every overlap is recorded for scheduler serialization;
- generated nodes cannot configure provider/model/effort directly;
- gate policies reference valid node/artifact IDs and bounded comparison values.

Compilation produces an immutable canonical topology/configuration document and SHA-256 fingerprint. Canonical bytes use RFC 8785 JSON Canonicalization Scheme over the validated/default-expanded document, encoded as UTF-8. The exact bytes and pinned command fingerprints are persisted as a graph revision. Provider/model/effort remain deliberately late-bound per agent launch and their resolved values/hashes are recorded on that invocation; prompt bytes do not — they are bound at run creation (see Prompt snapshots), with the per-invocation prompt hash recorded as the verification input. Invalid graphs red-block planning with structured diagnostics; Karst never “fixes” unsafe topology silently.

A compile-time **warning** — never an error — fires when the ratio of pairwise-overlapping write claims to total agent nodes exceeds 0.5, surfaced as a compile diagnostic so a planner that serializes everything is visible rather than silently slow.

### Compile repair loop

A rejected graph document returns to the **same** `PlannerRun` with the compiler's structured diagnostics as input, up to **3 compile attempts total** for that run, before the run fails to `graph-plan-invalid`. Attempts increment a `compile_attempt` counter on the planner run and do **not** create new planner runs, so they cost no planner-run or expert-run budget. The reason is plain: the compiler is strict — dominance, post-dominance, SCC visit bounds, unknown-field rejection, causal artifact binding, safe-integer ranges — so a first-pass rejection is the expected case, not an exceptional one. A planner that returns byte-identical invalid output on every attempt still terminates at 3 and fails to `graph-plan-invalid`; no progress check is attempted. A repair attempt that produces a *different* invalid document is handled identically, with the newest failure's diagnostics carried into the next attempt.

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

Therefore “not started in parallel” means declared or trusted resource claims overlap, isolated workspace or integration capacity is unavailable, the shared process budget is full, a durable physical-domain lease is held, or a dependency/join is incomplete. This reason is persisted and shown in graph state so deliberate serialization never looks like a scheduler defect. Ready ordering is deterministic by activation creation time and token ID, with bounded aging so a wide-resource node cannot starve behind repeatedly generated narrow loop work. Multi-window reconciliation produces a **consistent but not globally reproducible** execution order: two tokens created in different windows within the same millisecond order by token id, which reflects commit sequence rather than logical cause.

Integration is serialized by a **durable database-backed lease** — an `approach_resource_leases` row with status `held`, acquired in the claim transaction — never an in-memory mutex, because two windows may legitimately complete different nodes concurrently.

Resource claims are scheduling and validation declarations, not a security sandbox. The node executor compares the captured change set with declared writes; any expansion requires a `replan` or a future explicit claim-expansion protocol after conflicts drain. V1 never silently widens a running node's claim. Durable leases remain held until the supervised process tree is confirmed terminated and its change set is integrated, preserved behind a blocker, or explicitly discarded by the user.

## Artifacts and Context Policy

Artifacts are the first-class communication channel between nodes. `ArtifactDef` describes a logical artifact; every production creates an immutable `ArtifactInstance` keyed by graph revision, producer planner/node run, visit, and fork lineage. The instance stores logical artifact ID, content-addressed runtime-owned snapshot path, SHA-256, byte size, media type, producer identity, and creation time. Loop visits and replans therefore never overwrite prior evidence.

Karst creates a private per-run artifact root outside repository diffs with restrictive permissions. Before launch, every required output staging destination must be absent — a required output whose staging destination already exists at launch refuses the launch, unchanged. At submission/completion, validation and copy are **one operation per file**, an ordered sequence: open the path with `O_NOFOLLOW | O_NONBLOCK`; `fstat` the **opened descriptor**; reject non-regular files, link count > 1, size over the declared `maxBytes`, and media-type mismatch; read from that same descriptor into immutable content-addressed storage; never re-resolve the path. `O_NONBLOCK` is what makes a FIFO swapped in by a live writer fail immediately instead of hanging the open; `O_NOFOLLOW` is what makes a symlink swapped in after validation irrelevant, because the descriptor is already opened on the validated object. Consumers read only the snapshot whose hash was recorded; the mutable staging path is never authoritative. `graph.json`, planner artifacts, command logs, and diff/change-set artifacts use the same snapshot protocol — and the **planner process is terminated and its termination proven before its submission snapshot**, exactly as node completion already requires; the two flows have the same shape.

### Runtime-owned locations

- Per-run artifact root: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/artifacts/`.
- Node execution workspaces: `<globalStorage>/graph/<projectSlug>/<ticketId>/<graphRunId>/workspaces/<nodeRunId>/<repoName>/`.

Both live under the extension's **global storage**, outside every repository worktree. Two consequences follow and are deliberate: `ship`'s plain `git add -A` cannot see them, and **no `KARST_EXCLUDE_RULES` entry is required** — that is the reason, so a future reader does not “fix” a missing rule. The global-storage root is shared by every window, so the path is project-scoped by construction, following the existing global-storage rule. The `<agentsDir>/karst-graph-engineering/*.md` prompt overrides, by contrast, are deliberately tracked user content inside the repository, exactly like every existing agent prompt override — no exclude rule is added for them either.

The workspace provider must handle a cross-device clone: a local clone sharing immutable object storage is acceptable only when both paths are on one filesystem; otherwise a full clone is used. A pre-existing workspace directory at the target path from a prior crashed run is removed before creation — its owning node run is by definition superseded — and the removal goes through the same reap that checks process attribution first.

Every planner and node agent session, and every command subprocess, registers with the existing `servers` registry keyed by its workspace `cwd`, so that `removeWorktree` → `stopServersUnder` and the global `reapStaleServers` activation sweep can both see it. This prevents, by name, a ticket archived mid-graph leaving detached processes holding a tree — the 869ed2n50 failure class.

Byte deletion is owned: `deleteTicket` (hard delete) removes the ticket's whole `<globalStorage>/graph/<projectSlug>/<ticketId>/` subtree, and an activation sweep removes subtrees whose graph run is `closed` or whose ticket no longer exists. Archive removes nothing. No per-ticket pruning of a live ticket's graph history happens in V1.

Agent context is assembled from:

- freshly rendered ticket context;
- the node base prompt (`karst-graph-node`), prepended ahead of the node's instructions artifact, with its snapshot hash part of the frozen per-launch prompt hash (see Prompt snapshots);
- the node's instructions artifact;
- declared input artifacts;
- declared command/failure evidence;
- relevant isolated workspace or canonical repository paths appropriate to the executor;
- optional current diff scoped to the node's repositories.

It explicitly excludes previous interactive transcripts. Fresh node visits never receive `--resume` for another node, even when the provider is identical.

Karst resolves each input to the newest successful artifact instance in the activation's causal lineage. Planner artifacts are roots. `artifact-exists` gates inspect causal instances, not any historical file with the same logical ID. Ambiguous or missing bindings block rather than selecting globally “latest.”

Karst validates required output artifacts before accepting an effective `complete`. The agent-authored `complete` remains immutable reported evidence, but missing/unsafe output leaves effective outcome null and moves the node/graph to recoverable `output-artifact-missing` or `artifact-unsafe`; no edge is emitted.

Prompt/completion text is never written to SQLite. Prompt hashes, immutable artifact paths, and bounded metadata are stored. Artifacts and logs are sensitive by default, excluded from unrelated node context and issue reporting, and displayed only through explicit user actions.

### Prompt snapshots

The effective prompt bytes — the packaged file overlaid with the project override at `<agentsDir>/karst-graph-engineering/<name>.md` — are resolved and snapshotted into immutable content-addressed storage at **planner-run creation** and at **node-run creation**, using the same single-descriptor protocol as every other artifact. The launch reads only the snapshot and verifies the recorded SHA-256; a mismatch blocks with `instructions-missing` before any spend. This is why: a worker with a repository-wide write claim, or a `write`-access command node running against the canonical worktree, could otherwise rewrite the planner prompt before a replan, and the out-of-claim diff check runs only *after* the poisoned prompt was consumed. Consequences: the override file being deleted or modified between snapshot and launch is irrelevant — the launch reads the snapshot, which is the point; an override that fails to read at run creation (permissions) blocks the run with `instructions-missing` before any spend; and a packaged prompt changed by an extension upgrade keeps the active run on its own snapshot, with the next run picking up the new bytes. Edits to the on-disk prompt take effect on the next run, never on a retry of an existing one.

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

The environment keys map onto the existing contract so terminal re-identification keeps working unchanged: `KARST_TICKET_ID` keeps its meaning (ticket id); `KARST_LAUNCH_ID` carries the **node-run id** (or planner-run id) for graph sessions, so `ui/terminalIdentity.ts` re-identifies revived terminals without modification; graph-specific values use new `KARST_GRAPH_*` names — `KARST_GRAPH_RUN_ID` (graph run id), `KARST_GRAPH_REVISION_ID` (graph revision id, node sessions), `KARST_GRAPH_GENERATION` (launch generation), `KARST_GRAPH_CAPABILITY` (the completion capability), `KARST_GRAPH_ARTIFACT_ROOT` (fixed artifact root), `KARST_GRAPH_CALLBACK_URL` (loopback callback URL), and `KARST_GRAPH_DB` plus `KARST_GRAPH_PROJECT` (writable registry path and manifest/project identity). A session carrying a node-run id in `KARST_LAUNCH_ID` is a graph session to every consumer of that key; no other key's meaning changes.

**Two id namespaces share that key, and the ambiguity is resolved by a discriminator, never by parsing the value.** A legacy launch id and a node-run id are different types from different generators, so nothing about the string itself says which one it is, and a consumer that guessed would eventually guess wrong. `KARST_GRAPH_RUN_ID`'s presence is the discriminator: it is set on every graph session and on no legacy one, so `KARST_LAUNCH_ID` means a node-run id exactly when `KARST_GRAPH_RUN_ID` is present and a legacy launch id otherwise. `ui/terminalIdentity.ts` needs neither branch — it carries the value opaquely, which is the whole reason the key was reused rather than replaced — but every consumer that *resolves* the id must check the discriminator first, and a lookup that finds no row must report not-found rather than falling through to the other namespace.

The completion capability is a CSPRNG-generated bearer secret of at least 256 bits. SQLite stores only its cryptographic hash. The plaintext exists only in that supervised process environment; it is never placed in argv, callback URLs, logs, diagnostics, artifacts, UI state, or issue reports. The capability is **consumed one-shot on the first mutating verb** — `complete`, `block`, or `replan`, not `complete` alone — so a node that calls `block` and then `complete` gets an idempotent rejection of the second call. Capabilities **rotate per launch attempt and generation**: a launch retry after `failed-to-launch` mints a fresh capability for the new attempt and invalidates the prior hash in the same transaction that increments the launch-attempt counter, so a capability leaked from a prior attempt is dead.

**Residual risks.** A same-UID sibling process can read `/proc/<pid>/environ` of a running node and obtain its plaintext capability; that read is not defended. The invariant "never placed in artifacts" is a design intent, not an enforceable property, because the process holding the plaintext is the very party that writes artifacts. What does hold: one-shot consumption plus per-attempt rotation bounds the exposure window to the live process. Read-side exfiltration by a compromised agent is outside the model entirely — writes are the only policed axis.

**Environment identity is untrusted.** The environment identity fields (project, ticket, graph run, node run, generation, and any stage-attempt claim) are untrusted claims supplied by whatever process invokes the CLI; a prompt-injected agent can set any of them. The capability hash is the sole authenticator. The full-field conditional UPDATE — which requires project, ticket, stage attempt, graph, revision when applicable, run ID, generation, status, and capability hash to match a single `running` row — is exactly what makes the untrusted claims safe.

Planner submission and node completion have separate closed parsers from each other and from `stage`:

```text
karst graph submit
karst node complete
karst node block --reason <text>
karst node replan --reason <text>
```

`karst graph submit` accepts no path or outcome; it reads and snapshots the fixed planner artifact assigned by the host. Node commands accept only the closed verb and bounded reason shown. Neither parser accepts ticket key/id, stage, attempt, graph/revision/node/planner-run id, destination, profile, provider, model, effort, artifact root, callback address, timestamp, capability, or launch generation in argv. Trailing argv is rejected.

The CLI fails closed unless project identity and a compatible schema version are present. It never falls back to an unscoped ticket lookup. It conditionally updates only the `running` planner/node-run row identified by host environment and matching project, ticket, stage attempt, graph, revision when applicable, run ID, generation, status, and capability hash. Node completion validates the outcome against the pinned node definition and caps/collapses evidence text. Planner submission snapshots `graph.json` and planner artifacts, then marks only that planner run submitted. Durable state commits before a wake-up. Duplicate, stale, wrong-project, wrong-attempt, or wrong-capability completion is an idempotent rejection — including a valid-but-late completion that arrives after the coordinator already resolved the node through user cleanup: rejected idempotently, evidence recorded, no state change.

The loopback notification is only a wake-up. The route token is a CSPRNG value of at least 128 bits, the listener binds `127.0.0.1`, and non-loopback origins are rejected. The endpoint derives bounded routing identity from its host-created target, returns a fast response, and schedules the graph coordinator. No bearer capability appears in the URL. Wake-ups are rate-limited **per graph run** with exponential backoff, and the cap applies to **valid** requests as well as malformed and stale ones: the URL lives in every agent's environment and is inherited by every process that agent spawns, so a valid-token flood is the realistic attack, not a malformed one. The coordinator rereads canonical state before selecting any edge.

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

Existing provider CLI adapters remain supported through a `SupervisedCLITransport` that wraps `AgentAdapter.buildInteractiveCommand`. `AgentAdapter` stays a static command-and-environment builder; it does not gain lifecycle methods. `SupervisedCLITransport` takes the command/env `buildInteractiveCommand` returns, owns the spawn and the supervision on top of it — the owner nonce, process group/PID, process start identity, provider session ID, and generation described below — and is the sole piece of code that satisfies `AgentTransport` from an `AgentAdapter`. No other module bridges the two interfaces. The supervisor persists an owner nonce before spawn, then records process group/PID, process start identity, provider session ID, and generation immediately after spawn. ACP may be added as an optional preferred transport when a core supports it. ACP can launch, stream, request permissions, cancel, and report lifecycle for one host-selected node run. It cannot generate or mutate topology, activate edges, choose destinations, delegate graph work to peers, supply canonical outcomes outside the guarded completion protocol, or replace artifacts as the inter-node communication contract. An ACP `session-ended` event maps to **termination evidence only**, never to an outcome, and ACP endpoints must be loopback-bound with no remote callback addresses. V1 does not require ACP.

Transport termination must produce positive process/session lifecycle evidence. Terminal disposal alone is insufficient. An ambiguous `launching` crash becomes `launch-unknown`; unknown termination becomes `termination-unknown`. Neither is automatically retried or releases physical-resource leases.

### Process attribution

`runtime/serverIdentity.ts` is the mandated evidence source — the implementation does not invent a probe. Its hierarchy, strongest first:

1. the live process's own current working directory, where the OS provides it (`/proc/<pid>/cwd`);
2. else the live process's own **start time** via `ps -o lstart=` matched within `START_TIME_TOLERANCE_MS` — chosen over a boot-time-only check because it distinguishes our server from an unrelated process that reused the pid later in the same boot;
3. both sides of every comparison canonicalized through `runtime/pathScope.ts`'s `canonicalPath` — `/proc/<pid>/cwd` resolves through the kernel, the recorded `cwd` may not, and a raw string compare reads the same directory as a different one on a symlinked workspace root.

Outcomes are the four-way `attributable` / `dead` / `foreign` / `unknown`. A recorded pid is a recollection, never a handle. Outcome mapping to node statuses: `dead` → the node is marked stale and the graph blocks for recoverable retry; `foreign` → the recorded pid was reissued, the row is cleared and nothing is signalled; `unknown` → `termination-unknown`, leases retained, never automatically retried. A missing workspace directory is evidence of removal only when its parent directory still stands — an unmounted volume takes the parent with it, and a directory-gone-plus-parent-gone is `unknown`, not `dead`, matching the existing `directoryGone` rule.

`TerminationProof` requires an attributed process-**group** signal via `killTree`, with its return value checked: `killed`, `denied`, and `unknown` are three different facts, and `denied` (still running, refused) never reads as terminated — the lease stays held and the row stays truthfully `running`.

### Discard unknown process

`launch-unknown` and `termination-unknown` are escapable by exactly one explicit user action, "Discard unknown process". It is a single transaction with these steps in order:

1. verify the node is in one of the two ambiguous statuses (`launch-unknown` or `termination-unknown`);
2. conditionally move its token `claimed → cancelled`;
3. mark the node run `cancelled`;
4. release its reserved graph, node-visit, and expert budget contributions — so a drained or discarded revision does not permanently consume revision N+1's ceilings;
5. release its lease;
6. re-evaluate the graph, blocking with `graph-topology-deadlock` if the edge is now unsatisfiable — a recoverable blocker that leads to replan, so the user is never left with a silently dead graph.

This is the only path that releases a lease without proven termination. It is user-initiated and never automatic; its UI copy names the risk, because a process may still be running. The transaction is conditional on the current status, so when two windows both offer the action for the same node exactly one succeeds and the other is an idempotent no-op. A valid-but-late completion arriving after a discard is rejected idempotently.

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
11. On END quiescence, mark the graph run completed and keep the explicit IMPL marker separate — the quiescence check and the status flip are **one `BEGIN IMMEDIATE` transaction** that re-reads every condition the END-quiescence rule names (no pending/claimed non-END token, no unsatisfied join, no completing process, no integration operation, no active node run). A read-then-write here lets a concurrent window's completion commit successor tokens in between, after which the marker guard correctly refuses and no reopen path exists — the ticket would be stuck.

Graph planner and node seeds never contain the generic IMPL done-marker instruction or `cliStagePrefix`. No node is authorized to issue a stage marker as part of its completion sequence.

After END quiescence the graph status is `completed-awaiting-impl-marker`. The Inside view exposes an explicit “Complete implementation” action — the **only** marker entry point for a graph ticket, because graph seeds never contain `cliStagePrefix`, so no refreshed session has any way to fire the normal marker. It uses one `GraphImplMarkerGuard`. In the same transaction that calls the existing transition path, the guard requires the current project/ticket/stage attempt, exactly one active graph run in `completed-awaiting-impl-marker`, and no pending/claimed activations, unsatisfied joins, completing/integrating/active node runs, or held ambiguous-process leases; it then marks the graph `closed`. Any earlier marker is rejected without mutation. Non-graph approaches retain their current marker behavior. The graph status is an entry condition, not a verdict, and the scheduler never writes or infers `passed`.

Scheduler state is keyed by graph/revision/node-run IDs rather than only ticket id. Graph planner and node sessions are owned by `AgentTransport` and **bypass `SessionManager` entirely**: `SessionManager` (`ui/session.ts`, its `terminals` map`, a `Map<number, TrackedSession>`) stays 1:1 and legacy-only, with no key change made to it, and graph sessions are keyed `(ticketId, nodeRunId)` inside the transport's own registry. Lifecycle hooks, launch generations, provider session IDs, recovery, and waiting state are all keyed to the node run, never the ticket alone. Graph hooks carry host-generated node-run identity in their endpoint route, never in an agent-authored body or cwd inference. Ticket-level agent state becomes a projection over active node runs; existing ticket session fields remain only for legacy approaches.

While a graph run is active in `planning`, `running`, or `draining`, every existing ticket-level launch entry point has a defined behavior — each row below is a testable assertion, not guidance:

| Entry point | Behavior while a graph run is active |
|---|---|
| `openSession` (dashboard Open) | Never spawns, and never consults `SessionManager` for a graph ticket. It detects the active graph run first and delegates to the transport's own `(ticketId, nodeRunId)` registry, revealing the planner terminal or the node terminal chosen in the Inside view. `SessionManager`'s ticket-keyed map holds nothing for a graph ticket, so a lookup there would find no session and — without this branch — fall through to a spawn, which is exactly the failure the row forbids. |
| `nudge` | No-op; the coordinator owns continuation. |
| `adoptRevivedSession` | Adopts only terminals whose `KARST_LAUNCH_ID` matches a live node/planner run; never launches. |
| `driveTicket` | Not invoked for a graph ticket at `impl`; the coordinator drives instead. |
| `resumeFixSession` | Unreachable at `impl`; belongs to the `fix` stage. |

A terminal a user opens manually in a node workspace carries no `KARST_LAUNCH_ID`, so it is never adopted and never counted. A graph run in `completed-awaiting-impl-marker` has no active work, so `openSession` behaves normally again — which is what makes the Inside "Complete implementation" action usable beside a refreshed session. On window reload with live node processes, terminal re-identification uses the pid record exactly as it does today; the `KARST_LAUNCH_ID` mapping is what keeps that path unchanged.

The graph Stop signal is owned by a **coordinator-level controller**, not the stage driver's `DriverController` — a graph ticket at `impl` is never driven by `driveTicket`, so the existing per-run `AbortController` has no routing to it. Dashboard Stop reaches running node processes through `AgentTransport.terminate` for every node run of the active graph, and Stop moves the graph run to `draining`, never to `blocked`.

Graph scheduling never reads hook delivery: hooks are diagnostics only. They post to a per-window port that dies with its window, so a surviving node's hooks going nowhere is expected and logged as one bounded diagnostic, never an error.

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
7. launch the bootstrap planner with the original ticket context, prior plan/graph snapshots, completed artifacts, failures, diffs, resource conflicts, and the elected plus secondary replan reasons — the reasons travel as a **file artifact**, never as argv or a shell token (the repository's shell-token interpolation of agent-controlled text is the exact failure class being avoided), and the planner prompt frames them as untrusted agent-reported text;
8. validate a complete new graph document;
9. persist revision N+1 with `supersedes_revision_id` and bounded rationale;
10. create a new root fork/entry tokens and resume scheduling.

A planner submission for a revision that is no longer `active` — because a concurrent replan already won election in step 1 and moved it to `draining` while this planner was still running — is an idempotent no-op: the late planner run is marked `stale`, its graph/artifact snapshot is discarded unpersisted, and no revision is created. The elected initiator's revision N+1 is unaffected.

Prior revisions, planner runs, node runs, activations, artifact instances, and outcomes remain immutable history. Provider/model/effort/prompt configuration still resolves at each new agent launch and is frozen for that attempt. Pinned command definitions change only through recompilation/new revision. Project and product hard `maxReplans` prevent unbounded expert replanning. `maxExpertRuns` explicitly includes bootstrap and replan planner runs plus graph agent runs resolved to the `expert` profile.

Revision N+1's compilation validates its resource claims against the set of still-`held` leases from the draining revision N, and a node whose claims conflict is scheduled only after those leases release — a scheduling deferral, never a compile error. A drain whose leases never release because the holder is `termination-unknown` is resolved only by Task 8's "Discard unknown process" action; the deadlock has a named exit.

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
- aggregate workspace bytes per graph run;
- bounded scheduler actions per reconciliation tick.

Product hard ceilings apply even when project configuration requests more. V1 constants are: `maxParallel <= 8`, `maxNodeRuns <= 200`, `maxExpertRuns <= 10`, `maxReplans <= 5`, `maxVisits <= 20` per node, `maxActivations <= 1000`, graph lifetime `<= 72h`, planner/agent wall time `<= 8h`, idle time `<= 2h`, command timeout `<= 2h`, repositories per command `<= 20`, per artifact `<= 100 MiB`, per log `<= 10 MiB`, aggregate graph artifacts `<= 1 GiB`, aggregate workspace bytes per graph run `<= 100 GiB`, and scheduler work `<= 100` state transitions per tick. All duration/count/size fields use finite safe-integer parsing. Exceeding any hard or configured limit blocks without routing. The packaged workspace ceiling `maxAggregateWorkspaceBytes` defaults to 20 GiB and is measured per graph run; exceeding it blocks with `graph-budget-exhausted` rather than starting another workspace.

**Ceiling rationale.** The hard ceilings target a developer workstation running one VS Code window. `maxParallel <= 8` protects the extension host and a single machine's CPU/RAM from fan-out spikes; the 72-hour graph lifetime prevents an abandoned graph from holding a ticket hostage indefinitely while leaving long-running work possible; the 8-hour agent wall time bounds a single runaway session so a stuck agent cannot spend without bound. These are conservative first-release bounds, deliberately, and are intended to be revised once the cost measurement of the Premise and Measurement section exists — they are not calibrated against measured usage.

Every logical node visit, including zero-token gate and join visits, counts toward `maxNodeRuns` and its node's `maxVisits`. Every planner invocation counts toward both the planner-run and expert-run ceilings. `maxParallel` counts external processes, not logical nodes, and bounds only **karst-managed** concurrency — agent sessions and command subprocesses karst spawns — never the total system process count: an agent's own child processes are unbounded by it. This is an explicit V1 limitation.

Exceeding a budget produces a bounded deterministic outcome when the topology declares a gate/edge for it; otherwise the graph blocks with `graph-budget-exhausted`. A loop without a finite node-visit budget is rejected.

When a node reports `replan` but the project/product `maxReplans` ceiling is already exhausted, the replan election in Immutable Replanning step 1 is refused rather than attempted: the reporting node's effective outcome becomes `blocked` with reason `graph-budget-exhausted`, the graph transitions to `blocked`, and the node's isolation and leases are retained for user inspection. It is never routed as an unbounded replan and never silently dropped.

Escalation is expressed through deterministic evidence and graph topology. A gate can count repeated command failures or worker visits and route to an `expert` agent node. Self-reported confidence may be stored in an artifact but is not a routing primitive.

Token usage remains measured once at the agent seam. `instrumentedAdapter` continues to own headless accounting. Every graph launch — planner and node — opens a `process_runs` row, which the **existing** interactive usage sampler binds to: `interactive_usage_samples.process_run_id` is `NOT NULL REFERENCES process_runs(id)` (`schema.sql`, `interactive_usage_samples.process_run_id`), so an interactive graph session without a `process_runs` row is unrecordable — this keeps exactly one interactive accounting seam and satisfies the measured-once invariant rather than adding a second. `token_usage` gains two nullable columns in the same migration — `approach_planner_run_id` and `approach_node_run_id`, both `ON DELETE SET NULL` — following the existing detachment pattern of `implementation_segment_id` and `interactive_usage_sample_id` (`schema.sql`, the `token_usage` detachment columns`), so deleting graph history never takes the ledger's spend with it. `AI_CALL_SITES` (`agent/aiCallSites.ts`, `AI_CALL_SITES`) gains exactly two members, `graph-planner` and `graph-node`; node identity travels in the new FK columns, not in the call site, because the call-site set is closed and must stay bounded. The resolved profile name is recorded on the node/planner run, not on `token_usage`; usage rolls up to profile by joining through the run — no new column for it. A transport that cannot report usage records `unknown`, never a fabricated zero. No prompt or completion text is stored, and the store write is wrapped and swallowed so a locked database never fails a launch. No caller double-counts. V1 limits financial exposure deterministically through expert/agent run and wall-time ceilings; provider-reported hard cost caps may be used when supported, but Karst does not kill a session at an estimated token boundary or claim an unenforceable universal token cap.

## Persistence

Graph execution requires explicit durable identity. `phase_marks` cannot distinguish generated topology revisions, parallel activations, repeated node visits, joins, or replanning. It remains historical UI evidence for legacy approaches but does not drive the graph runtime.

V1 adds the following focused tables. Every table uses `INTEGER PRIMARY KEY` (rowid alias); `AUTOINCREMENT` is deliberately absent.

The rationale is **insert-only**, which is not the same claim as append-only and is the correct one: five of the eight tables update rows in place (status columns on graph runs, planner runs, revisions, node runs, tokens, and leases move through their transition maps), and `approach_node_overrides` is edited by the user. What none of the eight ever does is **delete** a row outside `deleteTicket`'s explicit ordered sequence. Since no row is deleted while the database is live, the largest rowid never decreases, so a reused rowid cannot occur and `AUTOINCREMENT` would buy nothing but a second table and a write per insert. `approach_artifact_instances` is additionally append-only in the stronger sense — an instance is immutable once written — and that is a property of the artifact contract, not the reason for this decision.

### `approach_graph_runs`

- id;
- ticket id and project ownership through the ticket;
- fixed stage key `impl` and stage attempt;
- approach id;
- status (`planning`, `awaiting-confirmation`, `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`, `closed`, `stale`, `cancelled`);
- created/updated/completed timestamps;
- planner/expert/node/replan counters.

### `approach_planner_runs`

- id and graph-run id;
- nullable target revision number and monotonic planner-run number;
- kind (`bootstrap`, `replan`);
- status (`ready`, `launching`, `running`, `submitted`, `blocked`, `launch-unknown`, `stale`, `cancelled`);
- selected profile and resolved provider/model/effort/prompt hash;
- compile attempt counter (`compile_attempt`);
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
- `source_node_run_id INTEGER NULL` plus `is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0,1))` — the entry-token representation, because a closed-value `CHECK` over a nullable FK cannot express "a real reference or the sentinel";
- edge id and destination node id/END;
- fork instance and bounded fork-lineage identity;
- status (`pending`, `claimed`, `consumed`, `cancelled`);
- claiming/consuming node-run id;
- created/consumed timestamps.

Token transitions are exactly four, each with its trigger:

| From | To | Trigger |
|---|---|---|
| `pending` | `claimed` | claim transaction |
| `pending` | `cancelled` | revision drain; ticket left `impl` |
| `claimed` | `consumed` | completion transaction |
| `claimed` | `cancelled` | "Discard unknown process"; drain of a claimed activation that cannot finish |

No other transition is legal — in particular there is no `claimed → pending`: a launch retry after a proven-no-process failure keeps the token `claimed` and reuses the reserved visit, incrementing only the launch-attempt counter.

### `approach_artifact_instances`

- id, graph run/revision, logical artifact id;
- producer planner/node run and fork lineage;
- content-addressed snapshot path, SHA-256, media type, byte size;
- sensitivity and created timestamp.

### `approach_resource_leases`

- `id INTEGER PRIMARY KEY` plus `UNIQUE(owner_node_run_id, physical_domain)` — without the uniqueness constraint two windows can insert duplicate leases and "affected-row checks" become enforcement-by-code;
- graph/node-run owner;
- canonical physical worktree/Git domain;
- access mode and normalized claimed paths;
- status (`held`, `released`, `ambiguous-process`);
- acquired/released timestamps.

Lease transitions: `held → released` (termination proven and the change set integrated, preserved behind a blocker, or explicitly discarded), `held → ambiguous-process` (termination cannot be proven), and `ambiguous-process → released` (only via the "Discard unknown process" action).

### `approach_node_overrides`

- graph revision/node identity;
- user-selected provider/model/effort/profile override fields;
- row version and updated timestamp.

### Transition maps

Closed-value `CHECK`s enforce **membership** only; transition legality is application code. The maps below are the testable contract for the five stateful tables. The token map is above; the remaining four:

**Graph run** — statuses `planning`, `awaiting-confirmation`, `running`, `draining`, `blocked`, `completed-awaiting-impl-marker`, `closed`, `stale`, `cancelled`:

| From | To | Trigger |
|---|---|---|
| `planning` | `awaiting-confirmation` | compilation complete, confirm policy on |
| `planning` | `running` | compilation complete, automatic execution |
| `awaiting-confirmation` | `running` | user confirms the generated graph |
| `running` | `draining` | replan election won; Stop |
| `draining` | `running` | revision N+1 active, scheduling resumes |
| `running` | `blocked` | recoverable graph fault (first fault stops new launches) |
| `blocked` | `running` | graph-aware Resume after recovery durably entered a recoverable state |
| `running` | `completed-awaiting-impl-marker` | END quiescence, one `BEGIN IMMEDIATE` transaction (step 11) |
| `draining` | `completed-awaiting-impl-marker` | END quiescence while draining (no successors were created) |
| `completed-awaiting-impl-marker` | `closed` | guarded IMPL marker transaction |
| `planning`/`awaiting-confirmation`/`running`/`draining`/`blocked` | `cancelled` | ticket leaves `impl`: cancel every pending token and move the run to `cancelled` without rewriting completed evidence |
| `completed-awaiting-impl-marker` | `cancelled` | ticket leaves `impl` **before** the marker fires — a stage moved by any other path (recovery, a user re-scope, an archive) leaves a quiescent run that must not stay eligible for the marker guard. The run has no active work, so this cancels nothing but its own eligibility, and completed evidence is untouched |
| any non-terminal status | `stale` | recovery supersedes the run's host evidence (a successor run for the same ticket/stage attempt exists, so the earlier host died — the `stage_runs` precedent) |

**Revision** — statuses `active`, `draining`, `superseded`, `completed`:

| From | To | Trigger |
|---|---|---|
| `active` | `draining` | replan election won |
| `draining` | `superseded` | revision N+1 persisted with `supersedes_revision_id` |
| `active` | `completed` | this revision's graph reached END quiescence |
| `draining` | `completed` | END quiescence while draining |
| `active` | `superseded` | graph run cancelled — so no orphan `active` row survives a cancelled run |

**Node run** — statuses `ready`, `waiting-resource`, `launching`, `running`, `completing`, `integrating`, `completed`, `blocked`, `failed-to-launch`, `launch-unknown`, `termination-unknown`, `stale`, `cancelled`:

| From | To | Trigger |
|---|---|---|
| `ready` | `waiting-resource` | claim deferred: resources or budget unavailable |
| `waiting-resource` | `ready` | reconciliation re-evaluates after release |
| `ready` | `launching` | claim transaction; owner nonce and leases persisted before spawn |
| `launching` | `running` | PID/process-start/session identity recorded immediately after spawn |
| `launching` | `failed-to-launch` | proven no process |
| `launching` | `launch-unknown` | crash after possible spawn but before identity |
| `running` | `completing` | reported outcome received; ownership retained |
| `completing` | `integrating` | termination proven, change sets validated |
| `completing` | `running` | reload: live attributable process — revert and let completion proceed |
| `integrating` | `completed` | change sets integrated; effective outcome consumed |
| `running` | `blocked` | agent `blocked` outcome |
| `running` | `stale` | demonstrably dead process; graph blocks for recoverable retry |
| `running` | `termination-unknown` | process death cannot be proven; leases retained |
| `launch-unknown`/`termination-unknown` | `cancelled` | "Discard unknown process" (also releases budgets and lease) |
| `ready`/`waiting-resource`/`launching`/`running`/`completing`/`integrating` | `cancelled` | revision drain; ticket left `impl` |
| `failed-to-launch` | `launching` | recovery claim: retry the **same reserved visit** with a new launch attempt (Recovery table, "launch failure with proven no process") |
| `blocked` | `launching` | graph-aware Resume after the blocking condition was corrected — provider/model/effort, prompt, artifacts, or claims — retrying the same reserved visit with a new launch attempt |
| `stale` | `launching` | recovery retry after a demonstrably dead process; the visit is reused, the launch attempt increments |
| `failed-to-launch`/`blocked`/`stale` | `cancelled` | revision drain; ticket left `impl` |

`failed-to-launch`, `blocked`, and `stale` are **rest states, not terminal ones**: each is a place a node run waits for a human or a recovery claim, and each has exactly the two exits above. Without them the Recovery table's "retry the same reserved visit" instructions would have no legal transition to make, which is the contradiction this row set closes. `completed` and `cancelled` are the only terminal node-run statuses. A recovery retry never moves the token (it stays `claimed`) and never allocates a second visit — the launch-attempt counter is the only thing that changes, exactly as the "no `claimed → pending`" rule requires.

**Lease** — see the `approach_resource_leases` entry above.

### Delete policy

One row per table, binding to the repository's existing deletion contract — `TICKET_CHILD_TABLES` (`store/tickets.ts`, `TICKET_CHILD_TABLES`) and `deleteTicket`'s explicit ordered leaf-first deletion (`tickets.ts`, `deleteTicket`) with the ledger detached first:

| Table | Ticket/parent reference | ON DELETE behavior |
|---|---|---|
| `approach_graph_runs` | `ticket_id REFERENCES tickets(id)` | **no cascade** — graph history is immutable evidence |
| `approach_planner_runs` | `graph_run_id REFERENCES approach_graph_runs(id)` | cascades with the run via the explicit sequence |
| `approach_graph_revisions` | `graph_run_id REFERENCES approach_graph_runs(id)` | cascades with the run via the explicit sequence |
| `approach_node_runs` | `graph_run_id REFERENCES approach_graph_runs(id)` | cascades with the run via the explicit sequence |
| `approach_graph_tokens` | `revision_id REFERENCES approach_graph_revisions(id)` | cascades with the revision via the explicit sequence |
| `approach_artifact_instances` | `graph_run_id REFERENCES approach_graph_runs(id)` | cascades with the run via the explicit sequence |
| `approach_resource_leases` | `owner_node_run_id REFERENCES approach_node_runs(id)` | cascades with the node run via the explicit sequence |
| `approach_node_overrides` | `graph_run_id REFERENCES approach_graph_runs(id)` | cascades with the run via the explicit sequence |

The eight tables are added to the explicit deletion sequence **after `process_runs` and before the older child tables**; a graph run whose ticket is hard-deleted mid-execution runs the explicit sequence, with the byte-subtree removal (Task 7) after the rows — live processes are handled by the Task 7 `servers`-registry registration, never by the delete itself. Archive (a soft delete) removes nothing. No `ON DELETE CASCADE` is added to any new table's ticket reference; correctness never depends on a cascade firing.

### Lineage

`fork_instance_id` is a host-generated UUIDv7 string minted at each fork execution. Every descendant token carries a bounded fork-lineage **stack** of those ids, outermost first, with a maximum depth equal to the compiler's nesting bound. Join correlation matches on the full lineage stack **and** the fork's visit number, so two arrivals from the same predecessor at different loop iterations never correlate. Artifact instances record the producing run's lineage stack, and input resolution walks the activation's own lineage — an instance from a superseded revision is never in a new revision's lineage, which is what prevents cross-revision binding.

### Retention

Graph evidence survives archive, dies with `deleteTicket`, and is not pruned per-ticket in V1. The per-ticket upper bounds — ≤1000 tokens, ≤200 node runs, ≤6 revisions, and the artifact/workspace byte ceilings — are what make unbounded growth impossible.

Foreign keys, closed-value `CHECK`s, and unique indexes enforce the state model. Required uniqueness includes one graph run per ticket/stage attempt (with the selected approach ID recorded), one revision number per run, one planner-run number per run, one node visit per revision/node, one claimant per token, one successor per `(source node run, edge, fork instance)`, and at most one active revision per graph run — the active revision is **derived**, never stored: read `approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'`, following the read-filtered derivation precedent in `store/mergeChecks.ts`. Every graph write joins through the ticket and requires current project plus stage attempt. Token claim, visit allocation, budget reservation, lease acquisition, and launch-state transition occur in one immediate transaction and proceed only after affected-row checks. Replan election and graph close use the same compare-and-set discipline. Correctness never depends on an in-memory single-flight or one open window.

All writes that finalize a node, consume claimed activations, create successor tokens, update counters, and change graph/revision status occur transactionally. Surrogate IDs permit retries and loops without destructive overwrites.

Large prompts, logs, plans, and output content remain immutable files, never DB blobs. Canonical topology JSON is bounded and stored because reload must execute the exact validated revision even if the planner artifact or package later changes — the stored canonical bytes are **authoritative** on reload, the SHA-256 fingerprint is verified on read, and a mismatch **blocks** rather than silently recompiling. The stored canonical JSON is the validated, default-expanded document, bounded by the compilation limits (`maxNodeRuns <= 200`). The canonicalization implementation is pinned by a reference-graph test whose expected output must not change across dependency upgrades.

Graph tickets write **no `phase_marks` rows**: the only writer is `recordPhaseMark` (`store/phaseMarks.ts`, `recordPhaseMark`), reachable only from `karst phase`, which graph seeds never contain. All new CLI store paths use bound positional parameters, per the CLI's driver-agnostic convention, pinned by a test.

The additive schema migration is atomic by mechanism: `BEGIN IMMEDIATE` opened **before reading `user_version`**, every guarded DDL step plus the `user_version` bump inside it, then `COMMIT`. This is a change from today — `migrate()` (`store/migrations.ts`, `migrate()`) has no outer transaction and each step autocommits, with idempotency coming only from column guards. Every statement stays guard-based so a mid-crash re-run is safe, and busy behavior relies on the connection's busy timeout at open. The DDL is byte-identical in `src/store/schema.sql` and in the new guarded step in `src/store/migrations.ts`, `SCHEMA_VERSION` is bumped from **whatever the tree carries when the migration is written** — `34` as of this correction (`src/store/migrations.ts:9`), not the `33` this paragraph originally recorded, because the repository shipped another migration in between — and `db.test.ts`'s hardcoded `user_version` and table-count assertions are updated. Graph-writing host and CLI paths require an explicit compatible schema range and fail closed on both older and newer unsupported schemas. The same migration adds the two nullable graph FKs to `token_usage` (`approach_planner_run_id`, `approach_node_run_id`, both `ON DELETE SET NULL` — Decision 25). A migration interrupted mid-transaction rolls back with `user_version` unchanged, so the next open re-runs the same guarded steps. Tests cover concurrent open, interrupted/partial prior state, and retry.

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

The compiler never imports stores, providers, VS Code, or the ticket stage machine. The store never launches processes. Executors never choose edges. Provider adapters never contain graph transitions. UI actions call coordinator/store services and do not mutate graph semantics locally. Only extension composition imports VS Code. The graph/stage integration has exactly **three** surfaces, and `src/workflow/graphMarkerGuard.ts` owns the graph-side logic of all three so the count stays at three: the guarded IMPL marker service, the `approach-graph-failed` stage block write and clear, and the typed graph recovery action. The third surface necessarily has a second file: `stageResume` is an existing stage-side module and keeps its own home, but it holds **no graph logic** — it recognizes the one blocker kind it may not clear and returns the typed action this module defines. That is the precise contract: three surfaces, one graph-side owner, and exactly one stage-side module that references it. A fourth reference from anywhere else in `src/workflow/` is a boundary violation, pinned by an import-graph test. Graph/node CLI handlers may import driver-agnostic graph-store operations but never the workflow machine.

`withBuiltInApproaches(manifest)` sits between manifest load and the approach consumers (ticket form, Settings, launch resolution) in the dependency order; it is the only place any consumer may learn about built-ins, and it imports no fs and no vscode.

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

**BlockerKind ripple.** `approach-graph-failed` is one new member of the closed `BlockerKind` union (`model/types.ts`, `BlockerKind`), and every consumer of the union gains an explicit case:

| Consumer | Behavior for `approach-graph-failed` |
|---|---|
| `needsUser` (`model/ticketGlyph.ts`) | Amber — the graph needs a human decision |
| dashboard `renderBlocked` | Title "Implementation graph blocked"; renders a **graph recovery** button, not the generic Resume |
| `resumeBlockedStage` (`workflow/stageResume.ts`) | Refuses to clear it; returns the typed graph recovery action instead of `true` |
| Inside ship/stage strips | Lists every blocking planner/node run, not only the projected earliest |

`resumeBlockedStage`'s return type widens from `boolean` to a discriminated result — `{kind:'cleared'} | {kind:'refused'} | {kind:'graph-recovery', ticketId, graphRunId}` — and every caller updates. The current implementation returns `boolean` and clears any block whose kind is not `awaiting-merge`, which is exactly why this is a mandatory compatibility change: without it, the generic path would clear the graph block. A graph ticket that is also `awaiting-merge` is impossible — `awaiting-merge` belongs to `ship`, the graph to `impl` — so no consumer writes defensive code for it. When multiple node runs block simultaneously, the stage block projects the earliest by durable event order while Inside lists all. The marker guard runs after graph quiescence and is authored by the host, not by the graph runtime — it is not a graph event — and stage block writes for `approach-graph-failed` go through the existing stage-block infrastructure (`store/stageBlocks.ts`), never a direct `UPDATE stages`. A stage block written after the ticket has already left `impl` is refused by the existing stage-scoped write path.

Recovery is category-specific:

| Category | Resume action |
|---|---|
| provider/model/effort configuration | retry the same reserved visit using the latest late-bound configuration and a new launch attempt (a launch retry does not re-snapshot the prompt) |
| prompt configuration | explicit Resume re-snapshots the effective prompt bytes from the current packaged/override files and retries the same reserved visit |
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
- A node found in `completing` or `integrating` with a demonstrably dead process: resume the completion pipeline from where it stopped — terminate-verify, snapshot, integrate, then consume the already-reported outcome. Do not re-execute the node; the outcome is already in hand and re-running duplicates both spend and integration.
- A node found in `completing` or `integrating` with a live attributable process: revert the status to `running` and let completion proceed normally.
- A completed node whose successor tokens were committed is scheduled exactly once.
- Pending non-conflicting tokens resume scheduling.
- A draining revision waits for active work or continues replanning after quiescence.
- A blocked graph remains blocked until Resume/config change.
- A completed graph at `impl` remains awaiting the explicit stage marker.
- A ticket no longer at `impl` cancels unscheduled tokens and prevents new graph work without rewriting completed evidence.

Launch generations and completion capabilities remain planner/node-run-owned. Stale, duplicate, wrong-project, wrong-window, wrong-attempt, wrong-capability, unknown-node, and out-of-order notifications cannot schedule work. Completion writes are **window-agnostic by design** — there is no window field in the conditional UPDATE and there must not be, because after a reload the old window's agent is still the legitimate owner; "wrong-window" applies solely to loopback routing identity. Coordinator correctness comes from durable conditional claims, so multiple windows may reconcile concurrently without duplicate external work.

## Settings and Graph UI

No visual graph editor is required. Packaged planner prompts and user configuration remain editable.

Settings → Approaches provides:

- built-in enable/disable;
- bootstrap planner profile and prompt link;
- execution-profile provider/model/effort mappings;
- trusted command allowlist editor;
- prompt override editor (planner and node base prompts, through the stable override paths below);
- per-node override editor (provider/model/effort/profile for a selected non-active agent node);
- artifact and resource constraints (per-artifact/per-log/aggregate byte ceilings and workspace disk ceiling);
- concurrency and budget ceilings;
- generated-graph confirmation policy. Confirmation is the one control Stop cannot replace: Stop interrupts work already underway and already paid for, while confirmation is the only point at which a user can read the generated topology before any token is spent executing it.

#### Budgets

A named **Budgets** subsection groups the wall-time ceilings: graph lifetime, planner/agent wall time, agent idle time, and command timeout, each with its packaged default and hard ceiling (see `## Budgets and Escalation`). Saving a wall-time budget outside the hard ceiling is refused at Save.

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

Background execution emits bounded structured diagnostics keyed by project, ticket, stage attempt, graph, revision, planner/node run, and generation (**Slice 6** — until then, closed event categories cover compile, claim, defer, launch, completion rejection, integration, recovery, replan, block, and close at V1). Per-invocation interactive usage reporting is likewise **Slice 6**; until then graph spend is not broken down per invocation in the usage UI. Inside provides “Copy diagnostic”/“Open log” without including completion capabilities, prompt/completion text, secrets, or unredacted command output.

### Inside controls for a graph ticket

The Inside view for a graph ticket replaces the generic Launch / Open session / reveal-terminal controls: Open focuses the planner or a chosen node terminal (never spawns, per the entry-point matrix); Stop signals the coordinator to drain; Resume routes through the typed graph recovery action; and “Complete implementation” is the only marker entry. The board glyph shows the graph state for a graph-running ticket, and a graph-blocked ticket renders the `approach-graph-failed` amber/needs-user treatment.

The UI consumes persisted runtime state and does not define routing. Every graph-derived label, reason, artifact name, and log line is rendered as text or through one audited HTML/attribute escaper; ANSI/control sequences and unsafe link schemes are removed, and the webview CSP remains authoritative.

## Security Invariants

- The graph runtime exists only inside `impl`.
- Graph END and node completion cannot import or invoke the ticket stage machine; the sole integration is the graph-aware IMPL marker guard after durable quiescence.
- An active graph approach's IMPL marker is impossible before the matching project/ticket/stage attempt is `completed-awaiting-impl-marker`.
- Project identity is mandatory and graph/marker writes never fall back to unscoped ticket lookup.
- `stage`, `node`, and graph-planner submission remain separate closed CLI paths.
- Generated graph data cannot supply provider/model/effort, credentials, callback addresses, stage ids, timestamps, attempts, launch generations, raw shell, SQL, JavaScript, or arbitrary condition code.
- Agent completion cannot supply ticket, graph, revision, node, edge, destination, provider, model, effort, artifact root, callback URL, timestamp, capability, or launch generation in argv.
- Free-form reasons are evidence only, collapsed and capped, prefixed `[agent-reported]` in every rendering, and never routing labels.
- Commands resolve through pinned trusted allowlist IDs, an absolute executable, fixed argv, and a minimal explicit environment without a shell or agent secrets.
- Artifact paths are canonically contained, link-safe, immutable snapshots; resource safety uses physical worktree/Git domains rather than repository aliases.
- Writing agents run in isolated workspaces with independent writable Git metadata; actual diffs must fit declared claims before deterministic integration.
- No resource lease is released while process termination is unknown.
- Edges and outcomes come from the pinned validated revision.
- Every completion requires a run-specific unforgeable capability; duplicate/stale/out-of-order events are idempotently rejected. Capability validation is one-shot per node run — the first mutating verb (`complete`, `block`, or `replan`) consumes it — and capabilities rotate per launch attempt and generation.
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
- generated provider/model/effort rejection;
- the expert-budget compile formula rejects an over-budget expert node;
- the compile repair loop stops at 3 attempts and charges no planner-run budget.

### Profiles, commands, prompts, and delivery

- package/project profile merge and exact precedence;
- built-in registry absence/default, enable tombstone, field reset/delete, and upgrade merging;
- user node overrides including blocked retry and launch-claim CAS;
- shared model catalog/custom IDs;
- distinct model syntax, compatibility, and launch-availability failures;
- core-level fallback disabled/detected; inability to prove exact model blocks;
- Claude/Codex/Agy/OpenCode effort-capability UI and exact adapter translation;
- packaged Claude Opus `high` and Sonnet `low` defaults validate;
- trusted command absolute executable/direct argv, cwd, timeout, access, pinned fingerprint, and minimal environment;
- planner/base prompt override/reset/upgrade preservation;
- analyzer-only automatic selection gated on `pickerTouched`; `defaultApproach` rule unchanged;
- complete tracked package inventory, abandoned two-phase retirement, ignored/untracked CI failure, and VSIX byte parity;
- manifest round-trip of a full graph config block through load → save → load;
- a labelless tombstone is refused; merge is by `id`, not position;
- the built-in resolves through `withBuiltInApproaches` in all three consumers and counts as installed;
- a model without `efforts` rejects an effort value; an OpenCode profile with both model and effort is rejected at Save;
- a prompt modified on disk mid-run does not affect the active run.

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
- `stage impl pass` rejects before quiescence and closes exactly once afterward in the guarded transaction;
- per-repository command subprocesses run serially and consume one slot;
- each of the five entry-point matrix rows;
- step-11 quiescence and status flip are one transaction under concurrent completion;
- an N-ary join firing is all-or-nothing;
- a busied claim aborts without blocking the event loop and is retried next tick;
- a completion whose wake-up is lost is scheduled by the periodic sweep.

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
- no false claim that a dependency-waiting node is resource blocked;
- graph sessions register with the `servers` registry and are reaped by `removeWorktree` and the global sweep.

### Completion/event safety

- valid complete/block/replan;
- agent cannot name destination;
- stale/duplicate/wrong-project/wrong-window/out-of-order rejection;
- unknown outcome rejection;
- durable completion before wake-up;
- node-specific capability validation;
- callback without DB commit advances nothing;
- concurrent windows claim one token/node visit and create one successor set;
- graph-derived UI/log injection fixtures remain escaped and bounded;
- capability consumed by the first mutating verb and rotated per attempt;
- replan reasons arrive as an artifact, never argv.

### Artifacts and integration

- symlink/reparse, hardlink, non-regular, pre-existing output, traversal, Windows alias, oversize, and type mismatch rejection;
- the single-descriptor artifact read rejects a symlink, a FIFO, a hardlinked file, and a mid-flight swap;
- artifact root and workspaces resolve outside every worktree and are invisible to `git status`;
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
- no terminal interpreted as success;
- `Discard unknown process` cancels the token, releases budgets and leases, and re-evaluates;
- the token transition map admits exactly four transitions;
- crash mid-`completing` with a dead process resumes rather than re-executes;
- a `replan` with no qualifying lineage evidence is treated as `blocked`.

### Compatibility and project invariants

- existing non-graph approaches still launch unchanged;
- existing manifests do not require manual migration;
- ticket stage graph remains unchanged;
- project scoping prevents cross-window/cross-project scheduling;
- graph migrations are atomic/idempotent and old/new incompatible CLIs fail closed;
- token usage recorded once at the headless-adapter or interactive-transport seam, with unknown rather than false zero;
- non-graph approaches retain existing launch, marker, settings, and session behavior through every delivery slice;
- typecheck, focused Vitest suites, full `npm test`, and build pass;
- migration atomicity under `BEGIN IMMEDIATE` with an interrupted prior run;
- `deleteTicket` removes graph rows and bytes; archive removes neither;
- graph launches open `process_runs` rows and usage is recorded once.

## Delivery Strategy

This design is implemented through sequenced vertical plans, not one cross-cutting “big bang.” Every slice leaves existing non-graph approaches releasable and keeps migrations forward-compatible:

1. **Package and configuration foundation:** tracked built-in package registry, enable tombstone/merge semantics, stable prompt overrides, analyzer-only selection, shared model/effort capabilities, command schema, and VSIX parity. The built-in ships **disabled by default** (`enabled: false`), invisible to the picker, the analyzer, and launch resolution; this slice also carries the manifest pipeline obligations, the `withBuiltInApproaches` overlay seam, the catalog `efforts` metadata plus adapter capability tests, and the Slice-1 half of the measurement baseline.
2. **Durable planning and compilation:** atomic schema migration, graph/planner/revision/artifact stores, planner submission capability, pure parser/compiler, structured fork/join validation, canonical fingerprints, and read-only Inside projection behind a feature flag.
3. **Sequential execution and guarded completion:** atomic activation claims, agent/command/gate/join executors with `maxParallel: 1`, supervised transport, immutable artifacts/change sets, canonical integration, graph-aware Resume, and transactional IMPL marker guard. This is the slice that flips the packaged default to enabled, once planner submission, executors, and the guarded marker exist — the failure it prevents is a ticket picking the approach in Slices 1–2 getting an impl launch with no graph runtime behind it. Its entry condition is the Slice-3 cost comparison of the Premise and Measurement section.
4. **Loops, recovery, and immutable replan:** repeated visits, causal artifact binding, budget enforcement, crash matrix, stale/unknown process handling, replan election/drain, and revision N+1.
5. **Safe parallel execution:** isolated node workspaces, physical-domain leases, fork lineage, deterministic integration, fairness, concurrent fault projection, and multi-window race coverage; only here may `maxParallel > 1` be enabled — this slice also raises the packaged `maxParallel` default from `1` to `4` as part of its own change.
6. **Optional transport and observability extensions:** ACP transport when supported, interactive usage reporting, structured diagnostics, and richer graph projection without changing scheduler semantics.

Per-slice API dependencies: Slice 2 depends on Slice 1's manifest and registry seams and extends them with the durable stores; Slice 3 depends on Slice 2's stores and parser/compiler and extends them with executors and the guarded marker; Slice 4 depends on Slice 3's executor and transport contracts and extends them with repeated visits, recovery, and replan; Slice 5 depends on Slice 4's recovery and fork-lineage machinery and extends it with workspaces, leases, and parallelism; Slice 6 depends on Slice 5's scheduler semantics and extends only observability and transport surfaces, never scheduler semantics. The per-slice plan output location is `docs/plans/`, following this repository's existing convention: one parent roadmap plus one detailed executable plan per slice.

The implementation-planning handoff produces one parent roadmap plus a detailed executable plan per slice. A later slice cannot weaken a prior slice's stage, project, capability, artifact, transaction, lease, workspace-location, or capability-rotation invariants.

## Premise and Measurement

Four premise-level positions are stated here so no implementation detail can reopen them.

**Integration doctrine.** Karst retired the `merge` stage because a landing is not work karst performs — that rule is about the **PR boundary**, where a remote, a teammate, and a review sit between karst and the result. Intra-ticket integration is different in kind: karst owns both sides, there is no remote, and the conflict being resolved is one karst created by fanning the work out. Therefore the graph runtime integrates node change sets into the ticket's canonical worktrees, and `integration-conflict` is a graph blocker — while the PR-landing rule is untouched. This distinction is load-bearing and must not be re-litigated during implementation.

**Cost model.** Before Slice 3 commits to the executor design, a worked cost comparison on one representative ticket — single-agent `impl` versus the generated graph — is produced and recorded in this document. The question is open because every node launches a fresh session with no `--resume`, so cached-prefix reuse is deliberately given up, and artifacts bound transcript growth but not re-sent context. The decision rule: if the graph costs materially more for an equal outcome, budgets expressed as run counts and wall time are the wrong control surface, and the budget primitives are revisited before Slice 3 ships. If the comparison is not produced by the time Slice 3 starts, that blocks Slice 3 — deliberately.

**Success and abandonment criteria.** The measurement is baselined in Slice 1 and evaluated after Slice 3: on N real tickets, compare graph versus non-graph on implementation wall time, total token cost, count of human interventions, and UAT-pass-on-first-attempt rate. The abandonment criterion: if the graph does not improve at least one of those four without worsening the others, the approach ships disabled and the slices after it are not built. A measurement favorable on cost but unfavorable on intervention count is covered by the same rule — improvement in at least one dimension without regression in the others.

**Platform scope.** The Windows path rules — alternate data streams, reserved device names, drive/UNC escapes, trailing dots and spaces, Unicode-normalization aliases — are enforced by **pure-string unit tests over the normalizer**, and no Windows runtime support is asserted for the graph runtime in V1. This is necessary because the native addon ships a `darwin-arm64` prebuild and no Windows runtime is under test.

## Architectural Rationale

The built-in approach is a planner plus a trusted runtime, not a predefined workflow. This adapts topology to task shape while keeping routing deterministic and auditable.

Execution profiles separate capability intent from vendors, so projects can move `expert` and `worker` work across Claude, Codex, Agy, OpenCode, and future adapters without regenerating topology.

Allowlisted commands keep deterministic verification cheap and authoritative. An LLM may decide that a configured `test` capability belongs in the plan; it cannot invent the executable that runs.

Artifacts prevent token cost from growing with cumulative transcripts. Fresh sessions consume only ticket context, bounded instructions, declared inputs, relevant repository state, and failure evidence.

Immutable revisions reconcile adaptability with recovery. Replanning is permitted and recorded, but a running revision never changes underneath the scheduler.

Resource-aware scheduling honors detailed planning by running all independent work concurrently in isolated workspaces. Isolation is necessary because Git state, generators, commands, stale processes, repository aliases, and newly discovered shared files are real execution constraints that a plan alone cannot enforce. Actual diff validation and deterministic integration turn the plan's claims into checked evidence instead of trusting them as containment.

The result is a scalable implementation approach without turning Karst into a general workflow engine or weakening the ticket stage machine.
