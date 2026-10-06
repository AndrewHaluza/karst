import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal, type PlanningProposal } from '../../store/planningProposals.js';
import { listTickets, createTicket } from '../../store/tickets.js';
import type { TicketFormPrefill } from '../../ui/ticketForm/panel.js';
import { createPlanningProposalOps, proposalPreview, type ProposalChoice } from './planningProposalOps.js';

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

  const ops = () => createPlanningProposalOps({
    store,
    projectId: () => projectId,
    confirmPreview: async (p) => { previews.push(p); return preview; },
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
    preview = true; choice = undefined; prompts = []; previews = []; forms = []; errors = []; changes = 0;
  });
  afterEach(() => store.close());

  const ticketCount = () => listTickets(store, { projectId }).length;

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

  it('the preview carries the full content and repos', () => {
    const text = proposalPreview(getProposal(store, proposalId)!);
    expect(text).toContain('d'.repeat(40));
    expect(text).toContain('sum');
    expect(text).toContain('api');
  });
});
