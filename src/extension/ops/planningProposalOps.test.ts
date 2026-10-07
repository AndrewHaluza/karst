import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal, updateProposalPayload, type PlanningProposal } from '../../store/planningProposals.js';
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
  let shown: PlanningProposal[];
  let refreshed: number[];
  let warns: string[];
  let reviseOnPreview: boolean;
  let refreshImpl: (sessionId: number) => void;

  const ops = () => createPlanningProposalOps({
    store,
    projectId: () => projectId,
    confirmPreview: async (p) => {
      previews.push(p);
      if (reviseOnPreview) updateProposalPayload(store, p.id, { ...p.payload, title: 'revised mid-modal' });
      return preview;
    },
    choose: async (text) => { prompts.push(text); return choice; },
    openForm: (prefill) => { forms.push(prefill); },
    showDraft: async (p) => { shown.push(p); },
    notify: { info: () => {}, warn: (m) => { warns.push(m); }, error: async (m) => { errors.push(m); } },
    onChange: () => { changes += 1; },
    refreshIndex: (id) => refreshImpl(id),
  });

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'Auth rework', core: 'claude', model: null }).id;
    proposalId = insertProposal(store, sessionId, { title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'] });
    preview = true; choice = undefined; prompts = []; previews = []; forms = []; errors = []; changes = 0; shown = []; refreshed = []; warns = [];
    reviseOnPreview = false;
    refreshImpl = (id) => { refreshed.push(id); };
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

  it('Create shows the preview first and only then creates the ticket', async () => {
    choice = 'create';
    await ops().announce(getProposal(store, proposalId)!);
    expect(previews.map((p) => p.id)).toEqual([proposalId]);
    expect(ticketCount()).toBe(1);
    expect(getProposal(store, proposalId)!.status).toBe('accepted');
    expect(changes).toBeGreaterThan(0);
    expect(refreshed).toContain(sessionId);
  });

  it('a declined preview creates nothing and stays pending', async () => {
    preview = false;
    await ops().create(proposalId);
    expect(ticketCount()).toBe(0);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
  });

  it('Create refuses if the agent revised the draft while the preview was open', async () => {
    reviseOnPreview = true;
    await ops().create(proposalId);
    expect(ticketCount()).toBe(0);
    expect(getProposal(store, proposalId)!.status).toBe('pending');
    expect(errors.join(' ')).toMatch(/changed since it was reviewed/);
  });

  it('a throwing index refresh never fails a committed accept or discard', async () => {
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
    expect(refreshed).toContain(sessionId);
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

  it('the preview carries the full content and repos', () => {
    const text = proposalPreview(getProposal(store, proposalId)!);
    expect(text).toContain('d'.repeat(40));
    expect(text).toContain('sum');
    expect(text).toContain('api');
  });
});
