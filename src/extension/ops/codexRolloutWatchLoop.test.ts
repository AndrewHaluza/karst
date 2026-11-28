import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { openStore, type Store } from '../../store/db.js';
import { configureAccounts, configureRecordedAccountLookup, resetAccounts } from '../../agent/accounts/registry.js';
import {
  createCodexRolloutWatchLoop,
  newestFirst,
  type CodexRolloutWatchLoopDeps,
  type CodexTerminalNamed,
} from './codexRolloutWatchLoop.js';

// Every handle the loop opens, so a missing close is visible.
const { openedHandles } = vi.hoisted(() => ({ openedHandles: [] as FileHandle[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const realOpen = actual.open as (path: string, flags?: number | string) => Promise<FileHandle>;
  return {
    ...actual,
    open: async (path: string, flags?: number | string) => {
      const handle = await realOpen(path, flags);
      openedHandles.push(handle);
      return handle;
    },
  };
});

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

const errorLine = (message = "You've hit your usage limit. Upgrade to Plus or try again at Aug 8th, 2026 11:06 AM."): string =>
  JSON.stringify({
    timestamp: '2026-08-08T09:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message, codex_error_info: 'usage_limit_exceeded' } },
  });

const startedLine = (): string =>
  JSON.stringify({ timestamp: '2026-08-08T09:05:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } });

const fillerLine = (i: number): string =>
  JSON.stringify({ timestamp: '2026-08-08T09:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', i } });

describe('newestFirst', () => {
  it('orders entries by name, greatest first', () => {
    const names = ['2026/08/07', '2026/08/09', '2026/08/08'].map((name) => ({ name }));
    expect(newestFirst(names).map((entry) => entry.name)).toEqual(['2026/08/09', '2026/08/08', '2026/08/07']);
  });
});

describe('createCodexRolloutWatchLoop', () => {
  let dir: string;
  let home: string;
  let store: Store;

  const ticket = (sessionId: string | null, backend: string | null = 'host'): number => {
    const id = Number(
      store.db.prepare('INSERT INTO tickets (key, session_id) VALUES (?, ?)').run(`T-${Math.random()}`, sessionId).lastInsertRowid,
    );
    if (backend !== null) store.db.prepare('UPDATE tickets SET placement_backend = ? WHERE id = ?').run(backend, id);
    return id;
  };

  /** Write `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<sessionId>.jsonl`. */
  const rollout = (yyyy: string, mm: string, dd: string, sessionId: string, text: string): string => {
    const dayDir = join(home, 'sessions', yyyy, mm, dd);
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, `rollout-${yyyy}-${mm}-${dd}T09-00-00-${sessionId}.jsonl`);
    writeFileSync(path, text);
    return path;
  };

  const deps = (over: Partial<CodexRolloutWatchLoopDeps> = {}): CodexRolloutWatchLoopDeps => ({
    store,
    listTerminals: () => [{}],
    identifyTerminal: () => ({ ticketId: currentTicket, identity: { provider: 'codex' } }),
    onRollout: vi.fn(),
    debug: vi.fn(),
    logError: vi.fn(),
    ...over,
  });
  let currentTicket: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-codex-rollout-'));
    home = join(dir, 'codex-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    resetAccounts();
    openedHandles.length = 0;
    store = openStore(':memory:');
    currentTicket = ticket(SESSION);
  });

  afterEach(() => {
    store.close();
    resetAccounts();
    configureRecordedAccountLookup(undefined);
    delete process.env.CODEX_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  const loopFor = (over: Partial<CodexRolloutWatchLoopDeps> = {}) => createCodexRolloutWatchLoop(deps(over));

  it('finds the rollout of the session id among several days', async () => {
    rollout('2026', '08', '07', SESSION, `${startedLine()}\n${errorLine()}\n`);
    rollout('2026', '08', '08', OTHER_SESSION, `${startedLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.onRollout).toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining("You've hit your usage limit"));
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('sweep tick'));
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('offers the newest rollout when the session has one in two day directories', async () => {
    rollout('2026', '08', '07', SESSION, `${errorLine('OLDER ERROR')}\n`);
    rollout('2026', '08', '08', SESSION, `${errorLine('NEWER ERROR')}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.onRollout).toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining('NEWER ERROR'));
  });

  it('does not look below the day directory for a rollout', async () => {
    // The nested path is not the day-directory placement: `sub/rollout-...` must stay invisible.
    const nested = join(home, 'sessions', '2026', '08', '08', 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`), `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(`[codex] ticket ${currentTicket}: no rollout yet for ${SESSION}`);
  });

  it('does not take a decoy name that only ends with the session id', async () => {
    const dayDir = join(home, 'sessions', '2026', '08', '08');
    mkdirSync(dayDir, { recursive: true });
    // Sorts after `rollout-…`, so a broken `startsWith('rollout-')` would take it first.
    writeFileSync(join(dayDir, `zzz-${SESSION}.jsonl`), `${errorLine('DECOY')}\n`);
    writeFileSync(join(dayDir, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`), `${errorLine('REAL')}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining('REAL'));
    expect(d.onRollout).not.toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining('DECOY'));
  });

  it('does not take a rollout name of another session that sorts first', async () => {
    const dayDir = join(home, 'sessions', '2026', '08', '08');
    mkdirSync(dayDir, { recursive: true });
    // Starts with `rollout-` and sorts before the real file, but ends with another session id.
    writeFileSync(join(dayDir, 'rollout-0000.jsonl'), `${errorLine('FOREIGN')}\n`);
    writeFileSync(join(dayDir, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`), `${errorLine('REAL')}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining('REAL'));
    expect(d.onRollout).not.toHaveBeenCalledWith(currentTicket, SESSION, expect.stringContaining('FOREIGN'));
  });

  it('looks under <home>/sessions only, not under the home itself', async () => {
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const outside = join(home, '2026', '08', '08');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`), `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(`[codex] ticket ${currentTicket}: no rollout yet for ${SESSION}`);
  });

  it('reads the account folder the session was started under', async () => {
    // The recorded account of the session (c2) differs from the active one (c1):
    // the sweep must resolve the provider `codex` for that session, not the active folder.
    configureAccounts({
      codex: {
        active: 'c1',
        list: {
          c1: { kind: 'subscription', source: 'folder', dir: join(dir, 'codex-c1') },
          c2: { kind: 'subscription', source: 'folder', dir: home },
        },
      },
    });
    configureRecordedAccountLookup((core, id) => (core === 'codex' && id === SESSION ? 'c2' : undefined));
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('ignores a terminal whose identity provider is not codex', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps({ identifyTerminal: () => ({ ticketId: currentTicket, identity: { provider: 'claude' } }) });
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
  });

  it('ignores a terminal with no identity and still watches a codex one', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps({
      listTerminals: () => ['unnamed', 'bare', 'codex'],
      identifyTerminal: (terminal) =>
        terminal === 'unnamed'
          ? undefined
          : terminal === 'bare'
            ? ({} as CodexTerminalNamed)
            : { ticketId: currentTicket, identity: { provider: 'codex' } },
    });
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('skips a ticket with no session id', async () => {
    currentTicket = ticket(null);
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(`[codex] ticket ${currentTicket}: no sessionId`);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('skips a session id that is not a strict UUID before it becomes a path', async () => {
    currentTicket = ticket('../x');
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(`[codex] ticket ${currentTicket}: session id is not a UUID`);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('reads nothing for a sandboxed placement', async () => {
    currentTicket = ticket(SESSION, 'sbx');
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining('sbx placement'));
  });

  it('watches a legacy ticket that has no recorded placement', async () => {
    currentTicket = ticket(SESSION, null);
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('reports a missing session root and looks again next sweep', async () => {
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining(`no session root ${join(home, 'sessions')}`));
    expect(d.logError).not.toHaveBeenCalled();
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable directory as a miss', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const year = join(home, 'sessions', '2026');
    const d = deps();
    chmodSync(year, 0o000);
    try {
      await loopFor(d).run();
    } finally {
      chmodSync(year, 0o700);
    }
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('refuses a rollout symlink that escapes the session root', async () => {
    const outside = join(dir, 'outside.jsonl');
    writeFileSync(outside, `${errorLine()}\n`);
    const dayDir = join(home, 'sessions', '2026', '08', '08');
    mkdirSync(dayDir, { recursive: true });
    symlinkSync(outside, join(dayDir, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`));
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).toHaveBeenCalledWith(
      `karst: codex rollout read failed for ticket ${currentTicket}`,
      expect.objectContaining({ message: expect.stringContaining('is outside') }),
    );
  });

  it('reads only the tail of a rollout larger than 512 KiB, cut at a line boundary', async () => {
    const lines = ['MARKER_HEAD\n'];
    for (let i = 0; i < 6000; i += 1) lines.push(`${fillerLine(i)}\n`);
    rollout('2026', '08', '08', SESSION, `${lines.join('')}${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    const text = (d.onRollout as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(text).not.toContain('MARKER_HEAD');
    expect(text.endsWith(`${errorLine()}\n`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(512 * 1024);
    // The first line is whole (the cut fragment is dropped), so it still parses.
    expect(() => JSON.parse(text.split('\n')[0]!)).not.toThrow();
  });

  it('hands over a small rollout whole, first line included', async () => {
    const text = `${startedLine()}\n${errorLine()}\n`;
    rollout('2026', '08', '08', SESSION, text);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).toHaveBeenCalledWith(currentTicket, SESSION, text);
  });

  it('closes the rollout handle after a read', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    await loopFor(deps()).run();
    expect(openedHandles.length).toBeGreaterThan(0);
    expect(openedHandles.map((handle) => handle.fd)).toEqual(openedHandles.map(() => -1));
  });

  it('reads an unchanged file once and a changed file again', async () => {
    const path = rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    appendFileSync(path, '{"timestamp":"2026-08-08T09:10:00.000Z","type":"event_msg","payload":{"type":"token_count"}}\n');
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(2);
  });

  it('re-reads when only the mtime moves', async () => {
    const first = new Date('2026-08-08T09:00:00.000Z');
    const second = new Date('2026-08-08T09:00:05.000Z');
    const path = rollout('2026', '08', '08', SESSION, `${errorLine('FIRST')}\n`);
    utimesSync(path, first, first);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    writeFileSync(path, `${errorLine('THIRD')}\n`);
    utimesSync(path, second, second);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(2);
  });

  it('re-reads when only the size moves', async () => {
    const fixed = new Date('2026-08-08T09:00:00.000Z');
    const path = rollout('2026', '08', '08', SESSION, `${errorLine('SIZE1')}\n`);
    utimesSync(path, fixed, fixed);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    writeFileSync(path, `${errorLine('SIZE1')}\n${fillerLine(1)}\n`);
    utimesSync(path, fixed, fixed);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(2);
  });

  it('keeps the located rollout for the session instead of re-finding it each sweep', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine('CACHED')}\n`);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    // A newer file for the same session does not move the cached path: one session, one rollout.
    rollout('2026', '08', '09', SESSION, `${errorLine('LATER')}\n`);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });

  it('forgets a vanished rollout and looks for it again next sweep', async () => {
    const path = rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    rmSync(path);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
    expect(d.debug).toHaveBeenCalledWith(expect.stringContaining(`rollout missing: ${path}`));
    expect(d.logError).not.toHaveBeenCalled();
    writeFileSync(path, `${errorLine()}\n`);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(2);
  });

  it('retries a failed read on the next sweep', async () => {
    const dayDir = join(home, 'sessions', '2026', '08', '08');
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`);
    // A directory squatting on the rollout name: open succeeds, the regular-file check fails.
    mkdirSync(path);
    const d = deps();
    const loop = loopFor(d);
    await loop.run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).toHaveBeenCalledWith(
      `karst: codex rollout read failed for ticket ${currentTicket}`,
      expect.objectContaining({ message: expect.stringContaining('is not a regular file') }),
    );
    rmSync(path, { recursive: true });
    writeFileSync(path, `${errorLine()}\n`);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });

  it('logs a fault in one ticket and keeps sweeping the next one', async () => {
    const failing = ticket(SESSION);
    const second = ticket(OTHER_SESSION);
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    rollout('2026', '08', '08', OTHER_SESSION, `${startedLine()}\n${errorLine()}\n`);
    const onRollout = vi.fn((id: number) => {
      if (id === failing) throw new Error('boom');
    });
    let n = 0;
    const d = deps({
      listTerminals: () => [{}, {}],
      identifyTerminal: () => {
        const id = n === 0 ? failing : second;
        n += 1;
        return { ticketId: id, identity: { provider: 'codex' } };
      },
      onRollout,
    });
    await createCodexRolloutWatchLoop(d).run();
    expect(onRollout).toHaveBeenCalledTimes(2);
    expect(onRollout.mock.calls[1]![0]).toBe(second);
    expect(d.logError).toHaveBeenCalledWith(`karst: codex rollout watch failed for ticket ${failing}`, expect.any(Error));
  });

  it('logs a sweep failure when the terminal list throws', async () => {
    const d = deps({
      listTerminals: () => {
        throw new Error('boom');
      },
    });
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).toHaveBeenCalledWith('karst: codex rollout watch failed', expect.any(Error));
  });

  it('does nothing on a second run() while a sweep is in flight', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    const loop = loopFor(d);
    const first = loop.run();
    const second = loop.run();
    await Promise.all([first, second]);
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });

  describe('ssh placement (D556 edit 5)', () => {
    let bridgeRoot: string;
    /** The forwarded flat rollout the D556 forwarder writes. */
    const forwarded = (id: number, text: string): string => {
      const dir = join(bridgeRoot, 'events', String(id), 'codex-sessions');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-08-08T09-00-00-${SESSION}.jsonl`);
      writeFileSync(path, text);
      return path;
    };

    beforeEach(() => {
      bridgeRoot = join(dir, 'bridge');
    });

    it('reads the forwarded rollout of an ssh ticket from <bridge>/codex-sessions', async () => {
      const id = ticket(SESSION, 'ssh');
      forwarded(id, `${startedLine()}\n${errorLine()}\n`);
      const onRollout = vi.fn();
      await loopFor({
        identifyTerminal: () => ({ ticketId: id, identity: { provider: 'codex' } }),
        onRollout,
        bridgeRoot: () => bridgeRoot,
      }).run();
      expect(onRollout).toHaveBeenCalledTimes(1);
      expect(onRollout.mock.calls[0]![0]).toBe(id);
      expect(onRollout.mock.calls[0]![1]).toBe(SESSION);
      expect(onRollout.mock.calls[0]![2]).toContain('usage_limit_exceeded');
    });

    it('still returns early for sbx and docker, even when a forwarded copy exists', async () => {
      for (const backend of ['sbx', 'docker']) {
        const id = ticket(SESSION, backend);
        forwarded(id, `${startedLine()}\n${errorLine()}\n`);
        const onRollout = vi.fn();
        await loopFor({
          identifyTerminal: () => ({ ticketId: id, identity: { provider: 'codex' } }),
          onRollout,
          bridgeRoot: () => bridgeRoot,
        }).run();
        expect(onRollout, backend).not.toHaveBeenCalled();
      }
    });

    it('logs a missing bridge root instead of reading the host home', async () => {
      const id = ticket(SESSION, 'ssh');
      rollout('2026', '08', '08', SESSION, `${errorLine()}\n`); // a host rollout that must NOT be read
      const d = deps({ identifyTerminal: () => ({ ticketId: id, identity: { provider: 'codex' } }) });
      await loopFor(d).run();
      expect(d.onRollout).not.toHaveBeenCalled();
      expect(d.debug).toHaveBeenCalledWith(`[codex] ticket ${id}: no bridge root for the forwarded rollout`);
    });
  });
});
