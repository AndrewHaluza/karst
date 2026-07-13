import type { AgentAdapter } from '../agent/adapter.js';

/**
 * The subset of a `vscode.Terminal` the manager touches. Modeling it as an
 * interface keeps `SessionManager` host-agnostic and unit-testable without a
 * `vscode` module; the activation adapter supplies a real terminal.
 */
export interface SessionTerminal {
  show(): void;
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
  shown: number;
  disposed: boolean;
  disposeHandler?: () => void;
}

/** Resolve the hook-settings path for a session (T3.4 `writeHookSettings`). */
export type SettingsPathFor = (ticketId: number, worktreePath: string) => string;

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
    private readonly adapter: AgentAdapter,
    private readonly host: TerminalHost,
    private readonly settingsPathFor: SettingsPathFor,
  ) {}

  /**
   * Open (or focus) the interactive session for a ticket. The optional `label`
   * carries the ticket's key + title so the terminal reads `Karst: <key>` with
   * the title as its description, rather than the raw internal id. The optional
   * `initialPrompt` seeds a fresh launch only; re-opens skip building a new
   * command. `extraArgs` carries agent-specific launch additions from the
   * adapter's `materializeApproach` (e.g. `--plugin-dir`), fresh-launch only.
   * `model` is the resolved launch model id (per-ticket or manifest default),
   * threaded as `--model`; omitted → the agent CLI's own default.
   */
  openSession(
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
    extraArgs?: string[],
    model?: string,
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      existing.show();
      return;
    }

    const settingsPath = this.settingsPathFor(ticketId, worktreePath);
    const cmd = this.adapter.buildInteractiveCommand({
      cwd: worktreePath,
      settingsPath,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(extraArgs && extraArgs.length > 0 ? { extraArgs } : {}),
      ...(model ? { model } : {}),
    });

    const terminal = this.host.createTerminal({
      name: `Karst: ${label?.key ?? `#${ticketId}`}`,
      description: label?.title ?? undefined,
      cwd: worktreePath,
      shellPath: cmd.command,
      shellArgs: cmd.args,
    });
    terminal.onDidClose(() => this.terminals.delete(ticketId));
    this.terminals.set(ticketId, terminal);
    terminal.show();
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
