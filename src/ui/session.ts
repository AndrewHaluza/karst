import type { AgentAdapter, HookChannel } from '../agent/adapter.js';
import { cleanupOwnedPaths } from '../agent/materializedCleanup.js';

/**
 * The subset of a `vscode.Terminal` the manager touches. Modeling it as an
 * interface keeps `SessionManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real terminal.
 */
export interface SessionTerminal {
  show(): void;
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

/** A host-discovered terminal previously created for a Karst ticket. */
export interface RestoredSession {
  ticketId: number;
  /** Opaque hook generation captured when this terminal was launched. */
  launchId?: string;
  terminal: SessionTerminal;
}

/** Tickets whose restored terminals should resume or remain recoverable idle. */
export interface RestoredRecoveryResult {
  resume: number[];
  idle: number[];
}

/** The current window's recovery decision for a restored terminal. */
export type RestoredSessionDisposition = 'resume' | 'idle' | 'ignore';

export interface CreateTerminalOpts {
  name: string;
  /** Dimmed text beside the name (real: `vscode.TerminalOptions.description`). */
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  /** Environment variables passed to the terminal process. */
  env: Record<string, string>;
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
 * One interactive terminal per ticket (§5.2, §5.6). `openSession` launches
 * `claude` scoped to the ticket's worktree via the agent adapter, threading the
 * hook-settings path so the HTTP channel fires; re-opening focuses the existing
 * terminal instead of spawning a duplicate. A closed terminal is dropped so a
 * later open recreates it.
 */
export class SessionManager {
  private readonly terminals = new Map<number, SessionTerminal>();
  private readonly cleanupByTerminal = new WeakMap<SessionTerminal, () => void>();

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
    private readonly onResumeFailed?: (ticketId: number) => void,
  ) {}

  private trackTerminal(
    ticketId: number,
    terminal: SessionTerminal,
    launchId?: string,
    cleanupOwned?: () => void,
    wasResume = false,
  ): void {
    if (cleanupOwned) this.cleanupByTerminal.set(terminal, cleanupOwned);
    this.terminals.set(ticketId, terminal);
    terminal.onDidClose((exitCode) => {
      // A recovery timeout can dispose one terminal and immediately create its
      // retry before VS Code delivers the old close event. Only the handle that
      // is still current may clear the ticket or announce that its session ended.
      const wasCurrent = this.terminals.get(ticketId) === terminal;
      if (wasCurrent) this.terminals.delete(ticketId);
      try {
        // Materialized paths are ticket-scoped and a retry may reuse them. A
        // delayed close from the retired handle must not delete assets now owned
        // by its replacement.
        if (wasCurrent) cleanupOwned?.();
      } finally {
        if (wasCurrent && wasResume && exitCode !== undefined && exitCode !== 0) {
          this.onResumeFailed?.(ticketId);
        }
        if (wasCurrent) this.onDidCloseSession?.(ticketId);
        this.onDidCloseTerminal?.(ticketId, launchId);
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
   * threaded as `--model`; omitted → the agent CLI's own default. `resume` is
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
    options: { reveal?: boolean } = {},
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      if (options.reveal !== false) existing.show();
      return;
    }

    const hookChannel = this.hookChannelFor(ticketId);
    const cmd = adapter.buildInteractiveCommand({
      cwd: worktreePath,
      hookChannel,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
    });
    const cleanupPaths = [...ownedPaths, ...(cmd.ownedPaths ?? [])];

    const terminal = this.host.createTerminal({
      name: naming?.name ?? `Karst: ${label?.key ?? `#${ticketId}`}`,
      description: naming ? undefined : (label?.title ?? undefined),
      cwd: worktreePath,
      shellPath: cmd.command,
      shellArgs: cmd.args,
      env: {
        ...cmd.env,
        [KARST_TICKET_ENV]: String(ticketId),
        ...(hookChannel.launchId
          ? { [KARST_LAUNCH_ENV]: hookChannel.launchId }
          : {}),
      },
      ...(options.reveal === false ? { hideFromUser: true } : {}),
      ...(naming?.iconPath ? { iconPath: naming.iconPath } : {}),
      ...(naming?.color ? { color: naming.color } : {}),
    });
    let cleanupStarted = false;
    const cleanupOwned = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      this.cleanup(worktreePath, cleanupPaths);
    };
    this.trackTerminal(ticketId, terminal, hookChannel.launchId, cleanupOwned, Boolean(resume));
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
    const recovered = new Set<number>();

    for (const {
      ticketId,
      launchId,
      terminal,
    } of this.host.restoredSessions?.() ?? []) {
      const disposition = classify(ticketId);
      if (disposition === 'ignore') continue;
      if (recovered.has(ticketId)) {
        // The duplicate never enters the managed map, so it has no close
        // listener through which its generation could otherwise be retired.
        this.onDidCloseTerminal?.(ticketId, launchId);
        terminal.dispose();
        continue;
      }
      recovered.add(ticketId);
      this.trackTerminal(ticketId, terminal, launchId);
      this.onDidAdoptTerminal?.(ticketId, launchId);
      result[disposition].push(ticketId);
    }

    return result;
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
   */
  nudge(ticketId: number, prompt: string): boolean {
    const terminal = this.terminals.get(ticketId);
    if (!terminal) return false;
    terminal.sendText(toSingleLine(prompt));
    return true;
  }

  /** Reveal an already-open session; no-op if the ticket has none. */
  focusSession(ticketId: number): void {
    this.terminals.get(ticketId)?.show();
  }

  /** Whether a session terminal is currently open for a ticket. */
  isOpen(ticketId: number): boolean {
    return this.terminals.has(ticketId);
  }

  /**
   * Dispose the current terminal and release the one-per-ticket guard
   * immediately. VS Code may report its close later; the identity check in the
   * close handler prevents that stale event from deleting a replacement.
   */
  disposeSession(ticketId: number): void {
    const terminal = this.terminals.get(ticketId);
    if (!terminal) return;
    try {
      // Release this launch's assets while it still owns the ticket slot. A
      // retry can safely reuse the same paths as soon as this method returns.
      this.cleanupByTerminal.get(terminal)?.();
    } finally {
      this.terminals.delete(ticketId);
      terminal.dispose();
    }
  }
}
