import { describe, expect, it } from 'vitest';
import { ticketIdentityText, ticketStatus } from './ticketHead.js';

describe('ticketStatus', () => {
  const base = { stageCurrent: 'impl', paused: false, agentState: 'running' };
  it.each([
    [{ ...base, stageCurrent: 'closed' }, 'Closed', 'info'],
    [{ ...base, stageCurrent: 'done' }, 'Done', 'passed'],
    [{ ...base, paused: true }, 'Paused', 'attention'],
    [{ ...base, agentState: 'waiting' }, 'Needs you', 'attention'],
    [{ ...base, agentState: 'not-started' }, 'Needs you', 'attention'],
    [base, 'Running', 'running'],
    [{ ...base, agentState: 'idle' }, 'Idle', 'info'],
  ])('%j → %s', (input, word, tone) => {
    expect(ticketStatus(input)).toEqual({ word, tone });
  });

  it('paused wins over a waiting agent, and a finished ticket over both', () => {
    expect(ticketStatus({ stageCurrent: 'impl', paused: true, agentState: 'waiting' }).word).toBe('Paused');
    expect(ticketStatus({ stageCurrent: 'done', paused: true, agentState: 'waiting' }).word).toBe('Done');
  });
});

describe('ticketIdentityText', () => {
  it('is T<id> · KEY · Title, and drops an empty key', () => {
    expect(ticketIdentityText('T583', 'ABC-123', 'Fix it')).toBe('T583 · ABC-123 · Fix it');
    expect(ticketIdentityText('T583', '', 'Fix it')).toBe('T583 · Fix it');
  });
});
