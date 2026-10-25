import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './main.js';
import { openStore } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { getTicket } from '../store/tickets.js';
import { transition } from '../workflow/machine.js';
import { parseCloseArgs, runCloseCommand } from './closeCommand.js';
import { mcpToolNames, MCP_EXCLUDED_COMMANDS } from './mcp/tools.js';
import { getCommandSpec } from './registry.js';

function seed() {
  const store = openStore(':memory:');
  const t = createTicketFlow(store, { key: 'T-1', title: 't' });
  transition(store, t.id, 'scope', { kind: 'passed' });
  return { store, id: t.id };
}

describe('parseCloseArgs', () => {
  it('parses key, reason and ref', () => {
    expect(parseCloseArgs(['close', 'T-1', '--reason', 'Sam did it', '--ref', 'CU-9'])).toEqual({
      action: 'close',
      key: 'T-1',
      reason: 'Sam did it',
      ref: 'CU-9',
    });
  });

  it('requires a key and a reason for close', () => {
    expect(() => parseCloseArgs(['close'])).toThrow(/missing ticket key/);
    expect(() => parseCloseArgs(['close', 'T-1'])).toThrow(/--reason/);
  });

  it('parses reopen and rejects trailing arguments', () => {
    expect(parseCloseArgs(['reopen', 'T-1'])).toEqual({ action: 'reopen', key: 'T-1' });
    expect(() => parseCloseArgs(['reopen', 'T-1', 'x'])).toThrow(/unexpected argument/);
    expect(() => parseCloseArgs(['close', 'T-1', '--reason', 'r', '--bogus'])).toThrow(/unexpected argument/);
  });
});

describe('runCloseCommand', () => {
  it('closes then reopens a ticket for a human caller', () => {
    const { store, id } = seed();
    const out = JSON.parse(runCloseCommand(store, ['close', 'T-1', '--reason', 'done by Sam']));
    expect(out).toMatchObject({ ok: true, ticketId: id, stage: 'closed' });
    expect(getTicket(store, id).stageCurrent).toBe('closed');
    const back = JSON.parse(runCloseCommand(store, ['reopen', 'T-1']));
    expect(back).toMatchObject({ ok: true, stage: 'impl' });
  });

  it('refuses inside an agent session and changes nothing', () => {
    const { store, id } = seed();
    expect(() =>
      runCloseCommand(store, ['close', 'T-1', '--reason', 'r'], { sessionKey: 'T-1' }),
    ).toThrow(/agent session/);
    expect(getTicket(store, id).stageCurrent).toBe('impl');
  });

  it('names an unknown ticket', () => {
    const { store } = seed();
    expect(() => runCloseCommand(store, ['close', 'NOPE', '--reason', 'r'])).toThrow(/no ticket found/);
  });
});

describe('registry and MCP', () => {
  it('registers close and reopen as writes, and keeps both off MCP', () => {
    for (const v of ['close', 'reopen']) {
      expect(getCommandSpec(v)?.writes, v).toBe(true);
      expect(MCP_EXCLUDED_COMMANDS).toContain(v);
      expect(mcpToolNames()).not.toContain(v);
    }
  });
});

describe('runCli close / reopen', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-cli-close-')));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const t = createTicketFlow(seed, { key: 'K-1', title: 't' });
    transition(seed, t.id, 'scope', { kind: 'passed' });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('closes and reopens through the real entrypoint', () => {
    const out = JSON.parse(runCli(['close', 'K-1', '--reason', 'Sam did it', '--db', dbPath], {}));
    expect(out).toMatchObject({ ok: true, stage: 'closed' });
    const back = JSON.parse(runCli(['reopen', 'K-1', '--db', dbPath], {}));
    expect(back).toMatchObject({ ok: true, stage: 'impl' });
  });

  it('refuses when the session env names a ticket, even if --ticket is omitted', () => {
    expect(() =>
      runCli(['close', 'K-1', '--reason', 'r', '--db', dbPath], { KARST_TICKET: 'K-1' }),
    ).toThrow(/agent session/);
    const check = openStore(dbPath);
    expect(getTicket(check, 1).stageCurrent).toBe('impl');
    check.close();
  });
});
