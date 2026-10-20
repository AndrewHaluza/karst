import { describe, it, expect, vi } from 'vitest';
import { QuotaOps, makeClaudeGlobalStatuslineSync, type QuotaOpsDeps, type QuotaStatusSink } from './quotaOps.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';
import type { Manifest } from '../../manifest/types.js';

function sink(): QuotaStatusSink & { sets: Array<[string, string, boolean]>; hides: number } {
  const sets: Array<[string, string, boolean]> = [];
  let hides = 0;
  return {
    sets,
    get hides() {
      return hides;
    },
    set: (text, tooltip, warning) => sets.push([text, tooltip, warning]),
    hide: () => {
      hides++;
    },
  };
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const ok = (core: QuotaSnapshot['core'], used: number): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt: null }],
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

const expired = (core: QuotaSnapshot['core'], used: number): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt: '2025-12-25T00:00:00.000Z' }],
  source: 'test',
  readAt: '2025-12-25T00:00:00.000Z',
});

// A window still open relative to NOW, but long expired relative to the real
// clock — so a test with it only passes when the INJECTED clock is honored.
const openAtNow = (core: QuotaSnapshot['core'], used: number): QuotaSnapshot => ({
  core,
  state: 'ok',
  windows: [{ label: '7-day', usedPct: used, resetsAt: '2026-01-02T00:00:00.000Z' }],
  source: 'test',
  readAt: '2026-01-01T00:00:00.000Z',
});

function make(over: {
  snapshots?: QuotaSnapshot[];
  get?: (core: string) => QuotaSnapshot | undefined;
  thresholdPct?: () => number | undefined;
  /** `null` omits the clock, exercising the real-`Date` default. */
  now?: (() => Date) | null;
}) {
  const status = sink();
  const notify = vi.fn();
  const deps: QuotaOpsDeps = {
    service: {
      snapshots: () => over.snapshots ?? [],
      get: (core) => over.get?.(core),
    },
    thresholdPct: over.thresholdPct ?? (() => 80),
    coreLabel: (core) => core,
    status,
    notify,
  };
  const now = over.now === undefined ? () => NOW : over.now;
  if (now) deps.now = now;
  const ops = new QuotaOps(deps);
  return { ops, status, notify };
}

describe('QuotaOps.applyStatus', () => {
  it('hides the badge when no core has a readable window', () => {
    const { ops, status } = make({ snapshots: [{ core: 'opencode', state: 'unknown', reason: 'x' }] });
    ops.applyStatus();
    expect(status.hides).toBe(1);
    expect(status.sets).toHaveLength(0);
  });

  it('sets the badge text, tooltip and warning from the snapshots', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 90)] });
    ops.applyStatus();
    expect(status.sets).toHaveLength(1);
    const [text, tooltip, warning] = status.sets[0]!;
    expect(text).toContain('codex 90%');
    expect(tooltip).toContain('Warn threshold 80%');
    expect(warning).toBe(true);
  });

  it('uses the snapshots passed in rather than re-reading the service', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 10)] });
    ops.applyStatus([ok('claude', 50)]);
    expect(status.sets[0]![0]).toContain('claude 50%');
  });

  it('defaults the threshold to 80 when the manifest carries none', () => {
    const { ops, status } = make({ snapshots: [ok('codex', 80)], thresholdPct: () => undefined });
    ops.applyStatus();
    expect(status.sets[0]![2]).toBe(true);
  });

  it('hides the badge when the only readable window has already expired (real clock)', () => {
    const { ops, status } = make({ snapshots: [expired('codex', 95)], now: null });
    ops.applyStatus();
    expect(status.hides).toBe(1);
    expect(status.sets).toHaveLength(0);
  });

  it('honors the injected clock: a window open at `now` still shows', () => {
    const { ops, status } = make({ snapshots: [openAtNow('codex', 95)] });
    ops.applyStatus();
    expect(status.sets).toHaveLength(1);
    expect(status.sets[0]![0]).toContain('codex 95%');
    expect(status.sets[0]![2]).toBe(true);
  });
});

