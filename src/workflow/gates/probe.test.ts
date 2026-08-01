import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeScripts } from './probe.js';

describe('probeScripts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'karst-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the scripts block when package.json is well-formed', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    expect(probeScripts(dir)).toEqual({ kind: 'ok', scripts: { test: 'vitest' } });
  });

  it('treats a package.json with no scripts block as ok-and-empty, not absent', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(probeScripts(dir)).toEqual({ kind: 'ok', scripts: {} });
  });

  it('distinguishes an absent package.json from a malformed one', () => {
    expect(probeScripts(dir).kind).toBe('absent');
    writeFileSync(join(dir, 'package.json'), '{ not json');
    const probe = probeScripts(dir);
    expect(probe.kind).toBe('malformed');
    if (probe.kind === 'malformed') expect(probe.message.length).toBeGreaterThan(0);
  });

  it('reports an unreadable package.json as io-error, not as absent', () => {
    const file = join(dir, 'package.json');
    writeFileSync(file, JSON.stringify({ scripts: {} }));
    chmodSync(file, 0o000);
    const probe = probeScripts(dir);
    chmodSync(file, 0o644); // restore so afterEach can remove it
    // Running as root defeats mode bits; skip rather than assert a false thing.
    if (process.getuid?.() === 0) return;
    expect(probe.kind).toBe('io-error');
  });
});
