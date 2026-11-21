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
    m.register.mockReset();
  });

  describe('ask with a modal detail', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
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
