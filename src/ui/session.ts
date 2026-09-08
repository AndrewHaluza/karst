import type { AgentAdapter, HookChannel } from '../agent/adapter.js';
import { cleanupOwnedPaths } from '../agent/materializedCleanup.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import { measureSeed, type SeedTelemetry } from '../agent/seed.js';

/**
 * The subset of a `vscode.Terminal` the manager touches. Modeling it as an
 * interface keeps `SessionManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real terminal.
 */
export interface SessionTerminal {
  /**
   * Reveal the terminal. `preserveFocus` leaves the keyboard where it is (real:
   * `Terminal.show(preserveFocus)`) — what the dashboard binding needs, since it
   * reveals this terminal beside a panel the user just clicked.
   */
  show(preserveFocus?: boolean): void;
  /** Type a line into the running shell (real: `Terminal.sendText(text, true)`). */
  sendText(text: string): void;
  dispose(): void;
  /**
   * `exitCode` is the child process's exit code when known (real:
   * `Terminal.exitStatus?.code`) — undefined for a disposal karst itself
   * initiated. Lets a resume launch that dies before starting be told apart
   * from an ordinary close.
   */
  onDidClose(handler: (exitCode?: number) => void): void;
}

/** Environment key that binds a restored terminal to its ticket. */
export const KARST_TICKET_ENV = 'KARST_TICKET_ID';
/** Environment key that preserves the terminal's provider-neutral generation. */
export const KARST_LAUNCH_ENV = 'KARST_LAUNCH_ID';
/** Env key pointing the agent at the registry so a `karst guide` pull is attributable. */
export const KARST_DB_ENV = 'KARST_DB';
/** Env key naming the core so a `karst guide` pull is attributed per core. */
export const KARST_PROVIDER_ENV = 'KARST_PROVIDER';

/**
 * The ticket a terminal was launched for, read back out of its environment.
 * `SessionManager`'s map is ticket→terminal and does not survive a reload, and
 * both consumers — session recovery and the dashboard binding — reach every
 * terminal in the window, karst's or not. Anything but a positive integer id
 * resolves to undefined rather than a coerced number.
 *
 * This is EXACT but not durable: VS Code does not restore a reconnected
 * terminal's env, so it reads undefined for every karst terminal after a window
 * reload. `terminalIdentity.ts` holds the durable half (the pid recorded at
 * launch) and `identifyTerminal` is the lookup that combines them — this
 * function is its first, preferred step, never the whole answer.
 */
