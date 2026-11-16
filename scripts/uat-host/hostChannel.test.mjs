import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const { handleHostLine } = createRequire(import.meta.url)('./hostChannel.cjs');

describe('handleHostLine', () => {
  it('answers ping without a probe', async () => {
    const runProbe = vi.fn();
    expect(await handleHostLine('{"op":"ping"}', { runProbe })).toEqual({ ok: true });
    expect(runProbe).not.toHaveBeenCalled();
  });
  it('runs a probe and returns its results', async () => {
    const results = [{ index: 0, type: 'snapshot', status: 'pass' }];
    const runProbe = vi.fn().mockResolvedValue(results);
    const reply = await handleHostLine('{"op":"run","scriptPath":"/w/s.json","outDir":"/w/out/a"}', { runProbe });
    expect(reply).toEqual({ ok: true, results });
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe).toHaveBeenCalledWith({ scriptPath: '/w/s.json', outDir: '/w/out/a' });
  });
  it('maps an Error rejection to its message', async () => {
    const runProbe = vi.fn().mockRejectedValue(new Error('step 0: unknown step type "x"'));
    expect(await handleHostLine('{"op":"run","scriptPath":"/w/s.json","outDir":"/w/o"}', { runProbe }))
      .toEqual({ ok: false, error: 'step 0: unknown step type "x"' });
  });
  it('maps a non-Error rejection to a string', async () => {
    const runProbe = vi.fn().mockRejectedValue('boom');
    expect(await handleHostLine('{"op":"run","scriptPath":"/w/s.json","outDir":"/w/o"}', { runProbe }))
      .toEqual({ ok: false, error: 'boom' });
  });
  it('refuses a line that is not JSON', async () => {
    expect(await handleHostLine('not json', { runProbe: vi.fn() })).toEqual({ ok: false, error: 'bad request: not JSON' });
  });
  it.each([
    ['{"op":"run","scriptPath":"rel.json","outDir":"/w/o"}'],
    ['{"op":"run","scriptPath":"/w/s.json","outDir":"rel"}'],
    ['{"op":"run","scriptPath":"/w/s.json"}'],
    ['{"op":"run","outDir":"/w/o"}'],
    ['{"op":"run","scriptPath":1,"outDir":"/w/o"}'],
    ['{"op":"run","scriptPath":"/w/s.json","outDir":null}'],
  ])('refuses a bad path in %s', async (line) => {
    const runProbe = vi.fn();
    expect(await handleHostLine(line, { runProbe }))
      .toEqual({ ok: false, error: 'bad request: scriptPath and outDir must be absolute paths' });
    expect(runProbe).not.toHaveBeenCalled();
  });
  it('refuses an unknown op', async () => {
    expect(await handleHostLine('{"op":"nope"}', { runProbe: vi.fn() })).toEqual({ ok: false, error: 'bad request: unknown op "nope"' });
  });
});
