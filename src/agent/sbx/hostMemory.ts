import { freemem } from 'node:os';
import type { SbxProcess } from './sbxProcess.js';

/**
 * Pages macOS can hand to a new VM without swapping: free + inactive + purgeable (+ speculative is counted
 * inside free by `vm_stat`, so it is not added again). Undefined when the text is not `vm_stat` output.
 */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  if (size === undefined) return undefined;
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('purgeable');
  return total * Number(size);
}

/**
 * Memory a new sandbox could use right now. macOS: `vm_stat`; anywhere else, or when it fails: `os.freemem()`
 * (which on macOS under-reports, since it excludes inactive pages — hence the vm_stat path first).
 */
export async function readFreeHostMemory(proc: SbxProcess, platform: string = process.platform): Promise<number> {
  if (platform === 'darwin') {
    try {
      const out = await proc.run('vm_stat', []);
      const bytes = out.code === 0 ? parseVmStat(out.stdout) : undefined;
      if (bytes !== undefined) return bytes;
    } catch {
      /* fall through to os.freemem */
    }
  }
  return freemem();
}
