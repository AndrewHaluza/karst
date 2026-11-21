import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), open: vi.fn(), showDoc: vi.fn(), register: vi.fn(),
}));
vi.mock('vscode', () => ({
  window: { showInformationMessage: m.info, showWarningMessage: m.warn, showErrorMessage: m.error, showTextDocument: m.showDoc },
  workspace: { openTextDocument: m.open, registerTextDocumentContentProvider: m.register },
  Uri: { from: (c: object) => c },
  ViewColumn: { Beside: -2 },
}));
import { ask, bindToastRecorder, boundModalDetail, MODAL_DETAIL_LIMITS, recordOnly, showToast, toast } from './toastSeam.js';

const LIMITS = { maxLines: 3, maxChars: 40 };

describe('boundModalDetail', () => {
  it('keeps a detail under both limits', () => {
    expect(boundModalDetail('a\nb', LIMITS, 'T')).toEqual({ detail: 'a\nb', cut: false });
  });
  it('cuts at the line limit at a line end and adds the pointer line', () => {
    const r = boundModalDetail('a\nb\nc\nd\ne', LIMITS, 'My title');
    expect(r.cut).toBe(true);
    expect(r.detail).toBe('a\nb\nc\nThe full text is in the editor tab "My title".');
  });
  it('cuts at the character limit at a line end', () => {
    const r = boundModalDetail(`${'x'.repeat(25)}\n${'y'.repeat(25)}`, LIMITS, 'T');
    expect(r).toEqual({ detail: `${'x'.repeat(25)}\nThe full text is in the editor tab "T".`, cut: true });
  });
  it('cuts one very long line at the character limit', () => {
    const r = boundModalDetail('z'.repeat(500), LIMITS, 'T');
    expect(r.detail).toBe(`${'z'.repeat(40)}\nThe full text is in the editor tab "T".`);
  });
  it('leaves the pointer line out without a title', () => {
    expect(boundModalDetail('a\nb\nc\nd', LIMITS)).toEqual({ detail: 'a\nb\nc', cut: true });
  });
  it('keeps a detail exactly at both limits', () => {
    expect(boundModalDetail('a\nb\nc', LIMITS).cut).toBe(false);
    expect(boundModalDetail('x'.repeat(40), LIMITS).cut).toBe(false);
    expect(boundModalDetail('x'.repeat(41), LIMITS).cut).toBe(true);
    expect(boundModalDetail('a\nb\nc\nd', LIMITS).cut).toBe(true);
  });
  it('keeps a last line that ends exactly on the character limit', () => {
    const r = boundModalDetail(`${'a'.repeat(19)}\n${'b'.repeat(20)}\nc`, LIMITS);
    expect(r.detail).toBe(`${'a'.repeat(19)}\n${'b'.repeat(20)}`);
    const r2 = boundModalDetail(`${'a'.repeat(19)}\n${'b'.repeat(21)}\nc`, LIMITS);
    expect(r2.detail).toBe('a'.repeat(19));
  });
  it('uses 15 lines and 1000 characters by default', () => {
    expect(MODAL_DETAIL_LIMITS).toEqual({ maxLines: 15, maxChars: 1000 });
  });
});

