import { describe, expect, it, vi } from 'vitest';
import { closeTerminalsOnTicketCompleted } from './completeTicketOps.js';

function run(setting: boolean | undefined, closeTerminals = vi.fn().mockReturnValue(2)) {
  const log = { info: vi.fn() };
  const logError = vi.fn();
  const manifest = () =>
    setting === undefined ? undefined : ({ closeDoneTerminalsWithTicket: setting } as never);
  closeTerminalsOnTicketCompleted(manifest, closeTerminals, log, logError, 7);
  return { closeTerminals, log, logError };
}

describe('closeTerminalsOnTicketCompleted', () => {
  it('closes and logs the count when the setting is on', () => {
    const d = run(true);
    expect(d.closeTerminals).toHaveBeenCalledWith(7);
    expect(d.log.info).toHaveBeenCalledWith(expect.stringContaining('2 terminal(s)'));
  });
  it('does nothing when the setting is off or manifest missing', () => {
    for (const s of [false, undefined]) expect(run(s).closeTerminals).not.toHaveBeenCalled();
  });
  it('does not log when nothing closed', () => {
    expect(run(true, vi.fn().mockReturnValue(0)).log.info).not.toHaveBeenCalled();
  });
  it('swallows and logs a disposal failure', () => {
    const boom = new Error('x');
    const d = run(true, vi.fn().mockImplementation(() => { throw boom; }));
    expect(d.logError).toHaveBeenCalledWith(expect.any(String), boom);
  });
});
