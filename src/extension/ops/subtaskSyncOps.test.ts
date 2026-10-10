import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../../store/tickets.js';
import { addRelation, listRelations, resolveDanglingRefs } from '../../store/ticketRelations.js';
import { createSubtask } from '../../workflow/stages/subtask.js';
import type { CreateTicketInput, TicketingProvider } from '../../integrations/ticketing.js';
import type { SyncSubtasksMode, TicketingConfig } from '../../manifest/types.js';
import { makeSubtaskSync, syncSubtaskToProvider } from './subtaskSyncOps.js';

describe('syncSubtaskToProvider', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  const created: CreateTicketInput[] = [];
  beforeEach(() => (created.length = 0));

  function provider(over: Partial<TicketingProvider> = {}): TicketingProvider {
    return {
      async updateStatus() {},
      async createTicket(input) {
        created.push(input);
        return { ref: 'cu-child', internalRef: 'int-child' };
      },
      ...over,
    };
  }

  function setup(opts: { parentRef?: string; blocking?: boolean } = {}) {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'parent' });
    updateTicketFields(store, parent.id, { selectedRepos: ['api'], sourceRef: opts.parentRef });
    const child = createSubtask(store, parent.id, {
      title: 'child',
      description: 'do it',
      blocking: opts.blocking,
      relationSource: 'user',
    });
    return { parent, child };
  }

  function run(mode: SyncSubtasksMode | undefined, childId: number, p: TicketingProvider) {
    const bound: number[] = [];
    const lines: string[] = [];
    const done = syncSubtaskToProvider(
      {
        store,
        provider: () => p,
        mode: () => mode,
        onSourceRefBound: async (id) => {
          bound.push(id);
          resolveDanglingRefs(store, id);
        },
        debug: (m) => lines.push(m),
      },
      childId,
    );
    return { done, bound, lines };
  }

  it('off: no provider calls', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    const r = run('off', child.id, provider());
    await r.done;
    expect(created).toEqual([]);
    expect(getTicket(store, child.id).sourceRef).toBeNull();
  });

  it.each(['link', 'full'] as const)('%s + bound parent: creates under parent, binds, promotes blocked-by', async (mode) => {
    const { parent, child } = setup({ parentRef: 'cu-parent', blocking: true });
    const r = run(mode, child.id, provider());
    await r.done;
    expect(created).toEqual([{ title: 'child', description: 'do it', parentRef: 'cu-parent' }]);
    const bound = getTicket(store, child.id);
    expect(bound.sourceRef).toBe('cu-child');
    expect(r.bound).toEqual([child.id]);
    expect(listRelations(store, parent.id).map((x) => x.writebackState)).toEqual(['pending']);
  });

  it('unbound parent: rows only, skip logged', async () => {
    const { parent, child } = setup({ blocking: true });
    const r = run('link', child.id, provider());
    await r.done;
    expect(created).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/parent .* no provider ref/);
    expect(listRelations(store, parent.id)).toHaveLength(1);
  });

  it('provider without createTicket: skip logged', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    const r = run('link', child.id, { async updateStatus() {} });
    await r.done;
    expect(r.lines.join('\n')).toMatch(/cannot create tickets/);
    expect(getTicket(store, child.id).sourceRef).toBeNull();
  });

  it('already bound child: never creates a second provider task', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    updateTicketFields(store, child.id, { sourceRef: 'existing' });
    await run('link', child.id, provider()).done;
    expect(created).toEqual([]);
  });

  it('provider error: rows marked failed with the reason, never throws', async () => {
    const { parent, child } = setup({ parentRef: 'cu-parent', blocking: true });
    const p = provider({
      async createTicket() {
        throw new Error('boom');
      },
    });
    await expect(run('link', child.id, p).done).resolves.toBeUndefined();
    const rows = [...listRelations(store, parent.id), ...listRelations(store, child.id)];
    expect(rows.map((x) => [x.kind, x.writebackState, x.writebackError])).toEqual([
      ['blocked-by', 'failed', 'boom'],
      ['parent', 'failed', 'boom'],
    ]);
    expect(getTicket(store, child.id).sourceRef).toBeNull();
  });

  it('makeSubtaskSync reads the current manifest per call', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    let ticketing: TicketingConfig | undefined = { provider: 'clickup' };
    const sync = makeSubtaskSync({
      store,
      ticketing: () => ticketing,
      makeProvider: () => provider(),
      onSourceRefBound: async (d, id) => void resolveDanglingRefs(d.store, id),
      debug: () => {},
    });
    await sync(child.id);
    expect(created).toEqual([]);
    ticketing = { provider: 'clickup', syncSubtasks: 'link' };
    await sync(child.id);
    expect(created).toHaveLength(1);
  });

  it('logs each decision with the sub-task id', async () => {
    const off = setup({ parentRef: 'cu-parent' });
    expect((await logs('off', off.child.id, provider()))).toEqual([
      `[ticketing] sub-task sync #${off.child.id}: mode off — recorded rows only`,
    ]);
    const ok = await logs('link', off.child.id, provider());
    expect(ok).toEqual([
      `[ticketing] sub-task sync #${off.child.id}: creating provider task under 'cu-parent' (link)`,
      `[ticketing] sub-task sync #${off.child.id}: bound 'cu-child'`,
    ]);
    expect(await logs('link', off.child.id, provider())).toEqual([
      `[ticketing] sub-task sync #${off.child.id}: already bound — no second provider task`,
    ]);
  });

  it('logs the failure reason', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    const lines = await logs('link', child.id, provider({ createTicket: async () => { throw new Error('boom'); } }));
    expect(lines[1]).toBe(`[ticketing] sub-task sync #${child.id}: failed — boom`);
  });

  it('logs the unbound-parent and no-createTicket skips', async () => {
    const { child } = setup();
    expect(await logs('link', child.id, provider())).toEqual([
      `[ticketing] sub-task sync #${child.id}: parent has no provider ref — skipping`,
    ]);
    const bound = setup2('cu-p2');
    expect(await logs('link', bound.id, { async updateStatus() {} })).toEqual([
      `[ticketing] sub-task sync #${bound.id}: provider cannot create tickets — skipping`,
    ]);
  });

  it('ignores a top-level ticket and treats a blank source_ref as unbound', async () => {
    const top = createTicket(store, { key: 'TOP-1', title: 'top' });
    await run('link', top.id, provider()).done;
    expect(created).toEqual([]);
    const { child } = setup({ parentRef: 'cu-parent' });
    updateTicketFields(store, child.id, { sourceRef: '   ' });
    await run('link', child.id, provider()).done;
    expect(created).toHaveLength(1);
  });

  it('stores the internal ref, clears it when absent, and skips the bind hook for a blank ref', async () => {
    const a = setup({ parentRef: 'cu-parent' });
    await run('link', a.child.id, provider()).done;
    expect(getTicket(store, a.child.id).sourceRefInternal).toBe('int-child');

    const b = setup2('cu-p3');
    const r = run('link', b.id, provider({ createTicket: async () => ({ ref: '  ' }) }));
    await r.done;
    expect(r.bound).toEqual([]);
  });

  it('on failure leaves unrelated relation rows untouched', async () => {
    const { parent, child } = setup({ parentRef: 'cu-parent', blocking: true });
    const other = createTicket(store, { key: 'OTH-1', title: 'other' });
    addRelation(store, { ticketId: parent.id, kind: 'blocked-by', targetTicketId: other.id, source: 'user' });
    addRelation(store, { ticketId: other.id, kind: 'blocked-by', targetTicketId: child.id, source: 'user' });
    await run('link', child.id, provider({ createTicket: async () => { throw new Error('x'); } })).done;
    const states = (id: number) => listRelations(store, id).map((x) => [x.targetTicketId, x.writebackState]);
    expect(states(parent.id)).toEqual([[child.id, 'failed'], [other.id, null]]);
    expect(states(other.id)).toEqual([[child.id, null]]);
  });

  it('makeSubtaskSync hands the store and provider to the bind hook', async () => {
    const { child } = setup({ parentRef: 'cu-parent' });
    const p = provider();
    const seen: unknown[] = [];
    await makeSubtaskSync({
      store,
      ticketing: () => ({ provider: 'clickup', syncSubtasks: 'link' }),
      makeProvider: () => p,
      onSourceRefBound: async (d, id) => void seen.push(d.store === store, d.provider === p, id),
      debug: () => {},
    })(child.id);
    expect(seen).toEqual([true, true, child.id]);
  });

  async function logs(mode: SyncSubtasksMode, childId: number, p: TicketingProvider): Promise<string[]> {
    const r = run(mode, childId, p);
    await r.done;
    return r.lines;
  }

  /** A second bound parent + child; returns the child. */
  function setup2(parentRef: string) {
    const parent = createTicket(store, { key: `P-${parentRef}`, title: 'p' });
    updateTicketFields(store, parent.id, { selectedRepos: ['api'], sourceRef: parentRef });
    return createSubtask(store, parent.id, { title: 'c2' });
  }
});
