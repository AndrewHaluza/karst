import { describe, expect, it } from 'vitest';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { sbxPreflight } from './sbxPreflight.js';

const LS = 'SANDBOX   AGENT   STATUS\nkarst-ab12cd34-7-claude   claude   running\nother   codex   stopped\n';

describe('sbxPreflight', () => {
  it('passes and lists existing sandboxes', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: LS }, 'sbx policy ls': { stdout: 'balanced\n' } });
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: true, existing: ['karst-ab12cd34-7-claude', 'other'] });
    expect(proc.calls.map((c) => c.args.join(' '))).toEqual(['version', 'ls', 'policy ls']);
  });

  it('reports a missing binary', async () => {
    const proc = fakeSbxProcess({ 'sbx version': { code: 127 } });
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: false, reason: 'sbx not installed (not on PATH)' });
    expect(proc.calls).toHaveLength(1);
  });

  it('reports a failing version call', async () => {
    const proc = fakeSbxProcess({ 'sbx version': { code: 2, stderr: 'boom\n' } });
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: false, reason: 'sbx version failed: boom' });
  });

  it('reports not signed in from the message even on exit 0', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stderr: 'error: not signed in to Docker' } });
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: false, reason: 'sbx not signed in (run `sbx login`)' });
  });

  it('reports a failing ls', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { code: 1, stderr: 'daemon down' } });
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: false, reason: 'sbx ls failed: daemon down' });
  });

  it('reports a missing network policy', async () => {
    const empty = fakeSbxProcess({ 'sbx policy ls': { stdout: '  \n' } });
    await expect(sbxPreflight(empty)).resolves.toEqual({
      ok: false,
      reason: 'sbx has no network policy (run `sbx policy init`)',
    });
    const failed = fakeSbxProcess({ 'sbx policy ls': { code: 1 } });
    await expect(sbxPreflight(failed)).resolves.toMatchObject({ ok: false });
  });

  it('never throws when the process seam rejects', async () => {
    const proc = { run: () => Promise.reject(new Error('spawn exploded')) };
    await expect(sbxPreflight(proc)).resolves.toEqual({ ok: false, reason: 'sbx preflight failed: spawn exploded' });
  });
});
