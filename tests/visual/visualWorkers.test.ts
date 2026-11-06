import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVisualWorkers } from './visualWorkers.js';

async function loadConfig(env: Record<string, string>, argv: string[] = []) {
  vi.resetModules();
  vi.stubEnv('CI', '');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const saved = process.argv;
  process.argv = [...saved, ...argv];
  try {
    return (await import('../../playwright.config.js')).default;
  } finally {
    process.argv = saved;
  }
}

describe('resolveVisualWorkers', () => {
  it('defaults to 1 when the variable is unset or empty', () => {
    expect(resolveVisualWorkers({})).toBe(1);
    expect(resolveVisualWorkers({ KARST_VISUAL_WORKERS: '' })).toBe(1);
  });

  it('reads a positive integer', () => {
    expect(resolveVisualWorkers({ KARST_VISUAL_WORKERS: '2' })).toBe(2);
    expect(resolveVisualWorkers({ KARST_VISUAL_WORKERS: '3' })).toBe(3);
  });

  it.each(['0', '-1', '1.5', 'abc', '2x', ' '])('falls back to 1 for the invalid value %j', (raw) => {
    expect(resolveVisualWorkers({ KARST_VISUAL_WORKERS: raw })).toBe(1);
  });

  it('stays at 1 in CI whatever the variable says', () => {
    expect(resolveVisualWorkers({ CI: 'true', KARST_VISUAL_WORKERS: '3' })).toBe(1);
  });

  it('stays at 1 for a baseline update run', () => {
    expect(resolveVisualWorkers({ KARST_VISUAL_WORKERS: '3' }, ['playwright', 'test', '--update-snapshots'])).toBe(1);
  });
});

describe('playwright.config workers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is 1 with the variable unset', async () => {
    expect((await loadConfig({})).workers).toBe(1);
  });

  it('follows KARST_VISUAL_WORKERS', async () => {
    expect((await loadConfig({ KARST_VISUAL_WORKERS: '2' })).workers).toBe(2);
  });

  it('is 1 on an update run', async () => {
    expect((await loadConfig({ KARST_VISUAL_WORKERS: '2' }, ['--update-snapshots'])).workers).toBe(1);
  });
});
