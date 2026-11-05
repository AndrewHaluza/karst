import { describe, expect, it } from 'vitest';
import { oomMessage, parseKilledProcess } from './sbxOom.js';

const DMESG = `[ 90.1] Out of memory: Killed process 412 (node) total-vm:9000kB
[ 91.2] Out of memory: Killed process 977 (cc1plus) total-vm:1000kB`;

describe('sbxOom', () => {
  it('names the last killed process', () => expect(parseKilledProcess(DMESG)).toBe('cc1plus'));
  it('null when dmesg has none', () => expect(parseKilledProcess('')).toBeNull());
  it('words the report with the limit and the hint', () => {
    const m = oomMessage('karst-1-claude', '6g', 'node');
    expect(m).toContain('Sandbox karst-1-claude ran out of memory (limit 6 GB): killed node');
    expect(m).toContain('sbxMemory');
  });
  it('still an OOM report when dmesg could not be read', () => expect(oomMessage('s', undefined, null)).toBe('Sandbox s ran out of memory. Raise sandboxMemory.sbxMemory in the manifest or run fewer sandboxes at once.'));
});
