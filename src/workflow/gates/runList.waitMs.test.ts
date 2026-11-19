import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessOutcome } from './run.js';

// The port slot pool is host-wide and large, so the test replaces the lease with one that waits a known time.
const PORT_WAIT_MS = 50;
const portLease = vi.hoisted(() => ({ waitMs: 0 }));
vi.mock('../../runtime/portSlots.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/portSlots.js')>();
  return {
    ...actual,
    leasePortSlot: async () => {
      if (portLease.waitMs > 0) await new Promise((r) => setTimeout(r, portLease.waitMs));
      return { offset: 0, release: async () => undefined };
    },
  };
});

const { runGateList } = await import('./runList.js');

const NOW = () => '2026-07-30T10:00:00.000Z';
const done: ProcessOutcome = { kind: 'completed', exitCode: 0, output: '' };
const plain = { name: 'lint', command: 'npm', args: ['run', 'lint'], script: null, required: true };
const limited = { name: 'sast', command: 'semgrep', args: [], script: null, required: true, maxConcurrent: 1 };
const integration = { name: 'test:integration', command: 'npm', args: ['run', 'test:integration'], script: null, required: true };

interface Completed { waitMs: number | null | undefined }
const collect = (): { seen: Completed[]; onGateComplete: (...a: unknown[]) => void } => {
  const seen: Completed[] = [];
  return { seen, onGateComplete: (...a: unknown[]) => { seen.push({ waitMs: a[6] as number | null | undefined }); } };
};

describe('runGateList wait_ms (T1248)', () => {
  beforeEach(() => { portLease.waitMs = 0; });

  it('records 0 for a gate that holds no lease and waits for nothing', async () => {
    const { seen, onGateComplete } = collect();
    const out = await runGateList([plain], process.cwd(), { now: NOW, runProcess: async () => done, onGateComplete });
    expect(seen).toEqual([{ waitMs: 0 }]);
    expect(out.kind === 'ran' && out.results[0]!.waitMs).toBe(0);
  });

  it('records the time spent on a held maxConcurrent slot, ending at the spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-wait-ms-'));
    try {
      mkdirSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      writeFileSync(join(dir, 'sast', 'slot-0', 'owner'), String(process.pid));
      const { seen, onGateComplete } = collect();
      const t0 = Date.now();
      let spawnedAfter = -1;
      const pending = runGateList([limited], process.cwd(), {
        now: NOW,
        gateSlotsDir: dir,
        gateSlotPollMs: 5,
        onGateComplete,
        runProcess: async () => { spawnedAfter = Date.now() - t0; return done; },
      });
      await new Promise((r) => setTimeout(r, 80));
      rmSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      await pending;
      const waited = seen[0]!.waitMs!;
      expect(waited).toBeGreaterThanOrEqual(70);
      expect(waited).toBeLessThanOrEqual(spawnedAfter);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the time spent waiting for a port slot', async () => {
    portLease.waitMs = PORT_WAIT_MS;
    const { seen, onGateComplete } = collect();
    await runGateList([integration], process.cwd(), { now: NOW, runProcess: async () => done, onGateComplete });
    expect(seen[0]!.waitMs).toBeGreaterThanOrEqual(PORT_WAIT_MS - 5);
  });

  it('sums the gate lease, the port slot and the runner slot wait', async () => {
    portLease.waitMs = PORT_WAIT_MS;
    const dir = mkdtempSync(join(tmpdir(), 'karst-wait-ms-'));
    try {
      const both = { ...integration, maxConcurrent: 1 };
      const { seen, onGateComplete } = collect();
      await runGateList([both], process.cwd(), {
        now: NOW,
        gateSlotsDir: dir,
        onGateComplete,
        runProcess: async () => ({ ...done, waitMs: 1000 }),
      });
      expect(seen[0]!.waitMs).toBeGreaterThanOrEqual(1000 + PORT_WAIT_MS - 5);
      expect(seen[0]!.waitMs).toBeLessThan(1000 + PORT_WAIT_MS + 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds the runner slot wait of a resource-kill retry', async () => {
    let calls = 0;
    const { seen, onGateComplete } = collect();
    await runGateList([plain], process.cwd(), {
      now: NOW,
      onGateComplete,
      runProcess: async () => (++calls === 1 ? { kind: 'completed', exitCode: 137, output: '', waitMs: 300 } : { ...done, waitMs: 200 }),
    });
    expect(calls).toBe(2);
    expect(seen[0]!.waitMs).toBe(500);
  });

  it('records null for a gate that never ran', async () => {
    const { seen, onGateComplete } = collect();
    await runGateList([{ ...plain, script: 'lint' }], process.cwd(), {
      now: NOW,
      scriptsAvailable: () => false,
      runProcess: async () => done,
      onGateComplete,
    });
    expect(seen).toEqual([{ waitMs: null }]);
  });

  it('a Stop during the wait is stopped: no run and no completed row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-wait-ms-'));
    try {
      mkdirSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      writeFileSync(join(dir, 'sast', 'slot-0', 'owner'), String(process.pid));
      const ac = new AbortController();
      const { seen, onGateComplete } = collect();
      let ran = false;
      const pending = runGateList([limited], process.cwd(), {
        now: NOW,
        gateSlotsDir: dir,
        gateSlotPollMs: 5,
        signal: ac.signal,
        onGateComplete,
        runProcess: async () => ((ran = true), done),
      });
      setTimeout(() => ac.abort(), 20);
      const out = await pending;
      expect(out.kind).toBe('stopped');
      expect(ran).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
