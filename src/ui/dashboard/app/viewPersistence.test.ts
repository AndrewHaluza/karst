import { describe, expect, it, vi } from 'vitest';
import type { HostMessage } from '../messages.js';
import type { DashboardState } from '../state.js';
import { readPersisted, ViewPersistence } from './viewPersistence.js';

const snap = (id: number): DashboardState => ({ ticketId: id, ticket: { id } }) as unknown as DashboardState;
const push = (state: DashboardState, extra: Record<string, unknown> = {}): HostMessage => ({ type: 'state', state, ...extra }) as HostMessage;
const FRESH_SCROLLS = { ticket: 0, index: 0, detail: {} };

/**
 * What the retired page script wrote with `vscode.setState` (envelope) and what an older build wrote before the
 * envelope existed (the bare snapshot). Both are literals on purpose: the shapes are the upgrade contract.
 */
const OLD_ENVELOPE = {
  state: snap(7),
  sel: 'review',
  shipWait: '7:confirm',
  srvFilter: 'svc-3',
  artView: { id: 'plan', from: 'index' },
  artScrolls: { ticket: 300, index: 40, detail: { plan: 900 } },
};

describe('readPersisted — the shape the old page wrote', () => {
  it('reads the whole envelope', () => {
    expect(readPersisted(OLD_ENVELOPE)).toEqual({
      state: snap(7),
      sel: 'review',
      shipWait: '7:confirm',
      srvFilter: 'svc-3',
      art: { id: 'plan', from: 'index' },
      scrolls: { ticket: 300, index: 40, detail: { plan: 900 } },
    });
  });

  it('reads the pre-envelope shape, a bare snapshot, as the state with no view state', () => {
    expect(readPersisted(snap(9))).toEqual({ state: snap(9), sel: null, shipWait: null, srvFilter: '', art: null, scrolls: FRESH_SCROLLS });
  });

  it('reads an envelope from before the artifact view existed (no artView, no artScrolls, no filter)', () => {
    const old = { state: snap(7), sel: 'uat', shipWait: null };
    expect(readPersisted(old)).toEqual({ state: snap(7), sel: 'uat', shipWait: null, srvFilter: '', art: null, scrolls: FRESH_SCROLLS });
  });

  it('keeps the view state of an envelope that holds no snapshot yet, and never mistakes it for a snapshot', () => {
    expect(readPersisted({ state: null, sel: null, shipWait: null, srvFilter: 'x', artView: null, artScrolls: FRESH_SCROLLS })).toEqual({
      state: null,
      sel: null,
      shipWait: null,
      srvFilter: 'x',
      art: null,
      scrolls: FRESH_SCROLLS,
    });
    expect(readPersisted({ srvFilter: 'x' }).state).toBeNull();
  });

  it('restores an artifact view only beside a snapshot (an envelope without one has nothing to show it over)', () => {
    expect(readPersisted({ state: null, artView: 'index' }).art).toBeNull();
    expect(readPersisted({ state: snap(1), artView: 'index' }).art).toBe('index');
  });

  it('tolerates garbage field by field', () => {
    expect(readPersisted({ state: snap(1), sel: 42, shipWait: '', srvFilter: 5, artView: 42, artScrolls: null })).toEqual({
      state: snap(1),
      sel: null,
      shipWait: null,
      srvFilter: '',
      art: null,
      scrolls: FRESH_SCROLLS,
    });
  });

  it.each([[null], [undefined], ['text'], [7], [true]])('reads %s as nothing persisted', (raw) => {
    expect(readPersisted(raw)).toEqual({ state: null, sel: null, shipWait: null, srvFilter: '', art: null, scrolls: FRESH_SCROLLS });
  });
});

describe('ViewPersistence — what is written, and when', () => {
  const make = (raw: unknown = null) => {
    const write = vi.fn();
    return { write, vp: new ViewPersistence(write, readPersisted(raw)) };
  };

  it('writes the exact envelope the old page wrote after a pushed snapshot', () => {
    const { vp, write } = make();
    vp.receive(push(snap(7)));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ state: snap(7), sel: null, shipWait: null, srvFilter: '', artView: null, artScrolls: FRESH_SCROLLS });
  });

  it('writes the restored view state back unchanged on the next push', () => {
    const { vp, write } = make(OLD_ENVELOPE);
    vp.receive(push(snap(8)));
    expect(write).toHaveBeenCalledWith({ ...OLD_ENVELOPE, state: snap(8) });
  });

  it('upgrades a bare snapshot into the envelope on the next push', () => {
    const { vp, write } = make(snap(9));
    vp.receive(push(snap(9)));
    expect(write).toHaveBeenCalledWith({ state: snap(9), sel: null, shipWait: null, srvFilter: '', artView: null, artScrolls: FRESH_SCROLLS });
  });

  it('holds a live repaint without writing it, and the next write carries it', () => {
    const { vp, write } = make();
    vp.receive(push(snap(1), { live: true }));
    expect(write).not.toHaveBeenCalled();
    vp.filter('x');
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ state: snap(1), srvFilter: 'x' }));
  });

  it('writes a push whose live flag is false', () => {
    const { vp, write } = make();
    vp.receive(push(snap(1), { live: false }));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['worktree-stats', { stats: [] }],
    ['clocks', { clocks: {} }],
    ['bind', { enabled: true }],
    ['action-result', { requestId: 'r', ok: true }],
  ])('ignores a %s message', (type, rest) => {
    const { vp, write } = make(OLD_ENVELOPE);
    vp.receive({ type, ...rest } as unknown as HostMessage);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes a selection only once a snapshot is held', () => {
    const { vp, write } = make();
    vp.selection({ sel: 'uat', shipWait: null });
    expect(write).not.toHaveBeenCalled();
    vp.receive(push(snap(1)));
    write.mockClear();
    vp.selection({ sel: 'uat', shipWait: '1:confirm' });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ sel: 'uat', shipWait: '1:confirm' }));
  });

  it('keeps a selection announced before the first snapshot for the first write', () => {
    const { vp, write } = make();
    vp.selection({ sel: 'uat', shipWait: null });
    vp.receive(push(snap(1)));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ sel: 'uat' }));
  });

  it('writes a restored snapshot beside a selection announced at once (the restore itself writes nothing)', () => {
    const { vp, write } = make(OLD_ENVELOPE);
    expect(write).not.toHaveBeenCalled();
    vp.selection({ sel: null, shipWait: OLD_ENVELOPE.shipWait });
    expect(write).toHaveBeenCalledWith({ ...OLD_ENVELOPE, sel: null });
  });

  it('writes a filter change even before any snapshot, as the old page did', () => {
    const { vp, write } = make();
    vp.filter('abc');
    expect(write).toHaveBeenCalledWith({ state: null, sel: null, shipWait: null, srvFilter: 'abc', artView: null, artScrolls: FRESH_SCROLLS });
  });

  it('writes an artifact view change even before any snapshot, with its own copy of the scrolls', () => {
    const { vp, write } = make();
    const scrolls = { ticket: 5, index: 0, detail: {} };
    vp.art({ artView: 'index', artScrolls: scrolls });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ artView: 'index', artScrolls: scrolls }));
  });

  it('exposes the restored filter for the Servers panel to start from', () => {
    expect(make(OLD_ENVELOPE).vp.srvFilter).toBe('svc-3');
    expect(make().vp.srvFilter).toBe('');
    const { vp } = make();
    vp.filter('q');
    expect(vp.srvFilter).toBe('q');
  });
});
