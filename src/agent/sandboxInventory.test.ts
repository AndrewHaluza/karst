import { describe, expect, it } from 'vitest';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { sbxName } from './sbx/sbxName.js';
import { listProjectSandboxes, parseSandboxName } from './sandboxInventory.js';

const ROOT = '/p/karst.yml';
const own = (id: number, core: string): string => sbxName({ projectRoot: ROOT, ticketId: id, core });
const foreign = sbxName({ projectRoot: '/other/karst.yml', ticketId: 7, core: 'claude' });

describe('parseSandboxName', () => {
  it('parses this project names back to ticket and core', () => {
    expect(parseSandboxName(own(7, 'claude'), ROOT)).toEqual({ ticketId: 7, core: 'claude' });
    expect(parseSandboxName(own(12, 'opencode2'), ROOT)).toEqual({ ticketId: 12, core: 'opencode2' });
  });
  it('ignores other projects, sidecars and unknown cores', () => {
    expect(parseSandboxName(foreign, ROOT)).toBeUndefined();
    expect(parseSandboxName(`${own(7, 'opencode')}-proxy`, ROOT)).toBeUndefined();
    expect(parseSandboxName(own(7, 'claude').replace(/claude$/, 'agy'), ROOT)).toBeUndefined();
    expect(parseSandboxName('karst-zz', ROOT)).toBeUndefined();
    for (const suffix of ['-repo', '-data', '-net']) expect(parseSandboxName(`${own(7, 'opencode2')}${suffix}`, ROOT)).toBeUndefined();
  });
});

describe('listProjectSandboxes invalid cores (F6)', () => {
  it('reports a project sandbox named for a wrong core as an invalid-core orphan, not as a ticket sandbox', async () => {
    const bad = own(7, 'claude').replace(/claude$/, 'null');
    const docker = fakeSbxProcess({ 'docker ps': { stdout: `${bad}\trunning\n${own(7, 'opencode')}\texited\n${own(7, 'opencode')}-proxy\trunning\n` } });
    const inv = await listProjectSandboxes({ projectRoot: ROOT, sbx: fakeSbxProcess(), docker });
    expect(inv.sandboxes).toEqual([
      { runner: 'docker', name: bad, ticketId: 7, core: 'null', state: 'running', invalidCore: true },
      { runner: 'docker', name: own(7, 'opencode'), ticketId: 7, core: 'opencode', state: 'stopped' },
    ]);
  });
});

describe('listProjectSandboxes', () => {
  it('lists both runners with state, own project only', async () => {
    const sbx = fakeSbxProcess({
      'sbx ls': { stdout: `SANDBOX AGENT STATUS\n${own(7, 'claude')} claude running\n${foreign} claude running\n${own(8, 'codex')} codex stopped\n` },
    });
    const docker = fakeSbxProcess({
      'docker ps': { stdout: `${own(9, 'opencode')}\trunning\n${own(9, 'opencode')}-proxy\trunning\n${own(10, 'opencode2')}\texited\n` },
    });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker });
    expect(r.errors).toEqual([]);
    expect(r.sandboxes).toEqual([
      { runner: 'sbx', name: own(7, 'claude'), ticketId: 7, core: 'claude', state: 'running' },
      { runner: 'sbx', name: own(8, 'codex'), ticketId: 8, core: 'codex', state: 'stopped' },
      { runner: 'docker', name: own(9, 'opencode'), ticketId: 9, core: 'opencode', state: 'running' },
      { runner: 'docker', name: own(10, 'opencode2'), ticketId: 10, core: 'opencode2', state: 'stopped' },
    ]);
    expect(docker.calls[0]!.args).toEqual(['ps', '-a', '--filter', `name=${own(9, 'opencode').split('-').slice(0, 2).join('-')}-`, '--format', '{{.Names}}\t{{.State}}']);
  });
  it('reports a failing tool instead of throwing, keeps the other', async () => {
    const sbx = fakeSbxProcess({ 'sbx ls': { code: 127, stderr: 'not found' } });
    const docker = fakeSbxProcess({ 'docker ps': { stdout: `${own(9, 'opencode')}\trunning\n` } });
    const r = await listProjectSandboxes({ projectRoot: ROOT, sbx, docker });
    expect(r.errors).toEqual(['sbx ls failed: not found']);
    expect(r.sandboxes.map((s) => s.ticketId)).toEqual([9]);
  });
});
