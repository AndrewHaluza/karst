import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal, updateProposalPayload } from '../../store/planningProposals.js';
import { listTickets, createTicket, getTicket } from '../../store/tickets.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import type { PlanningProposalOpsDeps } from './planningProposalOps.js';
import { createPlanningProposalOps, type ProposalChoice } from './planningProposalOps.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('planningProposalOps', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  let proposalId: number;
  let choice: ProposalChoice | undefined;
  let prompts: string[];
  let forms: TicketFormPrefill[];
  let errors: string[];
  let changes: number;
  let debugs: string[];
  let warns: string[];
  let refreshed: number[];
  let refreshImpl: (sessionId: number) => void;

  const ops = (over: Partial<PlanningProposalOpsDeps> = {}) => createPlanningProposalOps({
    store,
    projectId: () => projectId,
    choose: async (text) => { prompts.push(text); return choice; },
    openForm: (prefill) => { forms.push(prefill); },
    notify: { info: () => {}, warn: (m) => { warns.push(m); }, error: async (m) => { errors.push(m); } },
    onChange: () => { changes += 1; },
    refreshIndex: (id) => refreshImpl(id),
    debug: (m) => void debugs.push(m),
    ...over,
  });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'Auth rework', core: 'claude', model: null }).id;
    proposalId = insertProposal(store, sessionId, { title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'] });
    choice = undefined; prompts = []; forms = []; errors = []; changes = 0; debugs = []; warns = []; refreshed = [];
    refreshImpl = (id) => { refreshed.push(id); };
  });
  afterEach(() => store.close());

  const ticketCount = () => listTickets(store, { projectId }).length;

  /** Make any write to the proposal row throw, to exercise `guarded`'s catch. */
  function breakProposalWrites(): void {
    const real = store.db.prepare.bind(store.db);
    (store.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/UPDATE planning_proposals/.test(sql)) throw new Error('db down');
      return real(sql);
    };
  }

  it('exposes only announce/review/discard — no read-only view and no direct create', () => {
    expect(Object.keys(ops()).sort()).toEqual(['announce', 'discard', 'review']);
  });

  it('announce names the session, its #id, the title and the sizes', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(prompts[0]).toContain('Auth rework');
    expect(prompts[0]).toContain(`#${sessionId}`);
    expect(prompts[0]).toContain('Fix login');
    expect(prompts[0]).toMatch(/40 chars/);
    expect(prompts[0]).toMatch(/3 chars/);
    expect(prompts[0]).toMatch(/proposes/);
  });

  it('announce(updated) words it as a revision', async () => {
    await ops().announce(getProposal(store, proposalId)!, 'updated');
    expect(prompts[0]).toMatch(/updated its draft/);
    expect(prompts[0]).not.toMatch(/proposes a ticket/);
  });

  it('dismissing the notification leaves it pending and creates nothing', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
    expect(ticketCount()).toBe(0);
  });

  it('a throwing index refresh never fails a committed discard', async () => {
    refreshImpl = () => { throw new Error('scratch gone'); };
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('discarded');
    expect(errors).toHaveLength(0);
  });

  it('Discard discards without a ticket and refreshes the index', async () => {
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('discarded');
    expect(ticketCount()).toBe(0);
    expect(refreshed).toContain(sessionId);
    expect(changes).toBeGreaterThan(0);
    // No dependents → no prune warning.
    expect(warns).toEqual([]);
  });

  it('Review opens a prefilled form; nothing is created until it saves, and the save carries the summary as brief', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    expect(forms[0]).toMatchObject({ title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'] });
    expect(ticketCount()).toBe(0);
    const t = createTicket(store, { key: 'K', title: 'Fix login', projectId });
    forms[0]!.onCreated(t.id);
    expect(getProposal(store, proposalId)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
    expect(refreshed).toContain(sessionId);
    expect(getTicket(store, t.id)!.brief).toBe('sum');
  });

  it('a form-saved ticket is linked even if the draft was revised while the form was open, with a warning', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    const t = createTicket(store, { key: 'K2', title: 'Fix login', projectId });
    updateProposalPayload(store, proposalId, { ...getProposal(store, proposalId)!.payload, title: 'revised' });
    forms[0]!.onCreated(t.id);
    // No orphan and no second ticket: the human's save is authoritative, and
    // the divergence is surfaced instead of silently dropping the revision.
    expect(getProposal(store, proposalId)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
    expect(warns.join(' ')).toMatch(/revised while you were editing/);
    expect(errors).toHaveLength(0);
  });

  it('warns when a discard prunes a pending dependent draft', async () => {
    const dependent = insertProposal(store, sessionId, {
      title: 'Dependent', description: 'd', summary: 's', repos: ['api'], dependsOn: [proposalId],
    });
    const second = insertProposal(store, sessionId, {
      title: 'Second', description: 'd', summary: 's', repos: ['api'], dependsOn: [proposalId],
    });
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('discarded');
    expect(getProposal(store, dependent)!.payload.dependsOn ?? []).toEqual([]);
    expect(getProposal(store, second)!.payload.dependsOn ?? []).toEqual([]);
    expect(warns.join(' ')).toContain(`#${dependent}, #${second} no longer wait on it`);
  });

  it('a resolved or foreign proposal is refused with a message', async () => {
    await ops().discard(proposalId);
    await ops().review(proposalId);
    await ops().review(999);
    expect(forms).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it('a proposal of another project is refused', async () => {
    projectId = upsertProject(store, { slug: 'q' }).id;
    await ops().review(proposalId);
    expect(forms).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('announce falls back to "?" when the session row is gone', async () => {
    const orphan = { ...getProposal(store, proposalId)!, sessionId: 9999 };
    await ops().announce(orphan);
    expect(prompts[0]).toContain('"?"');
  });

  it('announce logs the chosen action and defaults a dismissal', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: choice dismissed`);

    debugs = [];
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: choice review`);
  });

  it('an unknown proposal reports the exact message and logs it', async () => {
    await ops().review(999);
    expect(errors).toEqual(['Planning proposal #999 was not found.']);
    expect(debugs).toContain('[planning] proposal 999: not found in this project');
  });

  it('an already resolved proposal reports its status and logs it', async () => {
    await ops().discard(proposalId);
    errors = [];
    debugs = [];
    await ops().review(proposalId);
    expect(errors).toEqual([`Planning proposal #${proposalId} is already discarded.`]);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: already discarded`);
  });

  it('a proposal whose session row vanished is refused', async () => {
    store.db.pragma('foreign_keys = OFF');
    const id = Number(
      store.db
        .prepare('INSERT INTO planning_proposals (session_id, payload_json) VALUES (9999, ?)')
        .run(JSON.stringify({ title: 't', description: 'd', summary: 's', repos: ['api'] }))
        .lastInsertRowid,
    );
    store.db.pragma('foreign_keys = ON');
    await expect(ops().review(id)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(ticketCount()).toBe(0);
  });

  it('a second discard is refused without a change', async () => {
    await ops().discard(proposalId);
    changes = 0;
    errors = [];
    await ops().discard(proposalId);
    expect(changes).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('reports a failed discard with the operation name and reason', async () => {
    breakProposalWrites();
    await ops().discard(proposalId);
    expect(errors).toEqual([`Couldn't discard planning proposal #${proposalId}: db down`]);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: discard failed: db down`);
  });

  it('reports a failed link from the form callback', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    breakProposalWrites();
    const t = createTicket(store, { key: 'K', title: 'Fix login', projectId });
    forms[0]!.onCreated(t.id);
    await flush();
    expect(errors).toEqual([`Couldn't link planning proposal #${proposalId}: db down`]);
  });
});
