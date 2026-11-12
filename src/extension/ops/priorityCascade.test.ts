import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import { getProposal, insertProposal, setProposalPriorityOverride, type ProposalDependency } from '../../store/planningProposals.js';
import { addRelation } from '../../store/ticketRelations.js';
import { createTicket, getTicket, setStageCurrent } from '../../store/tickets.js';
import { createPlanningProposalOps } from './planningProposalOps.js';
import { setTicketPriorityOp } from './ticketPriorityOps.js';
import { KEEP, LOWER_ALL, MAX_LISTED_IDS, offerLowerDependents, queueOwnLevel } from './priorityCascade.js';

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

  it('names the exact prompt text, calls onChange once for the cascade and refreshes a session once', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'high');
    const c = draft('C', [a], 'urgent');
    await draftOps().setPriority(a, 'low');
    expect(prompts[0]!.text).toBe(
      `D${a} is now Low. D${c}, D${b} wait on it at a higher level, so the queue keeps D${a} at Urgent. Lower them to Low too?`,
    );
    expect(changes).toBe(2); // the first write + one for the cascade
    expect(refreshed).toEqual([sessionId, sessionId]);
  });

  it('writes nothing and does not call onChange for the cascade on Keep', async () => {
    const a = draft('A');
    draft('B', [a], 'high');
    answer = KEEP;
    await draftOps().setPriority(a, 'low');
    expect(changes).toBe(1);
    expect(refreshed).toEqual([sessionId]);
  });

  it('does not prompt without a project', async () => {
    const a = draft('A');
    draft('B', [a], 'high');
    await createPlanningProposalOps({ ...common(), projectId: () => undefined, choose: async () => undefined, openForm: () => {} }).setPriority(a, 'low');
    expect(prompts).toHaveLength(0);
  });

  it('a failed index refresh never undoes the cascade, and a throwing write is skipped with one warn', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'high');
    const c = draft('C', [a], 'high');
    const ops = createPlanningProposalOps({
      ...common(),
      refreshIndex: (s) => { refreshed.push(s); if (refreshed.length > 1) throw new Error('disk'); },
      choose: async () => undefined,
      openForm: () => {},
    });
    store.db.exec(`CREATE TRIGGER block_c BEFORE UPDATE OF priority_override ON planning_proposals WHEN NEW.id = ${c} BEGIN SELECT RAISE(ABORT, 'locked'); END;`);
    await ops.setPriority(a, 'low');
    expect(own(b)).toBe('low');
    expect(own(c)).toBeNull();
    expect(warns).toEqual([`D${c} changed in the meantime and stayed at their level.`]);
  });

  it('skips a discarded draft or a draft of another project and names it', async () => {
    const other = upsertProject(store, { slug: 'q' }).id;
    const foreign = createPlanningSession(store, { projectId: other, title: 'F', core: 'claude', model: null }).id;
    const a = draft('A');
    const b = draft('B', [a], 'high');
    const f = insertProposal(store, foreign, { title: 'F', description: 'd'.repeat(40), summary: 's', repos: ['api'], dependsOn: [a], priority: 'high' });
    await draftOps().setPriority(a, 'low');
    expect(own(b)).toBe('low');
    expect(own(f)).toBeNull();
  });

  it('names exactly five ids without +N, and six ids with +1', async () => {
    const a = draft('A');
    const five = Array.from({ length: 5 }, (_, i) => draft(`W${i}`, [a], 'high'));
    await draftOps().setPriority(a, 'low');
    expect(prompts[0]!.text).toContain(`D${a} is now Low. ${five.map((i) => `D${i}`).join(', ')} wait on it`);
    expect(prompts[0]!.text).not.toContain('+');
    const b = draft('B');
    const six = Array.from({ length: 6 }, (_, i) => draft(`V${i}`, [b], 'high'));
    await draftOps().setPriority(b, 'low');
    expect(prompts[1]!.text).toContain(`${six.slice(0, 5).map((i) => `D${i}`).join(', ')} +1 wait on it`);
  });

  it('queueOwnLevel reads the own level of a queue item and undefined for an absent item or no project', () => {
    const a = draft('A', undefined, 'high');
    expect(queueOwnLevel(common(), `D${a}`)).toBe('high');
    expect(queueOwnLevel(common(), 'D9999')).toBeUndefined();
    expect(queueOwnLevel({ ...common(), projectId: () => undefined }, `D${a}`)).toBeUndefined();
  });

  it('offerLowerDependents does nothing for an unknown before, an absent item, no project or an unchanged level', async () => {
    const a = draft('A');
    draft('B', [a], 'high');
    await offerLowerDependents(common(), `D${a}`, undefined);
    await offerLowerDependents(common(), 'D9999', 'high');
    await offerLowerDependents({ ...common(), projectId: () => undefined }, `D${a}`, 'high');
    await offerLowerDependents(common(), `D${a}`, 'normal'); // own level is still normal: not a lower
    expect(prompts).toHaveLength(0);
  });

  it('skips a draft that was discarded, deleted or moved to another project while the prompt was open, with one warn', async () => {
    const a = draft('A');
    const gone = draft('G', [a], 'high');
    const done = draft('X', [a], 'high');
    const moved = draft('M', [a], 'high');
    const ok = draft('K', [a], 'high');
    const otherProject = upsertProject(store, { slug: 'q' }).id;
    const otherSession = createPlanningSession(store, { projectId: otherProject, title: 'O', core: 'claude', model: null }).id;
    const n = { ...notify(), infoActions: async () => {
      store.db.prepare('DELETE FROM planning_proposals WHERE id = ?').run(gone);
      store.db.prepare("UPDATE planning_proposals SET status = 'discarded' WHERE id = ?").run(done);
      store.db.prepare('UPDATE planning_proposals SET session_id = ? WHERE id = ?').run(otherSession, moved);
      return LOWER_ALL;
    } };
    await createPlanningProposalOps({ ...common(), notify: n, choose: async () => undefined, openForm: () => {} }).setPriority(a, 'low');
    expect(own(ok)).toBe('low');
    expect(own(done)).toBeNull();
    expect(own(moved)).toBeNull();
    expect(warns).toEqual([`D${gone}, D${done}, D${moved} changed in the meantime and stayed at their level.`]);
  });

  it('works when refreshIndex is absent', async () => {
    const a = draft('A');
    const b = draft('B', [a], 'high');
    const { refreshIndex: _unused, ...rest } = common();
    await createPlanningProposalOps({ ...rest, choose: async () => undefined, openForm: () => {} }).setPriority(a, 'low');
    expect(own(b)).toBe('low');
  });

  it('lowers a waiting ticket with a user override and an unrelated urgent item does not set the named top level', async () => {
    const base = createTicket(store, { key: 'B', title: 'B', projectId });
    const w = createTicket(store, { key: 'W', title: 'W', projectId });
    for (const t of [base, w]) setStageCurrent(store, t.id, 'scope');
    store.db.prepare('UPDATE tickets SET priority_override = ? WHERE id = ?').run('high', w.id);
    addRelation(store, { ticketId: w.id, kind: 'blocked-by', targetTicketId: base.id, source: 'user' });
    const other = createTicket(store, { key: 'O', title: 'O', projectId });
    setStageCurrent(store, other.id, 'scope');
    store.db.prepare('UPDATE tickets SET priority_override = ? WHERE id = ?').run('urgent', other.id);
    await setTicketPriorityOp(common(), base.id, 'low');
    expect(prompts[0]!.text).toBe(`T${base.id} is now Low. T${w.id} wait on it at a higher level, so the queue keeps T${base.id} at High. Lower them to Low too?`);
    expect(getTicket(store, w.id).priorityOverride).toBe('low');
    expect(getTicket(store, other.id).priorityOverride).toBe('urgent');
    expect(warns).toEqual([]);
  });

  it('an unknown before level never prompts, even when the item sits below normal', async () => {
    const a = draft('A');
    draft('B', [a], 'urgent');
    setProposalPriorityOverride(store, a, 'low');
    await offerLowerDependents(common(), `D${a}`, undefined);
    expect(prompts).toHaveLength(0);
  });
});
