import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import { getProposal, insertProposal, setProposalPriorityOverride, type ProposalDependency } from '../../store/planningProposals.js';
import { addRelation } from '../../store/ticketRelations.js';
import { createTicket, getTicket, setStageCurrent } from '../../store/tickets.js';
import { createPlanningProposalOps } from './planningProposalOps.js';
import { setTicketPriorityOp } from './ticketPriorityOps.js';
import { KEEP, LOWER_ALL, MAX_LISTED_IDS } from './priorityCascade.js';

describe('priority cascade', () => {
  let store: Store;
  let projectId: number;
  let sessionId: number;
  let prompts: { text: string; actions: readonly string[] }[];
  let warns: string[];
  let changes: number;
  let refreshed: number[];
  let answer: string | undefined;
  let withActions: boolean;

  const notify = () => ({
    info: () => {},
    warn: (m: string) => { warns.push(m); },
    error: async () => {},
    ...(withActions ? { infoActions: async (text: string, actions: readonly string[]) => { prompts.push({ text, actions }); return answer; } } : {}),
  });
  const common = () => ({ store, projectId: () => projectId, notify: notify(), onChange: () => { changes += 1; }, refreshIndex: (s: number) => { refreshed.push(s); } });
  const draftOps = () => createPlanningProposalOps({ ...common(), choose: async () => undefined, openForm: () => {} });
  const draft = (title: string, dependsOn?: ProposalDependency[], priority?: 'urgent' | 'high' | 'normal' | 'low'): number =>
    insertProposal(store, sessionId, { title, description: 'd'.repeat(40), summary: 's', repos: ['api'], ...(dependsOn ? { dependsOn } : {}), ...(priority ? { priority } : {}) });
  const own = (id: number) => getProposal(store, id)!.priorityOverride;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 'S', core: 'claude', model: null }).id;
    prompts = []; warns = []; changes = 0; refreshed = []; answer = LOWER_ALL; withActions = true;
  });
  afterEach(() => store.close());

  it('Lower all writes the new level as an override on each waiting draft, once per session refresh', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'high');
    const c = draft('C', [b], 'high');
    setProposalPriorityOverride(store, c, 'high');
    await draftOps().setPriority(a, 'low');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.actions).toEqual([LOWER_ALL, KEEP]);
    expect(prompts[0]!.text).toContain(`D${a} is now Low. D${b}, D${c} wait on it`);
    expect(prompts[0]!.text).toContain('Lower them to Low too?');
    expect([own(a), own(b), own(c)]).toEqual(['low', 'low', 'low']);
    expect(refreshed.filter((s) => s === sessionId).length).toBe(2); // first write + one cascade refresh
    expect(warns).toEqual([]);
  });

  it('Keep and a dismissed prompt keep the first change and write nothing more', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'high');
    answer = KEEP;
    await draftOps().setPriority(a, 'low');
    await draftOps().setPriority(a, 'high');
    answer = undefined;
    await draftOps().setPriority(a, 'low');
    expect(own(a)).toBe('low');
    expect(own(b)).toBeNull();
    expect(prompts).toHaveLength(2);
  });

  it('a raise, an unchanged level and a lower with no higher dependent never prompt', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'low');
    await draftOps().setPriority(a, 'urgent');
    await draftOps().setPriority(a, 'urgent');
    await draftOps().setPriority(a, 'normal');
    expect(prompts).toHaveLength(0);
    expect(own(b)).toBeNull();
  });

  it('Clear that gives a lower effective level prompts', async () => {
    const a = draft('A', undefined, 'normal');
    setProposalPriorityOverride(store, a, 'urgent');
    const b = draft('B', [a], 'high');
    await draftOps().setPriority(a, null);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain('is now Normal');
    expect(own(b)).toBe('normal');
  });

  it('does nothing more when notify has no infoActions', async () => {
    withActions = false;
    const a = draft('A');
    const b = draft('B', [a], 'high');
    await draftOps().setPriority(a, 'low');
    expect(own(a)).toBe('low');
    expect(own(b)).toBeNull();
  });

  it('lists at most five ids, then +N', async () => {
    const a = draft('A');
    for (let i = 0; i < MAX_LISTED_IDS + 2; i += 1) draft(`W${i}`, [a], 'high');
    await draftOps().setPriority(a, 'low');
    expect(prompts[0]!.text).toContain('+2 wait on it');
  });

  it('a ticket dependent of a draft is lowered by a ticket-row check, and a draft cascades into a ticket', async () => {
    const t = createTicket(store, { key: 'K', title: 'T', projectId });
    setStageCurrent(store, t.id, 'scope');
    const a = draft('A', [`T${t.id}`], 'high');
    // the ticket is the blocker: lowering it offers to lower draft a
    await setTicketPriorityOp({ ...common() }, t.id, 'low');
    expect(prompts).toHaveLength(1);
    expect(getTicket(store, t.id).priorityOverride).toBe('low');
    expect(own(a)).toBe('low');
    expect(refreshed).toEqual([sessionId]);
  });

  it('a ticket that waits on a lowered ticket gets the override; a started ticket is skipped with one warn', async () => {
    const base = createTicket(store, { key: 'B', title: 'B', projectId });
    const w = createTicket(store, { key: 'W', title: 'W', projectId });
    for (const t of [base, w]) setStageCurrent(store, t.id, 'scope');
    store.db.prepare('UPDATE tickets SET priority_override = ? WHERE id = ?').run('high', w.id);
    const a = draft('A', [`T${base.id}`], 'high');
    // w waits on base through a blocked-by row
    addRelation(store, { ticketId: w.id, kind: 'blocked-by', targetTicketId: base.id, source: 'user' });
    // w leaves scope between the prompt and the write: the walk read it as queued.
    const deps = { ...common(), notify: { ...notify(), infoActions: async (text: string, actions: readonly string[]) => { prompts.push({ text, actions }); setStageCurrent(store, w.id, 'impl'); return LOWER_ALL; } } };
    await setTicketPriorityOp(deps, base.id, 'low');
    expect(getTicket(store, w.id).priorityOverride).toBe('high');
    expect(own(a)).toBe('low');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`T${w.id}`);
  });
});
