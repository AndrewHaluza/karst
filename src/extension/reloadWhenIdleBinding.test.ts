import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../store/db.js';
import type { Drain } from '../runtime/drain.js';

const m = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  withProgress: vi.fn(),
  executeCommand: vi.fn(async () => undefined),
  registerCommand: vi.fn(),
  installReloadDrain: vi.fn(),
  makeReloadWhenIdleHandler: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { showInformationMessage: m.showInformationMessage, withProgress: m.withProgress },
  commands: { executeCommand: m.executeCommand, registerCommand: m.registerCommand },
  ProgressLocation: { Notification: 15 },
}));
vi.mock('./ops/reloadWhenIdleHost.js', () => ({
  installReloadDrain: m.installReloadDrain,
  makeReloadWhenIdleHandler: m.makeReloadWhenIdleHandler,
}));

import { registerReloadWhenIdle } from './reloadWhenIdleBinding.js';
import { RELOAD_WHEN_IDLE_COMMAND } from './ops/reloadWhenIdle.js';

const store = {} as Store;
const drain = {} as Drain;
const log = vi.fn();
const redrive = vi.fn();
type Host = {
  inform(message: string): void;
  withProgress(title: string, run: (report: (m: string) => void, onCancel: (l: () => void) => void) => Promise<void>): Promise<void>;
  reloadWindow(): Promise<void>;
};

function bind(): { host: Host; handler: unknown; disposable: unknown } {
  const handler = vi.fn();
  const disposable = { dispose: vi.fn() };
  m.makeReloadWhenIdleHandler.mockReturnValue(handler);
  m.registerCommand.mockReturnValue(disposable);
  const result = registerReloadWhenIdle(store, drain, log, redrive);
  return { host: m.makeReloadWhenIdleHandler.mock.calls[0]![4] as Host, handler, disposable: result };
}

describe('registerReloadWhenIdle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the drain and registers the handler under the command id', () => {
    const { handler, disposable } = bind();
    expect(m.installReloadDrain).toHaveBeenCalledWith(drain);
    expect(m.makeReloadWhenIdleHandler).toHaveBeenCalledWith(store, drain, log, redrive, expect.anything());
    expect(m.registerCommand).toHaveBeenCalledWith(RELOAD_WHEN_IDLE_COMMAND, handler);
    expect(disposable).toBe(m.registerCommand.mock.results[0]!.value);
  });

  it('informs through showInformationMessage and reloads through the workbench command', async () => {
    const { host } = bind();
    host.inform('hello');
    expect(m.showInformationMessage).toHaveBeenCalledWith('hello');
    await host.reloadWindow();
    expect(m.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('shows a cancellable notification progress and wires report and cancel', async () => {
    const { host } = bind();
    const report = vi.fn();
    let cancel: (() => void) | undefined;
    m.withProgress.mockImplementation(async (opts: unknown, task: (p: unknown, t: unknown) => Promise<void>) => {
      expect(opts).toEqual({ location: 15, title: 'T', cancellable: true });
      await task({ report }, { onCancellationRequested: (l: () => void) => { cancel = l; } });
    });
    const listener = vi.fn();
    await host.withProgress('T', async (rep, onCancel) => {
      rep('half');
      onCancel(listener);
    });
    expect(report).toHaveBeenCalledWith({ message: 'half' });
    cancel!();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
