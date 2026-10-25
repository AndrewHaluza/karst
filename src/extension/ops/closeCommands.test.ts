import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { formatTicketRef } from '../../model/entityId.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { transition } from '../../workflow/machine.js';
import { closeTicket } from '../../workflow/closeTicket.js';
import { registerCloseCommands, type CloseCommandsUi } from './closeCommands.js';

type Handler = (arg?: unknown) => Promise<void>;

function setup(
  opts: { active?: number; inputs?: (string | undefined)[]; pick?: number; projectId?: number } = {},
) {
  const store = openStore(':memory:');
  const a = createTicketFlow(store, { key: 'A-1', title: 'a' }).id;
  transition(store, a, 'scope', { kind: 'passed' });
  const b = createTicketFlow(store, { key: 'B-1', title: 'b' }).id;
  transition(store, b, 'scope', { kind: 'passed' });
  const handlers = new Map<string, Handler>();
  const inputs = [...(opts.inputs ?? ['Sam did it', ''])];
  const picked: { label: string; ticketId: number }[][] = [];
  const ui: CloseCommandsUi = {
    registerCommand: (id, h) => {
      handlers.set(id, h as Handler);
      return { dispose: () => handlers.delete(id) };
    },
    showInputBox: vi.fn(async () => inputs.shift()),
    pickTicket: vi.fn(async (picks) => {
      picked.push([...picks]);
      return opts.pick;
    }),
  };
  const info = vi.fn();
  const disposables = registerCloseCommands({
    ui,
    store,
    projectId: () => opts.projectId,
    activeTicketId: () => opts.active,
    notify: { info, warn: vi.fn(), error: vi.fn(async () => {}) },
    log: { error: vi.fn() },
    stopWork: vi.fn(),
    refresh: vi.fn(),
  });
  return { store, a, b, handlers, ui, info, picked, disposables };
}

