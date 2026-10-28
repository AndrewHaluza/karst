/**
 * Typed model of `karst.yml` (§7.1). Produced by the manifest loader after
 * validation; every downstream consumer (resolver, spin) reads this shape.
 */

import type { SandboxMemoryConfig } from '../agent/docker/dockerMemory.js';
import type { AgentBackends, CoreBackend } from '../agent/backendChoices.js';

export interface PortSlot {
  name: string; // slot identity, e.g. "port", referenced by dependsOn.port
  env: string; // the env var that sets this port
  default: number; // baseline / default-mode value
}

export interface BindVar {
  env: string; // the env var a dependent uses to reference the target
  template: string; // e.g. "http://{host}:{port}"
}

export interface DependsOn {
  target: string; // another repository name (which must declare a service)
  port: string; // a port slot name on the target's service
  bind: BindVar[]; // env var(s) rendered from the target's (host, port)
}

/**
 * The RUNNABLE ASPECT of a repository — an optional relation, not an entity.
 *
 * Everything here is meaningless without a process to run: a start command, the
 * ports that process binds, the URL that proves it came up, and the peers it
 * needs addresses for. A repository that is only ever edited (karst's own
 * extension repo, a docs tree, a shared-config package) declares no service and
 * therefore cannot carry any of these fields — which is the point. Before this
 * split they were mandatory, so such a repository could only be registered by
 * inventing a fake `start` and a fake port.
 *
 * `repoPath`, `hasMigrations` and `signals` live on `RepositoryDef` instead:
 * they describe the source tree, and stay true whether or not anything runs.
 */
/**
 * A service whose process is a CONTAINER rather than a command in the worktree.
 *
 * It is not a second runtime: `runtime/dockerCommand.ts` renders this block into
 * the same `docker run …` argv `startHot` spawns for any other service, so port
 * reclaim, the health gate, the log file, the `servers` row and `killTree` are
 * unchanged. The one thing this block adds is a NAME — deterministic, recorded,
 * and never reissued the way a pid is — which is what lets every stop and reap
 * path remove the container itself instead of only the client attached to it.
 */
export interface DockerDef {
  /** Image reference, e.g. `postgres:16`. */
  image: string;
  /**
   * The port INSIDE the container. The allocated host port is published onto it,
   * so a container's own fixed port never has to move for a second ticket.
   */
  containerPort: number;
  /** `-e` variables. Merged OVER the resolved service env, so the block wins. */
  env: Record<string, string>;
  /** `-v` mounts, `src:dst[:opts]`. A relative `src` resolves against the worktree. */
  volumes: string[];
  /** Command/arguments after the image — an override of the image's own CMD. */
  args: string[];
}

export interface ServiceDef {
  /**
   * The start command, or `''` when `docker` carries the process instead.
   * Exactly one of the two is declared; validation rejects both and neither.
   */
  start: string;
  /** Run this image instead of `start`. See `DockerDef`. */
  docker?: DockerDef;
  health?: string;
  /**
   * Optional command that resets the service's state between agent UAT and
   * user UAT in a sandboxed ticket (arch:AC-32 decision 8). Run inside the
   * sandbox (`sh -c`, in the service's cwd) on the SAME running instance.
   * Absent → state is left as the Tester left it.
   */
  reset?: string;
  /**
   * Directory the process runs in, relative to the repository/worktree root
   * (e.g. `apps/api`). Absent → the root. Lets several services of one
   * monorepo share its single worktree yet start from their own folder.
   */
  cwd?: string;
  /**
   * Require the health response to prove it is THIS start, by echoing karst's
   * per-start token (`KARST_INSTANCE_TOKEN` in the spawn env) back in the
   * `X-Karst-Instance` header. Default false, because it is a contract the
   * service has to keep: a service that does not echo the header never becomes
   * healthy once this is on.
   *
   * Worth keeping for anything several worktrees run at once. Without it,
   * readiness is reachability — any 200 on the port passes, including one from
   * a DIFFERENT worktree's service that holds the port (a leaked process, a
   * default-port fallback). That is a wrong PASS: the stack comes up green
   * while wired to another branch's process.
   */
  healthIdentity?: boolean;
  ports: PortSlot[]; // validated non-empty — a service without a port cannot be addressed
  /**
   * Optional per-service allocation window. When present, ticket-hot ports for
   * this service are allocated ONLY from this inclusive [min, max] window,
   * overriding the manifest-level `portRange`. Absent → the global range.
   */
  portRange?: [number, number];
  dependsOn: DependsOn[];
}

/**
 * Per-repository ship behaviour. Today the one knob is `exclude`: git pathspecs
 * (glob magic, e.g. `dist/**`) that ship's sweep commit must leave out of the
 * index it builds in quarantine. Excluded paths stay dirty in the worktree —
 * nothing is deleted and the live index is untouched — but they never reach the
 * sweep commit. Committed changes are never affected: committing a path is the
 * escape hatch for shipping it on purpose.
 */
export interface ShipDef {
  /**
   * Git pathspecs (glob magic) ship's sweep commit must not stage. Each entry is
   * a plain pathspec — karst adds the `:(glob)` magic prefix itself, so an entry
   * starting with `:` is refused rather than silently misapplied.
   */
  exclude?: string[];
  /**
   * Shell commands that regenerate this repository's checked-in generated files
   * (e.g. `npm run -s docs:covers`). "Rebase on base" runs each in the worktree
   * after the rebase and commits what they change — the only way generated
   * output is touched, so a conflict in a generated file is never hand-merged.
   */
  regenerate?: string[];
}

