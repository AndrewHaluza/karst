import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, archiveTicket } from '../../store/tickets.js';
import { TicketFormManager, restoredTicketFormIdentity } from './panel.js';
import type { TicketFormPanel, TicketFormPanelHost } from './panel.js';
import type { TicketFormActions } from './messages.js';
import type { RestoredPanel } from '../shared/restoredPanel.js';
import { manifest as buildManifest } from '../../manifest/fixtures.js';

interface FakePanel extends TicketFormPanel {
  posted: unknown[];
  title?: string;
  disposeHandler?: () => void;
}

function makePanel(): FakePanel {
  const panel: FakePanel = {
    posted: [],
    reveal: () => {},
    setIcon: () => {},
    setTitle: (t) => (panel.title = t),
    toWebviewUri: (p) => p,
    postMessage: (m) => panel.posted.push(m),
    onDidReceiveMessage: () => {},
    onDidChangeViewState: () => {},
    onDidDispose: (h) => (panel.disposeHandler = h),
    dispose: () => panel.disposeHandler?.(),
  };
  return panel;
}

/** A restored raw panel: `wrap` hands out the fake, `dispose` is recorded. */
function restored(): { restored: RestoredPanel<TicketFormPanel>; panel: FakePanel; wrapped: () => boolean; disposed: () => boolean } {
  const panel = makePanel();
  let wrapped = false;
  let disposed = false;
  return {
    panel,
    wrapped: () => wrapped,
    disposed: () => disposed,
    restored: {
      wrap: () => ((wrapped = true), panel),
      dispose: () => void (disposed = true),
    },
  };
}

const noActions = (): TicketFormActions => new Proxy({} as TicketFormActions, { get: () => () => {} });

