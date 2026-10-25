// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { StageSelection, shownStage } from './stageSelection.js';

const stateOf = (ship: Record<string, unknown> | undefined, over: Record<string, unknown> = {}): DashboardState =>
  ({ ticketId: 7, stageCurrent: 'impl', presentedStage: 'impl', ship, ...over }) as unknown as DashboardState;
const push = (sel: StageSelection, state: DashboardState, extra: Record<string, unknown> = {}): void =>
  sel.receive({ type: 'state', state, ...extra } as HostMessage);

const persisted: unknown[] = [];
const record = (e: Event): void => {
  persisted.push((e as CustomEvent).detail);
};
window.addEventListener('karst:persistSel', record);
afterEach(() => {
  persisted.length = 0;
});

describe('StageSelection', () => {
  it('starts from the persisted selection and wait, or from nothing', () => {
    expect(new StageSelection({ sel: 'uat', shipWait: null }, null).getSnapshot().selected).toBe('uat');
    expect(new StageSelection({ sel: null, shipWait: null }, null).getSnapshot().selected).toBeNull();
  });

  it('a pick selects the stage, bumps the epoch, notifies and asks the page to persist it', () => {
    const sel = new StageSelection({ sel: null, shipWait: 'k' }, null);
    const seen = vi.fn();
    sel.subscribe(seen);
    const before = sel.getSnapshot();
    sel.select('review');
    expect(sel.getSnapshot()).toEqual({ selected: 'review', epoch: before.epoch + 1 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([{ sel: 'review', shipWait: 'k' }]);
  });

  it('picking the same stage again still bumps the epoch (it closes an open stage menu)', () => {
    const sel = new StageSelection({ sel: 'ship', shipWait: null }, null);
    const e = sel.getSnapshot().epoch;
    sel.select('ship');
    expect(sel.getSnapshot().epoch).toBe(e + 1);
  });

  it('Back clears the selection so the strip follows the ticket again', () => {
    const sel = new StageSelection({ sel: 'uat', shipWait: null }, null);
    sel.select(null);
    expect(sel.getSnapshot().selected).toBeNull();
    expect(persisted).toEqual([{ sel: null, shipWait: null }]);
  });

  it('stops notifying a subscriber that left', () => {
    const sel = new StageSelection({ sel: null, shipWait: null }, null);
    const seen = vi.fn();
    sel.subscribe(seen)();
    sel.select('uat');
    expect(seen).not.toHaveBeenCalled();
  });

  describe('the one-time auto-select of Ship (D234)', () => {
    it('a new confirm wait selects Ship once, records the wait and persists both', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'confirm' }));
      expect(sel.getSnapshot().selected).toBe('ship');
      expect(persisted).toEqual([{ sel: 'ship', shipWait: '7:confirm' }]);
    });

    it('leaves the user where they navigated while the same wait lasts, across pushes', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'confirm' }));
      sel.select('uat');
      push(sel, stateOf({ kind: 'confirm' }));
      push(sel, stateOf({ kind: 'confirm' }), { settlesActions: false });
      expect(sel.getSnapshot().selected).toBe('uat');
    });

    it('a wait restored from the persisted view state is not a new transition', () => {
      const sel = new StageSelection({ sel: 'uat', shipWait: '7:confirm' }, stateOf({ kind: 'confirm' }));
      expect(sel.getSnapshot().selected).toBe('uat');
      push(sel, stateOf({ kind: 'confirm' }));
      expect(sel.getSnapshot().selected).toBe('uat');
      expect(persisted).toEqual([]);
    });

    it('a wait already on screen at construction selects Ship without announcing (the page restored nothing yet)', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, stateOf({ kind: 'retry', reason: 'x' }));
      expect(sel.getSnapshot().selected).toBe('ship');
      expect(persisted).toEqual([]);
    });

    it('leaving the wait clears the record, so the next confirm (or a retry) selects Ship again', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'confirm' }));
      sel.select('uat');
      push(sel, stateOf({ kind: 'none' }));
      expect(persisted.at(-1)).toEqual({ sel: 'uat', shipWait: null });
      push(sel, stateOf({ kind: 'retry' }));
      expect(sel.getSnapshot().selected).toBe('ship');
      expect(persisted.at(-1)).toEqual({ sel: 'ship', shipWait: '7:retry' });
    });

    it('a different ticket with the same wait kind is a new transition', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'confirm' }));
      sel.select('uat');
      push(sel, stateOf({ kind: 'confirm' }, { ticketId: 8 }));
      expect(sel.getSnapshot().selected).toBe('ship');
    });

    it('other slots (waiting-merge, none, absent) never select', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'waiting-merge', repos: 1 }));
      push(sel, stateOf(undefined));
      expect(sel.getSnapshot().selected).toBeNull();
    });

    it('a live repaint is not a render: it neither selects nor persists', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      push(sel, stateOf({ kind: 'confirm' }), { live: true });
      expect(sel.getSnapshot().selected).toBeNull();
      expect(persisted).toEqual([]);
    });

    it('ignores messages that are not snapshots', () => {
      const sel = new StageSelection({ sel: null, shipWait: null }, null);
      sel.receive({ type: 'bind', enabled: true } as HostMessage);
      expect(persisted).toEqual([]);
    });
  });
});

describe('shownStage', () => {
  it('is the selection, else the presented stage, else the current one, else scope', () => {
    expect(shownStage('uat', { presentedStage: 'impl', stageCurrent: 'ship' })).toBe('uat');
    expect(shownStage(null, { presentedStage: 'impl', stageCurrent: 'ship' })).toBe('impl');
    expect(shownStage(null, { presentedStage: '', stageCurrent: 'ship' })).toBe('ship');
    expect(shownStage(null, { presentedStage: '', stageCurrent: '' })).toBe('scope');
  });
});
