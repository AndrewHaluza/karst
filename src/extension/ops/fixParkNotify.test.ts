import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openRecoveryRound } from '../../store/recoveryRounds.js';
import { upsertProject } from '../../store/projects.js';
import { setStage } from '../../store/stages.js';
import { setStageCurrent } from '../../store/tickets.js';
import { fixParkStoppedText } from '../../model/notifyText.js';
import type { Notify } from './notify.js';
import { makeFixParkNotifier } from './fixParkNotify.js';
import { PARK_NO_CHANGE_RERUN_FAILED, PARK_NO_NEW_COMMIT_RERUN_FAILED } from '../../workflow/fixHostRerun.js';

const AT = '2026-01-01T00:00:00Z';
const NO_CHANGE_PARK = `${PARK_NO_CHANGE_RERUN_FAILED} — still fails — unit (web): x. the way out`;
const SAME_HEAD_PARK = 'second no-change verdict on the same head (no change: again) — the way out';

describe('makeFixParkNotifier', () => {
  let store: Store;
  let projectId: number;
  let notify: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let labelOf: (ticketId: number) => string;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    labelOf = (ticketId) => `T${ticketId} "Fix"`;
  });

  const notifier = (): (() => void) =>
    makeFixParkNotifier({ store, projectId: () => projectId, notify: notify as unknown as Notify, labelOf });

  const ticket = (key = 'T-1'): number => createTicketFlow(store, { key, title: 'Fix', projectId }).id;

  /** Put a ticket at fix with one interrupted round and the given end reason. */
  const parked = (endReason: string, ticketId = ticket()): { ticketId: number; roundId: number } => {
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', startedAt: AT });
    return { ticketId, roundId: openParkedRound(ticketId, endReason) };
  };

  const openParkedRound = (ticketId: number, endReason: string, sourceStage: 'uat' | 'review' = 'uat'): number => {
    const id = openRecoveryRound(store, {
      ticketId,
      sourceStage,
      sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'interrupted', end_reason = ? WHERE id = ?").run(endReason, id);
    return id;
  };

  it('records the rounds of the first tick and shows no toast', () => {
    parked(NO_CHANGE_PARK);
    const tick = notifier();
    tick();
    tick();
    expect(notify.warn).not.toHaveBeenCalled();
  });

  it('shows one warning with the ticket id when a no-change re-run fails after the first tick', () => {
    parked(NO_CHANGE_PARK);
    const tick = notifier();
    tick();
    const later = parked(NO_CHANGE_PARK, ticket('T-2'));
    tick();
    expect(notify.warn).toHaveBeenCalledExactlyOnceWith(fixParkStoppedText(`T${later.ticketId} "Fix"`), later.ticketId);
  });

  it('shows one warning for a same-head park, and none on the next tick', () => {
    const tick = notifier();
    tick();
    const { ticketId } = parked(SAME_HEAD_PARK);
    tick();
    tick();
    expect(notify.warn).toHaveBeenCalledExactlyOnceWith(fixParkStoppedText(`T${ticketId} "Fix"`), ticketId);
  });

  it('shows none for a round parked before the first tick', () => {
    parked(NO_CHANGE_PARK);
    const tick = notifier();
    tick();
    tick();
    expect(notify.warn).not.toHaveBeenCalled();
  });

  it('shows none for an interrupted round with another end reason', () => {
    const tick = notifier();
    tick();
    parked('the host restarted during the re-run');
    tick();
    expect(notify.warn).not.toHaveBeenCalled();
  });

  it('shows another warning when a Retry fails again in a new round', () => {
    const { ticketId, roundId } = parked(NO_CHANGE_PARK);
    const tick = notifier();
    tick();
    openParkedRound(ticketId, `${PARK_NO_NEW_COMMIT_RERUN_FAILED} — still fails — unit (web): x. the way out`);
    tick();
    tick();
    expect(notify.warn).toHaveBeenCalledTimes(1);
    store.db.prepare("UPDATE recovery_rounds SET end_reason = ? WHERE id = ?").run('no change: the user retried the uat gate', roundId);
    const retry = openParkedRound(ticketId, NO_CHANGE_PARK);
    tick();
    expect(notify.warn).toHaveBeenCalledTimes(2);
    expect(notify.warn).toHaveBeenNthCalledWith(2, fixParkStoppedText(`T${ticketId} "Fix"`), ticketId);
    expect(retry).toBeGreaterThan(roundId);
  });

  it('does nothing without a project', () => {
    const tick = makeFixParkNotifier({ store, projectId: () => undefined, notify: notify as unknown as Notify, labelOf });
    tick();
    expect(notify.warn).not.toHaveBeenCalled();
  });
});
