import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession, listPlanningTickets } from '../../store/planningSessions.js';
import { getProposal, insertProposal, setProposalHostAttachments, updateProposalPayload } from '../../store/planningProposals.js';
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

  it('exposes only announce/review/discard/setPriority — no read-only view and no direct create', () => {
    expect(Object.keys(ops()).sort()).toEqual(['announce', 'discard', 'outcomeFor', 'prefillFor', 'review', 'setPriority']);
  });

  it('announce names the plan, the draft, the title and the sizes', async () => {
    await ops().announce(getProposal(store, proposalId)!);
    expect(prompts[0]).toContain('Auth rework');
    expect(prompts[0]).toBe(
      `Plan P${sessionId} "Auth rework" proposes D${proposalId}: "Fix login" (description 40 chars, summary 3 chars).`,
    );
  });

  it('announce(updated) words it as a revision', async () => {
    await ops().announce(getProposal(store, proposalId)!, 'updated');
    expect(prompts[0]).toMatch(new RegExp(`^Plan P${sessionId} "Auth rework" updated D${proposalId}: "Fix login" `));
    expect(prompts[0]).not.toMatch(/proposes/);
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

  it('prefillFor builds the review prefill silently for a pending proposal, and not for a resolved or unknown one', async () => {
    expect(ops().prefillFor(proposalId)).toMatchObject({ title: 'Fix login', summary: 'sum', repos: ['api'], draftId: proposalId });
    expect(ops().prefillFor(proposalId + 999)).toBeUndefined();
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(ops().prefillFor(proposalId)).toBeUndefined();
  });

  it('outcomeFor reports the stored status: pending, then accepted with the ticket the user saved', async () => {
    expect(ops().outcomeFor(proposalId)).toEqual({ status: 'pending', ticketId: null });
    expect(ops().outcomeFor(proposalId + 999)).toBeUndefined();
    expect(ops({ projectId: () => projectId + 1 }).outcomeFor(proposalId)).toBeUndefined();
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    // The row the form minted on Fetch carries a key, but it is not committed until the user saves.
    const t = createTicket(store, { key: 'FETCHED-1', title: 'Fix login', projectId });
    expect(ops().outcomeFor(proposalId)).toEqual({ status: 'pending', ticketId: null });
    forms[0]!.onCreated(t.id);
    expect(ops().outcomeFor(proposalId)).toEqual({ status: 'accepted', ticketId: t.id });
  });

  it('Review opens a prefilled form; nothing is created until it saves, and the save carries the summary as brief', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    expect(forms[0]).toMatchObject({ title: 'Fix login', description: 'd'.repeat(40), summary: 'sum', repos: ['api'], draftId: proposalId });
    expect(ticketCount()).toBe(0);
    const t = createTicket(store, { key: 'K', title: 'Fix login', projectId });
    changes = 0;
    forms[0]!.onCreated(t.id);
    expect(changes).toBe(1);
    expect(warns).toEqual([]);
    expect(getProposal(store, proposalId)).toMatchObject({ status: 'accepted', ticketId: t.id });
    expect(listPlanningTickets(store, sessionId)).toEqual([t.id]);
    expect(refreshed).toContain(sessionId);
    expect(getTicket(store, t.id)!.brief).toBe(`## Planning brief\nsum\n\nPlanned in P${sessionId} as D${proposalId}.`);
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
    expect(warns).toEqual([
      `Draft D${proposalId} was revised while you were editing; your saved ticket is linked and the newer revision was discarded.`,
    ]);
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
    expect(warns.join(' ')).toContain(`D${dependent}, D${second} no longer wait on it`);
  });

  it('refreshes the index of another session whose draft a discard pruned', async () => {
    const other = createPlanningSession(store, { projectId, title: 'Other', core: 'claude', model: null }).id;
    const dependent = insertProposal(store, other, {
      title: 'Dependent', description: 'd', summary: 's', repos: ['api'], dependsOn: [proposalId],
    });
    choice = 'discard';
    await ops().announce(getProposal(store, proposalId)!);
    expect(getProposal(store, dependent)!.payload.dependsOn ?? []).toEqual([]);
    expect([...refreshed].sort()).toEqual([sessionId, other].sort());
  });

  it('review passes constraints, doc names and host warnings to the form', async () => {
    const id = insertProposal(
      store, sessionId,
      { title: 'C', description: 'd', summary: 's', repos: ['api'], constraints: ['@arch:RESIDENT', '#9'] },
      'u', ['unknown commit abc1234'],
    );
    const archDocs = vi.fn(() => ({ '@arch:RESIDENT': 'prompt-metrics.md' }));
    await ops({ archDocs }).review(id);
    expect(archDocs).toHaveBeenCalledWith(['api'], ['@arch:RESIDENT', '#9']);
    expect(forms[0]).toMatchObject({
      constraints: ['@arch:RESIDENT', '#9'],
      constraintDocs: { '@arch:RESIDENT': 'prompt-metrics.md' },
      warnings: ['unknown commit abc1234'],
    });
  });

  it('review of an old draft passes empty constraints and warnings', async () => {
    await ops().review(proposalId);
    expect(forms[0]).toMatchObject({ constraints: [], constraintDocs: {}, warnings: [] });
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
    expect(errors).toEqual(['Draft D999 was not found.']);
    expect(debugs).toContain('[planning] proposal 999: not found in this project');
  });

  it('an already resolved proposal reports its status and logs it', async () => {
    await ops().discard(proposalId);
    errors = [];
    debugs = [];
    await ops().review(proposalId);
    expect(errors).toEqual([`Draft D${proposalId} is already discarded.`]);
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
    expect(errors).toEqual([`Couldn't discard draft D${proposalId}: db down`]);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: discard failed: db down`);
  });

  it('reports a failed link from the form callback', async () => {
    choice = 'review';
    await ops().announce(getProposal(store, proposalId)!);
    breakProposalWrites();
    const t = createTicket(store, { key: 'K', title: 'Fix login', projectId });
    changes = 0;
    expect(() => forms[0]!.onCreated(t.id)).toThrow('db down');
    await flush();
    expect(errors).toEqual([`Couldn't link draft D${proposalId}: db down`]);
    expect(debugs).toContain(`[planning] proposal ${proposalId}: link failed: db down`);
    expect(changes).toBe(1);
  });

  describe('setPriority', () => {
    it('sets and clears the override on a pending draft of this project, then repaints', async () => {
      await ops().setPriority(proposalId, 'urgent');
      expect(getProposal(store, proposalId)!.priorityOverride).toBe('urgent');
      await ops().setPriority(proposalId, null);
      expect(getProposal(store, proposalId)!.priorityOverride).toBeNull();
      expect(changes).toBe(2);
      expect(errors).toEqual([]);
    });

    it('refuses an unknown id, a foreign project and a non-pending draft without writing', async () => {
      await ops().setPriority(proposalId + 999, 'low');
      await ops({ projectId: () => projectId + 1 }).setPriority(proposalId, 'low');
      choice = 'discard';
      await ops().announce(getProposal(store, proposalId)!);
      await ops().setPriority(proposalId, 'low');
      expect(getProposal(store, proposalId)!.priorityOverride).toBeNull();
      expect(errors).toHaveLength(3);
    });

    it('refreshes the index of the draft session after a change', async () => {
      await ops().setPriority(proposalId, 'high');
      expect(refreshed).toEqual([sessionId]);
    });
  });

  describe('draft attachments', () => {
    const list = [
      { name: 'b.txt', storedName: '2222222222222222.txt', kind: 'file', byteSize: 1 },
      { name: 'a.html', storedName: '1111111111111111.html', kind: 'file', byteSize: 1, binding: true },
    ];
    const withList = (): void => {
      setProposalHostAttachments(store, proposalId, '', list);
    };

    it('prefill lists the host attachments, binding first', async () => {
      withList();
      await ops().review(proposalId);
      expect(forms[0]!.attachments!.map((a) => a.name)).toEqual(['a.html', 'b.txt']);
    });

    it('removes the host copy after accept and never throws when the removal fails', async () => {
      const removeDir = vi.fn().mockRejectedValue(new Error('boom'));
      await ops({ storageDir: '/s', removeDir }).review(proposalId);
      const ticket = createTicket(store, { key: 'K-1', title: 't', projectId });
      expect(() => forms[0]!.onCreated(ticket.id)).not.toThrow();
      await flush();
      expect(removeDir).toHaveBeenCalledWith('/s', proposalId);
      expect(getProposal(store, proposalId)!.status).toBe('accepted');
      expect(debugs.some((d) => d.includes('attachment cleanup failed'))).toBe(true);
    });

    it('prefill orders binding rows first, keeps the rest in order and sets binding only when true', async () => {
      const row = (name: string, binding?: boolean) => ({
        name,
        storedName: `${name.length}${name.charCodeAt(0)}`.padEnd(16, '0') + '.txt',
        kind: 'file' as const,
        byteSize: 1,
        ...(binding === undefined ? {} : { binding }),
      });
      setProposalHostAttachments(store, proposalId, '', [row('n1'), row('b1', true), row('n2', false), row('b2', true), row('n3')]);
      await ops().review(proposalId);
      const got = forms[0]!.attachments!;
      expect(got.map((a) => a.name)).toEqual(['b1', 'b2', 'n1', 'n2', 'n3']);
      expect(got.map((a) => 'binding' in a)).toEqual([true, true, false, false, false]);
      expect(got[0]).toEqual({ name: 'b1', storedName: row('b1').storedName, kind: 'file', byteSize: 1, binding: true });
    });

    it('does not remove a host copy without a storage dir', async () => {
      const removeDir = vi.fn().mockResolvedValue(undefined);
      await ops({ removeDir }).discard(proposalId);
      expect(removeDir).not.toHaveBeenCalled();
    });

    it('keeps the host copy when the discard fails and the draft stays pending', async () => {
      const removeDir = vi.fn().mockResolvedValue(undefined);
      breakProposalWrites();
      await ops({ storageDir: '/s', removeDir }).discard(proposalId);
      expect(removeDir).not.toHaveBeenCalled();
    });

    it('removes the host copy after discard', async () => {
      const removeDir = vi.fn().mockResolvedValue(undefined);
      await ops({ storageDir: '/s', removeDir }).discard(proposalId);
      expect(removeDir).toHaveBeenCalledWith('/s', proposalId);
    });
  });
});
