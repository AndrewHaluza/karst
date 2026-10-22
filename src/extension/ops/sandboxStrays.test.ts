import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { findStrays, removeStrays } from './sandboxStrays.js';

let root: string | undefined;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

const n = (project: string, id: number, core = 'claude'): string => sbxName({ projectRoot: project, ticketId: id, core });

function setup(answers: Record<string, { stdout?: string; code?: number }>) {
  root = mkdtempSync(join(tmpdir(), 'karst-strays-'));
  const project = join(root, 'karst.yml');
  const docker = fakeSbxProcess(answers);
  return { project, docker };
}

describe('findStrays / removeStrays', () => {
  it('clone dirs with no sandbox: closed ticket removable, open ticket reported only', async () => {
    const { project, docker } = setup({});
    for (const id of [3, 4, 5]) mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, id)), { recursive: true });
    const inv = { sandboxes: [{ runner: 'sbx' as const, name: n(project, 5), ticketId: 5, core: 'claude', state: 'running' as const }], errors: [] };
    const deps = { projectRoot: project, docker, liveTicketIds: new Set([4, 5]) };
    const strays = await findStrays(deps, inv);
    expect(strays.map((s) => [s.name, s.removable])).toEqual([[n(project, 3), true], [n(project, 4), false]]);
    expect(await removeStrays(deps, strays)).toEqual([]);
    expect(existsSync(join(root!, '.karst', 'sbx-clones', n(project, 3)))).toBe(false);
    expect(existsSync(join(root!, '.karst', 'sbx-clones', n(project, 4)))).toBe(true);
  });

  it('docker volumes, networks and proxies without a container; others\' and listed ones are untouched', async () => {
    const { project, docker } = setup({});
    const a = n(project, 3, 'opencode'), live = n(project, 4, 'opencode');
    const answers = {
      'docker volume ls': { stdout: `${a}-repo\n${a}-data\n${live}-repo\nkarst-deadbeef-9-opencode-repo\n` },
      'docker network ls': { stdout: `${a}-net\n` },
      'docker ps': { stdout: `${a}-proxy\n${live}-proxy\n` },
    };
    const proc = fakeSbxProcess(answers);
    const inv = { sandboxes: [{ runner: 'docker' as const, name: live, ticketId: 4, core: 'opencode', state: 'running' as const }], errors: [] };
    const deps = { projectRoot: project, docker: proc, liveTicketIds: new Set([4]) };
    void docker;
    const strays = await findStrays(deps, inv);
    expect(strays.map((s) => `${s.kind}:${s.name}`).sort()).toEqual([`network:${a}-net`, `proxy:${a}-proxy`, `volume:${a}-data`, `volume:${a}-repo`]);
    expect(await removeStrays(deps, strays)).toEqual([]);
    const rms = proc.calls.filter((c) => c.args.includes('rm')).map((c) => c.args.join(' '));
    expect(rms).toContain(`volume rm --force ${a}-repo`);
    expect(rms).toContain(`network rm ${a}-net`);
    expect(rms).toContain(`rm --force ${a}-proxy`);
    expect(rms.join('\n')).not.toContain(live);
  });

  it('a failed listing proves nothing stray', async () => {
    const { project, docker } = setup({});
    mkdirSync(join(root!, '.karst', 'sbx-clones', n(project, 3)), { recursive: true });
    const strays = await findStrays({ projectRoot: project, docker, liveTicketIds: new Set() }, { sandboxes: [], errors: ['sbx ls failed: x', 'docker ps failed: y'] });
    expect(strays).toEqual([]);
  });
});
