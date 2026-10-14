import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES } from './fixtures.js';

// Opt-in: three container boots are too slow for the default `integration` job.
// Run: UAT_HOST_DOCKER=1 npx vitest run --config vitest.integration.config.ts src/uatHost/boot.integration.test.ts
const enabled =
  process.env['UAT_HOST_DOCKER'] === '1' && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!enabled)('uat:host:docker', () => {
  it.each(FIXTURE_NAMES)('boots and activates on fixture %s with a clean teardown', (fixture) => {
    const run = spawnSync('npm', ['run', '-s', 'uat:host:docker', '--', '--fixture', fixture], {
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('extension active, db opened, fixture visible');

    const leftovers = spawnSync('docker', ['ps', '-a', '--filter', 'name=karst-uat-host-', '--format', '{{.Names}}'], {
      encoding: 'utf8',
    });
    expect(leftovers.stdout.trim()).toBe('');
  }, 900_000);

  it('runs a 3-step probe script end to end and leaves JSON evidence', () => {
    mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
    const out = mkdtempSync(join(process.cwd(), 'reports', 'uat-probe-out-'));
    try {
      const run = spawnSync(
        'npm',
        ['run', '-s', 'uat:host:docker', '--', '--fixture', 'ticket-mid-stage', '--script', 'scripts/uat-host/samples/smoke.json', '--out', relative(process.cwd(), out)],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stdout + run.stderr).toBe(0);
      for (const i of [0, 1, 2]) expect(run.stdout).toContain(`uat-probe: step ${i}`);
      const snap = JSON.parse(readFileSync(join(out, 'step-002.json'), 'utf8')) as { snapshot: { tickets: Array<{ key: string }> } };
      expect(snap.snapshot.tickets.map((t) => t.key)).toEqual(['FIX-MID']);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 900_000);
});
