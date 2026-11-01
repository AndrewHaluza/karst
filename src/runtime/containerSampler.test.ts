import { describe, expect, it } from 'vitest';
import { parseDockerStats, parseMemUsage, sampleContainers } from './containerSampler.js';
import { parseSandboxContainerName, projectPrefix } from '../agent/sandboxInventory.js';
import type { ProcessResult, SbxProcess } from '../agent/sbx/sbxProcess.js';

const ROOT = '/proj';
const P = projectPrefix(ROOT);
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' });
const stat = (Name: string, CPUPerc: string, MemUsage: string): string => JSON.stringify({ Name, CPUPerc, MemUsage });

function fakeDocker(handler: (args: readonly string[]) => Promise<ProcessResult> | ProcessResult): SbxProcess & { calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async (_c, args) => { calls.push([...args]); return handler(args); } };
}

describe('parseSandboxContainerName', () => {
  it('accepts the plain name and every suffix', () => {
    expect(parseSandboxContainerName(`${P}7-claude`, ROOT)).toEqual({ ticketId: 7, core: 'claude', suffix: null });
    expect(parseSandboxContainerName(`${P}7-claude-proxy`, ROOT)?.suffix).toBe('proxy');
    expect(parseSandboxContainerName(`${P}7-claude-svc`, ROOT)?.suffix).toBe('svc');
    expect(parseSandboxContainerName(`${P}7-claude-port-5173`, ROOT)).toMatchObject({ ticketId: 7, suffix: 'port-5173' });
  });
  it('rejects other projects, unknown suffixes and unknown cores', () => {
    expect(parseSandboxContainerName(`karst-deadbeef-7-claude`, ROOT)).toBeUndefined();
    expect(parseSandboxContainerName(`${P}7-claude-data`, ROOT)).toBeUndefined();
    expect(parseSandboxContainerName(`${P}7-nope-proxy`, ROOT)).toBeUndefined();
  });
});

describe('parseDockerStats', () => {
  it('normalizes CPU by core count and parses memory units', () => {
    const out = parseDockerStats(`${stat('a', '80.00%', '100MiB / 2GiB')}\n${stat('b', '0.00%', '1.5GiB / 2GiB')}\n`, 8);
    expect(out).toEqual([
      { name: 'a', cpuPct: 10, rssBytes: 100 * 1024 ** 2 },
      { name: 'b', cpuPct: 0, rssBytes: 1.5 * 1024 ** 3 },
    ]);
  });
  it('skips junk lines and keeps an unparsable CPU as null', () => {
    const out = parseDockerStats(`not json\n${stat('a', '--', '10kB / 1GB')}\n{"Name":1}\n`, 4);
    expect(out).toEqual([{ name: 'a', cpuPct: null, rssBytes: 10_000 }]);
  });
  it('parseMemUsage rejects garbage', () => {
    expect(parseMemUsage('lots')).toBeNull();
    expect(parseMemUsage('3 parsecs / 4')).toBeNull();
  });
});

describe('sampleContainers', () => {
  const base = { projectRoot: ROOT, cpuCoreCount: 4 };

  it('lists sandbox containers, adds server containers, and stats them in one call', async () => {
    const docker = fakeDocker((args) =>
      args[0] === 'ps' ? ok(`${P}7-claude\n${P}7-claude-proxy\n${P}junk\n`) : ok(stat(`${P}7-claude`, '40%', '10MiB / 1GiB')),
    );
    const res = await sampleContainers({ ...base, docker, serverContainers: ['karst-t7-pg'] });
    expect(res).toMatchObject({ ok: true, stats: [{ name: `${P}7-claude`, cpuPct: 10 }] });
    expect(docker.calls[1]).toEqual(['stats', '--no-stream', '--format', '{{json .}}', `${P}7-claude`, `${P}7-claude-proxy`, 'karst-t7-pg']);
  });

  it('skips docker stats when nothing is running', async () => {
    const docker = fakeDocker(() => ok(''));
    expect(await sampleContainers({ ...base, docker, serverContainers: [] })).toEqual({ ok: true, stats: [] });
    expect(docker.calls).toHaveLength(1);
  });

  it('reports daemon-down on a non-zero docker ps or stats', async () => {
    const down = fakeDocker(() => ({ code: 1, stdout: '', stderr: 'Cannot connect' }));
    expect(await sampleContainers({ ...base, docker: down, serverContainers: [] })).toEqual({ ok: false, reason: 'daemon-down' });
    const statsFail = fakeDocker((a) => (a[0] === 'ps' ? ok(`${P}7-claude`) : { code: 1, stdout: '', stderr: 'x' }));
    expect(await sampleContainers({ ...base, docker: statsFail, serverContainers: [] })).toEqual({ ok: false, reason: 'daemon-down' });
  });

  it('reports no-docker (not daemon-down) when the binary is missing', async () => {
    const docker = fakeDocker(() => ({ code: 127, stdout: '', stderr: '' }));
    expect(await sampleContainers({ ...base, docker, serverContainers: [] })).toEqual({ ok: false, reason: 'no-docker' });
  });

  it('times out a hung docker without waiting for it', async () => {
    const docker = fakeDocker(() => new Promise<ProcessResult>(() => {}));
    expect(await sampleContainers({ ...base, docker, serverContainers: [], timeoutMs: 10 })).toEqual({ ok: false, reason: 'timeout' });
  });
});
