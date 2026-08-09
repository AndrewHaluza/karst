import {
  KARST_LAUNCH_ENV,
  ticketIdFromTerminalEnv,
  type SessionIdentity,
} from './session.js';

/**
 * Which ticket a terminal belongs to, ACROSS a window reload.
 *
 * The launch environment (`KARST_TICKET_ID`) is the identity every karst
 * terminal carries, but VS Code does not give it back after a reload: a
 * reattached terminal is rebuilt from the pty host's process details, and those
 * carry `title`/`cwd`/`icon` — never `env`, never the executable. The extension
 * host therefore sees `creationOptions.env === undefined` for the very terminal
 * still running the agent, so the ticket→terminal link vanishes exactly when
 * recovery needs it: nothing is adopted, background recovery launches a SECOND
 * agent with `--resume`, and the user gets two terminals for one ticket (the
 * duplicate-session report behind 869eck3gv-fu1).
 *
 * The pid is the one identity that does survive. The pty host keeps the process
 * alive across a reload and reports the same pid, and `Terminal.processId`
 * resolves to it, so a pid captured at launch and persisted in this window's
 * state re-identifies the terminal when its env is gone. Terminal NAMES are not
 * usable for this — an agent CLI rewrites the title with an OSC sequence, and
 * that rewritten title is what gets persisted.
 *
 * vscode-free and pure: the host binds `Terminal.processId` and workspace state.
 */

/** A launched session terminal, as remembered by the window that launched it. */
export interface SessionTerminalRecord {
  readonly ticketId: number;
  /** The hook generation this terminal launched with, when it had one. */
  readonly launchId?: string;
  /** The pty process id, i.e. what `Terminal.processId` resolves to. */
  readonly pid: number;
  /** The exact provider/model snapshot supplied to the terminal launch. */
  readonly identity?: SessionIdentity;
}

/** What a terminal proves about itself — the ticket and its hook generation. */
export interface TerminalIdentity {
  readonly ticketId: number;
  readonly launchId?: string;
  readonly identity?: SessionIdentity;
}

/** Everything observable about a terminal that can name its ticket. */
export interface TerminalProbe {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly pid?: number | undefined;
}

/** Durable launch evidence sufficient to recover a terminal's execution core. */
export interface DurableSessionIdentity {
  readonly ticketId: number;
  readonly provider: string;
  readonly model: string | null;
  readonly agentName?: string | null;
}

export type DurableSessionIdentityLookup = (
  launchId: string,
) => DurableSessionIdentity | undefined;

/**
 * Records kept per window. A window holds one terminal per ticket, so this only
 * needs to outnumber the tickets one session realistically touches; the cap is
 * what keeps a crash-orphaned record from accumulating forever.
 */
export const MAX_SESSION_TERMINAL_RECORDS = 64;

function launchIdFrom(
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  const raw = env?.[KARST_LAUNCH_ENV];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function identity(
  ticketId: number,
  launchId?: string,
  sessionIdentity?: SessionIdentity,
): TerminalIdentity {
  return {
    ticketId,
    ...(launchId ? { launchId } : {}),
    ...(sessionIdentity ? { identity: sessionIdentity } : {}),
  };
}

/**
 * Name the ticket a terminal belongs to. The environment wins whenever it is
 * present: it is the launch's own statement, while a record is this window's
 * recollection of a pid that the OS may since have handed to someone else.
 */
export function identifyTerminal(
  probe: TerminalProbe,
  records: readonly SessionTerminalRecord[],
  lookupIdentity?: DurableSessionIdentityLookup,
): TerminalIdentity | undefined {
  const fromEnv = ticketIdFromTerminalEnv(probe.env);
  const record = probe.pid === undefined ? undefined : records.find((r) => r.pid === probe.pid);
  if (fromEnv !== undefined) {
    const launchId = launchIdFrom(probe.env);
    return identity(
      fromEnv,
      launchId,
      record?.ticketId === fromEnv && record.identity
        ? record.identity
        : durableIdentity(fromEnv, launchId, lookupIdentity),
    );
  }
  if (probe.pid === undefined) return undefined;
  return record
    ? identity(
        record.ticketId,
        record.launchId,
        record.identity ?? durableIdentity(record.ticketId, record.launchId, lookupIdentity),
      )
    : undefined;
}

function durableIdentity(
  ticketId: number,
  launchId: string | undefined,
  lookup: DurableSessionIdentityLookup | undefined,
): SessionIdentity | undefined {
  if (launchId === undefined || lookup === undefined) return undefined;
  let found: DurableSessionIdentity | undefined;
  try {
    found = lookup(launchId);
  } catch {
    return undefined;
  }
  if (found === undefined || found.ticketId !== ticketId) return undefined;
  return {
    provider: found.provider,
    model: found.model,
    ...(found.agentName !== undefined ? { agentName: found.agentName } : {}),
  };
}

/**
 * Record a launched terminal. Both the ticket and the pid are unique among live
 * terminals, so an earlier record matching either is stale by construction —
 * keeping it would let a dead session's pid claim a terminal the OS has since
 * given to a different process.
 */
export function rememberSessionTerminal(
  records: readonly SessionTerminalRecord[],
  record: SessionTerminalRecord,
): SessionTerminalRecord[] {
  const kept = records.filter(
    (r) => r.ticketId !== record.ticketId && r.pid !== record.pid,
  );
  return [...kept, record].slice(-MAX_SESSION_TERMINAL_RECORDS);
}

/** Drop a ticket's record — its terminal closed, so the pid is free again. */
export function forgetSessionTerminal(
  records: readonly SessionTerminalRecord[],
  ticketId: number,
): SessionTerminalRecord[] {
  return records.filter((r) => r.ticketId !== ticketId);
}

/**
 * Drop records for tickets this window can no longer act on (deleted, or from
 * another project). Cheap boot-time hygiene: a record only ever matches a live
 * pid, but the fewer stale ones survive, the smaller the pid-reuse window.
 */
export function pruneSessionTerminals(
  records: readonly SessionTerminalRecord[],
  knownTicketIds: Iterable<number>,
): SessionTerminalRecord[] {
  const known = new Set(knownTicketIds);
  return records.filter((r) => known.has(r.ticketId));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validate persisted state at the boundary. Anything that is not a usable
 * ticket/pid pair is dropped rather than coerced — a bad record would attach a
 * live agent terminal to the wrong ticket.
 */
export function parseSessionTerminalRecords(raw: unknown): SessionTerminalRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTerminalRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ticketId, pid, launchId, identity: rawIdentity } = entry as Record<string, unknown>;
    if (!isPositiveInt(ticketId) || !isPositiveInt(pid)) continue;
    if (launchId !== undefined && typeof launchId !== 'string') continue;
    const sessionIdentity = parseSessionIdentity(rawIdentity);
    out.push({
      ticketId,
      pid,
      ...(typeof launchId === 'string' && launchId.length > 0 ? { launchId } : {}),
      ...(sessionIdentity ? { identity: sessionIdentity } : {}),
    });
  }
  return out;
}

function parseSessionIdentity(raw: unknown): SessionIdentity | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { provider, model, agentName } = raw as Record<string, unknown>;
  if (typeof provider !== 'string' || provider.length === 0) return undefined;
  if (model !== null && typeof model !== 'string') return undefined;
  if (agentName !== undefined && agentName !== null && typeof agentName !== 'string') {
    return undefined;
  }
  return {
    provider,
    model,
    ...(agentName !== undefined ? { agentName: agentName as string | null } : {}),
  };
}
