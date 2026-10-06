import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal } from '../../store/planningProposals.js';
import { listTickets, createTicket, getTicket } from '../../store/tickets.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import { createPlanningProposalOps, type ProposalChoice } from './planningProposalOps.js';

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

  const ops = () => createPlanningProposalOps({
    store,
    projectId: () => projectId,
    choose: async (text) => { prompts.push(text); return choice; },
    openForm: (prefill) => { forms.push(prefill); },
    notify: { info: () => {}, warn: () => {}, error: async (m) => { errors.push(m); } },
    onChange: () => { changes += 1; },
  });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'Auth rework', core: 'claude', model: null }).id;
    proposalId = insertProposal(store, sessionId, { title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'] });
    choice = undefined; prompts = []; forms = []; errors = []; changes = 0;
  });
  afterEach(() => store.close());

  const ticketCount = () => listTickets(store, { projectId }).length;

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
  });

  it('dismissing the notification leaves it pending and creates nothing', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
    expect(ticketCount()).toBe(0);
  });

  it('Discard discards without a ticket', async () => {
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, proposalId)!.status).toBe('discarded');
    expect(ticketCount()).toBe(0);
    expect(changes).toBeGreaterThan(0);
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
    expect(getTicket(store, t.id)!.brief).toBe('sum');
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
});
