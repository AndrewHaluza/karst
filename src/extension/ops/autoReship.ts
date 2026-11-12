import type { Store } from '../../store/db.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import type { ShipPreview } from '../../workflow/shipPreview.js';
import { postAutopilotNote } from './autopilotWiring.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { clearCiRound, effectiveAutopilot, getAutopilotBudget, getAutopilotTicket, getCiRoundAt, listAutopilotBudgets } from '../../store/autopilot.js';

/**
 * Auto re-ship after an Autopilot CI round (T1095, @arch:AP-00). A CI round hands the ticket to Implement; uat and review pass
 * again and the driver then stops at the ship boundary (`ship-confirm`). When the PRs already exist, nothing outward is
 * opened by a re-ship, so Autopilot runs ship without the Confirm click. A first ship (no open PR) always keeps the click.
 * `vscode`-free: the ship saga, the preview and the controller test are injected.
 */

const LOG = '[ship] autopilot';

/** Ship options of an auto re-ship: push to the open PRs (the delivery branch). */
export const RESHIP_SHIP_OPTS = { deliver: true } as const;

export interface AutoReshipDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly config: () => AutopilotConfig | undefined;
  /** This window controls the ticket (@arch:AC-37). */
  readonly controls: () => boolean;
  /** The same read-only facts the dashboard's Ship preview shows (@arch:SHIP-PREVIEW). */
  readonly preview: () => Promise<ShipPreview>;
  /** The normal ship saga (every ship guard and the pre-push base check apply). */
  readonly ship: (opts: typeof RESHIP_SHIP_OPTS) => Promise<void>;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
}

