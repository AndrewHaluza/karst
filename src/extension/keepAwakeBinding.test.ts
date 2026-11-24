import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { KEEP_AWAKE_INTERVAL_MS, KEEP_AWAKE_MAX_HOLD_MS } from './ops/keepAwake.js';

const setting = { value: undefined as string | undefined, reads: 0 };
const spawnMock = vi.fn();
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) => {
        if (section !== 'karst' || key !== 'keepAwake') throw new Error(`unexpected read ${section}.${key}`);
        setting.reads += 1;
        return setting.value;
      },
    }),
  },
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
}));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const { registerKeepAwake } = await import('./keepAwakeBinding.js');

const NOW = Date.parse('2026-11-24T10:00:00.000Z');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function fakeChild() {
  return { kill: vi.fn(), on: vi.fn() };
}

/** A store with one running agent whose hook is fresh: one live key for the project. */
function liveStore(): { store: Store; projectId: number } {
  const store = openStore(':memory:');
  const projectId = 1;
  const ticket = createTicket(store, { key: 'K-1', title: 't', projectId });
  store.db
    .prepare("UPDATE tickets SET agent_state = 'running', last_hook_at = ? WHERE id = ?")
    .run(new Date(NOW).toISOString(), ticket.id);
  return { store, projectId };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  spawnMock.mockReset();
  setting.value = undefined;
  setting.reads = 0;
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('registerKeepAwake', () => {
  it('ticks once at once and spawns caffeinate with the host pid for a live run', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { store, projectId } = liveStore();
    const debug: string[] = [];
    const disposable = registerKeepAwake(store, { inFlight: () => 0 } as never, () => projectId, (m) => debug.push(m));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
    expect(debug).toEqual([expect.stringContaining('start caffeinate -s')]);
    disposable.dispose();
    store.close();
  });

  it('reads the setting on every tick: a change of the setting restarts the child', () => {
    const first = fakeChild();
    const second = fakeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { store, projectId } = liveStore();
    const disposable = registerKeepAwake(store, { inFlight: () => 0 } as never, () => projectId, () => {});
    expect(setting.reads).toBe(1);
    setting.value = 'always';
    vi.advanceTimersByTime(KEEP_AWAKE_INTERVAL_MS);
    expect(setting.reads).toBe(2);
    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenLastCalledWith('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    disposable.dispose();
    store.close();
  });

  it('uses the real clock for the hold limit: an unchanged live set releases the child', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { store, projectId } = liveStore();
    // Keep the hook fresh so only the hold limit can release the lock.
    const touch = store.db.prepare("UPDATE tickets SET last_hook_at = ? WHERE key = 'K-1'");
    const disposable = registerKeepAwake(store, { inFlight: () => 0 } as never, () => projectId, () => {});
    for (let elapsed = 0; elapsed < KEEP_AWAKE_MAX_HOLD_MS; elapsed += KEEP_AWAKE_INTERVAL_MS) {
      touch.run(new Date(Date.now()).toISOString());
      vi.advanceTimersByTime(KEEP_AWAKE_INTERVAL_MS);
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
    disposable.dispose();
    store.close();
  });

  it('dispose stops the interval and kills the child', () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const { store, projectId } = liveStore();
    const disposable = registerKeepAwake(store, { inFlight: () => 0 } as never, () => projectId, () => {});
    disposable.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
    const reads = setting.reads;
    vi.advanceTimersByTime(KEEP_AWAKE_INTERVAL_MS * 3);
    expect(setting.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
    store.close();
  });

  it('logs a failed tick and keeps the timer alive instead of throwing', () => {
    spawnMock.mockReturnValue(fakeChild());
    const { store, projectId } = liveStore();
    const debug: string[] = [];
    const disposable = registerKeepAwake(store, { inFlight: () => 0 } as never, () => projectId, (m) => debug.push(m));
    store.close();
    expect(() => vi.advanceTimersByTime(KEEP_AWAKE_INTERVAL_MS)).not.toThrow();
    expect(debug.filter((m) => m.startsWith('keep awake: tick failed: '))).toHaveLength(1);
    disposable.dispose();
  });
});