export function ticketIdFromTerminalEnv(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number | undefined {
  const raw = env?.[KARST_TICKET_ENV];
  return typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

/** A host-discovered terminal previously created for a Karst ticket. */
export interface RestoredSession {
  ticketId: number;
  /** Opaque hook generation captured when this terminal was launched. */
  launchId?: string;
  /** Provider/model snapshot recovered from the terminal's durable pid record. */
  identity?: SessionIdentity;
  /**
   * The terminal's process has already exited (real: `Terminal.exitStatus`).
   * A dead tab still sits in the terminal list, so adopting one would hand the
   * ticket a session that cannot answer — it must launch instead.
   */
  exited?: boolean;
  terminal: SessionTerminal;
}

/** What became of a terminal the host reported after the activation scan. */
export type LateSessionAdoption =
  | { kind: 'adopted'; disposition: Exclude<RestoredSessionDisposition, 'ignore'> }
  | { kind: 'duplicate' }
  | { kind: 'known' }
  | { kind: 'ignored' };

/** Tickets whose restored terminals should resume or remain recoverable idle. */
export interface RestoredRecoveryResult {
  resume: number[];
  idle: number[];
}

/** The current window's recovery decision for a restored terminal. */
export type RestoredSessionDisposition = 'resume' | 'idle' | 'ignore';

/** Host command context that must survive a failed-resume retry. */
export interface OpenSessionOptions {
  reveal?: boolean;
  recovery?: boolean;
  /**
   * Host-only fresh-launch signal. Agent switches set this false so a rapid
   * A→B→A cannot resume A's retired conversation before B reports SessionStart.
   */
  allowResume?: boolean;
  /** Host-only proof that this launch already passed async provider readiness. */
  providerReady?: boolean;
  /**
   * Replaces the seed the host would compose for this launch. Set only by a
   * caller that already knows the ONE thing the session is for — the merge
   * brief behind "Resolve conflicts" — where a generic ticket seed would open
   * a session that has to rediscover the conflict for itself. Host-internal:
   * no webview message can reach it.
   */
  seedPrompt?: string;
  /**
   * The resolved effort/variant for this launch (per-ticket or manifest
   * default), threaded as the provider's effort flag. Host-internal: no webview
   * message can reach it.
   */
  effort?: string;
  /**
   * Host-only configured process assignment (the Fix path, Task 3): when
   * present, the launch resolves provider/adapter/model from this snapshot
   * rather than the ticket/manifest precedence. It also rides the
   * prepared-launch info so the fix launch intent is recorded with the
   * CONFIGURED identity. Host-internal: never accepted from a webview message.
   */
  assignment?: ProcessAssignmentSnapshot;
  /**
   * v57 prompt-metrics: the registry file path this session's agent should be
   * able to attribute a `karst guide` pull to. Threaded onto the terminal env as
   * `KARST_DB`. Host-internal — never accepted from a webview message.
   */
  dbPath?: string | null;
}

/**
 * Run a failed-resume replacement on the next event-loop turn. A microtask is
 * too early: background recovery crosses two awaited promises before it retires
 * the failed generation, so the replacement must wait until that chain drains.
 */
export function deferSessionRetry(retry: () => void): void {
  setTimeout(retry, 0);
}

export interface CreateTerminalOpts {
  name: string;
  /** Dimmed text beside the name (real: `vscode.TerminalOptions.description`). */
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  /** Environment variables passed to the terminal process. */
  env: Record<string, string>;
  /** Host-only identity persisted beside the terminal pid, never put in env. */
  identity?: SessionIdentity;
  /** Keep automated continuations out of the visible terminal UI. */
  hideFromUser?: boolean;
  /** File path to a tinted icon SVG (real: mapped to `vscode.Uri.file`). */
  iconPath?: string;
  /** Terminal-color ThemeColor key (real: `new vscode.ThemeColor(color)`). */
  color?: string;
}

/** Factory the manager uses to mint terminals (real: `createTerminal`). */
export interface TerminalHost {
  createTerminal(opts: CreateTerminalOpts): SessionTerminal;
  restoredSessions?(): RestoredSession[];
}

/** Test double surface — extends the terminal with recorded state. */
export interface FakeTerminal extends SessionTerminal {
  name: string;
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  env: Record<string, string>;
  hideFromUser?: boolean;
  iconPath?: string;
  color?: string;
  shown: number;
  /** The `preserveFocus` argument of every `show`, in order. */
  shownPreserveFocus: Array<boolean | undefined>;
  sent: string[];
  disposed: boolean;
  disposeHandler?: (exitCode?: number) => void;
}

/** Resolve the provider-neutral lifecycle channel for a session. */
export type HookChannelFor = (ticketId: number) => HookChannel;
export type CleanupOwnedPaths = (
  worktreePath: string,
  ownedPaths: readonly string[],
) => void;

/**
 * The agent identity a session was launched with — the session manager's
 * RECORDED active provider/model/agent snapshot, captured at `openSession` and
 * read back by the fix-recovery path so the Fix process run carries the
 * identity that is actually running (not the one a manifest edit resolves
 * today). `agentName` (v33, Task 3) is the configured inside agent name when
 * the launch was a configured Fix assignment.
 */
export interface SessionIdentity {
  provider: string;
  model: string | null;
  agentName?: string | null;
}

/**
 * A launch karst just decided to actually perform: a launch id was allocated
 * and a terminal is about to be created. The host persists this as a pending
 * `session_launch_intents` row, so the eventual SessionStart can be confirmed
 * against the exact prepared launch — even after a window reload, when no
 * in-memory state survives.
 */
export interface LaunchPreparedInfo {
  ticketId: number;
  /** The hook generation the terminal's hook URL will carry. */
  launchId: string;
  /** True when the adapter command resumes a captured provider session. */
  resume: boolean;
  /** True for an agent-switch launch (`allowResume: false` + providerReady). */
  switchLaunch: boolean;
  /**
   * The host-only assignment this launch was prepared with (the configured Fix
   * identity), when one was set — so the host can record the launch intent
   * with the CONFIGURED snapshot, never re-resolve it later.
   */
  assignment?: ProcessAssignmentSnapshot;
  /**
   * v57 prompt-metrics: the composed seed's measured length + whether the guide
   * pointer rode it, so the host records them onto the launch's process run. A
   * resume/switch seed carries no pointer — the asymmetry is the denominator this
   * metric needs, so it is measured, never assumed.
   */
  seedTelemetry?: SeedTelemetry;
}
export type OnLaunchPrepared = (info: LaunchPreparedInfo) => void;
/** A terminal creation failed synchronously for the named launch. */
export type OnLaunchFailed = (launchId: string) => void;

export function continueSessionInBackground(
  sessions: Pick<SessionManager, 'nudge'>,
  open: (ticketId: number, options: { reveal: false }) => void,
  ticketId: number,
  prompt: string,
): boolean {
  if (sessions.nudge(ticketId, prompt)) return true;
  open(ticketId, { reveal: false });
  return false;
}

/**
 * Collapse a prompt to a single line. A terminal line ends at the newline: the
 * agent's REPL reads each one as a separate submit, so a multi-line prompt would
 * arrive as a handful of half-finished messages. Whitespace is the only thing
 * lost — every word still reaches the agent.
 */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A live terminal plus the hook generation it was launched with — the identity
 * that tells this window's own terminal apart from one VS Code revived for the
 * same ticket in a previous window.
 */
interface TrackedSession {
  terminal: SessionTerminal;
  launchId?: string;
  /** The recorded active provider/model snapshot of this session's launch. */
  identity?: SessionIdentity;
}

/**
 * One interactive terminal per ticket (§5.2, §5.6). `openSession` launches
 * `claude` scoped to the ticket's worktree via the agent adapter, threading the
 * hook-settings path so the HTTP channel fires; re-opening focuses the existing
 * terminal instead of spawning a duplicate. A closed terminal is dropped so a
 * later open recreates it.
 */
export class SessionManager {
  private readonly terminals = new Map<number, TrackedSession>();
  private readonly cleanupByTerminal = new WeakMap<SessionTerminal, () => void>();
  /**
   * Handles of terminals karst disposed that may still appear in VS Code's
   * `window.terminals` list during the async cleanup gap, keyed by ticket id
   * to the exact disposed handle. Prevents `adoptRevivedSession` from
   * re-adopting a terminal karst just disposed (race: agent core switch
   * disposes the old terminal, then `openSession` picks it back up before VS
   * Code removes it from the list). Keyed to the handle so only that
   * terminal's own close releases it — a newer session closing first must not
   * clear the guard while the disposed tab is still listed.
   */
  private readonly recentlyDisposed = new Map<number, SessionTerminal>();

  constructor(
    private readonly host: TerminalHost,
    private readonly hookChannelFor: HookChannelFor,
    /**
     * Fired AFTER a session's terminal closes and its map entry is dropped, so a
     * consumer can resume gate work under `isOpen === false`. The host wires this
     * to the stage-driver sweep — a gate-parked ticket whose session just ended
     * gets driven without waiting for a SessionEnd hook to reach the endpoint.
     */
    private readonly onDidCloseSession?: (ticketId: number) => void,
    private readonly cleanup: CleanupOwnedPaths = cleanupOwnedPaths,
    /** Observes every owned handle close, including a retired recovery handle. */
    private readonly onDidCloseTerminal?: (
      ticketId: number,
      launchId: string | undefined,
    ) => void,
    /** Registers a restored handle as the authoritative live generation. */
    private readonly onDidAdoptTerminal?: (
      ticketId: number,
      launchId: string | undefined,
    ) => void,
    /**
     * Fired when a `--resume` launch's terminal dies before ever becoming
     * usable (nonzero exit right after spawn — e.g. the agent CLI rejects a
     * captured session id it can no longer find). Distinct from
     * `onDidCloseSession`: an ordinary session end also closes the terminal,
     * but with a clean exit, so a nonzero code specifically flags a resume
     * that never actually started.
     */
    private readonly onResumeFailed?: (
      ticketId: number,
      options: OpenSessionOptions,
    ) => void,
    /**
     * Fired SYNCHRONOUSLY after the hook launch id is allocated for an actual
     * new terminal and before `createTerminal` — the launch is prepared, not
     * yet proven. The focus path (a ticket already has a live terminal) and
     * the adoption path (a revived terminal took the ticket over) invoke
     * NEITHER this nor `onLaunchFailed`: no launch is being prepared, so no
     * intent may be recorded for one.
     */
    private readonly onLaunchPrepared?: OnLaunchPrepared,
    /**
     * Fired when `createTerminal` throws — a prepared launch that never became
     * a terminal. The host marks the matching intent failed; the exception is
     * rethrown so the caller still sees the launch failure.
     */
    private readonly onLaunchFailed?: OnLaunchFailed,
  ) {}

  private trackTerminal(
    ticketId: number,
    terminal: SessionTerminal,
    launchId?: string,
    cleanupOwned?: () => void,
    wasResume = false,
    options: OpenSessionOptions = {},
    identity?: SessionIdentity,
  ): void {
    if (cleanupOwned) this.cleanupByTerminal.set(terminal, cleanupOwned);
    this.terminals.set(ticketId, {
      terminal,
      ...(launchId ? { launchId } : {}),
      ...(identity ? { identity } : {}),
    });
    terminal.onDidClose((exitCode) => {
      // A recovery timeout can dispose one terminal and immediately create its
      // retry before VS Code delivers the old close event. Only the handle that
      // is still current may clear the ticket or announce that its session ended.
      const wasCurrent = this.terminals.get(ticketId)?.terminal === terminal;
      if (wasCurrent) this.terminals.delete(ticketId);
      // Once VS Code delivers the close event the terminal is gone from
      // `window.terminals`, so the recently-disposed guard is no longer needed
      // — but only the guarded terminal's own close may release it. A newer
      // session's close delivering first still leaves the disposed tab listed.
      if (this.recentlyDisposed.get(ticketId) === terminal) {
        this.recentlyDisposed.delete(ticketId);
      }
      try {
        // Materialized paths are ticket-scoped and a retry may reuse them. A
        // delayed close from the retired handle must not delete assets now owned
        // by its replacement.
        if (wasCurrent) cleanupOwned?.();
      } finally {
        if (wasCurrent) this.onDidCloseSession?.(ticketId);
        this.onDidCloseTerminal?.(ticketId, launchId);
        // Retire the failed generation completely before asking the host to
        // recover it. The callback may immediately open a fresh replacement;
        // running either close observer afterwards would then apply the old
        // launch's lifecycle to the new terminal.
        if (wasCurrent && wasResume && exitCode !== undefined && exitCode !== 0) {
          this.onResumeFailed?.(ticketId, options);
        }
      }
    });
  }

  /**
   * Open (or focus) the interactive session for a ticket. The optional `label`
   * carries the ticket's key + title so the terminal reads `Karst: <key>` with
   * the title as its description, rather than the raw internal id. The optional
   * `initialPrompt` seeds a fresh launch only; re-opens skip building a new
   * command. `extraArgs` carries agent-specific launch additions from the
   * adapter's `materializeApproach` (e.g. `--plugin-dir`), fresh-launch only.
   * `model` is the resolved launch model id (per-ticket or manifest default),
   * threaded as `--model`; omitted → the agent CLI's own default. `effort` is
   * the resolved effort/variant, threaded as the provider's effort flag;
   * omitted → the agent CLI's own default. `resume` is
   * an agent session id to continue via `--resume`, fresh-launch only.
   */
   openSession(
    adapter: AgentAdapter,
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
    extraArgs?: string[],
    model?: string,
    resume?: string,
    naming?: { name: string; iconPath?: string; color?: string },
    ownedPaths: string[] = [],
    options: OpenSessionOptions = {},
    identity?: SessionIdentity,
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      if (options.reveal !== false) existing.terminal.show();
      return;
    }
    // VS Code revives terminal tabs asynchronously, so a session tagged for this
    // ticket can surface AFTER the activation scan that was meant to adopt it.
    // Re-check the host here or a recovery launch spawns a second agent beside a
    // terminal that is still running the first one.
    const revived = this.adoptRevivedSession(ticketId);
    if (revived) {
      if (options.reveal !== false) revived.terminal.show();
      return;
    }

    // Resolved ONCE and used for both the terminal tab and the agent's own
    // session name: a session found later in the agent's resume picker must
    // read exactly like the terminal it ran in, or it can't be matched back to
    // its ticket. Adapters whose CLI has no naming flag ignore it.
    const terminalName = naming?.name ?? `Karst: ${label?.key ?? `#${ticketId}`}`;
    const hookChannel = this.hookChannelFor(ticketId);
    const cmd = adapter.buildInteractiveCommand({
      cwd: worktreePath,
      hookChannel,
      sessionName: terminalName,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
      ...(model ? { model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(resume ? { resume } : {}),
    });
    const cleanupPaths = [...ownedPaths, ...(cmd.ownedPaths ?? [])];

    // The launch is PREPARED: the generation exists, a terminal is about to be
    // created. Record it before createTerminal so a failure of either half is
    // attributable — but only when the channel actually carries a generation
    // (a legacy hook channel has nothing to confirm against later).
    const launchId = hookChannel.launchId;
    if (launchId !== undefined) {
      this.onLaunchPrepared?.({
        ticketId,
        launchId,
        resume: Boolean(resume),
        switchLaunch: options.allowResume === false && options.providerReady === true,
        ...(options.assignment ? { assignment: options.assignment } : {}),
        seedTelemetry: measureSeed(initialPrompt),
      });
    }

    let terminal: SessionTerminal;
    try {
      terminal = this.host.createTerminal({
        name: terminalName,
        description: naming ? undefined : (label?.title ?? undefined),
        cwd: worktreePath,
        shellPath: cmd.command,
        shellArgs: cmd.args,
        env: {
          ...cmd.env,
          [KARST_TICKET_ENV]: String(ticketId),
          ...(launchId ? { [KARST_LAUNCH_ENV]: launchId } : {}),
          ...(options.dbPath ? { [KARST_DB_ENV]: options.dbPath } : {}),
          ...(identity?.provider ? { [KARST_PROVIDER_ENV]: identity.provider } : {}),
        },
        ...(identity ? { identity } : {}),
        ...(naming?.iconPath ? { iconPath: naming.iconPath } : {}),
        ...(naming?.color ? { color: naming.color } : {}),
      });
    } catch (err) {
      if (launchId !== undefined) this.onLaunchFailed?.(launchId);
      throw err;
    }
    let cleanupStarted = false;
    const cleanupOwned = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      this.cleanup(worktreePath, cleanupPaths);
    };
    this.trackTerminal(
      ticketId,
      terminal,
      hookChannel.launchId,
      cleanupOwned,
      Boolean(resume),
      options,
      identity,
    );
    if (options.reveal !== false) terminal.show();
  }

  /**
   * Reconcile only restored terminals owned by this window's project. Ignored
   * handles are left alone: another project (or a window without a project)
   * must never dispose a terminal it cannot safely own. Recovered terminals
   * are adopted into the live map so their existing agent session remains
   * usable after an IDE reload.
   */
  reconcileRestoredSessions(
    classify: (ticketId: number) => RestoredSessionDisposition,
  ): RestoredRecoveryResult {
    const result: RestoredRecoveryResult = { resume: [], idle: [] };

    for (const session of this.host.restoredSessions?.() ?? []) {
      const outcome = this.adoptLateSession(session, classify);
      if (outcome.kind === 'adopted') {
        result[outcome.disposition].push(session.ticketId);
      }
    }

    return result;
  }

  /**
   * Reconcile ONE terminal the host reports, whenever it surfaces. The
   * activation scan cannot be the only adoption point: VS Code restores its
   * terminal tabs on its own schedule, and a tab that lands after that scan is
   * still this ticket's running agent. Second sessions for a ticket are refused
   * here rather than left to sit beside the live one.
   */
  adoptLateSession(
    session: RestoredSession,
    classify: (ticketId: number) => RestoredSessionDisposition,
  ): LateSessionAdoption {
    const { ticketId, launchId, terminal } = session;
    const tracked = this.terminals.get(ticketId);
    if (tracked) {
      // Same handle, or same generation → this is the terminal this window
      // already manages (VS Code reports every terminal it opens, karst's own
      // included, and each report re-wraps it in a fresh handle object). An
      // ABSENT generation proves nothing: two legacy terminals both lack one,
      // so identity is the only evidence left for them.
      const known =
        tracked.terminal === terminal ||
        (launchId !== undefined && tracked.launchId === launchId);
      if (known) return { kind: 'known' };
      // A different generation for a ticket already running here is a leftover
      // from a previous window: its hooks are quarantined, so it can only
      // confuse the user. Retire it explicitly — it never enters the managed
      // map, so it has no close listener to do that for it.
      this.onDidCloseTerminal?.(ticketId, launchId);
      terminal.dispose();
      return { kind: 'duplicate' };
    }
    // A tab whose process already exited answers nothing; the caller must be
    // free to launch a live session instead of adopting the corpse.
    if (session.exited) return { kind: 'ignored' };
    const disposition = classify(ticketId);
    if (disposition === 'ignore') return { kind: 'ignored' };
    this.trackTerminal(ticketId, terminal, launchId, undefined, false, {}, session.identity);
    this.onDidAdoptTerminal?.(ticketId, launchId);
    return { kind: 'adopted', disposition };
  }

  /**
   * Adopt a live terminal the host already holds for this ticket. Used on the
   * open path, where the ticket is named explicitly: no classification is
   * needed, only proof that the tab is this ticket's and still running.
   */
  private adoptRevivedSession(ticketId: number): TrackedSession | undefined {
    // After a karst-initiated disposal (e.g. agent core switch), VS Code may
    // still list the terminal in `window.terminals` before its async cleanup
    // removes it. Skip it so we create a fresh terminal instead of adopting
    // one whose `.show()` would throw "Terminal has already been disposed".
    if (this.recentlyDisposed.has(ticketId)) return undefined;
    for (const session of this.host.restoredSessions?.() ?? []) {
      if (session.ticketId !== ticketId || session.exited) continue;
      this.trackTerminal(
        ticketId,
        session.terminal,
        session.launchId,
        undefined,
        false,
        {},
        session.identity,
      );
      this.onDidAdoptTerminal?.(ticketId, session.launchId);
      return this.terminals.get(ticketId);
    }
    return undefined;
  }

  /**
   * Send a prompt to a session that is ALREADY open without revealing it. Returns
   * false when the ticket has no live terminal, so the caller can fall back to
   * `openSession` instead of silently dropping the prompt.
   *
   * Why this exists: gates run while the session is still open (the marker, not
   * the terminal, says the work is done). A failed gate therefore has to reach an
   * agent already sitting at its prompt — `openSession` would only focus that
   * terminal and never deliver the brief, leaving the ticket parked at fix with
   * nothing happening.
   *
   * A revived terminal counts as live, exactly as it does on the open path: the
   * map is this host's bookkeeping and is empty after a reload, while the agent
   * it forgot is still running. Without this adoption the fallback launched a
   * SECOND agent beside it (869ecmk6v). Adoption never reveals the terminal —
   * an automated continuation must not yank the user out of what they are doing.
   */
  nudge(ticketId: number, prompt: string): boolean {
    const tracked = this.terminals.get(ticketId) ?? this.adoptRevivedSession(ticketId);
    if (!tracked) return false;
    tracked.terminal.sendText(toSingleLine(prompt));
    return true;
  }

  /**
   * Reveal an already-open session; no-op if the ticket has none. Never creates
   * one: the dashboard binding calls this on an ordinary panel activation, and
   * launching an agent must stay an explicit act.
   *
   * Returns whether a terminal was revealed. The binding needs to know: a reveal
   * that happened raises an activation event, and one that did not raises
   * nothing to wait for.
   */
  focusSession(ticketId: number, preserveFocus?: boolean): boolean {
    const tracked = this.terminals.get(ticketId);
    if (!tracked) return false;
    tracked.terminal.show(preserveFocus);
    return true;
  }

  /**
   * Reveal the ticket's session terminal, adopting a revived one first when
   * this window's own bookkeeping forgot it (a reload empties `terminals`
   * while the agent it forgot is still running). Never launches: the inside
   * panel's "Open session" control is a reveal-or-adopt, never a resume — the
   * dispatch already proved a live implementation run exists before calling
   * this, so `false` here means the run's terminal died between that read
   * and this call, not that no session was ever open.
   *
   * Returns whether a terminal was revealed, mirroring `focusSession`.
   */
  revealSession(ticketId: number, preserveFocus?: boolean): boolean {
    const tracked = this.terminals.get(ticketId) ?? this.adoptRevivedSession(ticketId);
    if (!tracked) return false;
    tracked.terminal.show(preserveFocus);
    return true;
  }

  /** Whether a session terminal is currently open for a ticket. */
  isOpen(ticketId: number): boolean {
    return this.terminals.has(ticketId);
  }

  /**
   * Whether the ticket's agent is LIVE in this window: its terminal is open,
   * or a revived handle takes the ticket over (the map is empty after a
   * reload while the agent it forgot is still running). Adoption never reveals
   * the terminal — the caller is an automated continuation.
   */
  isLive(ticketId: number): boolean {
    return this.terminals.has(ticketId) || this.adoptRevivedSession(ticketId) !== undefined;
  }

  /**
   * The recorded active provider/model snapshot of the ticket's session, if
   * this window launched it (a revived handle from another window carries no
   * snapshot — its caller falls back to a fresh resolution).
   */
  sessionIdentity(ticketId: number): SessionIdentity | null {
    return this.terminals.get(ticketId)?.identity ?? null;
  }

  /**
   * Dispose the current terminal and release the one-per-ticket guard
   * immediately. VS Code may report its close later; the identity check in the
   * close handler prevents that stale event from deleting a replacement.
   */
  disposeSession(ticketId: number): void {
    const tracked = this.terminals.get(ticketId);
    if (!tracked) return;
    // Mark the ticket before removing it from the map so that a concurrent
    // `adoptRevivedSession` call (during the async gap of an agent core
    // switch) does not re-adopt the terminal VS Code has not yet cleaned up.
    this.recentlyDisposed.set(ticketId, tracked.terminal);
    try {
      // Release this launch's assets while it still owns the ticket slot. A
      // retry can safely reuse the same paths as soon as this method returns.
      this.cleanupByTerminal.get(tracked.terminal)?.();
    } finally {
      this.terminals.delete(ticketId);
      tracked.terminal.dispose();
    }
  }
}
