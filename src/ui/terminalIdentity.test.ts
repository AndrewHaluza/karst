import { describe, expect, it } from 'vitest';
import { KARST_LAUNCH_ENV, KARST_TICKET_ENV } from './session.js';
import {
  MAX_SESSION_TERMINAL_RECORDS,
  forgetSessionTerminal,
  identifyTerminal,
  parseSessionTerminalRecords,
  pruneSessionTerminals,
  rememberSessionTerminal,
  type SessionTerminalRecord,
} from './terminalIdentity.js';

const env = (ticketId: number, launchId?: string): Record<string, string> => ({
  [KARST_TICKET_ENV]: String(ticketId),
  ...(launchId ? { [KARST_LAUNCH_ENV]: launchId } : {}),
});

describe('identifyTerminal', () => {
  it('reads the ticket and generation out of a live terminal environment', () => {
    expect(identifyTerminal({ env: env(7, 'gen-1') }, [])).toEqual({
      ticketId: 7,
      launchId: 'gen-1',
    });
  });

  it('identifies a reloaded terminal by pid when VS Code dropped its env', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 7, launchId: 'gen-1', pid: 4242 },
    ];
    // A terminal reattached after a window reload reports NO env at all.
    expect(identifyTerminal({ pid: 4242 }, records)).toEqual({
      ticketId: 7,
      launchId: 'gen-1',
    });
  });

  it('recovers the recorded provider and model with a reloaded terminal', () => {
    const records = [{
      ticketId: 7,
      launchId: 'gen-1',
      pid: 4242,
      identity: { provider: 'codex', model: 'sol' },
    }] as SessionTerminalRecord[];

    expect(identifyTerminal({ pid: 4242 }, records)).toEqual({
      ticketId: 7,
      launchId: 'gen-1',
      identity: { provider: 'codex', model: 'sol' },
    });
  });

  it('recovers a legacy pid record identity from its durable launch generation', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 7, launchId: 'gen-1', pid: 4242 },
    ];
    expect(identifyTerminal({ pid: 4242 }, records, (launchId) => ({
      ticketId: 7,
      provider: launchId === 'gen-1' ? 'codex' : 'claude',
      model: 'sol',
      agentName: 'UAT Fix',
    }))).toEqual({
      ticketId: 7,
      launchId: 'gen-1',
      identity: { provider: 'codex', model: 'sol', agentName: 'UAT Fix' },
    });
  });

  it('does not borrow durable identity from another ticket\'s launch', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 7, launchId: 'gen-1', pid: 4242 },
    ];
    expect(identifyTerminal({ pid: 4242 }, records, () => ({
      ticketId: 9,
      provider: 'codex',
      model: 'sol',
    }))).toEqual({ ticketId: 7, launchId: 'gen-1' });
  });

  it('keeps the terminal identifiable when durable identity lookup is unavailable', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 7, launchId: 'gen-1', pid: 4242 },
    ];

    expect(identifyTerminal({ pid: 4242 }, records, () => {
      throw new Error('store already closed');
    })).toEqual({ ticketId: 7, launchId: 'gen-1' });
  });

  it('prefers the environment over a stale record for the same terminal', () => {
    const records: SessionTerminalRecord[] = [{ ticketId: 9, pid: 4242 }];
    expect(identifyTerminal({ env: env(7, 'gen-2'), pid: 4242 }, records)).toEqual({
      ticketId: 7,
      launchId: 'gen-2',
    });
  });

  it('claims nothing for an unknown pid and no env', () => {
    expect(identifyTerminal({ pid: 111 }, [{ ticketId: 7, pid: 4242 }])).toBeUndefined();
    expect(identifyTerminal({}, [{ ticketId: 7, pid: 4242 }])).toBeUndefined();
  });

  it('ignores an env that is not a positive integer ticket id', () => {
    expect(identifyTerminal({ env: { [KARST_TICKET_ENV]: '0' } }, [])).toBeUndefined();
    expect(identifyTerminal({ env: { [KARST_TICKET_ENV]: 'x' } }, [])).toBeUndefined();
  });
});