/**
 * A repository's overrides of the three git artifact templates that CAN vary
 * per repo. Deliberately a subset of `ArtifactConventions`: `defaultType` steers
 * `{type}` for every repo from one place, and `branchName` is one branch per
 * ticket (@arch:BRANCH-NAME), so neither is overridable here. Every key is
 * optional and each falls back to the global `conventions.<key>` independently.
 */
export interface RepoConventions {
  commitMessage?: string;
  pullRequestTitle?: string;
  pullRequestDescription?: string;
}

/**
 * The PRIMARY ENTITY: a git repository karst can worktree, scope to a ticket,
 * classify, and ship. Runnability is the optional part (`service`), not the
 * assumption.
 */
export interface RepositoryDef {
  repoPath: string;
  /** Overrides the manifest-level default branch for this repository. */
  baselineBranch?: string;
  /**
   * [M2] Author-declared: does this repository carry DB migrations? Drives
   * T4.2's "not first-class under shared-DB" warning. Deterministic (not a
   * filesystem heuristic) so the resolver/scope path stays pure. Repository-level
   * because a migration is something the source tree CONTAINS — a repo with no
   * runnable service can still hold migrations. Defaults false.
   */
  hasMigrations: boolean;
  /**
   * Repo-classifier signal words (title/description/tag tokens that point a
   * ticket at this repository). Authored ahead of ticket time; empty/absent =
   * the repository is "unclassified" and the ticket-form classify-gate prompts
   * for signals. `validateManifest` always populates this (defaulting `[]`); it
   * is optional on the type only so hand-built fixtures need not supply it. Read
   * it via `isRepoClassified` / `?? []`, never assume presence.
   *
   * Repository-level: a non-runnable repo still has to be classifiable, or no
   * ticket could ever be routed to it.
   */
  signals?: string[];
  /**
   * Conventional-commit scope for artifacts touching this repository (`{scope}`).
   * Absent = the repository's manifest name. Repository-level, like `signals`: it
   * describes the source tree, not a running process.
   */
  scope?: string;
  /**
   * Per-repository overrides of the project's git artifact conventions
   * (`repositories.<name>.conventions`). Each key falls back INDEPENDENTLY to the
   * global `conventions.<key>`, then to today's default (the ticket title for
   * commit/PR title, the generated body for a PR description) — the same
   * layering as `scope:`. Repository-level, like `signals`: it describes how the
   * source tree is shipped, not a running process.
   *
   * `branchName` is deliberately NOT here: a ticket has ONE branch name across
   * every repository, rendered once at worktree creation (@arch:BRANCH-NAME), so
   * it cannot vary per repo — the schema refuses a per-repo `branchName`.
   */
  conventions?: RepoConventions;
  /**
   * The runnable relation. ABSENT means this repository is not runnable — that
   * is a valid, first-class state, never an error and never a sentinel. Gate on
   * it via `isRunnable` (`manifest/runnable.ts`) rather than testing the field
   * directly, so the narrowing is done in one place.
   */
  service?: ServiceDef;
  /**
   * The multi-service shape: a NAMED map of services sharing this repository's
   * one worktree (a monorepo with apps/web + apps/api). Mutually exclusive with
   * `service` — a file declaring both on one repository is refused. `service:`
   * stays as the shorthand for ONE service named after the repository.
   * Addressed everywhere as `repo/service`; see `manifest/runnable.ts`.
   */
  services?: Record<string, ServiceDef>;
  /**
   * Sandbox provisioning for this repository (arch:AC-36). `setup` is the command
   * (e.g. `npm ci`) run INSIDE a sandboxed ticket's clone before its gates, so
   * the gates find node_modules. Absent = no step, gates run as before.
   * `setupHosts` (host or `*.suffix` names, port 443) are the only extra hosts the
   * sandbox may reach WHILE the setup runs; absent = `DEFAULT_SETUP_HOSTS`.
   */
  sandbox?: { setup: string; setupHosts?: string[] };
  /**
   * Ship behaviour for this repository. Absent means "ship the whole worktree"
   * — the default. The one knob today is `exclude`, the pathspecs ship's sweep
   * commit leaves out.
   */
  ship?: ShipDef;
  /**
   * Whether this repository is used by the system. `false` is the DRAFT state:
   * the settings UI lets an author save an incomplete repository as long as it
   * is disabled, and a saved-valid repository can be toggled off the same way.
   * `validateRepository` relaxes required-field checks when this is `false` —
   * an enabled repository still has to be complete. Always concretely set by
   * `validateRepository` (default `true`, matching `ApproachDef.enabled` /
   * `AgentDef.enabled`); optional on the type only so hand-built fixtures need
   * not supply it.
   */
  enabled?: boolean;
}

/**
 * Source recipe for fetching an installable approach: one of git (clone a
 * repository) or npm (run a package command). Discriminated union keyed by `type`.
 */
export type ApproachSource =
  | {
      type: 'git';
      repo: string; // repository URL
      ref: string; // branch, tag, or commit ref to fetch
      include: string[]; // glob patterns of paths to collect (e.g. ["prompts/", "approach.yml"])
    }
  | {
      type: 'npm';
      package: string; // npm package name
      command: string; // command to run (e.g. "npm install", "yarn add")
      collect: string[]; // glob patterns of paths to collect from the result
    };

/**
 * A single phase in an approach's workflow (§ ticket form). `command` is a
 * native slash command to invoke for the phase (e.g. "/rpi:research");
 * absent when the phase has no dispatchable command.
 */
export interface WorkflowPhase {
  name: string; // e.g. "research"
  command?: string; // native slash command to invoke, e.g. "/rpi:research"
  description?: string; // human guidance for the phase
}

