import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('rebuild-better-sqlite3 outside an install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
  // The script's own siblings (it imports them), copied OUT of the repo so no node_modules is above it.
  cpSync(join(import.meta.dirname, '../../scripts'), dir, { recursive: true });
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(dir, 'rebuild-better-sqlite3.mjs')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

  it('inside a sandbox says the dependencies are not installed and names sandbox.setup', () => {
    const r = run({ KARST_BRIDGE_DIR: '/karst-bridge/7' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dependencies are not installed in this sandbox (declare sandbox.setup in the manifest)');
    expect(r.stderr).not.toContain('main checkout');
  });

  it('inside a sandbox gate exec (KARST_SANDBOX) names sandbox.setup too', () => {
    const r = run({ KARST_SANDBOX: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('declare sandbox.setup in the manifest');
  });

  it('on the host keeps the main-checkout hint', () => {
    expect(run({}).stderr).toContain('Run `npm install` in the main checkout first.');
  });
});
