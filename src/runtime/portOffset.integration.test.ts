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

/**
 * Two slots that collide with neither the band this very vitest run's own spin
 * suite uses (`readPortOffset()`) nor any concurrent gate (slots are leased).
 * Slots equal to the own offset are held until the end so they are not re-drawn.
 */
async function leaseTwoForeignSlots(own: number): Promise<{ held: PortSlotLease[]; offsets: number[] }> {
  const held: PortSlotLease[] = [];
  while (held.filter((l) => l.offset !== own).length < 2) held.push(await leasePortSlot());
  return { held, offsets: held.filter((l) => l.offset !== own).map((l) => l.offset) };
}

describe('concurrent spin suites with distinct port offsets', () => {
  it('both pass when run at the same time', async () => {
    const { held, offsets } = await leaseTwoForeignSlots(readPortOffset());
    try {
      const [a, b] = await Promise.all(offsets.map(runSpinSuite));
      expect(a!.code).toBe(0);
      expect(b!.code).toBe(0);
    } finally {
      for (const l of held) l.release();
    }
  }, 600_000);
});
