import { describe, expect, it } from 'vitest';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { createSbxSessionRunner } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';
const CLONE = '/p/.karst/sbx-clones/karst-ab12cd34-7-claude';
const input = { bridgeDir: '/b/events/7', hostWorktreePath: '/wt/a' };
const make = (proc = fakeSbxProcess(), existing: string[] = []) =>
  createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing, cloneDir: CLONE });

describe('sbx linkTranscripts', () => {
  it('creates a new sandbox with the placeInteractive workspaces, links, then reattaches', async () => {
    const proc = fakeSbxProcess();
    const runner = make(proc);
    expect(await runner.linkTranscripts!(input)).toEqual({ ok: true });
    expect(proc.calls[0]!.args).toEqual(['create', '--clone', '--name', NAME, 'claude', CLONE, '/b/events/7']);
    const exec = proc.calls[1]!.args;
    expect(exec.slice(0, 4)).toEqual(['exec', NAME, '--', 'sh']);
    expect(exec.slice(-3)).toEqual(['karst-link', '/b/events/7/claude-projects/-p--karst-sbx-clones-karst-ab12cd34-7-claude', '-p--karst-sbx-clones-karst-ab12cd34-7-claude']);
    expect(runner.placeInteractive({ ticketId: 7, hostWorktreePath: '/wt/a', command: 'claude', args: [], env: {}, bridgeDir: '/b/events/7' }).shellArgs.slice(0, 4)).toEqual(['run', '--name', NAME, 'claude']);
  });

  it('skips create for a known sandbox', async () => {
    const proc = fakeSbxProcess();
    await make(proc, [NAME]).linkTranscripts!(input);
    expect(proc.calls).toHaveLength(1);
    expect(proc.calls[0]!.args[0]).toBe('exec');
  });

  it('keeps today\'s create-on-run path when sbx create fails', async () => {
    const proc = fakeSbxProcess({ 'sbx create': { code: 1, stderr: 'boom' } });
    const runner = make(proc);
    const out = await runner.linkTranscripts!(input);
    expect(out.ok).toBe(false);
    expect(proc.calls).toHaveLength(1);
    expect(runner.placeInteractive({ ticketId: 7, hostWorktreePath: '/wt/a', command: 'claude', args: [], env: {}, bridgeDir: '/b/events/7' }).shellArgs.slice(0, 3)).toEqual(['run', '--clone', '--name']);
  });

  it('reports a failed link without throwing', async () => {
    const proc = fakeSbxProcess({ 'sbx exec': { code: 1, stderr: 'busy' } });
    const out = await make(proc, [NAME]).linkTranscripts!(input);
    expect(out).toEqual({ ok: false, reason: expect.stringContaining('busy') });
  });

  it('is absent for a non-claude core', () => {
    const r = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'codex', name: 'karst-ab12cd34-7-codex', existing: [] });
    expect(r.linkTranscripts).toBeUndefined();
  });
});
