/**
 * The agent-execution boundary (§2.6, §5.5) — the load-bearing seam.
 *
 * Every agent call — headless stage runs (M4), interactive session launch (M3)
 * — goes through this contract. Agent-specific details (Claude Code flags, auth,
 * output shape) must NOT leak past it, so a second agent is a config swap, not a
 * rewrite. MVP ships one implementation (ClaudeAdapter).
 */

import type { AiCallSite } from './aiCallSites.js';
import type { HeadlessOutputChunk } from './headlessSpawn.js';
import type { TokenUsage } from './tokenUsage.js';
import type { AdapterSurfaces } from './surfaces.js';
import type { EntryBasename } from './workflowCommand.js';

/**
 * A JSON Schema document describing the shape a core's FINAL response is asked
 * to conform to (draft-07 subset). Passed to `RunHeadlessOpts.outputSchema` and
 * translated by each supporting adapter into its own structured-output flag
 * (claude `--json-schema`, codex `--output-schema`). A scalar type union is all
 * a builder here emits; adapters serialize it with `JSON.stringify`. `supported`
 * is declared per adapter on `AdapterSurfaces.structuredOutput` — a caller
 * requests it only when that surface says the core can enforce it.
 */
export type JsonSchemaDocument = Record<string, unknown>;

/**
 * What a call site declares so its spend can be attributed (§ token consumption
 * stats). This is the ENTIRE cost of covering a new AI integration: the
 * recording happens in `instrumentedAdapter.ts`, never at the call site. Absent
 * → the call is filed under `unknown` rather than dropped.
 */
export interface UsageTracking {
  callSite: AiCallSite;
  /** The ticket the spend belongs to; absent for a not-yet-saved draft. */
  ticketId?: number | null;
  /**
   * The inside process run making the call (v27, § task 3): gates, commit,
   * delivery-receipt, recovery. Absent → the call is filed unattributed to a
   * process — an interactive session, a draft, or a caller that has not
   * threaded its run through yet.
   */
  processRunId?: number | null;
  /**
   * The graph planner run the call was made inside (Slice-3 T10). Node
   * identity travels in these FK columns, never in the call site — the set
   * is closed and must stay bounded.
   */
  approachPlannerRunId?: number | null;
  /** The graph node run the call was made inside (Slice-3 T10). */
  approachNodeRunId?: number | null;
}