describe('rememberSessionTerminal', () => {
  it('returns a new list rather than mutating the given one', () => {
    const records: SessionTerminalRecord[] = [];
    const next = rememberSessionTerminal(records, { ticketId: 1, pid: 10 });
    expect(records).toEqual([]);
    expect(next).toEqual([{ ticketId: 1, pid: 10 }]);
  });

  it('replaces any earlier record for the same ticket', () => {
    const first = rememberSessionTerminal([], { ticketId: 1, launchId: 'a', pid: 10 });
    const next = rememberSessionTerminal(first, { ticketId: 1, launchId: 'b', pid: 11 });
    expect(next).toEqual([{ ticketId: 1, launchId: 'b', pid: 11 }]);
  });

  it('replaces any earlier record holding the same pid', () => {
    // The OS reuses pids: a record still naming one that a new terminal now owns
    // would hand that terminal to the wrong ticket.
    const first = rememberSessionTerminal([], { ticketId: 1, pid: 10 });
    const next = rememberSessionTerminal(first, { ticketId: 2, pid: 10 });
    expect(next).toEqual([{ ticketId: 2, pid: 10 }]);
  });

  it('keeps the list bounded, dropping the oldest records', () => {
    let records: SessionTerminalRecord[] = [];
    for (let i = 1; i <= MAX_SESSION_TERMINAL_RECORDS + 3; i++) {
      records = rememberSessionTerminal(records, { ticketId: i, pid: 1000 + i });
    }
    expect(records).toHaveLength(MAX_SESSION_TERMINAL_RECORDS);
    expect(records[0]).toEqual({ ticketId: 4, pid: 1004 });
  });
});

describe('forgetSessionTerminal', () => {
  it('drops the ticket record and leaves the rest untouched', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 1, pid: 10 },
      { ticketId: 2, pid: 11 },
    ];
    expect(forgetSessionTerminal(records, 1)).toEqual([{ ticketId: 2, pid: 11 }]);
    expect(records).toHaveLength(2);
  });
});

describe('pruneSessionTerminals', () => {
  it('keeps only records whose ticket still exists', () => {
    const records: SessionTerminalRecord[] = [
      { ticketId: 1, pid: 10 },
      { ticketId: 2, pid: 11 },
    ];
    expect(pruneSessionTerminals(records, [2, 3])).toEqual([{ ticketId: 2, pid: 11 }]);
  });
});

describe('parseSessionTerminalRecords', () => {
  it('accepts a persisted list of records', () => {
    expect(
      parseSessionTerminalRecords([
        { ticketId: 1, launchId: 'a', pid: 10 },
        { ticketId: 2, pid: 11 },
      ]),
    ).toEqual([
      { ticketId: 1, launchId: 'a', pid: 10 },
      { ticketId: 2, pid: 11 },
    ]);
  });

  it('accepts a durable session identity and drops malformed identities', () => {
    expect(
      parseSessionTerminalRecords([
        { ticketId: 1, pid: 10, identity: { provider: 'codex', model: 'sol' } },
        { ticketId: 2, pid: 11, identity: { provider: '', model: null } },
        { ticketId: 3, pid: 12, identity: { provider: 'claude', model: 5 } },
      ]),
    ).toEqual([
      { ticketId: 1, pid: 10, identity: { provider: 'codex', model: 'sol' } },
      { ticketId: 2, pid: 11 },
      { ticketId: 3, pid: 12 },
    ]);
  });

  it('drops entries that are not a usable ticket/pid pair', () => {
    expect(
      parseSessionTerminalRecords([
        null,
        'nope',
        { ticketId: 0, pid: 10 },
        { ticketId: 1, pid: 0 },
        { ticketId: 1.5, pid: 10 },
        { ticketId: 1, pid: 10, launchId: 5 },
        { ticketId: 2, pid: 11 },
      ]),
    ).toEqual([{ ticketId: 2, pid: 11 }]);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(parseSessionTerminalRecords(undefined)).toEqual([]);
    expect(parseSessionTerminalRecords({})).toEqual([]);
  });
});
