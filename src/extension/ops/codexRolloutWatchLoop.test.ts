import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { resetAccounts } from '../../agent/accounts/registry.js';
import { createCodexRolloutWatchLoop, type CodexRolloutWatchLoopDeps } from './codexRolloutWatchLoop.js';

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
    store = openStore(':memory:');
    currentTicket = ticket(SESSION);
  });

  afterEach(() => {
    store.close();
    resetAccounts();
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
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('ignores a terminal whose identity provider is not codex', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps({ identifyTerminal: () => ({ ticketId: currentTicket, identity: { provider: 'claude' } }) });
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
  });

  it('skips a ticket with no session id', async () => {
    currentTicket = ticket(null);
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('skips a session id that is not a strict UUID before it becomes a path', async () => {
    currentTicket = ticket('../x');
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
    expect(d.logError).not.toHaveBeenCalled();
  });

  it('reads nothing for a sandboxed placement', async () => {
    currentTicket = ticket(SESSION, 'sbx');
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    expect(d.onRollout).not.toHaveBeenCalled();
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
    expect(d.logError).toHaveBeenCalledTimes(1);
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
    expect(d.logError).toHaveBeenCalledTimes(1);
    rmSync(path, { recursive: true });
    writeFileSync(path, `${errorLine()}\n`);
    await loop.run();
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });

  it('reads only the tail of a rollout larger than 512 KiB', async () => {
    const lines = ['MARKER_HEAD\n'];
    for (let i = 0; i < 600; i += 1) lines.push(`${'H'.repeat(1023)}\n`);
    const path = rollout('2026', '08', '08', SESSION, `${lines.join('')}${errorLine()}\n`);
    const d = deps();
    await loopFor(d).run();
    const text = (d.onRollout as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(text).not.toContain('MARKER_HEAD');
    expect(text.endsWith(`${errorLine()}\n`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(512 * 1024);
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

  it('does nothing on a second run() while a sweep is in flight', async () => {
    rollout('2026', '08', '08', SESSION, `${errorLine()}\n`);
    const d = deps();
    const loop = loopFor(d);
    const first = loop.run();
    const second = loop.run();
    await Promise.all([first, second]);
    expect(d.onRollout).toHaveBeenCalledTimes(1);
  });
});
