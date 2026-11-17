import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('vscode', () => ({
  window: { showInformationMessage: m.info, showWarningMessage: m.warn, showErrorMessage: m.error },
}));
import { ask, bindToastRecorder, showToast, toast } from './toastSeam.js';

describe('toastSeam', () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    m.info.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve('Yes'); });
    m.warn.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve(undefined); });
    m.error.mockReset().mockImplementation(() => { order.push('show'); return Promise.resolve(undefined); });
    bindToastRecorder(undefined);
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
});
