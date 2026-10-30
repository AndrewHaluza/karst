import * as vscode from 'vscode';
import { KARST_LAUNCH_ENV, ticketIdFromTerminalEnv, type TerminalHost, type SessionTerminal, type SessionIdentity, type RestoredSession } from '../ui/session.js';
import { forgetSessionTerminal, forgetSessionTerminalPid, identifyTerminal, pruneSessionTerminals, rememberSessionTerminal, type DurableSessionIdentityLookup, type SessionTerminalRecord, type TerminalIdentity } from '../ui/terminalIdentity.js';
import { KARST_TERMINAL_ICON_ID } from '../ui/terminalNaming.js';
import { observeTerminalClose } from '../ui/terminalObservation.js';
import { type TransportTerminal, type TransportTerminalHost } from '../approaches/graph/transport/supervisedCliTransport.js';
import { isGraphSessionEnv } from '../approaches/graph/transport/env.js';

/**
 * How long a terminal gets to report its pid. Activation waits on this before
 * it may adopt a restored session, and `Terminal.processId` never settles for a
 * process that failed to start — so the wait is bounded rather than open-ended.
 */
const PID_PROBE_TIMEOUT_MS = 5_000;

/**
 * A terminal's launch environment, when it has one. `creationOptions` is a union
 * — a pty-backed terminal carries no `env` at all — so the narrowing lives here
 * rather than at each call site.
 */
export function terminalEnv(
  terminal: vscode.Terminal | undefined,
): Readonly<Record<string, string | undefined>> | undefined {
  const opts = terminal?.creationOptions;
  return opts && 'env' in opts
    ? (opts.env as Readonly<Record<string, string | undefined>> | undefined)
    : undefined;
}

/**
 * This window's terminal→ticket lookup, and the only place a pid is captured.
 * `identify` never awaits: `restoredSessions()` is called synchronously from the
 * open path, so a pid must already be resolved (via `resolve`) to count.
 */
export interface TerminalIdentityRegistry {
  /** Learn a terminal's pid. Idempotent — repeat calls share one probe. */
  resolve(terminal: vscode.Terminal): Promise<void>;
  /** Name a terminal's ticket from what is already known. Never awaits. */
  identify(terminal: vscode.Terminal): TerminalIdentity | undefined;
  /** Remember a terminal karst just launched, once its pid resolves. */
  remember(
    terminal: vscode.Terminal,
    env: Record<string, string>,
    identity?: SessionIdentity,
    mcp?: boolean,
  ): void;
  /** Release a ticket's record — its terminal closed, freeing the pid. */
  forget(ticketId: number): void;
  /** Release ONE closed terminal's record. A graphing ticket has several live
   *  terminals at once, so the ticket is not an address for them; the pid is. */
  forgetTerminal(terminal: vscode.Terminal): void;
  /** Drop records for tickets this window can no longer act on. */
  prune(knownTicketIds: readonly number[]): void;
}