export type AutoReshipResult =
  | { readonly kind: 'shipped'; readonly used: number; readonly max: number }
  /** The ticket waits for the Confirm click, as without the feature. */
  | { readonly kind: 'waits'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** Tickets with an auto re-ship in this process: a second drive must not start another one. */
const inFlight = new Set<string>();

/**
 * True when every repo that ship would push has an open current PR. A repo is pushed when its sweep commit carries files or its
 * branch holds a change from base; a repo with neither is untouched. A blocked or unreadable repo, and a ticket with no open
 * PR at all, wait for a person.
 */
export function reshipBlocker(preview: ShipPreview): string | null {
  if (!preview.repos.some((r) => r.prNumber !== null)) return 'no open PR: a first ship needs the Confirm click';
  for (const r of preview.repos) {
    if (r.error !== undefined) return `the ship preview of ${r.repo} failed`;
    if (r.status === 'blocked') return `ship would park ${r.repo}`;
    const pushed = r.status === 'will-commit' || r.commitFiles.length > 0 || r.changedFromBase;
    if (r.status === 'already-merged') continue;
    if (pushed && r.prNumber === null) return `${r.repo} has no open PR: a new PR needs the Confirm click`;
  }
  return null;
}

/** The ci round count for the note: the highest attempt used on any repo against the allowlist budget. */
function roundOf(d: AutoReshipDeps, cfg: AutopilotConfig): { used: number; max: number } {
  let used = 0;
  let extra = 0;
  for (const b of listAutopilotBudgets(d.store, d.ticketId).filter((x) => x.kind === 'ci')) {
    const budget = getAutopilotBudget(d.store, d.ticketId, b.repo, 'ci');
    used = Math.max(used, budget.attempts);
    extra = Math.max(extra, budget.extra);
  }
  return { used, max: cfg.ci.maxAttempts + extra };
}

/** Policy part of the decision: a reason to wait, or null. The mark is read here; nothing is written. */
function waitReason(d: AutoReshipDeps, cfg: AutopilotConfig | undefined): string | null {
  if (!cfg) return 'no autopilot config';
  if (getCiRoundAt(d.store, d.ticketId) === null) return 'no ci round was sent';
  const ticket = getTicket(d.store, d.ticketId);
  if (ticket.stageCurrent !== 'ship') return 'the ticket is not at ship';
  if (!effectiveAutopilot(d.store, d.ticketId, cfg.enabled)) return 'autopilot is off';
  const state = getAutopilotTicket(d.store, d.ticketId);
  if (state.stopAfter || state.pausedReason !== null || state.stoppedReason !== null || ticket.pausedAt !== null) return 'the ticket is paused or stopped';
  if (stageBlock(d.store, d.ticketId, 'ship') !== null) return 'the ship stage has a block';
  if (getStage(d.store, d.ticketId, 'ship')?.status === 'running') return 'a ship is running';
  if (!d.controls()) return 'another window controls the ticket';
  return null;
}

/**
 * Called when the driver stopped at `ship-confirm`. Runs ship without the click only after a CI round the engine sent and only
 * when every repo ship would push has an open PR. The mark is cleared BEFORE ship starts, so one round gives one re-ship.
 */
export async function autoReship(d: AutoReshipDeps): Promise<AutoReshipResult> {
  const cfg = d.config();
  const wait = (reason: string): AutoReshipResult => {
    // A ticket that never had a round is the normal Confirm wait: no line.
    if (getCiRoundAt(d.store, d.ticketId) !== null) d.debug(`${LOG} ticket ${d.key}: no automatic re-ship, ${reason}`);
    return { kind: 'waits', reason };
  };
  const policy = waitReason(d, cfg);
  if (policy !== null) return wait(policy);
  const flight = `${d.store.db.name}:${d.ticketId}`;
  if (inFlight.has(flight)) return wait('an automatic re-ship is running');
  inFlight.add(flight);
  try {
    let blocker: string | null;
    try {
      blocker = reshipBlocker(await d.preview());
    } catch (err) {
      blocker = `the ship preview failed (${err instanceof Error ? err.message : String(err)})`;
    }
    if (blocker !== null) return wait(blocker);
    // The preview awaited: re-read the policy, a pause or a Stop may have landed meanwhile.
    const again = waitReason(d, cfg);
    if (again !== null) return wait(again);
    const { used, max } = roundOf(d, cfg!);
    // One UPDATE takes the mark: of two windows that reach here, only one finds it set.
    if (!clearCiRound(d.store, d.ticketId)) return wait('another window took the re-ship');
    d.note(`Autopilot: re-shipped after ci round ${used}/${max}`, `${d.key}: ship ran without the Confirm click; every PR it pushes to is already open.`);
    d.debug(`${LOG} ticket ${d.key}: re-ship after ci round ${used}/${max}`);
    try {
      await d.ship(RESHIP_SHIP_OPTS);
    } catch (err) {
      // The saga records its own park; the ticket then waits for Retry, as after a click. The mark is already spent.
      const reason = err instanceof Error ? err.message : String(err);
      d.debug(`${LOG} ticket ${d.key}: re-ship failed: ${reason}`);
      return { kind: 'failed', reason };
    }
    return { kind: 'shipped', used, max };
  } finally {
    inFlight.delete(flight);
  }
}

/** The part of a driver outcome that tells the driver stopped at the ship boundary. */
export interface DriveOutcomeLike {
  readonly stage: string;
  readonly status: string;
  readonly reason?: string;
}

export interface ReshipHost extends Omit<AutoReshipDeps, 'note'> {
  readonly projectId: () => number | undefined;
  readonly warn: (message: string) => void;
  readonly error: (message: string, e: unknown) => void;
}

/** Binding entry: run `autoReship` only when the driver stopped at `ship-confirm`. Never throws. */
export async function reshipAtShipConfirm(outcome: DriveOutcomeLike | null, h: ReshipHost): Promise<void> {
  if (outcome?.stage !== 'ship' || outcome.status !== 'blocked' || outcome.reason !== 'ship-confirm') return;
  try {
    const note = (title: string, body: string): void => {
      const pid = h.projectId();
      if (pid !== undefined) postAutopilotNote(h.store, pid, h.ticketId, title, body, h.debug);
    };
    const result = await autoReship({ ...h, note });
    if (result.kind === 'failed') h.warn(`${LOG} ticket ${h.key}: re-ship failed: ${result.reason}`);
  } catch (e) {
    h.error('autopilot re-ship failed', e);
  }
}
