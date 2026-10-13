import { spawnSync } from 'node:child_process';
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
});
