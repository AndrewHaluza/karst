import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from './db.js';
import { watchExternalChanges } from './externalChanges.js';

describe('watchExternalChanges', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  /**
   * Replace the pragma read. `PRAGMA data_version` comes back as a row object,
   * not a scalar — the stub returns one too, so the watcher's column read is
   * what the tests exercise.
   */
  function stubDataVersion(read: () => unknown): void {
    const original = store.db.prepare.bind(store.db);
    vi.spyOn(store.db, 'prepare').mockImplementation(
      ((sql: string) =>
        sql === 'PRAGMA data_version'
          ? ({ get: read } as unknown as ReturnType<typeof original>)
          : original(sql)) as typeof store.db.prepare,
    );
  }

  /** Capture the scheduled poll so a test can drive it without real time. */
  function capturePoll(onChange: () => void): { tick: () => void; dispose: () => void } {
    let poll: (() => void) | undefined;
    const watcher = watchExternalChanges(store, onChange, {
      setInterval: ((cb: () => void) => {
        poll = cb;
        return 1;
      }) as unknown as typeof setInterval,
    });
    return {
      tick: () => poll!(),
      dispose: () => watcher.dispose(),
    };
  }

  it('fires when another connection commits', () => {
    let version = 1;
    stubDataVersion(() => ({ data_version: version }));
    let onChangeCalls = 0;
    const { tick } = capturePoll(() => {
      onChangeCalls += 1;
    });

    tick(); // baseline
    version = 2; // the CLI commits from its own connection
    tick();
    tick(); // same value again — no second fire

    expect(onChangeCalls).toBe(1);
  });

  it('stays silent when nothing changed', () => {
    stubDataVersion(() => ({ data_version: 7 }));
    let onChangeCalls = 0;
    const { tick } = capturePoll(() => {
      onChangeCalls += 1;
    });

    tick();
    tick();
    tick();

    expect(onChangeCalls).toBe(0);
  });

  it('never throws out of the poll', () => {
    stubDataVersion(() => {
      throw new Error('database is locked');
    });
    let version = 1;
    let onChangeCalls = 0;
    const { tick } = capturePoll(() => {
      onChangeCalls += 1;
    });

    // A locked database must not take down the host.
    expect(() => tick()).not.toThrow();
    stubDataVersion(() => ({ data_version: version }));
    tick(); // baseline
    version = 2;
    tick(); // a later successful poll still fires

    expect(onChangeCalls).toBe(1);
  });

  it('stops after dispose', () => {
    let version = 1;
    stubDataVersion(() => ({ data_version: version }));
    let onChangeCalls = 0;
    const { tick, dispose } = capturePoll(() => {
      onChangeCalls += 1;
    });

    tick(); // baseline
    dispose();
    dispose(); // idempotent
    version = 2;
    tick();

    expect(onChangeCalls).toBe(0);
  });
});
