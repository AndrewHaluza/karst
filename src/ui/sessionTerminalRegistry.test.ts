import { describe, it, expect } from 'vitest';
import { KARST_LAUNCH_ENV, KARST_TICKET_ENV } from './session.js';
import {
  forgetSessionTerminal,
  parseSessionTerminalRecords,
  rememberSessionTerminal,
  resolveRestoredSession,
  type SessionTerminalRecord,
} from './sessionTerminalRegistry.js';

const launchId = '123e4567-e89b-42d3-a456-426614174000';

describe('parseSessionTerminalRecords', () => {
  it('keeps well-formed records and drops everything else', () => {
    expect(
      parseSessionTerminalRecords([
        { ticketId: 7, name: 'Karst: ABC-1', launchId },
        { ticketId: 8, name: 'Karst: ABC-2' },
        { ticketId: 0, name: 'zero is not a ticket' },
        { ticketId: 9.5, name: 'fractional' },
        { ticketId: 10, name: '' },
        { ticketId: 11 },
        { name: 'no ticket' },
        'not an object',
        null,
      ]),
    ).toEqual([
      { ticketId: 7, name: 'Karst: ABC-1', launchId },
      { ticketId: 8, name: 'Karst: ABC-2' },
    ]);
  });

  it('drops a non-string launch id rather than carrying it into a hook check', () => {
    expect(
      parseSessionTerminalRecords([{ ticketId: 7, name: 'Karst: ABC-1', launchId: 42 }]),
    ).toEqual([{ ticketId: 7, name: 'Karst: ABC-1' }]);
  });

  it('keeps the last record for a ticket — one live terminal per ticket', () => {
    expect(
      parseSessionTerminalRecords([
        { ticketId: 7, name: 'old' },
        { ticketId: 7, name: 'new', launchId },
      ]),
    ).toEqual([{ ticketId: 7, name: 'new', launchId }]);
  });

  it('returns nothing for a value that is not an array', () => {
    expect(parseSessionTerminalRecords(undefined)).toEqual([]);
    expect(parseSessionTerminalRecords({ ticketId: 7, name: 'x' })).toEqual([]);
  });
});

describe('rememberSessionTerminal', () => {
  it('appends a record without mutating the input', () => {
    const records: SessionTerminalRecord[] = [{ ticketId: 7, name: 'Karst: ABC-1' }];
    const next = rememberSessionTerminal(records, { ticketId: 8, name: 'Karst: ABC-2', launchId });

    expect(next).toEqual([
      { ticketId: 7, name: 'Karst: ABC-1' },
      { ticketId: 8, name: 'Karst: ABC-2', launchId },
    ]);
    expect(records).toEqual([{ ticketId: 7, name: 'Karst: ABC-1' }]);
  });

  it('replaces the record for a ticket that relaunched', () => {
    expect(
      rememberSessionTerminal([{ ticketId: 7, name: 'old', launchId }], {
        ticketId: 7,
        name: 'new',
      }),
    ).toEqual([{ ticketId: 7, name: 'new' }]);
  });
});

describe('forgetSessionTerminal', () => {
  it('drops the record when the closing generation is the recorded one', () => {
    expect(
      forgetSessionTerminal([{ ticketId: 7, name: 'Karst: ABC-1', launchId }], 7, launchId),
    ).toEqual([]);
  });

  it('keeps the record when a retired generation closes late', () => {
    const records: SessionTerminalRecord[] = [{ ticketId: 7, name: 'Karst: ABC-1', launchId }];
    expect(forgetSessionTerminal(records, 7, 'a-previous-launch')).toEqual(records);
  });

  it('drops a record that never captured a generation', () => {
    expect(forgetSessionTerminal([{ ticketId: 7, name: 'Karst: ABC-1' }], 7, launchId)).toEqual([]);
  });

  it('leaves other tickets alone', () => {
    const records: SessionTerminalRecord[] = [{ ticketId: 8, name: 'Karst: ABC-2' }];
    expect(forgetSessionTerminal(records, 7, undefined)).toEqual(records);
  });
});

describe('resolveRestoredSession', () => {
  const records: SessionTerminalRecord[] = [
    { ticketId: 7, name: 'Karst: ABC-1 — fix the thing', launchId },
  ];

  it('reads the launch environment when the host still has one', () => {
    expect(
      resolveRestoredSession(
        {
          env: { [KARST_TICKET_ENV]: '9', [KARST_LAUNCH_ENV]: 'env-launch' },
          name: 'Karst: ABC-1 — fix the thing',
        },
        records,
      ),
    ).toEqual({ ticketId: 9, launchId: 'env-launch' });
  });

  // The bug this module exists for: VS Code restores a terminal's title but NOT
  // its env, so after a window reload every karst session went unrecognised and
  // a gate failure launched a second agent beside the live one.
  it('falls back to the recorded terminal title when the reload dropped the env', () => {
    expect(
      resolveRestoredSession({ env: undefined, name: 'Karst: ABC-1 — fix the thing' }, records),
    ).toEqual({ ticketId: 7, launchId });
  });

  it('ignores a terminal no record claims', () => {
    expect(resolveRestoredSession({ name: 'zsh' }, records)).toBeUndefined();
  });

  it('refuses an ambiguous title rather than guessing a ticket', () => {
    expect(
      resolveRestoredSession({ name: 'Karst' }, [
        { ticketId: 7, name: 'Karst' },
        { ticketId: 8, name: 'Karst' },
      ]),
    ).toBeUndefined();
  });

  it('ignores an empty title', () => {
    expect(resolveRestoredSession({ name: '' }, [{ ticketId: 7, name: '' }])).toBeUndefined();
  });

  it('carries no launch id when the record captured none', () => {
    expect(
      resolveRestoredSession({ name: 'Karst: ABC-1' }, [{ ticketId: 7, name: 'Karst: ABC-1' }]),
    ).toEqual({ ticketId: 7 });
  });
});
