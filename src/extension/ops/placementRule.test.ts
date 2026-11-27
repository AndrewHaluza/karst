import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * arch:AC-32: only the recorded placement decides where a ticket runs. A core only tells which
 * sandbox kind it would use. Every production use of `sandboxKindOfCore` must be listed here with
 * the reason the core is right; a new use must read `getPlacement` first, then be added with a reason.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'extension/ops/sandboxLifecycleOps.ts': 'definition; reconcile and removeSandboxGuarded use it only as fallback after the recorded placement',
  'extension/ops/sandboxRebaseOps.ts': 'runsOnHost reads the recorded placement first; the core is the fallback for a NULL placement only',
  'extension/ops/sandboxWiring.ts': 'onSessionClosed reads the recorded placement first (ssh keeps the poller); the core is the fallback for a NULL placement only',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}

describe('placement rule (arch:AC-32)', () => {
  it('lists every production use of sandboxKindOfCore', () => {
    const root = join(__dirname, '..', '..');
    const users = walk(root)
      .filter((f) => /sandboxKindOfCore\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(users).toEqual(Object.keys(ALLOWED).sort());
  });
  it('no reconcile decision reads the core directly', () => {
    const src = readFileSync(join(__dirname, 'sandboxLifecycleOps.ts'), 'utf8');
    expect(src).toMatch(/t\.placementBackend \?\? sandboxKindOfCore\(t\.sessionProvider\)/);
  });
  it('every other use reads the recorded placement first (D826)', () => {
    const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8');
    expect(read('sandboxLifecycleOps.ts')).toMatch(/placement\?\.backend \?\? sandboxKindOfCore\(target\.core\)/);
    expect(read('sandboxRebaseOps.ts')).toMatch(/placementOf\(target\.ticketId\)\?\.backend \?\? sandboxKindOfCore\(target\.core\)/);
    expect(read('sandboxWiring.ts')).toMatch(/placementOf\(ticketId\)\?\.backend \?\? sandboxKindOfCore\(core\)/);
  });
});
