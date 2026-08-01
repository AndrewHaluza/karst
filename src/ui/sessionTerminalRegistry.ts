import { KARST_LAUNCH_ENV, ticketIdFromTerminalEnv } from './session.js';

/**
 * What karst remembers about ONE launched session terminal, so the same terminal
 * can be recognised again after the extension host is replaced.
 *
 * Why this exists: a terminal's launch env was the only terminal→ticket link,
 * and it does not survive a window reload. VS Code reconnects a persisted
 * terminal by handing the workbench an `attachPersistentProcess` descriptor and
 * copying only `hideFromUser`, `isFeatureTerminal`, `type`, `tabActions`, icon,
 * color and `waitOnExit` onto the revived launch config — `env` (and `cwd`, and
 * the executable) are simply gone, so `creationOptions.env` reads `undefined`
 * for every karst terminal after a reload. Nothing was ever adopted, the session
 * map stayed empty, and a failed gate's fix nudge therefore found no live
 * session and launched a SECOND agent beside the one still sitting at its prompt
 * (869ecmk6v). The terminal's TITLE does survive that reconnect, so karst
 * records the title it minted and matches on that.
 *
 * The `launchId` rides along for the same reason: adopting a terminal with no
 * generation quarantines its hooks (`SessionRecoveryLifecycle.adoptLaunch`), so
 * the live session would go dark even once it was found again.
 */
export interface SessionTerminalRecord {
  ticketId: number;
  /** The terminal title karst created this session with (`Terminal.name`). */
  name: string;
  /** Hook generation captured at launch; absent for a legacy record. */
  launchId?: string;
}

/** A terminal as the identity check sees it: its env (if any) and its title. */
export interface RestoredTerminalIdentity {
  env?: Readonly<Record<string, string | undefined>> | undefined;
  name: string;
}

/** The ticket a restored terminal belongs to, and the generation it launched with. */
export interface ResolvedRestoredSession {
  ticketId: number;
  launchId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read back persisted records. Storage is untrusted input like any other
 * boundary — a malformed entry is DROPPED rather than coerced, because a bad
 * ticket id here would hand one ticket's fix brief to another ticket's agent.
 */
export function parseSessionTerminalRecords(raw: unknown): SessionTerminalRecord[] {
  if (!Array.isArray(raw)) return [];
  const byTicket = new Map<number, SessionTerminalRecord>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { ticketId, name, launchId } = entry;
    if (typeof ticketId !== 'number' || !Number.isInteger(ticketId) || ticketId <= 0) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    byTicket.set(ticketId, {
      ticketId,
      name,
      // One live terminal per ticket, so a repeat is a relaunch: last wins.
      ...(typeof launchId === 'string' && launchId.length > 0 ? { launchId } : {}),
    });
  }
  return [...byTicket.values()];
}

/** Record a freshly launched terminal, replacing whatever the ticket had before. */
export function rememberSessionTerminal(
  records: readonly SessionTerminalRecord[],
  record: SessionTerminalRecord,
): SessionTerminalRecord[] {
  return [...records.filter((held) => held.ticketId !== record.ticketId), record];
}

/**
 * Drop a ticket's record when ITS generation closed. A retired generation can
 * close long after its replacement launched; evicting on that late event would
 * lose the live terminal's identity for the rest of the window's life.
 */
export function forgetSessionTerminal(
  records: readonly SessionTerminalRecord[],
  ticketId: number,
  launchId: string | undefined,
): SessionTerminalRecord[] {
  return records.filter(
    (held) =>
      held.ticketId !== ticketId ||
      (held.launchId !== undefined && held.launchId !== launchId),
  );
}

/**
 * Resolve a terminal the host reports to the ticket that owns it. The launch env
 * wins whenever the host still has one — it is exact, and it covers every
 * terminal this extension host created itself. The recorded title is the
 * fallback for a terminal VS Code revived across a reload, and it must be
 * UNAMBIGUOUS: two tickets whose templates render the same title resolve to
 * neither, because adopting the wrong terminal would type one ticket's brief
 * into another ticket's agent.
 */
export function resolveRestoredSession(
  terminal: RestoredTerminalIdentity,
  records: readonly SessionTerminalRecord[],
): ResolvedRestoredSession | undefined {
  const tagged = ticketIdFromTerminalEnv(terminal.env);
  if (tagged !== undefined) {
    const launchId = terminal.env?.[KARST_LAUNCH_ENV];
    return {
      ticketId: tagged,
      ...(typeof launchId === 'string' && launchId.length > 0 ? { launchId } : {}),
    };
  }
  if (terminal.name.length === 0) return undefined;
  const claimed = records.filter((record) => record.name === terminal.name);
  const only = claimed.length === 1 ? claimed[0]! : undefined;
  if (!only) return undefined;
  return {
    ticketId: only.ticketId,
    ...(only.launchId ? { launchId: only.launchId } : {}),
  };
}