describe('registerCloseCommands', () => {
  it('registers both commands and disposes them', () => {
    const { handlers, disposables } = setup();
    expect([...handlers.keys()].sort()).toEqual(['karst.closeTicket', 'karst.reopenTicket']);
    disposables.forEach((d) => d.dispose());
    expect(handlers.size).toBe(0);
  });

  it('closes the ticket named by the argument, treating a blank ref as none', async () => {
    const { store, a, handlers, ui } = setup();
    await handlers.get('karst.closeTicket')!(a);
    expect(getTicket(store, a).stageCurrent).toBe('closed');
    expect(getTicket(store, a).stages.find((s) => s.stageKey === 'closed')?.verdict).toBe('Sam did it');
    expect(ui.showInputBox).toHaveBeenCalledTimes(2);
  });

  it('keeps a given ref', async () => {
    const { store, a, handlers } = setup({ inputs: ['Sam did it', 'CU-9'] });
    await handlers.get('karst.closeTicket')!({ ticketId: a });
    expect(getTicket(store, a).stages.find((s) => s.stageKey === 'closed')?.verdict).toBe('Sam did it (CU-9)');
  });

  it('uses the active ticket when no argument is given and it is closable', async () => {
    const probe = setup();
    const { store, a, handlers, picked } = setup({ active: probe.a });
    await handlers.get('karst.closeTicket')!();
    expect(getTicket(store, a).stageCurrent).toBe('closed');
    expect(picked).toEqual([]);
  });

  it('ignores an active ticket that is already closed and asks instead', async () => {
    const probe = setup();
    const { store, a, b, handlers, picked } = setup({ active: probe.a, pick: probe.b });
    closeTicket(store, a, { reason: 'earlier' });
    await handlers.get('karst.closeTicket')!();
    expect(picked[0]!.map((p) => p.ticketId)).toEqual([b]);
    expect(getTicket(store, b).stageCurrent).toBe('closed');
  });

  it('offers only unfinished tickets in the picker and closes the pick', async () => {
    const { store, a, b, handlers, picked } = setup({ pick: 0 });
    closeTicket(store, a, { reason: 'earlier' });
    const h = handlers.get('karst.closeTicket')!;
    await h();
    expect(picked[0]!.map((p) => p.ticketId)).toEqual([b]);
  });

  it('does nothing when the picker is dismissed or the reason prompt is cancelled', async () => {
    const dismissed = setup();
    await dismissed.handlers.get('karst.closeTicket')!();
    expect(dismissed.ui.showInputBox).not.toHaveBeenCalled();

    const cancelled = setup({ inputs: [undefined] });
    await cancelled.handlers.get('karst.closeTicket')!(cancelled.a);
    expect(getTicket(cancelled.store, cancelled.a).stageCurrent).toBe('impl');
  });

  it('reopens a closed ticket from the picker of closed tickets', async () => {
    const { store, a, handlers, picked } = setup();
    closeTicket(store, a, { reason: 'r' });
    await handlers.get('karst.reopenTicket')!(a);
    expect(getTicket(store, a).stageCurrent).toBe('impl');
    expect(picked).toEqual([]);
  });

  it('offers only closed tickets when reopening without an argument', async () => {
    const { store, a, handlers, picked } = setup();
    closeTicket(store, a, { reason: 'r' });
    await handlers.get('karst.reopenTicket')!();
    expect(picked[0]!.map((p) => p.ticketId)).toEqual([a]);
  });

  it('rejects a blank reason in the input box validator', async () => {
    const { a, handlers, ui } = setup();
    await handlers.get('karst.closeTicket')!(a);
    const opts = (ui.showInputBox as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(opts.validateInput('  ')).toMatch(/reason/i);
    expect(opts.validateInput('ok')).toBeUndefined();
  });
});

describe('prompts, labels and scoping', () => {
  it('words the reason and reference prompts exactly', async () => {
    const { a, handlers, ui } = setup();
    await handlers.get('karst.closeTicket')!(a);
    const calls = (ui.showInputBox as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls[0]).toMatchObject({
      title: 'Close ticket — resolved outside karst',
      prompt: 'Why is this ticket closed? (e.g. "Sam did it in CU-123"). Nothing is verified.',
    });
    expect(calls[0].validateInput('')).toBe('A reason is required.');
    expect(calls[1]).toEqual({
      title: 'Close ticket — reference (optional)',
      prompt: 'A link, SHA or ticket key for the outside work. Stored, never verified.',
    });
  });

  it('cancelling the optional reference prompt cancels the whole close', async () => {
    const { store, a, handlers } = setup({ inputs: ['Sam did it', undefined] });
    await handlers.get('karst.closeTicket')!(a);
    expect(getTicket(store, a).stageCurrent).toBe('impl');
  });

  it('treats a whitespace-only reference as none', async () => {
    const { store, a, handlers } = setup({ inputs: ['Sam did it', '   '] });
    await handlers.get('karst.closeTicket')!(a);
    expect(getTicket(store, a).stages.find((s) => s.stageKey === 'closed')?.verdict).toBe('Sam did it');
  });

  it('labels picks with the ticket ref and title, and words the placeholders', async () => {
    const { a, handlers, ui, picked } = setup();
    await handlers.get('karst.closeTicket')!();
    expect(picked[0]!.find((p) => p.ticketId === a)).toEqual({
      label: formatTicketRef(a, 'A-1'),
      description: 'a',
      ticketId: a,
    });
    expect((ui.pickTicket as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(
      'Close which ticket? (resolved outside karst)',
    );
    await handlers.get('karst.reopenTicket')!();
    expect((ui.pickTicket as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toBe('Reopen which closed ticket?');
  });

  it('offers only the bound project\'s tickets', async () => {
    const store = openStore(':memory:');
    const p1 = upsertProject(store, { slug: 'p1' });
    const p2 = upsertProject(store, { slug: 'p2' });
    const mine = createTicket(store, { key: 'M-1', title: 'm', projectId: p1.id });
    createTicket(store, { key: 'O-1', title: 'o', projectId: p2.id });
    const picked: number[][] = [];
    const registered = new Map<string, (arg?: unknown) => Promise<void>>();
    registerCloseCommands({
      ui: {
        registerCommand: (id, h) => (registered.set(id, h), { dispose: () => {} }),
        showInputBox: vi.fn(),
        pickTicket: async (picks) => (picked.push(picks.map((x) => x.ticketId)), undefined),
      },
      store,
      projectId: () => p1.id,
      activeTicketId: () => undefined,
      notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => {}) },
      log: { error: vi.fn() },
      stopWork: vi.fn(),
      refresh: vi.fn(),
    });
    await registered.get('karst.closeTicket')!();
    expect(picked).toEqual([[mine.id]]);
  });
});
