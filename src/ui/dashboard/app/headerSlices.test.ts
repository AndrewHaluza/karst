import { describe, expect, it } from 'vitest';
import type { DashboardState } from '../state.js';
import type { DashboardSnapshot } from './dashboardStore.js';
import { selectIdentity } from './headerSlices.js';

/**
 * `priority` was a plain display string before T1396. `vscode.setState` is the upgrade contract across builds, so a
 * restored panel hands the header the old shape on its first render (see viewPersistence.ts).
 */
const identity = (priority: unknown) =>
  selectIdentity({
    state: {
      idLabel: 'T1',
      key: 'FEAT-1',
      title: 'Title',
      provider: null,
      priority,
      ticketUrl: null,
      stageCurrent: 'impl',
      paused: false,
      agentState: 'idle',
    } as unknown as DashboardState,
  } as DashboardSnapshot);

describe('selectIdentity — priority view', () => {
  it('trims the word of the current shape', () => {
    expect(identity({ level: 'high', text: ' high ', source: 'you' })?.priority).toEqual({ level: 'high', text: 'high', source: 'you' });
  });

  it('upgrades a legacy level string to the view, with no source to claim', () => {
    expect(identity(' high ')?.priority).toEqual({ level: 'high', text: 'high', source: null });
  });

  it('keeps a legacy provider label that names no level in the neutral look', () => {
    expect(identity('P2')?.priority).toEqual({ level: null, text: 'P2', source: null });
  });

  it('keeps a legacy normal level so the chip draws nothing', () => {
    expect(identity('normal')?.priority).toEqual({ level: 'normal', text: 'normal', source: null });
  });

  it('reads a blank, null or absent legacy value as no priority', () => {
    expect(identity('')?.priority).toBeNull();
    expect(identity('   ')?.priority).toBeNull();
    expect(identity(null)?.priority).toBeNull();
    expect(identity(undefined)?.priority).toBeNull();
  });
});