/**
 * The built-in graph runtime's planner declaration: which execution profile the
 * bootstrap planner runs under, and which packaged prompt artifact feeds it.
 */
export interface GraphPlannerConfig {
  /** Profile id from `profiles`, e.g. "expert". */
  profile: string;
  /** Packaged prompt artifact (relative path under the approach package). */
  prompt?: { artifact: string };
}

/**
 * One named execution profile: the provider/model/effort an agent node
 * resolving to this profile launches with. Generated graphs may reference a
 * profile id, never a provider/model/effort (karst owns routing).
 */
export interface GraphProfileConfig {
  provider: AgentProvider;
  model: string;
  effort?: string;
}

/**
 * The capabilities a preset can override — the ROWS of the preset matrix (§3).
 * The inside-process roles (same manifest spellings as `PROCESS_KEYS`, which
 * includes `planning`), the launch paths outside them, and the three graph rows
 * are the profile ids `expert`/`worker`/`fast`: an approach whose graph declares
 * a different profile id is untouched by presets.
 *
 * The array is load-bearing beyond typing — the legacy-flat normalization below
 * widens one `{provider, model}` bundle to a slot on EVERY row, so adding a
 * capability here is what makes an old preset cover it.
 */
export const PRESET_CAPABILITIES = [
  'uatTester',
  'uatFix',
  'review',
  'reviewFix',
  'prDescription',
  'ticketAnalysis',
  'implementation',
  'planning',
  'graphExpert',
  'graphWorker',
  'graphFast',
] as const;

export type PresetCapability = (typeof PRESET_CAPABILITIES)[number];

/**
 * One capability's explicit override: a core + model pair with an optional
 * effort/variant. Deliberately the same `{provider, model, effort?}` shape as
 * `GraphProfileConfig` and the old flat `AgentPreset`, because a slot replaces
 * that flat bundle wholesale — core, model and effort travel together, which is
 * what keeps "a model never crosses to another core" true of presets too.
 */
export interface PresetSlot {
  provider: AgentProvider;
  model: string;
  effort?: string;
}

/**
 * A named preset: a SPARSE capability → slot matrix (§ agent presets). An
 * absent capability is Inherit — it falls through to the process assignment /
 * per-agent config / manifest defaults, never to a guessed value. `label` is
 * the display name (Settings, ticket form); the map key is the persisted
 * reference name.
 *
 * A legacy flat `{provider, model, effort?}` preset is accepted at load and
 * normalized to the same slot on every capability, so a pre-existing preset
 * keeps applying globally (§6).
 */
export interface AgentPreset {
  label?: string;
  slots: Partial<Record<PresetCapability, PresetSlot>>;
}


/**
 * One trusted command definition a `CommandNode` may reference. `command` is
 * the executable name (resolved to an absolute host path at compile time),
 * `args` the fixed argv — never shell-interpolated. `cwd`/`access` use the
 * closed vocabularies; `env` is a bounded map of `NAME: value` string pairs
 * merged onto the minimal host environment.
 */
export interface GraphCommandConfig {
  command: string;
  args: string[];
  cwd: 'repository' | 'worktreeRoot';
  access: 'read' | 'write';
  timeoutSeconds: number;
  env?: Record<string, string>;
}

/**
 * The graph runtime's budget block (`limits`, deliberately not named `graph`
 * so `graph.graph` never occurs). Every numeric field is a finite safe integer
 * inside its explicit inclusive range; product hard ceilings are enforced at
 * manifest validation and cannot be raised by project configuration.
 */
export interface GraphLimits {
  confirmGeneratedGraph: boolean;
  maxParallel: number;
  maxNodeRuns: number;
  maxExpertRuns: number;
  maxReplans: number;
  maxActivations: number;
  maxGraphWallSeconds: number;
  maxAgentWallSeconds: number;
  maxAgentIdleSeconds: number;
  maxArtifactBytes: number;
  maxLogBytes: number;
  maxAggregateArtifactBytes: number;
  maxAggregateWorkspaceBytes: number;
}

/**
 * The nested `graph:` block on an approach entry (Decision 4): `planner`,
 * `profiles`, `commands` and `limits`, NOT hoisted to the top level — one
 * nested key keeps `SECTION_FIELDS.approaches` unchanged and confines the
 * validator work to one function. A block on a non-built-in approach id
 * validates and is inert (accepted, consumed by no runtime).
 */
export interface GraphApproachConfig {
  planner: GraphPlannerConfig;
  profiles: Record<string, GraphProfileConfig>;
  commands: Record<string, GraphCommandConfig>;
  limits: GraphLimits;
}

