import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { transition } from '../../workflow/machine.js';
import { getAutopilotBudget, getAutopilotTicket, setAutopilotStopped, takeAutopilotAttempt } from '../../store/autopilot.js';
import { approveCommand, setOverrideCommand, stopCommand, type AutopilotCommandDeps } from './autopilotCommandOps.js';

let store: Store;
let id: number;
let projectId: number;

function deps(over: Partial<AutopilotCommandDeps> = {}): AutopilotCommandDeps & { said: string[] } {
  const said: string[] = [];
  return {
    store, projectId: () => projectId, said, say: (m) => void said.push(m), debug: vi.fn(),
    pickTicket: async (picks) => picks[0]?.ticketId, pick: async (choices) => choices[0],
    stopSession: vi.fn(async () => {}), ...over,
  };
}
const notes = () => store.db.prepare('SELECT title FROM bulletin_notes ORDER BY rowid').all().map((r) => (r as { title: string }).title);

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  id = createTicket(store, { key: 'AP-1', title: 't', projectId }).id;
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) transition(store, id, from, { kind: 'passed' });
  setStage(store, id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
});

describe('ticket picker', () => {
  it('offers every open ticket of the project (not only ship), labelled by key', async () => {
    const early = createTicket(store, { key: 'AP-2', title: 'other', projectId }).id;
    const other = upsertProject(store, { slug: 'q' }).id;
    createTicket(store, { key: 'AP-3', title: 'x', projectId: other });
    const pickTicket = vi.fn(async () => undefined);
    await setOverrideCommand(deps({ pickTicket }));
    const [picks, holder] = pickTicket.mock.calls[0] as unknown as [Array<{ label: string; ticketId: number }>, string];
    expect(holder).toBe('Set auto-fix mode for which ticket?');
    expect(picks.map((p) => p.ticketId).sort()).toEqual([id, early].sort());
  });
  it('does not ask without a bound project', async () => {
    const pickTicket = vi.fn();
    await stopCommand(deps({ pickTicket, projectId: () => undefined }));
    expect(pickTicket).not.toHaveBeenCalled();
  });
});

describe('setOverrideCommand', () => {
  it('sets the override for the picked ticket, clears a spent state and writes a note', async () => {
    setAutopilotStopped(store, id, 'auto-fix stopped: ci 3/3');
    const d = deps({ pick: async () => 'on' as never });
    await setOverrideCommand(d);
    expect(getAutopilotTicket(store, id)).toMatchObject({ mode: 'on', stoppedReason: null });
    expect(notes()).toEqual(['Autopilot: override set']);
    expect(d.said).toEqual(['Auto-fix mode for AP-1: on.']);
  });
  it('takes an explicit ticket and mode without asking, and ignores a cancelled or invalid pick', async () => {
    const pickTicket = vi.fn();
    await setOverrideCommand(deps({ pickTicket }), id, 'off');
    expect(pickTicket).not.toHaveBeenCalled();
    expect(getAutopilotTicket(store, id).mode).toBe('off');
    await setOverrideCommand(deps({ pick: async () => undefined }), id);
    await setOverrideCommand(deps(), id, 'bogus' as never);
    expect(getAutopilotTicket(store, id).mode).toBe('off');
    await setOverrideCommand(deps({ pickTicket: async () => undefined }));
    await setOverrideCommand(deps({ projectId: () => undefined }));
  });
});

describe('command edges', () => {
  it('labels a ticket without a key by its entity id and offers the mode choices', async () => {
    const bare = createTicket(store, { key: null as never, title: 'no key', projectId }).id;
    const pick = vi.fn(async () => undefined);
    await setOverrideCommand(deps({ pick }), bare);
    expect(pick).toHaveBeenCalledWith(['inherit', 'on', 'off'], 'Auto-fix mode');
    await setOverrideCommand(deps(), bare, 'on');
    expect(notes().at(-1)).toBe('Autopilot: override set');
    const d = deps();
    await stopCommand(d, bare, 'after-round');
    expect(d.said).toEqual([`Auto-fix stopped after this round for T${bare}.`]);
  });
  it('writes no note without a bound project but still applies the change', async () => {
    await setOverrideCommand(deps({ projectId: () => undefined }), id, 'on');
    expect(getAutopilotTicket(store, id).mode).toBe('on');
    expect(notes()).toEqual([]);
  });
});

describe('approveCommand', () => {
  it('grants one extra attempt for the only budget row, with a note', async () => {
    takeAutopilotAttempt(store, id, 'r', 'ci', 'build', 3);
    await approveCommand(deps());
    expect(getAutopilotBudget(store, id, 'r', 'ci')).toMatchObject({ extra: 1, attempts: 1 });
    expect(notes()).toEqual(['Autopilot: one more ci attempt approved']);
  });
  it('asks which row when there are several, and says so when there is none', async () => {
    takeAutopilotAttempt(store, id, 'r', 'ci', 'build', 3);
    takeAutopilotAttempt(store, id, 'r', 'conflicts', 'b1', 2);
    await approveCommand(deps({ pick: async (c) => c[1] }));
    expect(getAutopilotBudget(store, id, 'r', 'conflicts').extra).toBe(1);
    expect(getAutopilotBudget(store, id, 'r', 'ci').extra).toBe(0);
    await approveCommand(deps({ pick: async () => undefined }));
    const none = deps();
    store.db.prepare('DELETE FROM autopilot_budgets').run();
    await approveCommand(none);
    expect(none.said).toEqual(['AP-1 has no auto-fix attempt to extend.']);
  });
  it('takes an explicit target', async () => {
    await approveCommand(deps(), id, { repo: 'x', kind: 'ci' });
    expect(getAutopilotBudget(store, id, 'x', 'ci').extra).toBe(1);
  });
});

describe('stopCommand', () => {
  it('after-round sets the flag and keeps the session', async () => {
    const d = deps();
    await stopCommand(d, id, 'after-round');
    expect(getAutopilotTicket(store, id).stopAfter).toBe(true);
    expect(d.stopSession).not.toHaveBeenCalled();
    expect(d.said).toEqual(['Auto-fix stopped after this round for AP-1.']);
  });
  it('now also ends the session through the stop seam', async () => {
    const d = deps({ pick: async () => 'now' as never });
    await stopCommand(d);
    expect(d.stopSession).toHaveBeenCalledWith(id);
    expect(d.said).toEqual(['Auto-fix stopped now for AP-1.']);
    await stopCommand(deps({ pick: async () => undefined }), id);
  });
});
