import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { recordPlacement } from '../../store/placement.js';
import { openShipRun } from '../../store/shipRuns.js';
import {
  KEEP_AWAKE_AGENT_FRESH_MS,
  KEEP_AWAKE_MAX_HOLD_MS,
  caffeinateArgs,
  keepAwakeLiveKeys,
  makeKeepAwake,
  type KeepAwakeDeps,
  type KeepAwakeSpawn,
} from './keepAwake.js';

/** The slice of a spawned process the lock touches; the tests emit the events by hand. */
class FakeChild {
  killed = 0;
  private readonly listeners = new Map<string, (value: unknown) => void>();

  kill(): void {
    this.killed += 1;
  }

  on(event: string, listener: (value: unknown) => void): unknown {
    this.listeners.set(event, listener);
    return this;
  }

  emit(event: 'error' | 'exit', value?: unknown): void {
    this.listeners.get(event)?.(value);
  }
}

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly stdio: 'ignore' };
}

function setup(overrides: Partial<KeepAwakeDeps> = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const debug: string[] = [];
  const state = { mode: 'auto' as string | undefined, keys: ['gate:1'] as string[], clock: 1_000_000 };
  const spawn: KeepAwakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const deps: KeepAwakeDeps = {
    platform: 'darwin',
    hostPid: 4242,
    mode: () => state.mode,
    liveKeys: () => state.keys,
    now: () => state.clock,
    spawn,
    debug: (line) => debug.push(line),
    ...overrides,
  };
  return { keep: makeKeepAwake(deps), state, calls, children, debug };
}

const started = (debug: readonly string[]): string[] => debug.filter((l) => l.includes('start'));
const released = (debug: readonly string[]): string[] => debug.filter((l) => l.includes('release'));

describe('caffeinateArgs', () => {
  it('auto holds the system awake on AC power and ends with the host pid', () => {
    expect(caffeinateArgs('auto', 4242)).toEqual(['-s', '-w', '4242']);
  });

  it('always holds the idle sleep off on battery too', () => {
    expect(caffeinateArgs('always', 4242)).toEqual(['-i', '-w', '4242']);
  });

  it('off holds nothing', () => {
    expect(caffeinateArgs('off', 4242)).toBeNull();
  });

  it('an unknown or absent setting reads as auto', () => {
    expect(caffeinateArgs('bogus', 7)).toEqual(['-s', '-w', '7']);
    expect(caffeinateArgs(undefined, 7)).toEqual(['-s', '-w', '7']);
  });
});