export function makeTerminalIdentityRegistry(
  initial: readonly SessionTerminalRecord[],
  persist: (records: SessionTerminalRecord[]) => void,
  lookupIdentity?: DurableSessionIdentityLookup,
  /**
   * Live-pid registry hook (the resource monitor): called once a remembered
   * terminal's pid resolves, with the pid and its ticket. The returned disposer
   * runs when the ticket's record is forgotten — a closed terminal's pid is
   * free for the OS to reissue, so the registration must not outlive it.
   */
  onSessionTerminal?: (pid: number, ticketId: number) => (() => void) | void,
): TerminalIdentityRegistry {
  let records: SessionTerminalRecord[] = [...initial];
  const pidByTerminal = new WeakMap<vscode.Terminal, number>();
  const probes = new WeakMap<vscode.Terminal, Promise<void>>();
  const sessionDisposers = new Map<number, () => void>();

  const resolve = (terminal: vscode.Terminal): Promise<void> => {
    const running = probes.get(terminal);
    if (running) return running;
    // `Terminal.processId` never settles for a terminal whose process never
    // reported one, and activation awaits this before it may adopt anything —
    // so the probe is bounded. A pid that never arrives simply leaves the
    // terminal unidentifiable: the state karst was in before records existed,
    // never a hang and never a failure.
    const probe = new Promise<number | undefined>((done) => {
      const timer = setTimeout(() => done(undefined), PID_PROBE_TIMEOUT_MS);
      void Promise.resolve(terminal.processId).then(
        (pid) => {
          clearTimeout(timer);
          done(pid);
        },
        () => {
          clearTimeout(timer);
          done(undefined);
        },
      );
    }).then((pid) => {
      if (typeof pid === 'number' && pid > 0) pidByTerminal.set(terminal, pid);
    });
    probes.set(terminal, probe);
    return probe;
  };

  const write = (next: SessionTerminalRecord[]): void => {
    records = next;
    persist(records);
  };

  return {
    resolve,
    identify: (terminal) =>
      identifyTerminal(
        { env: terminalEnv(terminal), pid: pidByTerminal.get(terminal) },
        records,
        lookupIdentity,
      ),
    remember: (terminal, env, sessionIdentity, mcp) => {
      const ticketId = ticketIdFromTerminalEnv(env);
      if (ticketId === undefined) return;
      const launchId = env[KARST_LAUNCH_ENV];
      // Graph ownership is recorded at launch because the reload that strips
      // the env is exactly when it is needed: without it a revived node
      // terminal reads as the ticket's session terminal.
      const graph = isGraphSessionEnv(env);
      void resolve(terminal).then(() => {
        const pid = pidByTerminal.get(terminal);
        if (pid === undefined) return;
        write(
          rememberSessionTerminal(records, {
            ticketId,
            pid,
            ...(launchId ? { launchId } : {}),
            ...(sessionIdentity ? { identity: sessionIdentity } : {}),
            ...(graph ? { graph: true as const } : {}),
            ...(mcp ? { mcp: true as const } : {}),
          }),
        );
        // The live-pid registry (the resource monitor) is keyed by ticket and a
        // graphing ticket has many pids, so a graph terminal never claims that
        // per-ticket slot — it would evict the session terminal's disposer.
        if (graph) return;
        const dispose = onSessionTerminal?.(pid, ticketId);
        if (dispose) sessionDisposers.set(ticketId, dispose);
      });
    },
    forgetTerminal: (terminal) => {
      const pid = pidByTerminal.get(terminal);
      if (pid === undefined) return;
      const next = forgetSessionTerminalPid(records, pid);
      if (next.length !== records.length) write(next);
    },
    forget: (ticketId) => {
      const next = forgetSessionTerminal(records, ticketId);
      if (next.length !== records.length) write(next);
      const dispose = sessionDisposers.get(ticketId);
      if (dispose) {
        sessionDisposers.delete(ticketId);
        dispose();
      }
    },
    prune: (knownTicketIds) => {
      const next = pruneSessionTerminals(records, knownTicketIds);
      if (next.length !== records.length) write(next);
    },
  };
}

/**
 * Read a terminal's karst identity, or undefined when it has none. `exitStatus`
 * is what separates a live session from a tab whose agent already quit.
 */
export function restoredSessionOf(
  terminal: vscode.Terminal,
  identity: TerminalIdentityRegistry,
): RestoredSession | undefined {
  const named = identity.identify(terminal);
  if (!named) return undefined;
  // A graph node/planner terminal is NOT a ticket session. It carries
  // `KARST_TICKET_ID` like every karst terminal, so the session recovery used
  // to see the second terminal of a graphing ticket as a duplicate restored
  // session and CLOSE it — killing an agent node milliseconds after the graph
  // driver launched it, which the reconcile sweep then reported as
  // "process (pid N) is gone (dead at reconcile)" and blocked the whole run
  // (869eg9k2p). The graph transport owns these terminals; `reattachGraphSessions`
  // is their re-attach path.
  if (named.graph) return undefined;
  return {
    ticketId: named.ticketId,
    ...(named.launchId ? { launchId: named.launchId } : {}),
    ...(named.identity ? { identity: named.identity } : {}),
    ...(named.mcp ? { mcp: true } : {}),
    ...(terminal.exitStatus !== undefined ? { exited: true } : {}),
    terminal: wrapTerminal(terminal),
  };
}

/** Wrap a VS Code terminal for both freshly-created and restored sessions. */
export function wrapTerminal(terminal: vscode.Terminal): SessionTerminal {
  return {
    show: (preserveFocus) => terminal.show(preserveFocus),
    sendText: (text, addNewLine = true) => terminal.sendText(text, addNewLine),
    dispose: () => terminal.dispose(),
    onDidClose: (handler) => observeTerminalClose(terminal, handler),
  };
}

