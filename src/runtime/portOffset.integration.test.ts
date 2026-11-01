import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PORT_OFFSET_ENV, leasePortSlot, readPortOffset, type PortSlotLease } from './portSlots.js';

function runSpinSuite(offset: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['vitest', 'run', '--config', 'vitest.integration.config.ts', 'src/runtime/spin.integration.test.ts'],
      { env: { ...process.env, [PORT_OFFSET_ENV]: String(offset) } },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Longest this test waits for slots before skipping — holding partial slots while waiting could deadlock a concurrent gate. */
const LEASE_BUDGET_MS = 60_000;

/**
 * Two slots that collide with neither the band this very vitest run's own spin
 * suite uses (`readPortOffset()`) nor any concurrent gate (slots are leased).
 * Slots equal to the own offset are held until the end so they are not re-drawn.
 * Returns null — after releasing everything — when the table stays too busy, so
 * two such runs can never wait on each other forever.
 */
async function leaseTwoForeignSlots(own: number): Promise<{ held: PortSlotLease[]; offsets: number[] } | null> {
  const held: PortSlotLease[] = [];
  const signal = AbortSignal.timeout(LEASE_BUDGET_MS);
  try {
    while (held.filter((l) => l.offset !== own).length < 2) {
      held.push(await leasePortSlot({ signal }));
    }
  } catch {
    await Promise.all(held.map((l) => l.release()));
    return null;
  }
  return { held, offsets: held.filter((l) => l.offset !== own).map((l) => l.offset) };
}

describe('concurrent spin suites with distinct port offsets', () => {
  it('both pass when run at the same time', async (ctx) => {
    const leased = await leaseTwoForeignSlots(readPortOffset());
    if (!leased) return ctx.skip();
    try {
      const [a, b] = await Promise.all(leased.offsets.map(runSpinSuite));
      expect(a!.code).toBe(0);
      expect(b!.code).toBe(0);
    } finally {
      await Promise.all(leased.held.map((l) => l.release()));
    }
  }, 600_000);
});
