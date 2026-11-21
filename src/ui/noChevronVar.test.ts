import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(css|html|js|ts|tsx)$/.test(name) && !/\.test\.|__snapshots__/.test(full)) out.push(full);
  }
  return out;
}

describe('select chevron (ST-1)', () => {
  it('no source file defines or uses --chevron: the CSP blocks a data: URL image', () => {
    const hits = walk(SRC).filter((f) => readFileSync(f, 'utf8').includes('--chevron'));
    expect(hits).toEqual([]);
  });
});