describe('makeKeepAwake', () => {
  it('starts one caffeinate for the auto mode', () => {
    const { keep, calls } = setup();
    keep.tick();
    expect(calls).toEqual([{ command: 'caffeinate', args: ['-s', '-w', '4242'], options: { stdio: 'ignore' } }]);
  });

  it('uses -i for always', () => {
    const { keep, calls, state } = setup();
    state.mode = 'always';
    keep.tick();
    expect(calls[0]!.args).toEqual(['-i', '-w', '4242']);
  });

  it('reads an unknown mode as auto', () => {
    const { keep, calls, debug, state } = setup();
    state.mode = 'bogus';
    keep.tick();
    expect(calls[0]!.args).toEqual(['-s', '-w', '4242']);
    expect(started(debug)).toEqual([expect.stringContaining('mode auto')]);
  });

  it('spawns nothing when the setting is off', () => {
    const { keep, calls, debug, state } = setup();
    state.mode = 'off';
    keep.tick();
    expect(calls).toEqual([]);
    expect(debug).toEqual([]);
  });

  it('spawns nothing when no run is live', () => {
    const { keep, calls, debug, state } = setup();
    state.keys = [];
    keep.tick();
    keep.tick();
    expect(calls).toEqual([]);
    expect(debug).toEqual([]);
  });

  it('keeps one child across many ticks', () => {
    const { keep, calls, children } = setup();
    keep.tick();
    keep.tick();
    keep.tick();
    expect(calls).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(0);
  });

  it('releases the child when the live set becomes empty', () => {
    const { keep, calls, children, debug, state } = setup();
    keep.tick();
    state.keys = [];
    keep.tick();
    expect(children[0]!.killed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(released(debug)).toEqual([expect.stringContaining('mode auto, 0 live')]);
  });

  it('releases the child when the setting turns off', () => {
    const { keep, children, state } = setup();
    keep.tick();
    state.mode = 'off';
    keep.tick();
    expect(children[0]!.killed).toBe(1);
  });

  it('kills and restarts the child when the mode changes', () => {
    const { keep, calls, children, debug, state } = setup();
    keep.tick();
    state.mode = 'always';
    keep.tick();
    expect(children[0]!.killed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(['-i', '-w', '4242']);
    // One start per child, and never two live children at once.
    expect(started(debug)).toHaveLength(2);
    expect(children.filter((c) => c.killed === 0)).toHaveLength(1);
  });

  it('writes one start line with the mode and the key count', () => {
    const { keep, debug, state } = setup();
    state.keys = ['gate:1', 'agent:2'];
    keep.tick();
    expect(started(debug)).toEqual([expect.stringContaining('caffeinate -s -w 4242 (mode auto, 2 live)')]);
  });

  it('handles a spawn that throws: one line and no retry', () => {
    const spawn: KeepAwakeSpawn = () => {
      throw new Error('EACCES');
    };
    const { keep, debug } = setup({ spawn });
    keep.tick();
    keep.tick();
    expect(debug).toEqual([expect.stringContaining('failed to start (mode auto)')]);
  });

  it('tries a missing binary once, logs it once, and stops trying in this window', () => {
    const { keep, calls, children, debug } = setup();
    keep.tick();
    children[0]!.emit('error', new Error('spawn caffeinate ENOENT'));
    keep.tick();
    keep.tick();
    expect(calls).toHaveLength(1);
    // The errored child is dropped, not killed again: nothing runs.
    expect(children[0]!.killed).toBe(0);
    expect(debug.filter((l) => l.includes('not retrying in this window'))).toHaveLength(1);
  });

  it('restarts the child after an unexpected exit', () => {
    const { keep, calls, children } = setup();
    keep.tick();
    children[0]!.emit('exit', 1);
    keep.tick();
    expect(calls).toHaveLength(2);
  });

  it('an old child that exits after a restart does not release the new one', () => {
    const { keep, calls, children, state } = setup();
    keep.tick(); // child A
    state.mode = 'always';
    keep.tick(); // A killed, child B
    children[0]!.emit('exit', 1); // A's exit arrives late
    keep.tick();
    expect(calls).toHaveLength(2);
    expect(children[1]!.killed).toBe(0);
  });

  it('does not kill a child that already exited', () => {
    const { keep, children, state } = setup();
    keep.tick();
    children[0]!.emit('exit', 1);
    state.keys = [];
    keep.tick();
    expect(children[0]!.killed).toBe(0);
  });

  it('an old child that errors after a restart does not drop the new child', () => {
    const { keep, children, state } = setup();
    keep.tick(); // child A
    state.mode = 'always';
    keep.tick(); // A killed, child B
    children[0]!.emit('error', new Error('late'));
    keep.dispose();
    expect(children[1]!.killed).toBe(1);
  });

  it('dispose kills the child and stops later ticks', () => {
    const { keep, calls, children } = setup();
    keep.tick();
    keep.dispose();
    expect(children[0]!.killed).toBe(1);
    // A dying child's late events after dispose are ignored, never thrown.
    expect(() => {
      children[0]!.emit('exit', 0);
      children[0]!.emit('error', new Error('late'));
    }).not.toThrow();
    keep.tick();
    expect(calls).toHaveLength(1);
  });

  it('a tick after dispose spawns nothing, even with a live run and no late child event', () => {
    const { keep, calls } = setup();
    keep.dispose();
    keep.tick();
    expect(calls).toHaveLength(0);
  });

  it('dispose without a child is a no-op', () => {
    const { keep } = setup();
    expect(() => keep.dispose()).not.toThrow();
  });

  it('spawns nothing on a platform other than darwin', () => {
    const { keep, calls, debug } = setup({ platform: 'linux' });
    keep.tick();
    keep.tick();
    keep.dispose();
    expect(calls).toEqual([]);
    expect(debug).toEqual([]);
  });
});

describe('makeKeepAwake hold limit', () => {
  it('releases after four hours of an unchanged live set', () => {
    const { keep, calls, children, debug, state } = setup();
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS - 1;
    keep.tick();
    expect(children[0]!.killed).toBe(0);
    state.clock += 1;
    keep.tick();
    expect(children[0]!.killed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(released(debug)).toEqual([expect.stringContaining('mode auto, 1 live')]);
    expect(debug.filter((l) => l.includes('hold limit'))).toHaveLength(1);
    // Still released while the signature stays the same.
    state.clock += 60_000;
    keep.tick();
    expect(calls).toHaveLength(1);
    expect(debug.filter((l) => l.includes('hold limit'))).toHaveLength(1);
  });

  it('keys that differ only by where they split are another live set', () => {
    const { keep, children, state } = setup();
    state.keys = ['a', 'b'];
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS - 1;
    state.keys = ['ab'];
    keep.tick();
    state.clock += 1;
    keep.tick();
    expect(children[0]!.killed).toBe(0);
  });

  it('holds again once the live set changes', () => {
    const { keep, calls, state } = setup();
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS;
    keep.tick(); // released
    state.clock += 1;
    state.keys = ['gate:1', 'agent:2'];
    keep.tick();
    expect(calls).toHaveLength(2);
  });

  it('a changed live set restarts the four hours', () => {
    const { keep, calls, children, state } = setup();
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS - 60_000;
    state.keys = ['gate:1', 'agent:2'];
    keep.tick(); // signature changed: the clock restarts here
    state.clock += KEEP_AWAKE_MAX_HOLD_MS - 1;
    keep.tick();
    expect(children[0]!.killed).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('a reordered live set is the same signature', () => {
    const { keep, children, state } = setup();
    state.keys = ['gate:1', 'agent:2'];
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS;
    state.keys = ['agent:2', 'gate:1'];
    keep.tick();
    expect(children[0]!.killed).toBe(1);
  });

  it('never reports the hold limit when nothing is live', () => {
    const { keep, calls, debug, state } = setup();
    state.keys = [];
    keep.tick();
    state.clock += KEEP_AWAKE_MAX_HOLD_MS;
    keep.tick();
    expect(calls).toEqual([]);
    expect(debug.filter((l) => l.includes('hold limit'))).toEqual([]);
  });
});

const PROJECT = 7;
const OTHER_PROJECT = 8;
const HOST_PID = 4242;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

function addRun(
  store: ReturnType<typeof openStore>,
  sql: string,
  ...args: unknown[]
): void {
  store.db.prepare(sql).run(...args);
}

describe('keepAwakeLiveKeys over a real store', () => {
  it('gives a key for each live run of this host, and none for another host', () => {
    const store = openStore(':memory:');
    const gate = createTicket(store, { key: 'K-gate', title: 'gate', projectId: PROJECT });
    const ship = createTicket(store, { key: 'K-ship', title: 'ship', projectId: PROJECT });
    const deliver = createTicket(store, { key: 'K-deliver', title: 'deliver', projectId: PROJECT });
    const node = createTicket(store, { key: 'K-node', title: 'node', projectId: PROJECT });
    const elsewhere = createTicket(store, { key: 'K-elsewhere', title: 'elsewhere', projectId: PROJECT });
    addRun(
      store,
      "INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, pid, started_at) VALUES (?, 'uat', 1, 'x', 'running', ?, 'x')",
      gate.id,
      HOST_PID,
    );
    openShipRun(store, { ticketId: ship.id, attempt: 1, startedAt: 'x', pid: HOST_PID });
    addRun(
      store,
      "INSERT INTO deliver_runs (ticket_id, head_sha, gates, state, pid, started_at, kind) VALUES (?, 'h', '[]', 'running', ?, 'x', 'auto')",
      deliver.id,
      HOST_PID,
    );
    // A graph node opens a `process_runs` row with the host pid.
    addRun(
      store,
      "INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, provider, pid, status, started_at) VALUES (?, 'impl', 'graph-node', 1, 'codex', ?, 'running', 'x')",
      node.id,
      HOST_PID,
    );
    addRun(
      store,
      "INSERT INTO stage_runs (ticket_id, stage_key, attempt, run_at, status, pid, started_at) VALUES (?, 'uat', 1, 'x', 'running', ?, 'x')",
      elsewhere.id,
      999_999,
    );

    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([
      `agent:${node.id}`,
      `deliver:${deliver.id}`,
      `gate:${gate.id}`,
      `ship:${ship.id}`,
    ]);
    expect(keepAwakeLiveKeys(store, 999_999, PROJECT, 0, [], NOW)).toEqual([`gate:${elsewhere.id}`]);
    expect(keepAwakeLiveKeys(store, 111_111, PROJECT, 0, [], NOW)).toEqual([]);
    store.close();
  });

  it('gives no agent key and no error when the project is unknown', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-np', title: 'no project', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", new Date(NOW).toISOString(), t.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, undefined, 0, [], NOW)).toEqual([]);
    store.close();
  });

  it('does not query the tickets when the project is unknown', () => {
    const store = openStore(':memory:');
    const prepare = store.db.prepare.bind(store.db);
    const seen: string[] = [];
    store.db.prepare = ((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    }) as typeof store.db.prepare;
    keepAwakeLiveKeys(store, HOST_PID, undefined, 0, [], NOW);
    expect(seen.filter((sql) => sql.includes('FROM tickets'))).toEqual([]);
    store.close();
  });

  it('counts the tracked in-flight runs the drain tracks', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-tracked', title: 'tracked', projectId: PROJECT });
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 1, [t.id], NOW)).toEqual([`deliver:${t.id}`]);
    // A tracked run that names no ticket still holds a key.
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 1, [], NOW)).toEqual(['gate:none']);
    store.close();
  });

  it('gives a key for a running agent with a fresh hook', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-fresh', title: 'fresh', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", new Date(NOW - 30 * 60_000).toISOString(), t.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    store.close();
  });

  it('gives a key for a running ssh agent even without a fresh host hook (D826)', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-ssh', title: 'ssh', projectId: PROJECT });
    recordPlacement(store, t.id, { backend: 'ssh', core: 'claude', sandboxName: 'devbox/karst-ab-1-claude', reason: null }, 'claude');
    // The hooks land in the REMOTE bridge: no host hook, or a stale one, is expected.
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = NULL WHERE id = ?", t.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    addRun(store, "UPDATE tickets SET last_hook_at = ? WHERE id = ?", new Date(NOW - 61 * 60_000).toISOString(), t.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    // A host agent with the same stale hook stays out.
    const host = createTicket(store, { key: 'K-host-stale', title: 'host', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", new Date(NOW - 61 * 60_000).toISOString(), host.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    store.close();
  });

  it('counts a hook exactly sixty minutes old as fresh', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-edge', title: 'edge', projectId: PROJECT });
    addRun(
      store,
      "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?",
      new Date(NOW - KEEP_AWAKE_AGENT_FRESH_MS).toISOString(),
      t.id,
    );
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    store.close();
  });

  it('gives no key for a stale, missing, waiting, idle, archived, unprojected or foreign agent', () => {
    const store = openStore(':memory:');
    const fresh = new Date(NOW - 5 * 60_000).toISOString();
    const stale = createTicket(store, { key: 'K-stale', title: 'stale', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", new Date(NOW - 61 * 60_000).toISOString(), stale.id);
    const noHook = createTicket(store, { key: 'K-nohook', title: 'no hook', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = NULL WHERE id = ?", noHook.id);
    const waiting = createTicket(store, { key: 'K-waiting', title: 'waiting', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'waiting', last_hook_at = ? WHERE id = ?", fresh, waiting.id);
    const idle = createTicket(store, { key: 'K-idle', title: 'idle', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'idle', last_hook_at = ? WHERE id = ?", fresh, idle.id);
    const archived = createTicket(store, { key: 'K-archived', title: 'archived', projectId: PROJECT });
    addRun(
      store,
      "UPDATE tickets SET agent_state = 'running', last_hook_at = ?, archived_at = ? WHERE id = ?",
      fresh,
      fresh,
      archived.id,
    );
    const foreign = createTicket(store, { key: 'K-foreign', title: 'foreign', projectId: OTHER_PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", fresh, foreign.id);
    const garbage = createTicket(store, { key: 'K-garbage', title: 'garbage', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = 'not a date' WHERE id = ?", garbage.id);
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([]);
    store.close();
  });

  it('deduplicates the file-level agent key with a live agent run of the same ticket', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-both', title: 'both', projectId: PROJECT });
    addRun(store, "UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?", new Date(NOW).toISOString(), t.id);
    addRun(
      store,
      "INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, provider, pid, status, started_at) VALUES (?, 'impl', 'graph-node', 1, 'codex', ?, 'running', 'x')",
      t.id,
      HOST_PID,
    );
    expect(keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW)).toEqual([`agent:${t.id}`]);
    store.close();
  });

  it('returns a new array on each call', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-new', title: 'new', projectId: PROJECT });
    openShipRun(store, { ticketId: t.id, attempt: 1, startedAt: 'x', pid: HOST_PID });
    const first = keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW);
    const second = keepAwakeLiveKeys(store, HOST_PID, PROJECT, 0, [], NOW);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    store.close();
  });
});
