import { describe, expect, it, vi } from 'vitest';
import type { GateProcessRunner, ProcessOutcome } from './run.js';

// A port slot lease that can be made to fail, to test a throw in one lane.
const portLease = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('../../runtime/portSlots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/portSlots.js')>();
  return {
    ...actual,
    leasePortSlot: async () => {
      if (portLease.error) throw portLease.error;
      return { offset: 0, release: async () => undefined };
    },
  };
});

const { runGateList } = await import('./runList.js');

const NOW = () => '2026-11-19T10:00:00.000Z';
const ok: ProcessOutcome = { kind: 'completed', exitCode: 0, output: 'ok' };
const gate = (name: string, script: string | null = null) => ({
  name,
  command: 'npm',
  args: ['run', '-s', script ?? name],
  script,
  required: true,
});
const visual = gate('visual', 'test:visual:docker');
const unit = gate('unit');
const lint = gate('lint');
const integration = gate('integration');

/** The gate a spawn belongs to: its npm script name is the last argument. */
const nameOf = (args: readonly string[]): string => args[args.length - 1]!;
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('runGateList lanes (T1251)', () => {
  it('returns the results in manifest order, each with its index, when the visual gate ends last', async () => {
    const runProcess: GateProcessRunner = async (_c, args) => {
      if (nameOf(args) === 'test:visual:docker') await tick(30);
      return ok;
    };
    const out = await runGateList([visual, unit, lint], process.cwd(), { now: NOW, runProcess });
    expect(out.kind).toBe('ran');
    expect(out.results.map((r) => [r.name, r.index])).toEqual([['visual', 0], ['unit', 1], ['lint', 2]]);
  });

  it('runs the UI lane beside the other lane, and the gates of one lane one at a time', async () => {
    let live = 0;
    let liveMax = 0;
    const liveNames = new Set<string>();
    const starts: string[] = [];
    const runProcess: GateProcessRunner = async (_c, args) => {
      const name = nameOf(args);
      starts.push(name);
      live += 1;
      liveNames.add(name);
      liveMax = Math.max(liveMax, live);
      // Two gates of the same lane never overlap: when `unit` runs, `lint` has not started.
      if (name === 'unit') expect(starts).not.toContain('lint');
      await tick(20);
      live -= 1;
      return ok;
    };
    await runGateList([unit, visual, lint], process.cwd(), { now: NOW, runProcess });
    expect(liveMax).toBe(2);
    expect(starts.indexOf('test:visual:docker')).toBeLessThan(starts.indexOf('lint'));
    expect(starts.indexOf('unit')).toBeLessThan(starts.indexOf('lint'));
  });

  it('keeps each result index when a Stop lands in the middle of a lane', async () => {
    const controller = new AbortController();
    const runProcess: GateProcessRunner = async (_c, args, _cwd, o) => {
      const name = nameOf(args);
      if (name === 'test:visual:docker') {
        await new Promise<void>((r) => o?.signal?.addEventListener('abort', () => r(), { once: true }));
        return { kind: 'aborted', output: '' } as ProcessOutcome;
      }
      if (name === 'lint') {
        controller.abort();
        return { kind: 'aborted', output: '' } as ProcessOutcome;
      }
      return ok;
    };
    const out = await runGateList([visual, unit, lint], process.cwd(), { now: NOW, runProcess, signal: controller.signal });
    expect(out.kind).toBe('stopped');
    expect(out.results.map((r) => [r.name, r.index])).toEqual([['unit', 1]]);
  });

  it('announces the gate that still runs again after the other lane ended', async () => {
    const events: string[] = [];
    const runProcess: GateProcessRunner = async (_c, args) => {
      await tick(nameOf(args) === 'test:visual:docker' ? 5 : 40);
      return ok;
    };
    await runGateList([visual, unit], process.cwd(), {
      now: NOW,
      runProcess,
      onGateStart: (name) => events.push(`start ${name}`),
      onGateComplete: (name) => events.push(`done ${name}`),
    });
    expect(events).toEqual(['start visual', 'start unit', 'done visual', 'start unit', 'done unit']);
  });

  it('does not re-announce in a list that runs one gate at a time', async () => {
    const starts: string[] = [];
    await runGateList([unit, lint], process.cwd(), { now: NOW, runProcess: async () => ok, onGateStart: (n) => starts.push(n) });
    expect(starts).toEqual(['unit', 'lint']);
  });

  it('aborts the other lane on a lease throw and waits for it before it throws again', async () => {
    portLease.error = new Error('port pool broken');
    let visualSettled = false;
    const runProcess: GateProcessRunner = async (_c, _args, _cwd, o) => {
      await new Promise<void>((r) => o?.signal?.addEventListener('abort', () => r(), { once: true }));
      await tick(20);
      visualSettled = true;
      return { kind: 'aborted', output: '' } as ProcessOutcome;
    };
    try {
      await expect(runGateList([visual, integration], process.cwd(), { now: NOW, runProcess })).rejects.toThrow('port pool broken');
      expect(visualSettled).toBe(true);
    } finally {
      portLease.error = undefined;
    }
  });
});