/** Fixed vocabulary for what an approach output is; checked at load. */
export const OUTPUT_KINDS = ['plan', 'research', 'spec', 'review', 'meta', 'script', 'other'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** A repo-relative glob an approach writes artifacts to, with its kind. */
export interface OutputDef {
  glob: string;
  kind: OutputKind;
}

/**
 * A development approach offered on the ticket form (§ ticket form). `id` is
 * the stable key persisted on a ticket; `recommended` marks the default pick
 * (at most one). `source` is absent for hand-authored/custom approaches (no fetch).
 * Extensible: custom approaches are just more entries.
 */
/** One edge of the artifact chain intent → spec → plan (reviewer conformance). */
export type ChainEdge = 'intent-spec' | 'spec-plan' | 'intent-plan';
export const CHAIN_EDGES: readonly ChainEdge[] = ['intent-spec', 'spec-plan', 'intent-plan'];

export interface ApproachDef {
  id: string;
  label: string;
  description?: string; // short "when to use" blurb
  entrypoint?: string; // which prompt starts the flow, e.g. "research"
  source?: ApproachSource; // absent = hand-authored/custom (no fetch)
  recommended?: boolean;
  workflow?: WorkflowPhase[];
  /** Where this approach writes artifacts; absent = built-in defaults (`effectiveOutputs`). */
  outputs?: OutputDef[];
  /** Chain edges this approach verifies itself; karst skips them. Absent = built-in table. */
  checks?: ChainEdge[];
  enabled?: boolean; // default true
  /** Nested graph-runtime configuration; present only on graph approaches. */
  graph?: GraphApproachConfig;
}

/**
 * A configured agent for a workflow role (research/plan/implement/…). `command`
 * is optional so a role can be declared before its runner is wired.
 */
export interface AgentDef {
  role: string;
  command?: string;
  promptPath?: string; // relative path to the agent's markdown file under agentsDir
  enabled?: boolean; // default true
}

/** How worktree paths render on the dashboard: absolute or project-relative. */
export type WorktreePathDisplay = 'absolute' | 'relative';

export type StopServersOnDone = 'ask' | 'auto' | 'off';
export const DEFAULT_STOP_SERVERS_ON_DONE: StopServersOnDone = 'ask';

/** Which ticketing backend a ticket's source/status is bound to. */
export type TicketProvider = 'clickup' | 'manual';

/** Which coding-agent CLI karst launches sessions with. */
export type AgentProvider = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'opencode2';

/**
 * Project-level templates for the git/GitHub artifacts Karst creates itself: the
 * ticket's worktree branch (scope stage) and the fallback commit + new pull
 * request (ship stage).
 */
export interface ArtifactConventions {
  /**
   * Worktree branch name. Rendered once, when the worktree is created; an
   * existing worktree keeps the branch stored on its row, so changing this never
   * renames anything.
   */
  branchName?: string;
  commitMessage?: string;
  pullRequestTitle?: string;
  pullRequestDescription?: string;
  /** `{type}` for tickets that carry none of their own; defaults to `feat`. */
  defaultType?: string;
}

/**
 * Ticketing integration config (§15). `provider` selects the backend;
 * `manual` (default) is local-only. `teamId` is ClickUp's workspace id
 * (needed for custom task ids); `listId` is the ClickUp list whose statuses
 * the settings picker loads and whose tickets `advanceOnShip` moves. Both
 * optional and provider-specific.
 */
export interface TicketingConfig {
  provider: TicketProvider;
  teamId?: string;
  listId?: string;
  /**
   * Push `shipStatus` to the provider after a successful ship. Always set by
   * `validateManifest` (default `false`).
   */
  advanceOnShip?: boolean;
  /**
   * Provider status NAME to set after ship (ClickUp's PUT takes a name, not an
   * id). Required when `advanceOnShip` is true; blank normalizes to undefined.
   */
  shipStatus?: string;
  /**
   * Push `startStatus` to the provider when work begins on a ticket. Always set
   * by `validateManifest` (default `false`).
   */
  advanceOnStart?: boolean;
  /**
   * Provider status NAME to set at start of work (ClickUp's PUT takes a name,
   * not an id). Optional even when `advanceOnStart` is true — unlike
   * `shipStatus`, a blank/missing value falls back to
   * `start.ts`'s `DEFAULT_START_STATUS` rather than failing validation, since
   * "in progress" is a sensible default most trackers already have.
   */
  startStatus?: string;
  /**
   * Offer the ticket-search dropdown on the Add/Edit ticket page: the Key
   * field becomes a combobox that lists the configured list's tickets, with a
   * status filter defaulting to the list's TODO status. Always set by
   * `validateManifest` (default `true`). Only meaningful for a provider that
   * can search (`clickup`); `manual` has no board to list.
   */
  searchEnabled?: boolean;
  /**
   * Mirror sub-tasks onto the provider. `off` (default, key absent): relation
   * rows only. `link`: the sub-task becomes a provider child task of its bound
   * parent and a blocking sub-task blocks the parent there. `full`: `link`
   * plus the sub-task's own stage pushes (`advanceOnStart`/`advanceOnShip`).
   */
  syncSubtasks?: SyncSubtasksMode;
}

export type SyncSubtasksMode = 'off' | 'link' | 'full';

export type GateKind = 'script' | 'command';

/**
 * Shared shape of one declared gate — the config surface UAT's `gates:` and
 * review's `gates:` both offer authors. `resolveGates`'s own `GateDef`
 * (`workflow/gates/resolve.ts`) needs only this much, so callers pass either
 * this or `UatGateDef` straight through rather than converting it. UAT extends
 * this with its own (currently inert) `report` field instead of redeclaring
 * the base fields a second time.
 */
export interface GateDef {
  name: string;
  kind: GateKind;
  script?: string; // kind: 'script' — the package.json script
  command?: string; // kind: 'command' — the binary, spawned without a shell
  args?: string[]; // kind: 'command'
  repo?: string; // manifest repository name; absent = every target
  /** Where a sandboxed ticket runs this gate; absent = `inside` (arch:AC-36). `host` runs it on the host after a verified sync. */
  sandbox?: 'host' | 'inside';
  /** `false` keeps the definition but skips the gate project-wide; absent = on. */
  enabled?: boolean;
}

/** UAT's gate shape: `GateDef` plus a repo-relative report path, inert in Phase 1. */
export interface UatGateDef extends GateDef {
  report?: string;
}
export interface UatAuthBootstrap {
  path: string;
  secrets: string[];
}
export interface UatAuthor {
  agent?: string;
  enabled: boolean;
}
export interface UatRepositoryOverride {
  env?: Record<string, string>;
  secrets?: string[];
  gates?: UatGateDef[];
  testDir?: string;
}
/**
 * How long a fix may show no progress before the watchdog parks it, in minutes.
 * The ONE default: every reader imports this rather than repeating the literal.
 */
export const DEFAULT_FIX_STALL_TIMEOUT_MINUTES = 60;

/** Optional ticket-analysis passes (`analysis:` in karst.yml). */
export interface AnalysisConfig {
  /** Opt-in extra pass listing unverified code hints for the implementer. Default false. */
  codePointers: boolean;
}

/**
 * Per-core subscription-quota view config (`quota:` in karst.yml). View-only
 * and warn-before-launch: karst reads each core's provider-reported usage
 * windows and warns when the resolved core is near a limit — it never blocks a
 * launch and never auto-routes to another core.
 */
export interface QuotaConfig {
  /**
   * Warn at or above this used-% of a core's TIGHTEST subscription window.
   * Always set by `validateManifest` (default 80). Whole number, 1–100.
   */
  warnThresholdPct: number;
  /**
   * Opt-in (default false) install of the Claude statusline wrapper into the
   * operator's GLOBAL `<CLAUDE_CONFIG_DIR>/settings.json`, so Claude sessions
   * karst did not launch also report quota. A pre-existing `statusLine` is
   * chained; turning it off restores the backed-up entry.
   */
  claudeGlobalStatusline?: boolean;
  /**
   * Opt-in (default false) FALLBACK source for the Claude quota row: when the
   * statusline cache is missing or stale, read the two subscription windows
   * from `GET https://api.anthropic.com/api/oauth/usage` using the OAuth access
   * token Claude Code already stored. The token is held in memory for the
   * request only — never logged, stored or refreshed — and every failure
   * degrades to the cached value or `unknown`.
   */
  claudeOauthUsageApi?: boolean;
}

export interface UatConfig {
  testDir?: string;
  maxFixAttempts: number;
  /**
   * The stall window for the fix loop, in minutes — the watchdog parks a fix
   * whose live-but-idle run shows no progress for this long. Configured per
   * gate; the watchdog takes the LARGER of the two gates' values. Required on
   * the type like `maxFixAttempts` (the validator defaults an absent key), so
   * an existing manifest keeps working byte-identically.
   */
  stallTimeoutMinutes: number;
  gates?: UatGateDef[];
  /** Every gate off: false/absent = run nothing (stage bypassed); true = probe package.json scripts. */
  probeWhenAllDisabled?: boolean;
  /**
   * Task 8: an optional deterministic verification command for the UAT
   * Tester's work — a host-authored `GateDef` (script/command) run through the
   * host gate boundary AFTER the Tester reports its observations. Its
   * completed exit code is the sole Tester-specific UAT verdict: 0 completes
   * the Tester, a completed nonzero exit fails UAT (opening a
   * Tester-attributed recovery round), and an execution failure parks without
   * consuming a Fix round. Absent → the Tester's observations are advisory
   * and the ordinary UAT gates decide progression alone.
   */
  testerVerifier?: GateDef;
  /**
   * Task 3.1: the manifest knob only — a LATER task wires this into the
   * actual UAT verdict. `undefined` reads as `'none'` (see
   * `UatTesterObservationsConfig.blockingSeverity`), matching every existing
   * manifest's behavior byte-for-byte.
   */
  testerObservations?: UatTesterObservationsConfig;
  /**
   * T663: the budget one Tester target may spend before the lane stops it and
   * re-asks for whatever the agent already observed. Absent → every target uses
   * the default (`UAT_TESTER_TOKEN_BUDGET`); a manifest that omits the block
   * behaves exactly as before.
   */
  tester?: UatTesterConfig;
  /**
   * Opt-in (@arch:BASELINE-REVIEW), manifest-only: repo-relative globs of files
   * (visual baselines, ratchet ledgers) whose change by a ticket counts only
   * after the USER approves it in the UAT report. Absent — or an empty `paths`,
   * which the validator drops — means the feature is off.
   */
  baselineReview?: UatBaselineReviewConfig;
  env: Record<string, string>;
  secrets: string[];
  passthrough: string[];
  origins: string[];
  authBootstrap?: UatAuthBootstrap;
  author?: UatAuthor;
  repositories: Record<string, UatRepositoryOverride>;
}

/** Closed severity vocabulary for review findings (§6.7's `review_findings.severity`). */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface UatBaselineReviewConfig {
  /** Repo-relative git pathspec globs; never empty (an empty list disables the knob). */
  paths: string[];
}

/**
 * Task T663: the UAT Tester's own spend budget. `tokenBudget` is the FRESH
 * (cache-read-excluded) token count the run's ledger may accumulate on one
 * target before the lane stops the call and re-asks it once to report what it
 * already observed. Manifest-only, like `blockingSeverity` — no Settings field.
 */
export interface UatTesterConfig {
  /** Fresh tokens one target may spend before the lane stops it. Default 400k. */
  tokenBudget: number;
}

export interface UatTesterObservationsConfig {
  /**
   * The worst severity a Tester observation may carry without failing UAT's
   * verdict. `'none'` (the default, and the shipped behavior) keeps every
   * observation advisory — see `uat/testerVerifier.ts`. Any Severity turns an
   * observation at or above it into a failed UAT verdict that opens a
   * Tester-attributed recovery round, exactly like the review lane's R6.
   */
  blockingSeverity: Severity | 'none';
}

/**
 * Review's Lane B config (Tasks 11–13 build the lane itself; this block only
 * carries its configuration). `enabled: true` / `blockingSeverity: 'high'` are
 * a deliberate deviation from the design spec's advisory-only recommendation
 * (§10 O4 recommends `none`, lane off) — the human partner's explicit call:
 * critical/high findings should fail review to `fix` until the lane is proven
 * out, not sit as unread evidence.
 */
export interface ReviewFindingsConfig {
  enabled: boolean;
  blockingSeverity: Severity | 'none';
  maxFindings: number;
}

/**
 * `review:` manifest block (§6.3). Deliberately smaller than `UatConfig` — no
 * env, no secrets, no origins, no auth, no testDir: review reads the diff and
 * runs static gates, it does not stand up a system under test.
 *
 * Per-repository `gates` in `repositories` REPLACE the global list for that
 * repository, exactly like `UatRepositoryOverride.gates` — never additive
 * (`declaredGatesFor`'s semantics, `uat/gates.ts:73-84`, mirrored for review by
 * `declaredReviewGatesFor`, `review/gates.ts`).
 *
 * No `approval` key: human approval in review was ruled out entirely (the
 * design spec's §6.3 lists `approval: auto | human`), so the only value the
 * key could carry — `'human'` — does not exist. Do not add one speculatively.
 */
export interface ReviewConfig {
  maxFixAttempts: number;
  /**
   * The stall window for the fix loop, in minutes — see
   * `UatConfig.stallTimeoutMinutes`. The watchdog takes the LARGER of the two
   * gates' values, so a project's longer review fixes are never parked on the
   * shorter uat window.
   */
  stallTimeoutMinutes: number;
  requireIndependentSignal: boolean;
  /**
   * Whether review reveals the ticket's Changes panel when its gates finish.
   * DEFAULT OFF (this ticket): opening the panel used to be unconditional
   * whenever the host wired `openDiff`, so a review could surface a stack of
   * panels the user never asked for. The host ALWAYS wires `openDiff`; this
   * flag is the user's control over whether anything opens at all.
   *
   * This flag does NOT control whether the findings lane reviews uncommitted
   * work: the lane ALWAYS reviews a worktree snapshot (committed + uncommitted
   * as one tree) when a git runner is available, so work left uncommitted until
   * ship is in scope regardless of this setting. Its influence on the diff
   * range ended; only the diff-view behavior (above) remains.
   */
  openChanges: boolean;
  gates?: GateDef[];
  /** Every gate off: false/absent = run nothing (stage bypassed); true = probe package.json scripts. */
  probeWhenAllDisabled?: boolean;
  findings: ReviewFindingsConfig;
  repositories: Record<string, { gates?: GateDef[] }>;
}

/**
 * One inside AI process role's assignment override (§ inside redesign Task 7).
 * Every field is optional so an absent block needs no configuration at all;
 * `resolveProcessAssignment` (agent/processAssignment.ts) fills the gaps.
 *
 * `agent` names a profile from the selectable agent POOL (a local file under
 * `agentsDir` or an approach artifact — see `agents/pool.ts`); it feeds the
 * `process_runs` display snapshot. Pool membership is checked in the Settings
 * UI (`ui/settings/processAssignmentViews.ts`, `unknown-profile`), NOT at
 * manifest load, because the pool is filesystem-derived and the pure loader
 * cannot see it. `agentName` is the display-snapshot override for the
 * `process_runs` row. `provider`/`model` select the launch adapter the
 * process runs headless through, ahead of the ticket/manifest defaults.
 */
export interface ProcessAssignmentConfig {
  agentName?: string;
  agent?: string;
  provider?: AgentProvider;
  model?: string;
  /**
   * Per-process effort/variant override — the unified agent picker's third
   * field (agent core + model + effort, § agentPicker.ts). Only meaningful
   * when the resolved model advertises the value in the catalog; a blank
   * value normalizes to inherit (the manifest `defaultEffort` at launch).
   */
  effort?: string;
  /**
   * DEPRECATED (§6): per-process agent-preset reference. Names a key of the
   * top-level `agentPresets` map; reference integrity is checked at manifest
   * load (`assertAgentPresetReferences`). Still read for one release — the
   * loader reports it with a deprecation warning naming the replacement, the
   * preset's per-capability slot (`agentPresets.<name>.slots.<key>`) plus
   * `activeAgentPreset` — then Settings stops offering the key and it is
   * removed. Beaten by this block's explicit `provider`/`model`/`effort`.
   */
  preset?: string;
  /**
   * PIN: when true, `provider`/`model`/`effort` here beat every preset slot
   * ("same in all presets"). Without it a row carries only `agent` and
   * `enabled`; core fields on an unpinned row are a validation error.
   */
  pinned?: boolean;
  // NOTE: there is deliberately no `instructions` field. A process's prompt is
  // the BODY of the profile named by `agent` — one place to write it, one place
  // to read it. The retired key is still reported at load (`inertKeys.ts`).
  enabled?: boolean; // default true
}

/**
 * The closed `processes:` block (Task 7 + ticket-form follow-up + planner).
 * Keys are the manifest spelling (`uatTester`); the resolver consumes the
 * kebab ROLE spellings (`uat-tester`) via `PROCESS_ROLE_BY_KEY` — both
 * vocabularies live in `manifest/validate/processAssignments.ts`.
 */
export interface ProcessAssignmentsConfig {
  uatTester?: ProcessAssignmentConfig;
  uatFix?: ProcessAssignmentConfig;
  review?: ProcessAssignmentConfig;
  reviewFix?: ProcessAssignmentConfig;
  prDescription?: ProcessAssignmentConfig;
  /**
   * The ticket form's coupled analyzer (prompt + approach + repos + type
   * prefill, § ticket form). Absent → the global defaults (manifest
   * agentProvider/defaultModel) apply, exactly like every other role.
   */
  ticketAnalysis?: ProcessAssignmentConfig;
  /**
   * The planning-session core/model (Settings → Agents, "Planner"). A planning
   * session is not a ticket and not a stage, so this is not a `process_runs`
   * role: it selects the read-only planning terminal's core and model. Absent →
   * the implementation resolution applies (`resolvePlanningDefaults`,
   * `agent/planningDefaults.ts`), so an existing project sees no change until
   * it picks a planner. The active preset's `planning` slot outranks this block.
   */
  planning?: ProcessAssignmentConfig;
}

/**
 * How an AI call recovers from a provider failure (§ retry and model
 * fallback). Absent → two extra attempts on a transient failure, a 2s
 * doubling backoff, and NO model fallback (an operator opts in to running a
 * model they did not configure).
 */
export interface ResilienceConfig {
  /** Extra attempts on the SAME model after a transient failure. 0 disables retry. */
  retries: number;
  /** Base backoff in ms; doubled per attempt, ±20% jitter. */
  backoffMs: number;
  /**
   * Models tried in order after the resolved model is exhausted. Only
   * entries compatible with the CALLING provider are used
   * (`resolveModelChain`). Empty → no fallback.
   */
  fallbackModels: readonly string[];
}

/** `Manifest.agentBackend` values (arch:AC-32). */
export type AgentBackend = CoreBackend;

export interface Manifest {
  /**
   * Stable project identity (§ projects / multi-window). Scopes tickets to a
   * project so two IDE windows on different stacks don't see each other's board.
   * Lives in the manifest rather than being derived from the workspace path so it
   * survives a repo move and reads the same from a worktree opened directly.
   *
   * Undefined for a legacy manifest written before the field existed; the host
   * then falls back to a path-derived slug (`resolveProjectSlug`), so loading
   * never fails on its absence. Blank normalizes to undefined at validation.
   */
  id?: string;
  host: string;
  portRange: [number, number];
  baselineBranch: string;
  /**
   * Every repository karst knows about, keyed by the name tickets and the
   * registry refer to it by. Was `services` before repositories became the
   * primary entity; `manifest/migrate.ts` translates the legacy key on load.
   */
  repositories: Record<string, RepositoryDef>;
  /**
   * Ticket-form development approaches; `validateManifest` always sets this
   * (`[]` when none configured). Optional on the type only so hand-built
   * fixtures need not supply it.
   */
  approaches?: ApproachDef[];
  /** Role-keyed configured agents; always set by `validateManifest` (`{}` default). */
  agents?: Record<string, AgentDef>;
  /** Dashboard worktree-path rendering mode; always set (`'relative'` default). */
  worktreePathDisplay?: WorktreePathDisplay;
  /**
   * Ticket-label template with `{var}` tokens (key/title/id/status/stage/repos).
   * Undefined → the default `'{key} — {title}'`. Blank is normalized to undefined
   * at validation so an empty field can't erase every label.
   */
  ticketLabelTemplate?: string;
  /**
   * Terminal-name template with the same `{var}` tokens as ticketLabelTemplate.
   * The one-char follow-up marker (`↳`) is NOT a token here: the host appends
   * it at launch for follow-up tickets (model/followUp.ts), so it stays visible
   * whatever this template says. Undefined → the default `'Karst: {key} — {title}'`.
   * Blank normalizes to undefined at validation. Rendered once at launch
   * (terminals are static).
   */
  terminalNameTemplate?: string;
  /**
   * Optional conventions for Karst-created fallback commits and new pull
   * requests. Absent fields preserve their historical generation paths.
   */
  conventions?: ArtifactConventions;
  /** Ticketing integration config; always set by `validateManifest` (`{ provider: 'manual' }` default). */
  ticketing?: TicketingConfig;
  /** Selected agent provider; always set by validate (default 'claude'). */
  agentProvider?: AgentProvider;
  /**
   * Default launch model id inherited by tickets that don't pick their own
   * (§ model selection). Undefined → no default (the agent CLI picks). Blank is
   * normalized to undefined at validation.
   */
  defaultModel?: string;
  /**
   * How an AI call recovers from a provider failure (§ retry and model
   * fallback). Absent → two extra attempts on a transient failure, a 2s
   * doubling backoff, and NO model fallback (an operator opts in to running a
   * model they did not configure).
   */
  resilience?: ResilienceConfig;
  /**
   * Default effort/variant inherited by tickets that don't pick their own
   * (§ Execution policy resolution). Undefined → the agent CLI's own default.
   * Only meaningful when `defaultModel` advertises efforts in the catalog; a
   * configured effort the selected model does not advertise is a configuration
   * error at Save, never silently discarded (see `agent/effort.ts`).
   */
  defaultEffort?: string;
  /**
   * Named per-capability presets (§ agent presets). A ticket's `agentPreset`,
   * a process role's `preset`, or `activeAgentPreset` may reference one by
   * name. A preset OVERRIDES the capabilities it declares a slot for and is
   * Inherit everywhere else; the existing per-ticket and per-process explicit
   * fields still win over it. Absent → no presets, and resolution is
   * byte-identical to the legacy agentProvider/defaultModel/defaultEffort
   * behavior. A legacy flat `{provider, model}` entry is normalized at load to
   * a slot on every capability (§6).
   */
  agentPresets?: Record<string, AgentPreset>;
  /**
   * The preset applied to every ticket that names none of its own. Must
   * reference a key of `agentPresets` — an unknown name is refused at load,
   * never silently ignored. Blank normalizes to undefined (no active preset).
   *
   * Canonical spelling; `defaultAgentPreset` below is its deprecated alias and
   * a file declaring BOTH is refused at load rather than letting one win.
   */
  activeAgentPreset?: string;
  /**
   * Deprecated alias of `activeAgentPreset` — the key every file written
   * before the Presets tab carries. Read as the same single active preset (the
   * resolver falls back to it when `activeAgentPreset` is absent), written back
   * unchanged until the writer renames it, and refused alongside
   * `activeAgentPreset` at load. Blank normalizes to undefined.
   */
  defaultAgentPreset?: string;
  /**
   * How many days a ticket stays visible at `done` before the periodic sweep
   * archives it (§ auto-archiving done tickets). Defaults to 3 — a ticket is
   * never archived the moment it lands, and 0 is refused for that reason.
   * Always set by `validateManifest` (3 when absent).
   */
  archiveDoneAfterDays?: number;
  /**
   * How many days a FINISHED planning session (every draft accepted, no live
   * terminal) sits idle before the periodic sweep archives it. Defaults to 3.
   * Always set by `validateManifest` (3 when absent).
   */
  archivePlanningAfterDays?: number;
  /**
   * Artifact store retention. Absent = keep forever (the default); a positive
   * `maxAgeDays` lets the periodic sweep purge a ticket's store once its
   * newest revision is older than that.
   */
  artifacts?: { maxAgeDays?: number };
  /**
   * Sub-task auto-start concurrency caps (`0` = unlimited). Always set by
   * `validateManifest` (2 per parent / 4 per project when absent).
   */
  subtasks?: SubtaskLimits;
  /**
   * Enable verbose debug-level logging (`logger.debug`, § debug logging).
   * Defaults to false. The host reads this at manifest (re)load and toggles
   * the logger's gated debug flag at runtime; when false, `logger.debug()` is
   * a no-op, so production carries zero cost. Debug entries ride the same
   * redaction pipeline as info/warn/error and appear in issue reports when
   * enabled.
   */
  debug?: boolean;
  /**
   * Run interactive agent sessions inside the core's OWN OS-level sandbox
   * (`arch:AC-31`): writes limited to the ticket worktree, network to provider
   * APIs + package registries, prompts relaxed only inside it. Opt-in, default
   * off. A core or platform that cannot enforce it fails closed to today's
   * prompted behaviour; the effective mode is logged per launch.
   */
  agentSandbox?: boolean;
  /**
   * Where each core's interactive sessions run (`arch:AC-32`): claude/codex
   * `host`|`sbx`, opencode/opencode2 `host`|`docker`, agy `host`. Absent key =
   * host. Anything that cannot run in the requested backend fails closed to the
   * host, prompted; the effective backend is logged per launch. A legacy scalar
   * `agentBackend` in the yml is folded into this map on load and never written.
   * Independent of `agentSandbox`.
   */
  agentBackends?: AgentBackends;
  /**
   * Overrides for the docker sandbox's container memory (`--memory` /
   * `--memory-reservation`), in Docker's `512m` / `2g` form. Absent keys scale
   * from the Docker VM's total memory; values above 85% of it are clamped.
   */
  sandboxMemory?: SandboxMemoryConfig;
  /**
   * When a ticket is closed (archived), also dispose its agent terminals whose
   * process has already exited — the dead tabs VS Code keeps with a "Done"
   * suffix. Defaults to off: dead tabs stay until the user closes them, and a
   * live session is never touched either way (only exited terminals qualify).
   */
  closeDoneTerminalsWithTicket?: boolean;

  /**
   * Open a ticket's changed-file list in the IDE's native Source Control view
   * (collapsible groups per worktree and per commit) instead of the "Ticket
   * changes" webview panel. Clicking a file opens the same diff editor either
   * way. Defaults to off: absent and `false` both mean the webview panel.
   */
  diffsInSourceControl?: boolean;

  /**
   * What happens to a ticket's services when the ticket reaches done.
   * 'ask' (default): one host prompt per ticket — Stop servers / Keep running / Always stop.
   * 'auto': stop without asking and announce it.
   * 'off': leave them running until archive.
   */
  stopServersOnDone?: StopServersOnDone;
  /**
   * UAT gates, credentials and (Phase 2) authored-step config. Absent yields the
   * default pipeline: karst probes package.json for known scripts. `origins` and
   * `authBootstrap` are validated at load but inert until Phase 2, so declaring
   * them early is harmless.
   */
  uat?: UatConfig;
  /** Ticket-analysis passes. Absent = defaults (code pointers off). */
  analysis?: AnalysisConfig;
  /**
   * Per-core subscription-quota warnings (`quota:`). Always set by
   * `validateManifest` (default threshold 80). View-only — never blocks a
   * launch and never auto-routes to another core.
   */
  quota?: QuotaConfig;
  /**
   * Review gates. Absent yields the default pipeline: karst probes
   * package.json for `REVIEW_PROBE_SCRIPTS` (`workflow/gates/scripts.ts`).
   */
  review?: ReviewConfig;
  /**
   * Per-role assignments for the inside AI processes (ticket-analysis,
   * uat-tester, uat-fix, review, review-fix, pr-description). Absent entries
   * resolve to the approved defaults. Optional on the type only so hand-built
   * fixtures need not supply it; `validateManifest` leaves it undefined when
   * the block is absent.
   */
  processes?: ProcessAssignmentsConfig;
}

/** Caps on concurrently RUNNING sub-tasks; `0` = unlimited. */
export interface SubtaskLimits {
  maxConcurrentPerParent: number;
  maxConcurrentTotal: number;
}
