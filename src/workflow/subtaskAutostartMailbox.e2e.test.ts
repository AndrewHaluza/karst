import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import {
  archiveTicket,
  createTicket,
  detachSubtaskParent,
  findTicketById,
  setStageCurrent,
} from '../store/tickets.js';
import { setStage } from '../store/stages.js';
import { listInbox } from '../store/ticketMessages.js';
import { createSubtask } from './stages/subtask.js';
import { transition } from './machine.js';
import { makeSubtaskAutostart } from '../extension/ops/subtaskAutostartOps.js';
import {
  makeMessageDeliverySweep,
  POINTER_INTERVAL_MS,
} from '../extension/ops/messageDeliveryOps.js';
import { makeTerminalDelivery } from './messageDelivery.js';
import { runCli } from '../cli/main.js';

/**
 * End-to-end over the real store (a FILE db, so a second connection and the
 * CLI's node:sqlite store see the same rows): sub-task autostart under caps,
 * the cross-connection claim, the mailbox CLI + pointer delivery, events
 * written at the source by `setStage`, and the parent wake. Sessions, the host
 * start path and the wake are fakes.
 */

const quietNotify = { info: () => {}, warn: () => {}, error: () => {} } as never;
const noop = (): void => {};

describe('sub-task autostart + mailbox (e2e)', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;
  let projectId: number;
  let parentId: number;
  const extra: Store[] = [];
  /**
   * The host's connection, read through a getter so it can be reopened.
   * `runCli` writes via node:sqlite IN THIS PROCESS — a second SQLite copy.
   * Closing its fd drops this process's POSIX locks, and a long-lived
   * better-sqlite3 WAL connection then misses later writes. In production
   * the CLI is a separate process (verified), so this is a harness artefact:
   * after every in-process CLI call the host connection is reopened.
   */
  const live: Store = { get db() { return store.db; }, close: () => store.close() };
  const runCliHere = (argv: string[], env: Record<string, string>): string => {
    try {
      return runCli(argv, env);
    } finally {
      store.close();
      store = openStore(dbPath);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-mailbox-e2e-'));
    dbPath = join(dir, 'karst.db');
    store = openStore(dbPath);
    projectId = upsertProject(store, { slug: 'p1' }).id;
    parentId = createTicket(store, { key: 'K-1', title: 'parent', projectId }).id;
    transition(store, parentId, 'scope', { kind: 'passed' }); // parent at impl
  });

  afterEach(() => {
    for (const s of extra.splice(0)) s.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const child = (title: string, blocking = false): number =>
    createSubtask(store, parentId, { title, blocking }, { projectId }).id;

  /** The host start path, faked as "scope passes" on the given connection. */
  const autostartOn = (s: Store, started: number[], perParent = 2, total = 4) =>
    makeSubtaskAutostart({
      store: s,
      projectId: () => projectId,
      caps: () => ({ perParent, total }),
      ownsParent: () => true,
      startTicket: async (id) => {
        started.push(id);
        transition(s, id, 'scope', { kind: 'passed' });
        return { ok: true };
      },
      notify: quietNotify,
      debug: noop,
    });

  const stageOf = (id: number): string | null => findTicketById(store, id)?.stageCurrent ?? null;

  it('caps per parent at 2, queues the 3rd, and starts it once a slot frees at ship', async () => {
    const [a, b, c] = [child('a'), child('b'), child('c')];
    const started: number[] = [];
    const op = autostartOn(store, started);

    expect(await op.sweep()).toEqual([a, b]);
    expect(stageOf(c)).toBe('scope');
    expect(findTicketById(store, c)?.autostartPending).toBe(true);
    expect(await op.sweep()).toEqual([]);

    setStageCurrent(store, a, 'ship');
    expect(await op.sweep()).toEqual([c]);
    expect(started).toEqual([a, b, c]);
    expect(stageOf(c)).toBe('impl');
  });

  it('two sweeps on two connections to one file start each child exactly once', async () => {
    const ids = [child('a'), child('b'), child('c')];
    const other = openStore(dbPath);
    extra.push(other);
    const started: number[] = [];
    const [r1, r2] = await Promise.all([
      autostartOn(store, started, 0, 0).sweep(),
      autostartOn(other, started, 0, 0).sweep(),
    ]);
    expect([...r1, ...r2].sort()).toEqual([...ids].sort());
    expect([...started].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(stageOf(id)).toBe('impl');
  });

  it('a parent still at scope leaves its children queued', async () => {
    const scoped = createTicket(store, { key: 'K-2', title: 'p2', projectId }).id;
    const kid = createSubtask(store, scoped, { title: 'x' }, { projectId }).id;
    const started: number[] = [];
    expect(await autostartOn(store, started).sweep()).toEqual([]);
    expect(started).toEqual([]);
    expect(stageOf(kid)).toBe('scope');
    expect(findTicketById(store, kid)?.autostartPending).toBe(true);
  });

  it('a child archived or detached between queue and claim is not started', async () => {
    const archived = child('archived');
    const detached = child('detached');
    const started: number[] = [];
    // Picked first, then changed before the claim: the claim is the guard.
    let raced = false;
    const op = makeSubtaskAutostart({
      store,
      projectId: () => projectId,
      caps: () => ({ perParent: 0, total: 0 }),
      ownsParent: (id) => {
        if (!raced) {
          raced = true;
          archiveTicket(store, archived);
          detachSubtaskParent(store, detached, parentId);
        }
        return id === parentId;
      },
      startTicket: async (id) => {
        started.push(id);
        return { ok: true };
      },
      notify: quietNotify,
      debug: noop,
    });
    expect(await op.sweep()).toEqual([]);
    expect(started).toEqual([]);
    expect(stageOf(archived)).toBe('scope');
    expect(stageOf(detached)).toBe('scope');
  });

  it('CLI `stage impl pass` on a child emits no event; landing on done emits exactly one', () => {
    const kid = child('k');
    transition(store, kid, 'scope', { kind: 'passed' });
    const key = findTicketById(store, kid)!.key!;
    runCliHere(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', key], {});
    expect(stageOf(kid)).toBe('uat');
    // impl→uat is neither a block nor done: setStage emits nothing for it.
    expect(listInbox(store, parentId, { unreadOnly: false })).toHaveLength(0);

    setStageCurrent(store, kid, 'ship');
    transition(store, kid, 'ship', { kind: 'passed' });
    const rows = listInbox(store, parentId, { unreadOnly: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('event');
  });

  describe('mailbox', () => {
    let now: number;
    let nudges: Array<{ id: number; line: string }>;
    let woken: number[];
    let integrating: boolean;

    const sweepFor = () =>
      makeMessageDeliverySweep({
        store: live,
        projectId: () => projectId,
        delivery: makeTerminalDelivery({
          isLive: () => true,
          graphOwned: () => false,
          nudge: (id, line) => {
            nudges.push({ id, line });
            return true;
          },
          sessionCliEnv: () => undefined,
          literal: () => ({ cli: '/opt/karst/cli.js', db: dbPath }),
        }),
        isLive: () => false,
        isGraphTicket: () => false,
        integrating: () => integrating,
        refreshUnread: noop,
        wake: (id) => {
          woken.push(id);
        },
        now: () => now,
        debug: noop,
        warn: noop,
      });

    beforeEach(() => {
      now = Date.now();
      nudges = [];
      woken = [];
      integrating = false;
    });

    const cli = (key: string, env: string | undefined, ...rest: string[]): string =>
      runCliHere([...rest, '--db', dbPath, '--ticket', key], env === undefined ? {} : { KARST_TICKET: env });

    it('pointer nudges are rate-limited; inbox returns all and marks read; bad senders refused', () => {
      const kid = child('k');
      const sib = child('s');
      const kidKey = findTicketById(store, kid)!.key!;
      const sibKey = findTicketById(store, sib)!.key!;
      const stranger = createTicket(store, { key: 'K-9', title: 'x', projectId }).id;
      void stranger;
      const sweep = sweepFor();

      cli(kidKey, kidKey, 'message', 'send', '--to', 'parent', '--body', 'first');
      sweep.sweep();
      expect(nudges).toHaveLength(1);
      expect(nudges[0]!.id).toBe(parentId);
      expect(nudges[0]!.line).toContain('inbox');
      expect(nudges[0]!.line).not.toContain('first');
      expect(nudges[0]!.line).toContain('/opt/karst/cli.js');

      cli(kidKey, kidKey, 'message', 'send', '--to', 'parent', '--body', 'second');
      sweep.sweep();
      expect(nudges).toHaveLength(1);
      now += POINTER_INTERVAL_MS;
      sweep.sweep();
      expect(nudges).toHaveLength(2);

      const out = JSON.parse(cli('K-1', 'K-1', 'inbox', '--json')) as { messages: { body: string }[] };
      expect(out.messages.map((m) => m.body)).toEqual(['first', 'second']);
      expect(listInbox(store, parentId, { unreadOnly: true })).toHaveLength(0);

      expect(() => cli(kidKey, kidKey, 'message', 'send', '--to', sibKey, '--body', 'hi')).toThrow();
      expect(() => cli(kidKey, kidKey, 'message', 'send', '--to', 'K-9', '--body', 'hi')).toThrow();
      expect(() => cli(kidKey, sibKey, 'message', 'send', '--to', 'parent', '--body', 'forged')).toThrow(
        /KARST_TICKET/,
      );
      expect(listInbox(store, parentId, { unreadOnly: false })).toHaveLength(2);
      expect(listInbox(store, sib, { unreadOnly: false })).toHaveLength(0);
    });

    it('last blocking child landing wakes the idle parent once, never under an integration park', () => {
      const a = child('a', true);
      const b = child('b', true);
      const sweep = sweepFor();
      const land = (id: number): void => {
        setStageCurrent(store, id, 'ship');
        transition(store, id, 'ship', { kind: 'passed' });
      };

      land(a);
      sweep.sweep();
      expect(woken).toEqual([]); // b still blocks

      setStage(store, parentId, 'impl', {
        blockedKind: 'awaiting-subtask',
        blockedReason: 'merge conflict integrating K-1-s1',
        blockedAt: new Date().toISOString(),
      });
      land(b);
      sweep.sweep();
      expect(woken).toEqual([]);

      setStage(store, parentId, 'impl', { blockedKind: null, blockedReason: null, blockedAt: null });
      sweep.sweep();
      expect(woken).toEqual([parentId]);
      now += 10 * 60_000;
      sweep.sweep();
      expect(woken).toEqual([parentId]);
    });
  });
});
