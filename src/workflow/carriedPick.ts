import type { Store } from '../store/db.js';
import type { AgentProvider } from '../manifest/types.js';
import type { DriveProcessBundle } from '../agent/processAssignment.js';
import type { CarriedPickInput, UsageLimitParkRow } from '../store/usageLimitParks.js';
import { resolveCarriedPick } from '../store/usageLimitParks.js';
import { tightestWindow, type QuotaSnapshot } from '../agent/quota/types.js';
import { agentSwitchCoreChoices } from '../agent/sessionSwitch.js';

/**
 * The opt-in carried usage-limit pick (T1313, @arch:AC-65).
 *
 * A pick stays one-shot unless the operator chooses "Use for this ticket until
 * the limit resets". Then the claimed park row carries the picked core/model
 * until `carry_until`, and the headless UAT tester and review findings lanes
 * of the same ticket run on it while their role still resolves to the parked
 * (exhausted) provider. Nothing is written to Settings, the ticket row or a role.
 */

/** The carry window when no reset instant is known: 5 hours (the claude/agy session window). */
export const DEFAULT_CARRY_WINDOW_MS = 5 * 3_600_000;

/** The headless lanes a carry applies to. The fix lane and the ship description stay one-shot. */
export type CarryLaneRole = 'uat-tester' | 'review';

function futureIso(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) || at <= now.getTime() ? null : new Date(at).toISOString();
}

/**
 * The reset instant of a core's tightest still-open quota window, from the
 * quota module's snapshot; null when the core is unknown or names no reset.
 */
export function quotaResetAt(snapshot: QuotaSnapshot | undefined, now: Date): string | null {
  if (!snapshot) return null;
  return futureIso(tightestWindow(snapshot, now)?.resetsAt, now);
}

/**
 * The instant a carry made at `now` ends: the park's parsed `reset_at` when it
 * is ahead, else the quota module's window reset when it is ahead, else `now +
 * DEFAULT_CARRY_WINDOW_MS`. The pick dialog shows this value and the claim
 * stores the same value.
 */
export function carryUntilFor(input: {
  resetAt: string | null;
  quotaResetAt?: string | null;
  now: Date;
}): string {
  return (
    futureIso(input.resetAt, input.now) ??
    futureIso(input.quotaResetAt, input.now) ??
    new Date(input.now.getTime() + DEFAULT_CARRY_WINDOW_MS).toISOString()
  );
}

/** `HH:MM` in local time, with the date when it is not today. */
export function formatCarryTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString()
    ? clock
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** The pick dialog's third step: one-shot (the default, first) or carry until the reset. */
export interface CarryChoice {
  label: string;
  description?: string;
  carry: boolean;
}

export function carryChoices(untilIso: string, now: Date): CarryChoice[] {
  return [
    { label: 'Only this run', description: 'One-shot: the next lane resolves its role again', carry: false },
    {
      label: `Use for this ticket until the limit resets (${formatCarryTime(untilIso, now)})`,
      description: 'Headless UAT and review lanes on the exhausted core use this pick',
      carry: true,
    },
  ];
}

/** The Activity title and debug text a lane writes when it runs on a carry. */
export function carriedPickActivity(park: UsageLimitParkRow, now: Date): string {
  return `used ${carryTarget(park)} from the usage-limit pick until ${formatCarryTime(park.carryUntil ?? '', now)}`;
}

/** `<provider>/<model>` of a carry, or the provider alone when the pick named no model. */
export function carryTarget(park: Pick<UsageLimitParkRow, 'carryProvider' | 'carryModel'>): string {
  return `${park.carryProvider}${park.carryModel ? `/${park.carryModel}` : ''}`;
}

/** The carry step's seams (@arch:AC-65), shared by the dashboard and the ticket form. */
export interface CarryPickDeps {
  /**
   * The third step: "Only this run" (the default, first) or "Use for this
   * ticket until the limit resets (<time>)". Undefined = cancelled. Absent →
   * no third step: the pick is one-shot.
   */
  pickCarry?: (items: CarryChoice[]) => Promise<CarryChoice | undefined>;
  /** The quota module's reset instant for a core, when it has one. */
  quotaResetFor?: (provider: string) => string | null;
  /** Injectable clock; defaults to the wall clock. */
  now?: () => Date;
}

/**
 * Ask the carry step for a park. Returns `null` for one-shot, the carry to
 * write for "Use for this ticket…", or `undefined` when the user cancelled.
 * The time the dialog shows is the time the claim stores.
 */
export async function askCarry(
  deps: CarryPickDeps,
  park: UsageLimitParkRow,
  picked: { provider: AgentProvider; model: string | null },
): Promise<CarriedPickInput | null | undefined> {
  if (!deps.pickCarry) return null;
  const now = deps.now?.() ?? new Date();
  const until = carryUntilFor({
    resetAt: park.resetAt,
    quotaResetAt: deps.quotaResetFor?.(park.provider) ?? null,
    now,
  });
  const choice = await deps.pickCarry(carryChoices(until, now));
  if (!choice) return undefined;
  return choice.carry ? { provider: picked.provider, model: picked.model, until } : null;
}

/** True for a known agent-core id (the carry columns are TEXT). */
export function isAgentProvider(value: string | null): value is AgentProvider {
  return value !== null && agentSwitchCoreChoices().some((c) => c.id === value);
}

export interface LaneProcessInput {
  store: Store;
  ticketId: number;
  role: CarryLaneRole;
  now: Date;
  /**
   * The role's resolved provider, read WITHOUT building an adapter. Absent →
   * the carry is never consulted (a host without the seam runs as before).
   */
  laneProvider?: (ticketId: number, role: CarryLaneRole) => string | null;
  /**
   * The role's process bundle, built ONCE: with no override for the role's own
   * core, or with the carried `{provider, model}` (assignment resolved for that
   * one run, as the park re-run, @arch:AC-50).
   */
  resolve: (override?: { provider: AgentProvider; model: string | null }) => DriveProcessBundle | null;
  debug?: (message: string) => void;
  /** One Activity entry when the lane runs on a carry. */
  activity?: (ticketId: number, title: string) => void;
}

/**
 * The lane guard (@arch:AC-65): before a headless UAT tester or review findings
 * lane builds its adapter, look for a carried pick on the lane's resolved
 * provider. Found → the lane's one bundle is built on the carried core/model;
 * else the role's own bundle. A disabled role (null) stays disabled.
 */
export function resolveLaneProcess(input: LaneProcessInput): DriveProcessBundle | null {
  const provider = input.laneProvider?.(input.ticketId, input.role) ?? null;
  const carry = provider === null ? null : resolveCarriedPick(input.store, input.ticketId, provider, input.now);
  if (carry === null || !isAgentProvider(carry.carryProvider)) return input.resolve();
  const bundle = input.resolve({ provider: carry.carryProvider, model: carry.carryModel });
  if (bundle === null) return null;
  const text = carriedPickActivity(carry, input.now);
  input.debug?.(`[driver] ticket ${input.ticketId} ${input.role}: ${text} (park ${carry.id}, parked on ${carry.provider})`);
  input.activity?.(input.ticketId, text);
  return bundle;
}
