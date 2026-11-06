import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, archiveTicket } from '../../store/tickets.js';
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
    expect(restoredTicketFormIdentity({ karstPanel: { mode: 'edit', ticketId: 4 } })).toEqual({ mode: 'edit', ticketId: 4 });
  });
  it('closes a proposal review form silently: its link to the proposal is lost on reload', () => {
    const r = restored();
    expect(mgr.adopt(r.restored, { karstPanel: { mode: 'create', prefilled: true } }, exists)).toBe(false);
    expect(r.disposed()).toBe(true);
    expect(r.wrapped()).toBe(false);
  });

  it('sets the tab title of a restored edit form from the fresh ticket', () => {
    const id = createTicket(store, { title: 'Fresh title', description: '' }).id;
    createdIds.add(id);
    const r = restored();
    expect(mgr.adopt(r.restored, { karstPanel: { mode: 'edit', ticketId: id } }, exists)).toBe(true);
    expect(r.panel.title).toContain('Fresh title');
  });
});
