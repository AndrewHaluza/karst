import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PORT_OFFSET_ENV, PORT_SLOT_STRIDE } from './portSlots.js';

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

describe('concurrent spin suites with distinct port offsets', () => {
  it('both pass when run at the same time', async () => {
    const [a, b] = await Promise.all([runSpinSuite(0), runSpinSuite(PORT_SLOT_STRIDE)]);
    expect(a.out.slice(-600)).toContain('passed');
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
  }, 600_000);
});
