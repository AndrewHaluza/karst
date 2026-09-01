import { describe, it, expect } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  appendTicketLog,
  listTicketLogs,
  debugModule,
  TICKET_LOG_RETENTION,
  type TicketLog,
} from './ticketLogs.js';

function store(): Store {
  return openStore(':memory:');
}

describe('appendTicketLog / listTicketLogs', () => {
  it('appends a debug line and reads it back oldest-first', () => {
    const s = store();
    appendTicketLog(s, { ticketId: 7, module: '[driver]', message: 'entry', recordedAt: 'a' });
    appendTicketLog(s, { ticketId: 7, module: '[gate]', message: 'decision', recordedAt: 'b' });

    const logs = listTicketLogs(s, 7);
    expect(logs.map((l) => l.message)).toEqual(['entry', 'decision']);
    expect(logs[0]).toMatchObject({ ticketId: 7, module: '[driver]', level: 'debug' });
  });

  it('scopes logs per ticket', () => {
    const s = store();
    appendTicketLog(s, { ticketId: 1, module: '[driver]', message: 'one', recordedAt: 'a' });
    appendTicketLog(s, { ticketId: 2, module: '[gate]', message: 'two', recordedAt: 'b' });

    expect(listTicketLogs(s, 1).map((l) => l.message)).toEqual(['one']);
    expect(listTicketLogs(s, 2).map((l) => l.message)).toEqual(['two']);
  });

  it('prunes a ticket to the retention cap, keeping the newest', () => {
    const s = store();
    const n = TICKET_LOG_RETENTION + 10;
    for (let i = 0; i < n; i++) {
      appendTicketLog(s, { ticketId: 9, module: '[driver]', message: `m${i}`, recordedAt: String(i) });
    }

    const logs = listTicketLogs(s, 9);
    expect(logs).toHaveLength(TICKET_LOG_RETENTION);
    // The newest 200 survive, oldest-first.
    expect(logs[0]!.message).toBe('m10');
    expect(logs[logs.length - 1]!.message).toBe(`m${n - 1}`);
  });

  it('returns nothing for a ticket with no logs', () => {
    const s = store();
    expect(listTicketLogs(s, 123)).toEqual([]);
  });

  it('honors a smaller limit', () => {
    const s = store();
    for (let i = 0; i < 5; i++) {
      appendTicketLog(s, { ticketId: 4, module: '[gate]', message: `m${i}`, recordedAt: String(i) });
    }
    const logs = listTicketLogs(s, 4, 2);
    // The NEWEST two, oldest-first within the window.
    expect(logs.map((l: TicketLog) => l.message)).toEqual(['m3', 'm4']);
  });
});

describe('debugModule', () => {
  it('extracts a leading bracketed prefix', () => {
    expect(debugModule('[driver] ticket 1: loop entry')).toBe('[driver]');
    expect(debugModule('[agent:claude] spawn')).toBe('[agent:claude]');
    expect(debugModule('  [gate] run')).toBe('[gate]');
  });

  it('falls back to [ticket] for an unprefixed line', () => {
    expect(debugModule('plain line')).toBe('[ticket]');
    expect(debugModule('')).toBe('[ticket]');
  });
});