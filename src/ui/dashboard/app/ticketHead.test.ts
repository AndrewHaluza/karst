import { describe, expect, it } from 'vitest';
import { ticketIdentityText, ticketStatus } from './ticketHead.js';

describe('ticketStatus', () => {
  const base = { stageCurrent: 'impl', paused: false, agentState: 'running' };
  it.each([
    [{ ...base, stageCurrent: 'closed' }, 'Closed', 'info'],
    [{ ...base, paused: true }, 'Paused', 'attention'],
    [{ ...base, agentState: 'waiting' }, 'Needs you', 'attention'],
    [{ ...base, agentState: 'not-started' }, 'Needs you', 'attention'],
    [{ ...base, agentState: 'interrupted' }, 'Interrupted', 'attention'],
  ])('%j → %s', (input, word, tone) => {
    expect(ticketStatus(input)).toEqual({ word, tone });
  });

  it.each(['running', 'idle', null])('gives no pill for agent state %s (the runtime strip shows it)', (agentState) => {
    expect(ticketStatus({ ...base, agentState })).toBeNull();
  });

  it('gives a done ticket no chip at all: the stepper already ends in DONE', () => {
    expect(ticketStatus({ ...base, stageCurrent: 'done' })).toBeNull();
  });

  it('keeps done quiet even while paused, waiting, not started or interrupted', () => {
    for (const input of [
      { paused: true },
      { agentState: 'waiting' },
      { agentState: 'not-started' },
      { agentState: 'interrupted' },
    ]) {
      expect(ticketStatus({ ...base, stageCurrent: 'done', ...input }), JSON.stringify(input)).toBeNull();
    }
  });

  it('paused wins over a waiting agent, and closed wins over both and over interrupted', () => {
    expect(ticketStatus({ stageCurrent: 'impl', paused: true, agentState: 'waiting' })?.word).toBe('Paused');
    expect(ticketStatus({ stageCurrent: 'closed', paused: true, agentState: 'waiting' })?.word).toBe('Closed');
    expect(ticketStatus({ stageCurrent: 'closed', paused: false, agentState: 'interrupted' })?.word).toBe('Closed');
  });
});

describe('ticketIdentityText', () => {
  it('is T<id> · KEY · Title, and drops an empty key', () => {
    expect(ticketIdentityText('T583', 'ABC-123', 'Fix it')).toBe('T583 · ABC-123 · Fix it');
    expect(ticketIdentityText('T583', '', 'Fix it')).toBe('T583 · Fix it');
  });
});
