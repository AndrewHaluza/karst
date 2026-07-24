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
  onDidClose(handler: () => void): void;
}

export interface CreateTerminalOpts {
  name: string;
  /** Dimmed text beside the name (real: `vscode.TerminalOptions.description`). */
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  /** File path to a tinted icon SVG (real: mapped to `vscode.Uri.file`). */
  iconPath?: string;
  /** Terminal-color ThemeColor key (real: `new vscode.ThemeColor(color)`). */
  color?: string;
}

/** Factory the manager uses to mint terminals (real: `createTerminal`). */
export interface TerminalHost {
  createTerminal(opts: CreateTerminalOpts): SessionTerminal;
}

/** Test double surface — extends the terminal with recorded state. */
export interface FakeTerminal extends SessionTerminal {
  name: string;
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  iconPath?: string;
  color?: string;
  shown: number;
  sent: string[];
  disposed: boolean;
  disposeHandler?: () => void;
}

/** Resolve the provider-neutral lifecycle channel for a session. */
export type HookChannelFor = () => HookChannel;
export type CleanupOwnedPaths = (
  worktreePath: string,
  ownedPaths: readonly string[],
) => void;

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
  ) {}

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
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      existing.show();
      return;
    }

    const cmd = adapter.buildInteractiveCommand({
      cwd: worktreePath,
      hookChannel: this.hookChannelFor(),
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
      ...(naming?.iconPath ? { iconPath: naming.iconPath } : {}),
      ...(naming?.color ? { color: naming.color } : {}),
    });
    terminal.onDidClose(() => {
      this.terminals.delete(ticketId);
      try {
        this.cleanup(worktreePath, cleanupPaths);
      } finally {
        this.onDidCloseSession?.(ticketId);
      }
    });
    this.terminals.set(ticketId, terminal);
    terminal.show();
  }

  /**
   * Send a prompt to a session that is ALREADY open, and reveal it. Returns
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
    terminal.show();
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
}
