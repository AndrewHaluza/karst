import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal, type PlanningProposal } from '../../store/planningProposals.js';
import { listTickets, createTicket } from '../../store/tickets.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import type { PlanningProposalOpsDeps } from './planningProposalOps.js';
import { createPlanningProposalOps, proposalPreview, type ProposalChoice } from './planningProposalOps.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('planningProposalOps', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  let proposalId: number;
  let preview: boolean;
  let choice: ProposalChoice | undefined;
  let prompts: string[];
  let previews: PlanningProposal[];
  let forms: TicketFormPrefill[];
  let errors: string[];
  let changes: number;
  let shown: PlanningProposal[];
  let debugs: string[];

  const ops = (over: Partial<PlanningProposalOpsDeps> = {}) => createPlanningProposalOps({
    store,
    projectId: () => projectId,
    confirmPreview: async (p) => { previews.push(p); return preview; },
    choose: async (text) => { prompts.push(text); return choice; },
    openForm: (prefill) => { forms.push(prefill); },
    showDraft: async (p) => { shown.push(p); },
    notify: { info: () => {}, warn: () => {}, error: async (m) => { errors.push(m); } },
    onChange: () => { changes += 1; },
    debug: (m) => void debugs.push(m),
    ...over,
  });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'Auth rework', core: 'claude', model: null }).id;
    proposalId = insertProposal(store, sessionId, { title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'] });
    preview = true; choice = undefined; prompts = []; previews = []; forms = []; errors = []; changes = 0; shown = []; debugs = [];
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

  it('announce names the session, its #id, the title and the sizes', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(prompts[0]).toContain('Auth rework');
    expect(prompts[0]).toContain(`#${sessionId}`);
    expect(prompts[0]).toContain('Fix login');
    expect(prompts[0]).toMatch(/40 chars/);
    expect(prompts[0]).toMatch(/3 chars/);
  });

  it('dismissing the notification leaves it pending and creates nothing', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
    expect(ticketCount()).toBe(0);
  });

  it('Create shows the preview first and only then creates the ticket', async () => {
    choice = 'create';
    await ops().announce(getProposal(store, proposalId)!);
    expect(previews.map((p) => p.id)).toEqual([proposalId]);
    expect(ticketCount()).toBe(1);
    expect(getProposal(store, proposalId)!.status).toBe('accepted');
    expect(changes).toBeGreaterThan(0);
  });

  it('a declined preview creates nothing and stays pending', async () => {
    preview = false;
    await ops().create(proposalId);
    expect(ticketCount()).toBe(0);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
  });

  it('Discard discards without a ticket', async () => {
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('discarded');
    expect(ticketCount()).toBe(0);
  });

  it('Review opens a prefilled form; nothing is created until it saves', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    expect(forms[0]).toMatchObject({ title: 'Fix login', description: 'd'.repeat(40), repos: ['api'] });
    expect(ticketCount()).toBe(0);
    const t = createTicket(store, { key: 'K', title: 'Fix login', projectId });
    forms[0]!.onCreated(t.id);
    expect(getProposal(store, proposalId)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
  });

  it('view shows the draft read-only: nothing is created, it stays pending', async () => {
    await ops().view(proposalId);
    expect(shown.map((p) => p.id)).toEqual([proposalId]);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
    expect(ticketCount()).toBe(0);
    expect(forms).toHaveLength(0);
  });

  it('view refuses an unknown proposal with a message', async () => {
    await ops().view(999);
    expect(shown).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('a resolved or foreign proposal is refused with a message', async () => {
    await ops().discard(proposalId);
    await ops().create(proposalId);
    await ops().review(999);
    expect(previews).toHaveLength(0);
    expect(forms).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it('a proposal of another project is refused', async () => {
    projectId = upsertProject(store, { slug: 'q' }).id;
    await ops().create(proposalId);
    expect(ticketCount()).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('the preview carries the full content and repos verbatim', () => {
    const text = proposalPreview(getProposal(store, proposalId)!);
    expect(text).toBe(
      [
        'Title: Fix login',
        'Repositories: api',
        '',
        'Summary:',
        'sum',
        '',
        'Description:',
        'd'.repeat(40),
      ].join('\n'),
    );
  });

  it('the preview joins several repos and names empty sections', () => {
    const p = getProposal(store, proposalId)!;
    const text = proposalPreview({
      ...p,
      payload: { title: 'T', repos: ['api', 'web'], summary: '', description: '' },
    });
    expect(text).toBe(
      [
        'Title: T',
        'Repositories: api, web',
        '',
        'Summary:',
        '(empty)',
        '',
        'Description:',
        '(empty)',
      ].join('\n'),
    );
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

  it('create logs the accepted ticket id', async () => {
    await ops().create(proposalId);
    expect(debugs.some((m) => /accepted as ticket \d+/.test(m))).toBe(true);
  });

  it('a declined preview is logged and stays pending', async () => {
    preview = false;
    await ops().create(proposalId);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: preview declined, stays pending`);
  });

  it('view logs the read-only display', async () => {
    await ops().view(proposalId);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: shown read-only`);
  });

  it('an unknown proposal reports the exact message and logs it', async () => {
    await ops().view(999);
    expect(errors).toEqual(['Planning proposal #999 was not found.']);
    expect(debugs).toContain('[planning] proposal 999: not found in this project');
  });

  it('an already resolved proposal reports its status and logs it', async () => {
    await ops().discard(proposalId);
    errors = [];
    debugs = [];
    await ops().create(proposalId);
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
    await expect(ops().create(id)).resolves.toBeUndefined();
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

  it('reports a failed create naming the operation', async () => {
    breakProposalWrites();
    await ops().create(proposalId);
    expect(errors).toEqual([`Couldn't create a ticket from planning proposal #${proposalId}: db down`]);
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
