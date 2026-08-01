import { KARST_LAUNCH_ENV, ticketIdFromTerminalEnv } from './session.js';

/**
 * What this window remembers about one terminal it launched, so the terminal can
 * still be recognized after an IDE reload.
 *
 * Why a registry exists at all: `KARST_TICKET_ID` in the launch environment is
 * the terminal→ticket link only while the handle that created it lives. VS Code
 * revives a persisted terminal by reattaching to its process — the instance is
 * recreated from `{ attachPersistentProcess }` alone, so the ext-host handle it
 * reports carries NO `creationOptions.env`. Every env-based lookup therefore
 * answers "not a karst terminal" for exactly the sessions that are still
 * running, and recovery launches a second agent beside each of them.
 *
 * The NAME is what survives: a terminal created with an explicit `name` keeps it
 * as its static title (it outranks anything the agent process sets), and the
 * title is persisted with the process and restored with it. So the name is the
 * durable link — provided this window wrote down which ticket it launched under
 * which name, which is what this registry is.
 */
export interface TerminalTag {
  readonly ticketId: number;
  /** The exact name the terminal was created with. */
  readonly name: string;
  /** Hook generation, so an adopted session's hooks are not quarantined. */
  readonly launchId?: string;
}

/** A terminal's karst identity, however it was resolved. */
export interface TerminalIdentity {
  readonly ticketId: number;
  readonly launchId?: string;
}

function isTag(value: unknown): value is TerminalTag {
  if (typeof value !== 'object' || value === null) return false;
  const tag = value as Record<string, unknown>;
  if (typeof tag['ticketId'] !== 'number' || !Number.isInteger(tag['ticketId'])) {
    return false;
  }
  if (tag['ticketId'] <= 0) return false;
  if (typeof tag['name'] !== 'string' || tag['name'].length === 0) return false;
  return tag['launchId'] === undefined || typeof tag['launchId'] === 'string';
}

/**
 * Narrow persisted state back to tags. `workspaceState` is external data on the
 * way back in — a malformed entry is dropped, never coerced, because the value
 * decides which ticket's prompts a terminal receives.
 */
export function parseTerminalTags(raw: unknown): TerminalTag[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTag).map((tag) => ({
    ticketId: tag.ticketId,
    name: tag.name,
    ...(tag.launchId !== undefined ? { launchId: tag.launchId } : {}),
  }));
}

/**
 * How many launches one window remembers. A close drops a tag, so this is only
 * reached when closes were missed (a crash, a terminal killed with the window);
 * the oldest go first, being the least likely to still have a terminal.
 */
export const MAX_TERMINAL_TAGS = 128;

/**
 * Record a launch. Any earlier tag for the same ticket OR the same name is
 * replaced: a ticket has one live terminal, and a name identifies one terminal,
 * so keeping either stale entry would let a later lookup resolve to a tab that
 * no longer exists.
 */
export function rememberTerminalTag(
  tags: readonly TerminalTag[],
  tag: TerminalTag,
): TerminalTag[] {
  const kept = [
    ...tags.filter(
      (existing) => existing.ticketId !== tag.ticketId && existing.name !== tag.name,
    ),
    tag,
  ];
  return kept.length > MAX_TERMINAL_TAGS
    ? kept.slice(kept.length - MAX_TERMINAL_TAGS)
    : kept;
}

/** Drop the tag of a terminal that has closed. */
export function forgetTerminalTagByName(
  tags: readonly TerminalTag[],
  name: string,
): TerminalTag[] {
  const kept = tags.filter((tag) => tag.name !== name);
  return kept.length === tags.length ? (tags as TerminalTag[]) : kept;
}

/**
 * Resolve a terminal's ticket. The launch environment is preferred — it is
 * first-hand evidence and needs no registry — and the remembered name is the
 * fallback that survives a reload. A name two tickets both claim resolves to
 * nothing: adoption feeds the terminal a ticket's prompts, so a guess is worse
 * than the duplicate it would have avoided.
 */
export function terminalIdentity(
  env: Readonly<Record<string, string | undefined>> | undefined,
  name: string | undefined,
  tags: readonly TerminalTag[],
): TerminalIdentity | undefined {
  const ticketId = ticketIdFromTerminalEnv(env);
  if (ticketId !== undefined) {
    const launchId = env?.[KARST_LAUNCH_ENV];
    return {
      ticketId,
      ...(typeof launchId === 'string' && launchId.length > 0 ? { launchId } : {}),
    };
  }
  if (name === undefined) return undefined;
  const matches = tags.filter((tag) => tag.name === name);
  const only = matches.length === 1 ? matches[0]! : undefined;
  if (!only) return undefined;
  return {
    ticketId: only.ticketId,
    ...(only.launchId !== undefined ? { launchId: only.launchId } : {}),
  };
}
