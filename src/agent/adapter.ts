/**
 * The agent-execution boundary (§2.6, §5.5) — the load-bearing seam.
 *
 * Every agent call — headless stage runs (M4), interactive session launch (M3)
 * — goes through this contract. Agent-specific details (Claude Code flags, auth,
 * output shape) must NOT leak past it, so a second agent is a config swap, not a
 * rewrite. MVP ships one implementation (ClaudeAdapter).
 */

export interface RunHeadlessOpts {
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  permissionMode?: string;
  resume?: string; // session_id to continue
  settingsPath?: string; // registers the HTTP hook, scoped to our sessions
}

export interface HeadlessResult {
  sessionId: string;
  verdict: unknown;
  raw: string;
}

export interface InteractiveCommandOpts {
  cwd: string;
  settingsPath?: string; // registers the HTTP hook, scoped to our sessions
  initialPrompt?: string; // seed prompt for the session (e.g. an approach entrypoint)
  model?: string; // resolved launch model id (§ model selection); omitted → agent CLI default
  /**
   * Agent-specific launch additions produced by `materializeApproach` (e.g.
   * `--plugin-dir <dir>`). Opaque to the launcher; appended by the adapter.
   */
  extraArgs?: string[];
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
}

export interface InteractiveCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentCapabilities {
  httpHooks: boolean;
  resume: boolean;
}

export interface AgentAdapter {
  /**
   * The CLI binary this adapter invokes (e.g. `'claude'`). Advertised so the
   * startup dependency check can verify it's installed without knowing the
   * agent's flag details (§ todo-5 dependencies check).
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
}