describe('toastSeam', () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    m.info.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve('Yes'); });
    m.warn.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve(undefined); });
    m.error.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve(undefined); });
    bindToastRecorder(undefined);
    m.open.mockReset().mockImplementation(() => { order.push('open'); return Promise.resolve({}); });
    m.showDoc.mockReset().mockResolvedValue(undefined);
  });

  describe('ask with a modal detail', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    it('registers the content provider once (this test runs first: the seam binds it at its first use) and serves the full text by uri', async () => {
      await ask.warn('One', { modal: true, detail: long });
      await ask.warn('Two', { modal: true, detail: `${long}\nmore` });
      expect(m.register).toHaveBeenCalledTimes(1);
      expect(m.register.mock.calls[0]![0]).toBe('karst-modal-detail');
      const provider = m.register.mock.calls[0]![1] as { provideTextDocumentContent: (u: { path: string }) => string };
      const [a, b] = m.open.mock.calls.map((c) => (c[0] as { scheme: string; path: string }));
      expect(a!.scheme).toBe('karst-modal-detail');
      expect(a!.path).toMatch(/^\/\d+\/One$/u);
      expect(b!.path).not.toBe(a!.path);
      expect(provider.provideTextDocumentContent(a!)).toBe(long);
      expect(provider.provideTextDocumentContent(b!)).toBe(`${long}\nmore`);
      expect(provider.provideTextDocumentContent({ path: '/nope' })).toBe('');
    });
    it('opens the full text once in a tab before the capped modal', async () => {
      await ask.warn('Apply setup?', { modal: true, detail: long }, 'Apply');
      expect(order).toEqual(['open', 'show']);
      expect(m.open).toHaveBeenCalledTimes(1);
      expect(m.showDoc).toHaveBeenCalledWith({}, { preview: true, viewColumn: -2, preserveFocus: true });
      const [msg, opts, label] = m.warn.mock.calls[0] as [string, { modal: boolean; detail: string }, string];
      expect([msg, label, opts.modal]).toEqual(['Apply setup?', 'Apply', true]);
      expect(opts.detail.endsWith('The full text is in the editor tab "Apply setup?".')).toBe(true);
      expect(opts.detail.split('\n')).toHaveLength(16);
    });
    it('builds the tab title from the message: one line, no slash, at most 60 characters', async () => {
      await ask.warn('a//b\n\nc\\d', { modal: true, detail: long });
      await ask.warn('', { modal: true, detail: long });
      await ask.warn('\nHi\n', { modal: true, detail: long });
      await ask.warn('x'.repeat(60), { modal: true, detail: long });
      await ask.warn('y'.repeat(61), { modal: true, detail: long });
      const paths = m.open.mock.calls.map((c) => (c[0] as { path: string }).path.replace(/^\/\d+\//u, ''));
      expect(paths).toEqual(['a b c d', 'Details', 'Hi', 'x'.repeat(60), `${'y'.repeat(59)}…`]);
    });
    it('passes a modal with a null or a non-string detail through unchanged', async () => {
      await ask.warn('A', null);
      await ask.warn('B', { modal: true });
      await ask.warn('C', { modal: true, detail: 5 });
      expect(m.open).not.toHaveBeenCalled();
      expect(m.warn).toHaveBeenNthCalledWith(1, 'A', null);
      expect(m.warn).toHaveBeenNthCalledWith(3, 'C', { modal: true, detail: 5 });
    });
    it('opens no tab for a short detail', async () => {
      await ask.info('Sure?', { modal: true, detail: 'short' }, 'Yes');
      expect(m.open).not.toHaveBeenCalled();
      expect(m.info).toHaveBeenCalledWith('Sure?', { modal: true, detail: 'short' }, 'Yes');
    });
    it('opens no tab for a long detail that is not modal', async () => {
      await ask.error('Hm', { detail: long });
      expect(m.open).not.toHaveBeenCalled();
    });
    it('shows the capped detail without the pointer line when the tab fails', async () => {
      m.open.mockRejectedValueOnce(new Error('no'));
      await ask.warn('Q', { modal: true, detail: long });
      const opts = m.warn.mock.calls[0]![1] as { detail: string };
      expect(opts.detail).not.toContain('editor tab');
      expect(opts.detail.split('\n')).toHaveLength(15);
    });
  });

  it('records the row first, then shows the same message at the same level', async () => {
    const record = vi.fn(() => { order.push('record'); });
    bindToastRecorder(record);
    await toast.warn('Careful', 'Open');
    expect(record).toHaveBeenCalledWith('warn', 'Careful', undefined);
    expect(order).toEqual(['record', 'show']);
    expect(m.warn).toHaveBeenCalledWith('Careful', 'Open');
  });

  it('maps information to info and passes the ticket id', () => {
    const record = vi.fn();
    bindToastRecorder(record);
    void showToast('info', 'Done', [], 7);
    expect(record).toHaveBeenCalledWith('info', 'Done', 7);
    expect(m.info).toHaveBeenCalledWith('Done');
  });

  it('still shows the toast when the recorder throws', () => {
    bindToastRecorder(() => { throw new Error('db gone'); });
    void toast.error('Boom');
    expect(m.error).toHaveBeenCalledWith('Boom');
  });

  it('shows a message with no action items by default', () => {
    void showToast('warn', 'plain');
    expect(m.warn).toHaveBeenCalledWith('plain');
  });

  it('shows without a row while no recorder is bound', () => {
    void toast.info('early');
    expect(m.info).toHaveBeenCalledWith('early');
  });

  it('never records an ask and returns the choice', async () => {
    const record = vi.fn();
    bindToastRecorder(record);
    await expect(ask.info('Sure?', { modal: true }, 'Yes')).resolves.toBe('Yes');
    expect(record).not.toHaveBeenCalled();
    expect(m.info).toHaveBeenCalledWith('Sure?', { modal: true }, 'Yes');
  });

  it('recordOnly writes the row and shows no message', () => {
    const record = vi.fn();
    bindToastRecorder(record);
    recordOnly('warn', 'Quiet', 3);
    expect(record).toHaveBeenCalledWith('warn', 'Quiet', 3);
    expect(m.info).not.toHaveBeenCalled();
    expect(m.warn).not.toHaveBeenCalled();
    expect(m.error).not.toHaveBeenCalled();
  });

  it('recordOnly does nothing without a recorder and survives a throwing one', () => {
    expect(() => recordOnly('info', 'early')).not.toThrow();
    bindToastRecorder(() => { throw new Error('db gone'); });
    expect(() => recordOnly('error', 'x')).not.toThrow();
  });
});