export interface RunHeadlessOpts {
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  permissionMode?: string;
  resume?: string; // session_id to continue
  model?: string;
  /**
   * A resolved effort value for this run (design § Execution policy
   * resolution). Validated against the live model catalog by `effort.ts`
   * BEFORE it reaches an adapter, so the adapter never sees an unsupported
   * value — its job is provider-specific flag translation only. Absent → the
   * CLI's own default applies. Always passed as its own argv entry, never
   * shell-interpolated.
   */
  effort?: string;
  tracking?: UsageTracking;
  /**
   * Aborts this call: the headless spawn kills the child's whole process group
   * and the adapter rejects with `name === 'AbortError'` (see
   * `agent/headlessSpawn.ts`). Optional so a caller without a signal (a draft
   * classify, a ship description) still gets the timeout bound. Callers that
   * check `opts.signal?.aborted` after the call (tester, findings lane) keep
   * working unchanged.
   */
  signal?: AbortSignal;
  /**
   * The hard deadline for THIS call, in milliseconds — forwarded into the
   * headless spawn (`HeadlessSpawnOptions.timeoutMs`). Absent → the spawner's
   * 15-minute quick-call default (classify, PR description). The gate lanes
   * whose agent is asked to DO WORK in the worktree (the UAT tester runs the
   * repo's tests) pass their own generous bound — see
   * `GATE_LANE_HEADLESS_TIMEOUT_MS` — so a slow-but-progressing run is never
   * cut off at a bound sized for a single-turn call.
   */
  timeoutMs?: number;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[agent:<name>]`.
   * Absent → no debug lines. The host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on); `instrumentAdapter` injects it
   * into every headless call, so a new adapter gets debug logging by
   * construction.
   */
  debug?: (message: string) => void;
  /**
   * Live-pid registry hook (the resource monitor). Forwarded verbatim to the
   * headless spawn's `HeadlessSpawnOptions.onSpawned`: called once with the
   * child's pid the moment it exists, and the returned disposer runs wherever
   * the run settles. Absent → the spawner never calls it.
   */
  onSpawned?: (pid: number) => (() => void) | void;
  /**
   * Live-output hook, forwarded verbatim to the headless spawn's
   * `HeadlessSpawnOptions.onOutput`: called with each decoded stdout/stderr
   * chunk as it streams in, before the run settles. RAW untrusted CLI prose —
   * the caller that surfaces it (the tester/findings console tail) must bound
   * and sanitize it. Absent → no live chunks; the full output still arrives
   * in `HeadlessResult.raw` on settle, exactly as before.
   */
   onOutput?: (chunk: HeadlessOutputChunk) => void;
  /**
   * A JSON Schema the core's FINAL response should be made to conform to. Only
   * meaningful on a core that declares `AdapterSurfaces.structuredOutput`
   * supported — the findings/review and UAT-tester lanes request it only there,
   * and the core's headless CLI enforces it so the salvage parse in
   * `review/findings.ts` reads a clean whole-document JSON array instead of
   * coaxing one out of prose. Absent → the call runs against the plain prose
   * prompt, exactly as a non-structured core needs.
   */
  outputSchema?: JsonSchemaDocument;
}

export interface HeadlessResult {
  sessionId: string;
  verdict: unknown;
  raw: string;
  /**
   * Token counts the core reported for this run, parsed by the adapter from the
   * SAME stdout it read the answer out of. Absent means the core said nothing —
   * the instrumented wrapper decides whether that is worth an estimate. It is
   * never a zero: a zero would read as a measured free call.
   */
  usage?: TokenUsage;
}

export interface InteractiveCommandOpts {
  cwd: string;
  hookChannel?: HookChannel;
  resume?: string; // session_id to --resume an interrupted interactive session (§5.3)
  initialPrompt?: string; // seed prompt for the session (e.g. an approach entrypoint)
  model?: string; // resolved launch model id (§ model selection); omitted → agent CLI default
  /**
   * A resolved effort value for this session — provider-specific flag
   * translation only, exactly as `RunHeadlessOpts.effort` (see there).
   */
  effort?: string;
  /**
   * The session's display name — the SAME rendered string the terminal tab
   * shows, so the session is findable by ticket in the agent's resume picker.
   * Untrusted ticket prose: an adapter that forwards it MUST pass it through
   * `sanitizeSessionName`. An agent CLI with no naming flag ignores it.
   */
  sessionName?: string;
  /**
   * Agent-specific launch additions produced by `materializeApproach` (e.g.
   * `--plugin-dir <dir>`). Opaque to the launcher; appended by the adapter.
   */
  extraArgs?: string[];
}

export interface HookChannel {
  endpointUrl: string;
  configDir: string;
  /** Opaque per-terminal generation used only to order lifecycle hooks. */
  launchId?: string;
}

/**
 * Inputs for materializing a neutral approach package into an agent's on-disk
 * format at launch. `pkg`/`baseDir` locate the installed neutral package;
 * `sessionDir` is a per-session scratch the adapter may write into.
 */
export interface MaterializeOpts {
  pkg: MaterializablePackage;
  baseDir: string;
  sessionDir: string;
  /**
   * A resolved single-subagent to materialize alongside (or instead of) the
   * package's own artifacts — the chosen agent for a `single-subagent`
   * ticket. `body` is the already-sanitized markdown source (written to disk
   * by the agent-file / approach-artifact writer). Present is itself a reason
   * to build the plugin, even when `pkg` has no artifacts/workflow of its own.
   */
  soloAgent?: { name: string; body: string };
  /**
   * Shell command prefix the generated `/karst:<id>` command runs (with the
   * ticket key appended) to re-pull live ticket context (§ context loader),
   * e.g. `node "<ext>/dist/cli/main.js" context --db "<db>" --manifest "<yml>"`.
   * Absent → the command falls back to a generic "read the ticket" instruction.
   */
  cliContextPrefix?: string;
  /**
   * Shell command prefix the generated `/karst:<id>` command runs (with the
   * ticket key appended) to fire the impl→uat marker when implementation is
   * done (§5.4), e.g. `node "<ext>/dist/cli/main.js" stage impl pass --db
   * "<db>" --ticket`. Absent → no marker step (the impl boundary stays manual).
   */
  cliStagePrefix?: string;
  /**
   * Builds, for one phase name, the shell command prefix a workflow step runs
   * (with the ticket key appended) to report that the agent has ENTERED that
   * phase, e.g. `node "<ext>/dist/cli/main.js" phase research --db "<db>"
   * --manifest "<yml>" --ticket`. A function rather than a fixed prefix because
   * the name is baked into the command, one per phase. Absent → no phase
   * markers (karst records no per-phase state, exactly as before).
   */
  cliPhasePrefix?: (phaseName: string) => string;
  /**
   * Shell command the generated `/karst:<id>` command runs to read the
   * agent-facing manual (how Karst works, the flow, the verbs), e.g.
   * `node "<ext>/dist/cli/main.js" guide`. Absent → the command does not point
   * at the guide (a host too old to serve it must not hand out a dead verb).
   */
  cliGuidePrefix?: string;
  /**
   * Shell command prefix for `karst test` subcommands, e.g.
   * `node "<ext>/dist/cli/main.js" test --db "<db>" --manifest "<yml>"`.
   * Embedded in the test-family skill body so the agent never composes the
   * `--db`/`--manifest` boilerplate itself. Absent → the test skill is not
   * injected (a host too old to serve it must not hand out a dead verb).
   */
  cliTestPrefix?: string;
  /**
   * Shell command prefix for `karst fix-brief` (the ticket key is appended by
   * the generated command). Absent → the `fix` command is not materialized.
   */
  cliFixBriefPrefix?: string;
  /**
   * Shell command prefix for `karst conflict-brief` (key and repo appended).
   * Absent → the `resolve-conflict` command is not materialized.
   */
  cliConflictBriefPrefix?: string;
}

/**
 * The minimal neutral package shape `materializeApproach` needs — kept local to
 * the adapter seam so the agent boundary does not import the approaches module
 * (agent-agnostic: no leak in either direction). `src/approaches/pkg.ts`'s
 * `ApproachPackage` is structurally assignable to this.
 */
export interface MaterializablePackage {
  id: string;
  label: string;
  description?: string;
  entrypoint?: string;
  artifacts?: { kind: 'agent' | 'skill' | 'command'; relPath: string }[];
  workflow?: { name: string; command?: string; description?: string }[];
}

/** What an adapter contributes to a launch after materializing a package. */
export interface Materialized {
  /** Extra CLI args to append (e.g. `--plugin-dir <dir>`). */
  extraArgs: string[];
  /** Native agent invocation for the generated workflow, when one exists. */
  invocation?: string;
  /**
   * The invocation each generated entry orchestrator registered, in this core's OWN
   *  namespace — `/karst:<basename>` on claude, `/karst-<basename>` on opencode,
   *  `$<slug>` on antigravity and codex. A basename is absent when that orchestrator
   *  was not materialized. Absent entirely when the core declares
   *  `entryOrchestrators` unsupported. */
  readonly entryInvocations?: Readonly<Partial<Record<EntryBasename, string>>>;
  /** Exact runtime paths created by the adapter and safe to remove on close. */
  ownedPaths: string[];
}

export interface InteractiveCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Exact runtime paths generated while building this command. */
  ownedPaths?: string[];
}

export interface AgentCapabilities {
  lifecycleEvents: boolean;
  resume: boolean;
  /**
   * Task 5: whether the adapter's bridge can emit measured `UsageUpdate`
   * events. Optional so pre-Task-5 constructors (tests, launcher fakes) keep
   * compiling; the adapters themselves declare it explicitly, and reducers
   * that need a definite answer read `providerInteractiveUsage` from
   * `provider.ts`, never an adapter's absence.
   */
  interactiveUsage?: boolean;
}

export interface AgentAdapter {
  /**
   * The CLI binary this adapter invokes (e.g. `'claude'`). Advertised so the
   * startup dependency check can verify it's installed without knowing the
   * agent's flag details.
   */
  readonly requiredBinary: string;

  /** Headless, structured run — scope/uat/review/ship stages (M4). */
  runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult>;

  /** Build the command to run in a VS Code terminal for an interactive session. */
  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand;

  /**
   * Translate a neutral approach package into this agent's on-disk format and
   * return the launch additions (e.g. Claude's `--plugin-dir`). Optional: an
   * adapter that has no notion of loadable approaches omits it → bare launch.
   * The ONLY place an agent-specific package format (plugin, etc.) may exist.
   */
  materializeApproach?(opts: MaterializeOpts): Materialized;

  capabilities: AgentCapabilities;

  /**
   * This core's declared position on every optional surface of this seam
   * (869ej1zpv rule R1, `surfaces.ts`). Optional here only so the many test
   * fakes that implement `AgentAdapter` keep compiling — every adapter
   * `registry.ts` can resolve MUST declare it, which
   * `adapterConformance.test.ts` enforces against real argv.
   */
  surfaces?: AdapterSurfaces;
}
