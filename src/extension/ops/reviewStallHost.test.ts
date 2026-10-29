import { describe, it, expect, vi } from 'vitest';
import { buildActionDeps, hostFromVscode, registerStallCommands, type StallHost } from './reviewStallHost.js';

const base = {
  store: {} as never, ticketId: 7, afterServerChange: vi.fn(), logError: vi.fn(), debug: vi.fn(), drive: vi.fn(),
};
const host = (over: Partial<StallHost> = {}): StallHost => ({
  info: vi.fn(), error: vi.fn(), warn: vi.fn(async () => 'Continue'), input: vi.fn(async () => 'hint'),
  executeCommand: vi.fn(), registerCommand: vi.fn((name: string) => ({ dispose: () => name })),
  ...over,
});

describe('buildActionDeps', () => {
  it('forwards info and error messages', () => {
    const h = host();
    const d = buildActionDeps(h, base);
    d.info('i');
    d.error('e');
    expect(h.info).toHaveBeenCalledWith('i');
    expect(h.error).toHaveBeenCalledWith('e');
  });
  it('confirm is a modal warning that resolves true only on Continue', async () => {
    const h = host();
    expect(await buildActionDeps(h, base).confirm('T', 'D')).toBe(true);
    expect(h.warn).toHaveBeenCalledWith('T', 'D', 'Continue');
    expect(await buildActionDeps(host({ warn: vi.fn(async () => undefined) }), base).confirm('T', 'D')).toBe(false);
  });
  it('promptHint asks for the hint', async () => {
    const h = host();
    expect(await buildActionDeps(h, base).promptHint()).toBe('hint');
    expect(h.input).toHaveBeenCalledWith({
      prompt: 'Redesign hint for the fix agent',
      placeHolder: 'e.g. split this module instead of patching it again',
    });
  });
  it('keeps the shared deps', () => {
    expect(buildActionDeps(host(), base).ticketId).toBe(7);
  });
});

describe('registerStallCommands', () => {
  const setup = () => {
    const h = host();
    const drive = vi.fn();
    const run = vi.fn();
    registerStallCommands(h, { ...base, ticketId: undefined as never, drive } as never, run);
    const handlers = new Map((h.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[0], c[1]]));
    return { h, drive, run, handlers };
  };
  it('registers the three commands', () => {
    expect([...setup().handlers.keys()]).toEqual([
      'karst.reviewStallHint', 'karst.reviewStallContinue', 'karst.reviewStallRescope',
    ]);
  });
  it('ignores an arg without a ticket id', () => {
    const { handlers, run } = setup();
    handlers.get('karst.reviewStallHint')!({});
    expect(run).not.toHaveBeenCalled();
  });
  it('routes each command to its answer for the ticket', () => {
    const { handlers, run, h, drive } = setup();
    for (const [name, pick] of [
      ['karst.reviewStallHint', 'reviewStallHint'],
      ['karst.reviewStallContinue', 'reviewStallContinue'],
      ['karst.reviewStallRescope', 'reviewStallRescope'],
    ] as const) {
      run.mockClear();
      handlers.get(name)!(9);
      expect(run).toHaveBeenCalledWith(pick, expect.objectContaining({ ticketId: 9 }));
    }
    const deps = run.mock.calls[0]![1];
    deps.drive();
    expect(drive).toHaveBeenCalledWith(9);
    deps.editTicket();
    expect(h.executeCommand).toHaveBeenCalledWith('karst.editTicket', 9);
  });
});

describe('hostFromVscode', () => {
  const fake = () => ({
    window: {
      showInformationMessage: vi.fn(() => 'x'), showErrorMessage: vi.fn(() => 'x'),
      showWarningMessage: vi.fn(async () => 'Continue'), showInputBox: vi.fn(async () => 'typed'),
    },
    commands: { executeCommand: vi.fn(() => 'x'), registerCommand: vi.fn(() => ({ dispose: () => 'd' })) },
  });
  it('maps each call onto the matching vscode API and drops return values', async () => {
    const api = fake();
    const h = hostFromVscode(api);
    expect(h.info('i')).toBeUndefined();
    expect(h.error('e')).toBeUndefined();
    expect(h.executeCommand('c', 1, 2)).toBeUndefined();
    expect(api.window.showInformationMessage).toHaveBeenCalledWith('i');
    expect(api.window.showErrorMessage).toHaveBeenCalledWith('e');
    expect(api.commands.executeCommand).toHaveBeenCalledWith('c', 1, 2);
    expect(await h.warn('t', 'd', 'b')).toBe('Continue');
    expect(api.window.showWarningMessage).toHaveBeenCalledWith('t', { modal: true, detail: 'd' }, 'b');
    expect(await h.input({ prompt: 'p', placeHolder: 'h' })).toBe('typed');
    expect(api.window.showInputBox).toHaveBeenCalledWith({ prompt: 'p', placeHolder: 'h', ignoreFocusOut: true });
    const fn = () => undefined;
    h.registerCommand('n', fn);
    expect(api.commands.registerCommand).toHaveBeenCalledWith('n', fn);
  });
});
