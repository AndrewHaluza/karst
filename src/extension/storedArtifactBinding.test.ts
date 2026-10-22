import { beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => {
  const state = { provider: undefined as undefined | { provideTextDocumentContent(uri: { toString(): string }): string } };
  const disposed: string[] = [];
  const uriFrom = (c: { scheme: string; path: string; query: string }) => ({ ...c, toString: () => `${c.scheme}:${c.path}?${c.query}` });
  return {
    state,
    disposed,
    registerTextDocumentContentProvider: vi.fn((_s: string, p: never) => { state.provider = p; return { dispose: () => disposed.push('provider') }; }),
    openTextDocument: vi.fn(async (u: unknown) => ({ u })),
    setTextDocumentLanguage: vi.fn(async () => {}),
    showTextDocument: vi.fn(async () => {}),
    executeCommand: vi.fn(async () => {}),
    showWarningMessage: vi.fn(),
    uriFrom: vi.fn(uriFrom),
    uriFile: vi.fn((p: string) => ({ file: p })),
  };
});

vi.mock('vscode', () => ({
  EventEmitter: class { event = 'ev'; dispose() { v.disposed.push('emitter'); } },
  Uri: { from: v.uriFrom, file: v.uriFile },
  workspace: { registerTextDocumentContentProvider: v.registerTextDocumentContentProvider, openTextDocument: v.openTextDocument },
  languages: { setTextDocumentLanguage: v.setTextDocumentLanguage },
  window: { showTextDocument: v.showTextDocument, showWarningMessage: v.showWarningMessage },
  commands: { executeCommand: v.executeCommand },
  Disposable: { from: (...ds: { dispose(): void }[]) => ({ dispose: () => ds.forEach((d) => d.dispose()) }) },
}));

const ops = vi.hoisted(() => ({
  makeStoredArtifactActionsForTicket: vi.fn(() => 'actions'),
  loader: vi.fn(),
  makeStoredArtifactsLoader: vi.fn(),
}));
ops.makeStoredArtifactsLoader.mockReturnValue(ops.loader);
vi.mock('./ops/storedArtifactOps.js', () => ({
  makeStoredArtifactActionsForTicket: ops.makeStoredArtifactActionsForTicket,
  makeStoredArtifactsLoader: ops.makeStoredArtifactsLoader,
}));

import { createStoredArtifactBinding } from './storedArtifactBinding.js';

const deps = { registry: {} as never, notify: {} as never, artifactsRoot: '/a', fallbackProjectId: () => 4, manifest: () => undefined };

beforeEach(() => {
  vi.clearAllMocks();
  v.disposed.length = 0;
  v.state.provider = undefined;
  ops.makeStoredArtifactsLoader.mockReturnValue(ops.loader);
});

describe('createStoredArtifactBinding', () => {
  it('registers the read-only scheme and exposes the loader', () => {
    const b = createStoredArtifactBinding(deps);
    expect(v.registerTextDocumentContentProvider).toHaveBeenCalledWith('karst-artifact', expect.objectContaining({ onDidChange: 'ev' }));
    expect(ops.makeStoredArtifactsLoader).toHaveBeenCalledWith(deps);
    expect(b.load).toBe(ops.loader);
  });

  it('showReadOnly serves the text under a sanitized, sequenced uri and opens it', async () => {
    const b = createStoredArtifactBinding(deps);
    await b.showReadOnly('a/b c.diff', 'BODY', 'diff');
    expect(v.uriFrom).toHaveBeenCalledWith({ scheme: 'karst-artifact', path: '/a_b c.diff', query: '1' });
    const uri = v.uriFrom.mock.results[0]!.value;
    expect(v.state.provider!.provideTextDocumentContent(uri)).toBe('BODY');
    expect(v.state.provider!.provideTextDocumentContent({ toString: () => 'other' })).toBe('');
    expect(v.openTextDocument).toHaveBeenCalledWith(uri);
    expect(v.setTextDocumentLanguage).toHaveBeenCalledWith({ u: uri }, 'diff');
    expect(v.showTextDocument).toHaveBeenCalledWith({ u: uri }, { preview: true });
    await b.showReadOnly('x', 'T');
    expect(v.uriFrom).toHaveBeenLastCalledWith({ scheme: 'karst-artifact', path: '/x', query: '2' });
    expect(v.setTextDocumentLanguage).toHaveBeenCalledTimes(1);
  });

  it('keeps allowed title characters', async () => {
    const b = createStoredArtifactBinding(deps);
    await b.showReadOnly('Ab_9.@ -', 't');
    expect(v.uriFrom).toHaveBeenCalledWith(expect.objectContaining({ path: '/Ab_9.@ -' }));
  });

  it('forTicket binds the ui actions to the vscode window/commands', async () => {
    const b = createStoredArtifactBinding(deps);
    const refresh = vi.fn();
    expect(b.forTicket(9, refresh)).toBe('actions');
    const arg = (ops.makeStoredArtifactActionsForTicket.mock.calls as unknown as [Record<string, unknown>][])[0]![0] as {
      ui: { openFile(p: string): Promise<void>; reveal(p: string): Promise<void>; confirm(m: string): Promise<boolean> };
    } & Record<string, unknown>;
    expect(arg).toMatchObject({ registry: deps.registry, artifactsRoot: '/a', fallbackProjectId: 4, notify: deps.notify, ticketId: 9, refresh });
    await arg.ui.openFile('/f');
    expect(v.openTextDocument).toHaveBeenCalledWith({ file: '/f' });
    expect(v.showTextDocument).toHaveBeenCalledWith({ u: { file: '/f' } }, { preview: true });
    await arg.ui.reveal('/r');
    expect(v.executeCommand).toHaveBeenCalledWith('revealFileInOS', { file: '/r' });
    v.showWarningMessage.mockResolvedValueOnce('Purge artifacts');
    await expect(arg.ui.confirm('sure?')).resolves.toBe(true);
    expect(v.showWarningMessage).toHaveBeenCalledWith('sure?', { modal: true }, 'Purge artifacts');
    v.showWarningMessage.mockResolvedValueOnce(undefined);
    await expect(arg.ui.confirm('sure?')).resolves.toBe(false);
  });

  it('dispose releases provider, emitter and clears served docs', async () => {
    const b = createStoredArtifactBinding(deps);
    await b.showReadOnly('t', 'X');
    const uri = v.uriFrom.mock.results[0]!.value;
    b.dispose();
    expect(v.disposed.sort()).toEqual(['emitter', 'provider']);
    expect(v.state.provider!.provideTextDocumentContent(uri)).toBe('');
  });
});