describe('TicketFormManager.adopt', () => {
  let store: Store;
  let created: FakePanel[];
  let logs: string[];
  let mgr: TicketFormManager;
  const exists = (id: number): boolean => createdIds.has(id) && !archivedIds.has(id);
  const createdIds = new Set<number>();
  const archivedIds = new Set<number>();

  beforeEach(() => {
    store = openStore(':memory:');
    created = [];
    logs = [];
    createdIds.clear();
    archivedIds.clear();
    const host: TicketFormPanelHost = { createPanel: () => { const p = makePanel(); created.push(p); return p; } };
    mgr = new TicketFormManager(
      store, () => buildManifest({}, {}), host, noActions,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (m: string) => void logs.push(m),
    );
  });

  it('adopts a create form under a fresh sentinel key and pushes the normal state', () => {
    const a = restored();
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'create' } }, exists)).toBe(true);
    expect(a.wrapped()).toBe(true);
    expect(mgr.isCreateOpen()).toBe(true);
    expect((a.panel.posted[0] as { type: string }).type).toBe('state');
    // a second restored create form does not collide with the first
    const b = restored();
    expect(mgr.adopt(b.restored, { karstPanel: { mode: 'create' } }, exists)).toBe(true);
    expect(b.disposed()).toBe(false);
  });

  it('adopts an edit form under its ticket id, so openEdit reveals it instead of opening a second one', () => {
    const t = createTicket(store, { key: 'P-1', title: 'thing' });
    createdIds.add(t.id);
    const a = restored();
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(true);
    expect((a.panel.posted[0] as { state: { mode: string; ticketId: number } }).state).toMatchObject({ mode: 'edit', ticketId: t.id });
    mgr.openEdit(t.id);
    expect(created).toHaveLength(0);
    // closeTicket finds the adopted panel: ticketByPanel is consistent
    mgr.closeTicket(t.id);
    expect(mgr.adopt(restored().restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(true);
  });

  it('does not report an adopted edit form as the active view; a later focus change does', () => {
    const t = createTicket(store, { key: 'P-2', title: 'thing' });
    createdIds.add(t.id);
    const calls: Array<[number, boolean]> = [];
    // The report callback is a private constructor parameter; set it on the instance.
    (mgr as unknown as { onViewActivated: (id: number, active: boolean) => void }).onViewActivated =
      (id, active) => void calls.push([id, active]);
    const a = restored();
    let viewState: ((active: boolean) => void) | undefined;
    a.panel.onDidChangeViewState = (h) => { viewState = h; };
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(true);
    expect(calls).toEqual([]);
    viewState?.(true);
    expect(calls).toEqual([[t.id, true]]);
  });

  it('closes silently when the ticket is missing', () => {
    const a = restored();
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: 999 } }, exists)).toBe(false);
    expect(a.disposed()).toBe(true);
    expect(a.wrapped()).toBe(false);
    expect(logs.join('\n')).toContain('ticket 999 missing or archived');
  });

  it('closes silently when the ticket is archived', () => {
    const t = createTicket(store, { key: 'P-2', title: 'old' });
    createdIds.add(t.id);
    archiveTicket(store, t.id);
    archivedIds.add(t.id);
    const a = restored();
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(false);
    expect(a.disposed()).toBe(true);
  });

  it('closes silently when a form for that ticket is already open', () => {
    const t = createTicket(store, { key: 'P-3', title: 'dup' });
    createdIds.add(t.id);
    mgr.openEdit(t.id);
    const a = restored();
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(false);
    expect(a.disposed()).toBe(true);
    expect(a.wrapped()).toBe(false);
    expect(logs.join('\n')).toContain('already open');
  });

  it.each([undefined, null, 'x', {}, { karstPanel: null }, { karstPanel: { mode: 'edit' } }, { karstPanel: { mode: 'edit', ticketId: 0 } }, { karstPanel: { mode: 'edit', ticketId: 1.5 } }, { karstPanel: { mode: 'other' } }])(
    'closes silently on invalid state %j',
    (state) => {
      const a = restored();
      expect(mgr.adopt(a.restored, state, exists)).toBe(false);
      expect(a.disposed()).toBe(true);
      expect(logs.join('\n')).toContain('invalid saved state');
    },
  );

  it('reads the identity of a valid state', () => {
    expect(restoredTicketFormIdentity({ karstPanel: { mode: 'create' }, draft: { title: 'x' } })).toEqual({ mode: 'create', prefilled: false });
    expect(restoredTicketFormIdentity({ karstPanel: { mode: 'create', prefilled: true, draftId: 3, mintedTicketId: 8 } }))
      .toEqual({ mode: 'create', prefilled: true, draftId: 3, mintedTicketId: 8 });
    expect(restoredTicketFormIdentity({ karstPanel: { mode: 'create', prefilled: true, draftId: -1, mintedTicketId: 'x' } }))
      .toEqual({ mode: 'create', prefilled: true });
    expect(restoredTicketFormIdentity({ karstPanel: { mode: 'edit', ticketId: 4 } })).toEqual({ mode: 'edit', ticketId: 4 });
  });
  describe('proposal review form', () => {
    const prefill = { title: 'Fix', description: 'd', summary: 's', repos: [], draftId: 5, onCreated: () => {} };
    const state = (extra: Record<string, unknown> = {}) => ({ karstPanel: { mode: 'create', prefilled: true, draftId: 5, ...extra } });
    const pending = (id: number) => (id === 5 ? { status: 'pending' as const, ticketId: null } : undefined);
    const lookupPrefill = (id: number) => (id === 5 ? prefill : undefined);
    const mint = (key: string): number => {
      const row = createTicket(store, { key, title: 'Fix' });
      createdIds.add(row.id);
      return row.id;
    };
    const adoptPending = (r: ReturnType<typeof restored>, extra: Record<string, unknown> = {}): boolean =>
      mgr.adopt(r.restored, state(extra), exists, lookupPrefill, pending);

    it('re-links to its proposal: the form is adopted with the rebuilt prefill', () => {
      const r = restored();
      expect(adoptPending(r)).toBe(true);
      expect(r.wrapped()).toBe(true);
      const pushed = (r.panel.posted[0] as { state: { prefilled?: boolean; title: string } }).state;
      expect(pushed).toMatchObject({ prefilled: true, title: 'Fix' });
    });

    it('keeps the proposal link of a form that fetched a keyed draft row: Save still accepts the proposal', () => {
      const onCreated: number[] = [];
      const linked = { ...prefill, onCreated: (id: number) => void onCreated.push(id) };
      const rowId = mint('FETCHED-1');
      const r = restored();
      expect(mgr.adopt(r.restored, state({ mintedTicketId: rowId }), exists, () => linked, pending)).toBe(true);
      expect((r.panel.posted[0] as { state: { mode: string; ticketId: number; prefilled?: boolean } }).state)
        .toMatchObject({ mode: 'edit', ticketId: rowId, prefilled: true });
      // restore never deletes a row: another form may have saved it since the reload
      r.panel.dispose();
      expect(getTicket(store, rowId).id).toBe(rowId);
    });

    it('restores a saved proposal form as the edit form of its ticket and never deletes the ticket', () => {
      const rowId = mint('');
      const accepted = () => ({ status: 'accepted' as const, ticketId: rowId });
      const r = restored();
      // the saved identity is older than the save: it still names the draft and the minted row
      expect(mgr.adopt(r.restored, state({ mintedTicketId: rowId }), exists, () => undefined, accepted)).toBe(true);
      expect((r.panel.posted[0] as { state: { mode: string; ticketId: number } }).state).toMatchObject({ mode: 'edit', ticketId: rowId });
      r.panel.dispose();
      expect(getTicket(store, rowId).id).toBe(rowId);
      // a ticket that was archived since closes the tab and still deletes nothing
      archivedIds.add(rowId);
      const gone = restored();
      expect(mgr.adopt(gone.restored, state({ mintedTicketId: rowId }), exists, () => undefined, accepted)).toBe(false);
      expect(gone.disposed()).toBe(true);
      expect(getTicket(store, rowId).id).toBe(rowId);
    });

    it('closes a second restored form for a row that already has an open form', () => {
      const rowId = mint('FETCHED-2');
      const first = restored();
      expect(adoptPending(first, { mintedTicketId: rowId })).toBe(true);
      const second = restored();
      expect(adoptPending(second, { mintedTicketId: rowId })).toBe(false);
      expect(second.disposed()).toBe(true);
      expect(logs.join('\n')).toContain('already open');
      // the first form still owns the row
      expect(getTicket(store, rowId).id).toBe(rowId);
    });

    it('closes a second restored form for a draft that already has an open form', () => {
      const first = restored();
      expect(adoptPending(first)).toBe(true);
      const second = restored();
      expect(adoptPending(second)).toBe(false);
      expect(second.disposed()).toBe(true);
      // closing the first form frees the draft
      first.panel.dispose();
      expect(adoptPending(restored())).toBe(true);
    });

    it('keeps the row as an edit form when the proposal is no longer pending', () => {
      const rowId = mint('FETCHED-3');
      const r = restored();
      const discarded = () => ({ status: 'discarded' as const, ticketId: null });
      expect(mgr.adopt(r.restored, state({ mintedTicketId: rowId }), exists, () => undefined, discarded)).toBe(true);
      expect((r.panel.posted[0] as { state: { mode: string; ticketId: number } }).state).toMatchObject({ mode: 'edit', ticketId: rowId });
      r.panel.dispose();
      expect(getTicket(store, rowId).id).toBe(rowId);
    });

    it('closes when the proposal is gone and the form minted no row', () => {
      const r = restored();
      expect(mgr.adopt(r.restored, state(), exists, () => undefined, () => ({ status: 'discarded', ticketId: null }))).toBe(false);
      expect(r.disposed()).toBe(true);
      expect(logs.join('\n')).toContain('proposal of the review form is gone');
    });

    it('keeps the row when the store has no verdict on the proposal', () => {
      const rowId = mint('FETCHED-4');
      const r = restored();
      expect(mgr.adopt(r.restored, state({ mintedTicketId: rowId }), exists, () => undefined, () => undefined)).toBe(true);
      expect((r.panel.posted[0] as { state: { mode: string } }).state).toMatchObject({ mode: 'edit' });
      r.panel.dispose();
      expect(getTicket(store, rowId).id).toBe(rowId);
    });

    it('closes when the saved state has no draft id or no lookup is wired', () => {
      const r = restored();
      expect(mgr.adopt(r.restored, { karstPanel: { mode: 'create', prefilled: true } }, exists, lookupPrefill, pending)).toBe(false);
      const r2 = restored();
      expect(mgr.adopt(r2.restored, state(), exists)).toBe(false);
    });
  });

  it('reports an adopted form as the active view when VS Code already shows it as active', () => {
    const t = createTicket(store, { key: 'P-9', title: 'thing' });
    createdIds.add(t.id);
    const calls: Array<[number, boolean]> = [];
    (mgr as unknown as { onViewActivated: (id: number, active: boolean) => void }).onViewActivated =
      (id, active) => void calls.push([id, active]);
    const a = restored();
    a.panel.isActive = () => true;
    expect(mgr.adopt(a.restored, { karstPanel: { mode: 'edit', ticketId: t.id } }, exists)).toBe(true);
    expect(calls).toEqual([[t.id, true]]);
  });

  it('sets the tab title of a restored edit form from the fresh ticket', () => {
    const id = createTicket(store, { key: 'FRESH', title: 'Fresh title', description: '' }).id;
    createdIds.add(id);
    const r = restored();
    expect(mgr.adopt(r.restored, { karstPanel: { mode: 'edit', ticketId: id } }, exists)).toBe(true);
    expect(r.panel.title).toContain('Fresh title');
  });
});
