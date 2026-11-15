import { describe, it, expect, vi } from 'vitest';
import { imageOf, imagePresent, probeContainer, watchContainer } from './containerWatch.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('imageOf', () => {
  it('returns the playwright image or null', () => {
    expect(imageOf(['run', '--rm', '--name', 'x', 'mcr.microsoft.com/playwright:v1.63.0-noble', 'npm'])).toBe(
      'mcr.microsoft.com/playwright:v1.63.0-noble',
    );
    expect(imageOf(['run', 'alpine'])).toBeNull();
  });
});

describe('probeContainer', () => {
  const fake = (err, out) =>
    vi.fn((_cmd, _args, _opts, cb) => {
      cb(err, out, '');
    });
  it('maps stdout and errors to present, absent and unknown', async () => {
    const present = fake(null, 'abc\n');
    expect(await probeContainer('n1', present)).toBe('present');
    expect(present.mock.calls[0][1]).toEqual(['ps', '-a', '-q', '--filter', 'name=^n1$']);
    expect(await probeContainer('n1', fake(null, ''))).toBe('absent');
    expect(await probeContainer('n1', fake(new Error('boom'), ''))).toBe('unknown');
  });
});

describe('imagePresent', () => {
  it('returns false for a null image without a call', async () => {
    const impl = vi.fn();
    expect(await imagePresent(null, impl)).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });
  it('returns true on success and false on rejection', async () => {
    expect(await imagePresent('img', (_c, _a, _o, cb) => cb(null, '', ''))).toBe(true);
    expect(await imagePresent('img', (_c, _a, _o, cb) => cb(new Error('x'), '', ''))).toBe(false);
  });
});

describe('watchContainer', () => {
  it('calls onHung once after the misses', async () => {
    const onHung = vi.fn();
    watchContainer({ name: 'n1', graceMs: 10, pollMs: 5, misses: 3, probe: async () => 'absent', onHung });
    await wait(200);
    expect(onHung).toHaveBeenCalledTimes(1);
    expect(onHung).toHaveBeenCalledWith({ name: 'n1', waitedMs: 25 });
  });

  it('does not call onHung while the container is present', async () => {
    const onHung = vi.fn();
    const w = watchContainer({ name: 'n1', graceMs: 10, pollMs: 5, misses: 3, probe: async () => 'present', onHung });
    await wait(100);
    w.stop();
    expect(onHung).not.toHaveBeenCalled();
  });

  it('resets the miss count on a present probe', async () => {
    const seq = ['absent', 'absent', 'present', 'absent', 'absent', 'absent'];
    let calls = 0;
    const onHungAt = [];
    watchContainer({
      name: 'n1',
      graceMs: 5,
      pollMs: 5,
      misses: 3,
      probe: async () => seq[calls++] ?? 'absent',
      onHung: () => onHungAt.push(calls),
    });
    await wait(200);
    expect(onHungAt).toEqual([6]);
  });

  it('stop before the grace ends means no probe', async () => {
    const probe = vi.fn(async () => 'absent');
    const w = watchContainer({ name: 'n1', graceMs: 30, pollMs: 5, misses: 3, probe, onHung: vi.fn() });
    w.stop();
    await wait(80);
    expect(probe).not.toHaveBeenCalled();
  });
});