describe('QuotaOps.warnBeforeLaunch', () => {
  it('warns when the resolved core is at or above the threshold', () => {
    const { ops, notify } = make({ get: () => ok('codex', 85) });
    ops.warnBeforeLaunch('codex');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('codex is at 85%'));
  });

  it('stays silent below the threshold or for an unknown core', () => {
    const below = make({ get: () => ok('codex', 79) });
    below.ops.warnBeforeLaunch('codex');
    expect(below.notify).not.toHaveBeenCalled();

    const unknown = make({ get: () => undefined });
    unknown.ops.warnBeforeLaunch('codex');
    expect(unknown.notify).not.toHaveBeenCalled();
  });

  it('stays silent when the core window has already expired (real clock)', () => {
    const { ops, notify } = make({ get: () => expired('codex', 95), now: null });
    ops.warnBeforeLaunch('codex');
    expect(notify).not.toHaveBeenCalled();
  });

  it('honors the injected clock: a window open at `now` still warns', () => {
    const { ops, notify } = make({ get: () => openAtNow('codex', 95) });
    ops.warnBeforeLaunch('codex');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('codex is at 95%'));
  });
});

describe('makeClaudeGlobalStatuslineSync', () => {
  function sync(over: {
    manifest?: () => Manifest | undefined;
    apply?: ReturnType<typeof vi.fn>;
  }) {
    const apply = over.apply ?? vi.fn(() => ({ installed: true, changed: false }));
    const warn = vi.fn();
    const info = vi.fn();
    const error = vi.fn();
    const run = makeClaudeGlobalStatuslineSync({
      manifest: over.manifest ?? (() => ({}) as Manifest),
      storageRoot: '/storage',
      warn,
      info,
      error,
      apply: apply as never,
      node: () => '/usr/bin/node',
    });
    return { run, apply, warn, info, error };
  }

  it('installs when the manifest flags ON, with the wrapper outside the config dir', () => {
    const { run, apply } = sync({ manifest: () => ({ quota: { claudeGlobalStatusline: true } }) as Manifest });
    run();
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        wrapperDir: '/storage/claude-statusline',
        node: '/usr/bin/node',
      }),
    );
  });

  it('reads an absent flag as OFF', () => {
    const { run, apply } = sync({ manifest: () => ({ quota: { warnThresholdPct: 80 } }) as Manifest });
    run();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('leaves global settings alone when no manifest is usable', () => {
    const { run, apply, warn, info, error } = sync({ manifest: () => undefined });
    run();
    expect(apply).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs nothing when the settings already match (idempotent sync)', () => {
    const { run, info, warn, error } = sync({
      apply: vi.fn(() => ({ installed: true, changed: false })),
    });
    run();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('warns instead of logging a change when the settings file is refused', () => {
    const { run, warn, info } = sync({
      manifest: () => ({ quota: { claudeGlobalStatusline: true } }) as Manifest,
      apply: vi.fn(() => ({ installed: false, changed: false, refused: 'invalid-json' })),
    });
    run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    expect(info).not.toHaveBeenCalled();

    const unreadable = sync({
      manifest: () => ({ quota: { claudeGlobalStatusline: true } }) as Manifest,
      apply: vi.fn(() => ({ installed: false, changed: false, refused: 'unreadable' })),
    });
    unreadable.run();
    expect(unreadable.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  it('reports an install/restore change and never throws', () => {
    const { run, info } = sync({
      manifest: () => ({ quota: { claudeGlobalStatusline: true } }) as Manifest,
      apply: vi.fn(() => ({ installed: true, changed: true })),
    });
    run();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('installed'));

    const restored = sync({
      manifest: () => ({}) as Manifest,
      apply: vi.fn(() => ({ installed: false, changed: true })),
    });
    restored.run();
    expect(restored.info).toHaveBeenCalledWith(expect.stringContaining('restored'));

    const failing = sync({
      manifest: () => {
        throw new Error('boom');
      },
    });
    expect(() => failing.run()).not.toThrow();
    expect(failing.error).toHaveBeenCalledWith(
      'karst: Claude global statusline sync failed',
      expect.any(Error),
    );
  });
});