/** The workspace a revived graph terminal was launched in, when recoverable.
 *  `creationOptions.cwd` survives a reload (the pty details carry it); a
 *  non-string value degrades to '' — the session's cwd is used for attribution
 *  on terminate, and an empty value simply falls back to start-time matching. */
export function graphTerminalCwd(terminal: vscode.Terminal): string {
  const opts = terminal.creationOptions;
  const cwd = opts && 'cwd' in opts ? opts.cwd : undefined;
  return typeof cwd === 'string' ? cwd : '';
}

/** Wrap a REVIVED vscode terminal in the graph transport's `TransportTerminal`
 *  surface (the graph host's `createTerminal` returns the same shape for a
 *  freshly-spawned one). Only ever used to re-attach a session that already
 *  exists — it never spawns, and never re-registers in the identity registry. */
export function wrapRevivedGraphTerminal(terminal: vscode.Terminal): TransportTerminal {
  return {
    processId: () => Promise.resolve(terminal.processId),
    show: (preserveFocus) => terminal.show(preserveFocus),
    sendText: (text) => terminal.sendText(text, true),
    dispose: () => terminal.dispose(),
    onDidClose: (handler) => observeTerminalClose(terminal, handler),
  };
}

/** Real terminals, wrapped in the `SessionTerminal` interface. */
export function makeTerminalHost(identity: TerminalIdentityRegistry): TerminalHost {
  return {
    createTerminal(opts): SessionTerminal {
      // VS Code terminals have no separate "description" field — fold the title
      // into the tab name so the terminal reads "Karst: <key> — <title>".
      const name = opts.description ? `${opts.name} — ${opts.description}` : opts.name;
      const terminal = vscode.window.createTerminal({
        name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        // Name/icon/color are frozen at creation — `Terminal.creationOptions` is
        // readonly, so the launch glyph is what the tab keeps for its lifetime.
        // A ThemeIcon (the contributed `karst-mark` font glyph), NOT a Uri: VS Code
        // persists only ThemeIcon ids for revived terminals, so a Uri icon is lost
        // on window reload. `opts.iconPath` stays the opt-in switch.
        ...(opts.iconPath ? { iconPath: new vscode.ThemeIcon(KARST_TERMINAL_ICON_ID) } : {}),
        ...(opts.color ? { color: new vscode.ThemeColor(opts.color) } : {}),
      });
      // Capture the launch pid NOW: it is what re-identifies this terminal
      // after a reload strips the env that carries the ticket today.
      identity.remember(terminal, opts.env, opts.identity, opts.mcp);
      return wrapTerminal(terminal);
    },
    restoredSessions: () =>
      vscode.window.terminals.flatMap((terminal) => {
        const session = restoredSessionOf(terminal, identity);
        return session ? [session] : [];
      }),
  };
}

/** Graph node terminals, wrapped in the `TransportTerminal` interface. */
export function makeGraphTerminalHost(identity: TerminalIdentityRegistry): TransportTerminalHost {
  return {
    createTerminal(opts): TransportTerminal {
      const terminal = vscode.window.createTerminal({
        name: opts.name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        env: opts.env,
        hideFromUser: opts.hideFromUser,
        // The brand mark rides the graph tab exactly like a regular session's
        // (Terminal.creationOptions is readonly — the launch glyph is frozen). A
        // ThemeIcon so it survives reload revival (a Uri icon does not persist).
        ...(opts.iconPath ? { iconPath: new vscode.ThemeIcon(KARST_TERMINAL_ICON_ID) } : {}),
      });
      // Remembered in the same per-window registry the session terminals use:
      // the graph env carries KARST_TICKET_ID + KARST_LAUNCH_ID, so a reload
      // re-attaches a live node session instead of launching a second one.
      identity.remember(terminal, opts.env, undefined);
      return {
        processId: () => Promise.resolve(terminal.processId),
        show: (preserveFocus) => terminal.show(preserveFocus),
        sendText: (text) => terminal.sendText(text, true),
        dispose: () => terminal.dispose(),
        // No captured output: VS Code exposes a terminal's data only through a
        // proposed API a shipped extension cannot use, so the launch-failure
        // reason carries no provider line here (see `terminalObservation`).
        onDidClose: (handler) => observeTerminalClose(terminal, handler),
      };
    },
  };
}
