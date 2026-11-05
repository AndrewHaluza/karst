import { describe, expect, it } from 'vitest';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { parseVmStat, readFreeHostMemory } from './hostMemory.js';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             5000.
Pages inactive:                           2000.
Pages speculative:                         100.
Pages purgeable:                           500.
`;

describe('hostMemory', () => {
  it('sums free + inactive + purgeable pages', () => expect(parseVmStat(VM_STAT)).toBe(3500 * 16384));
  it('rejects text that is not vm_stat', () => expect(parseVmStat('nope')).toBeUndefined());
  it('reads vm_stat on darwin, fresh each call', async () => {
    const proc = fakeSbxProcess({ vm_stat: { stdout: VM_STAT } });
    expect(await readFreeHostMemory(proc, 'darwin')).toBe(3500 * 16384);
    await readFreeHostMemory(proc, 'darwin');
    expect(proc.calls.filter((c) => c.command === 'vm_stat')).toHaveLength(2);
  });
  it('falls back to os.freemem off darwin or when vm_stat fails', async () => {
    const proc = fakeSbxProcess({ vm_stat: { code: 1 } });
    expect(await readFreeHostMemory(proc, 'linux')).toBeGreaterThan(0);
    expect(await readFreeHostMemory(proc, 'darwin')).toBeGreaterThan(0);
    expect(proc.calls.filter((c) => c.command === 'vm_stat')).toHaveLength(1);
  });
});
