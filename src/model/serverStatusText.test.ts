import { describe, it, expect } from 'vitest';
import { SERVER_STATUS_WORD, SERVER_STATUS_MARK, SERVER_VERB_LABEL, KEPT_RUNNING_CHIP } from './serverStatusText.js';

describe('serverStatusText', () => {
  it('has one word for each status, and no "Crashed" word', () => {
    expect(SERVER_STATUS_WORD).toEqual({
      running: 'Running',
      starting: 'Starting…',
      stopping: 'Stopping…',
      stopped: 'Stopped',
      failed: 'Failed',
      missing: 'Missing',
    });
    expect(Object.values(SERVER_STATUS_WORD)).not.toContain('Crashed');
  });

  it('gives each status a shape, and the failed shape is the cross', () => {
    expect(Object.keys(SERVER_STATUS_MARK).sort()).toEqual(Object.keys(SERVER_STATUS_WORD).sort());
    expect(SERVER_STATUS_MARK.failed).toBe('✕');
    expect(SERVER_STATUS_MARK.starting).toBe(SERVER_STATUS_MARK.stopping);
  });

  it('keeps the button and the chip words apart', () => {
    expect(SERVER_VERB_LABEL.keepRunning).toBe('Keep running');
    expect(KEPT_RUNNING_CHIP).toBe('Kept running');
    expect(SERVER_VERB_LABEL.stopServers).toBe('Stop servers');
    expect(SERVER_VERB_LABEL.stopProcess).toBe('Stop process');
  });
});
