/**
 * Typed model of `karst.yml` (§7.1). Produced by the manifest loader after
 * validation; every downstream consumer (resolver, spin) reads this shape.
 */

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
export interface ServiceDef {
  start: string;
  health?: string;
  ports: PortSlot[]; // validated non-empty — a service without a port cannot be addressed
  dependsOn: DependsOn[];
}

/**
 * The PRIMARY ENTITY: a git repository karst can worktree, scope to a ticket,
 * classify, and ship. Runnability is the optional part (`service`), not the
 * assumption.
 */
export interface RepositoryDef {
  repoPath: string;
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
   * the repository is "unclassified" and the onboarding classify-gate prompts
   * for signals. `validateManifest` always populates this (defaulting `[]`); it
   * is optional on the type only so hand-built fixtures need not supply it. Read
   * it via `isRepoClassified` / `?? []`, never assume presence.
   *
   * Repository-level: a non-runnable repo still has to be classifiable, or no
   * ticket could ever be routed to it.
   */
  signals?: string[];
  /**
   * The runnable relation. ABSENT means this repository is not runnable — that
   * is a valid, first-class state, never an error and never a sentinel. Gate on
   * it via `isRunnable` (`manifest/runnable.ts`) rather than testing the field
   * directly, so the narrowing is done in one place.
   */
  service?: ServiceDef;
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
 * A single phase in an approach's workflow (§ onboarding). `command` is a
 * native slash command to invoke for the phase (e.g. "/rpi:research");
 * absent when the phase has no dispatchable command.
 */
export interface WorkflowPhase {
  name: string; // e.g. "research"
  command?: string; // native slash command to invoke, e.g. "/rpi:research"
  description?: string; // human guidance for the phase
}

/**
 * A development approach offered on the onboarding page (§ onboarding). `id` is
 * the stable key persisted on a ticket; `recommended` marks the default pick
 * (at most one). `source` is absent for hand-authored/custom approaches (no fetch).
 * Extensible: custom approaches are just more entries.
 */
export interface ApproachDef {
  id: string;
  label: string;
  description?: string; // short "when to use" blurb
  entrypoint?: string; // which prompt starts the flow, e.g. "research"
  source?: ApproachSource; // absent = hand-authored/custom (no fetch)
  recommended?: boolean;
  workflow?: WorkflowPhase[];
  enabled?: boolean; // default true
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

/** Which ticketing backend a ticket's source/status is bound to. */
export type TicketProvider = 'clickup' | 'manual';

/** Which coding-agent CLI karst launches sessions with. */
export type AgentProvider = 'claude' | 'codex';

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
}

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
   * Onboarding development approaches; `validateManifest` always sets this
   * (`[]` when none configured). Optional on the type only so hand-built
   * fixtures need not supply it.
   */
  approaches?: ApproachDef[];
  /** Role-keyed configured agents; always set by `validateManifest` (`{}` default). */
  agents?: Record<string, AgentDef>;
  /** Dashboard worktree-path rendering mode; always set (`'absolute'` default). */
  worktreePathDisplay?: WorktreePathDisplay;
  /**
   * Ticket-label template with `{var}` tokens (key/title/id/status/stage/repos).
   * Undefined → the default `'{key} — {title}'`. Blank is normalized to undefined
   * at validation so an empty field can't erase every label.
   */
  ticketLabelTemplate?: string;
  /**
   * Terminal-name template with the same `{var}` tokens as ticketLabelTemplate.
   * Undefined → the default `'Karst: {key} — {title}'`. Blank normalizes to
   * undefined at validation. Rendered once at launch (terminals are static).
   */
  terminalNameTemplate?: string;
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
}
