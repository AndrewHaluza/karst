import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { MARKER_EMIT } from '../hookBridge.js';
import { NODE_SBX_PROCESS } from '../sbx/sbxProcess.js';
import { makeFakeSshBin, type FakeSshBin } from './fakeSshBin.js';
import { createSshGateRegistry } from './sshGateRegistry.js';
import { createNodeSshProcess, sshArgv } from './sshProcess.js';
import { createSshSessionRunner } from './sshRunner.js';
import type { SessionRunner } from '../sessionRunner.js';
import type { BridgePaths } from '../bridge/bridgeDir.js';

/**
 * The ssh runner against a real `sh` through the fake `ssh` (`fakeSshBin`):
 * the remote scripts really run, so file modes, the exit file, the pgid file
 * and the quoting layers are checked, not only the script text.
 */

const run = promisify(execFile);
const PREFIX = 'karst-0123abcd';
const NAME = `${PREFIX}-7-claude`;

let fake: FakeSshBin;
let shimDir: string;
let hostWt: string;
let remoteDir: string;
let ws: string;
let savedPath: string | undefined;

/** macOS has no `setsid`: a shim that makes the process a session leader, then execs (Linux keeps its own when present). */
const SETSID_SHIM = `#!/bin/sh
[ "$1" = -w ] && shift
exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' "$@"
`;

function makeRunner(over: Record<string, unknown> = {}): SessionRunner {
  const remote: RemoteDef = { host: 'fake', user: 'karst', mode: 'direct', remoteDir };
  return createSshSessionRunner({
    ssh: createNodeSshProcess({ sshBin: fake.ssh }), sshBin: fake.ssh, host: NODE_SBX_PROCESS, remote,
    remoteName: 'devbox', sandboxName: NAME, projectPrefix: PREFIX, controlDir: '/tmp/karst-ssh-test/',
    core: 'claude', ticketId: 7, hostWorktreePath: hostWt, tmux: false, registry: createSshGateRegistry(),
    killGraceSeconds: 0, ...over,
  });
}

const spec = (over: Record<string, unknown> = {}) => ({
  ticketId: 7, hostWorktreePath: hostWt, command: 'claude', args: [] as string[],
  env: { KARST_TICKET_ID: '7', KARST_WORKTREE: hostWt, ANTHROPIC_API_KEY: 'sk-secret' }, ...over,
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

beforeAll(async () => {
  fake = await makeFakeSshBin();
  shimDir = await mkdtemp(join(tmpdir(), 'karst-ssh-shim-'));
  if (process.platform === 'darwin') {
    await writeFile(join(shimDir, 'setsid'), SETSID_SHIM);
    await chmod(join(shimDir, 'setsid'), 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
});

afterAll(async () => {
  process.env.PATH = savedPath;
  await fake.cleanup();
  await rm(shimDir, { recursive: true, force: true });
});

beforeEach(async () => {
  hostWt = await mkdtemp(join(tmpdir(), 'karst-ssh-wt-'));
  remoteDir = join(fake.remoteRoot, 'srv', `k${String(Date.now())}${String(Math.random()).slice(2, 8)}`);
  ws = join(remoteDir, NAME);
  await mkdir(join(ws, 'repo', 'sub'), { recursive: true });
});

describe('prepareInteractive (real sh)', () => {
  it('makes the dirs 0700 and the env file 0600, with the remote paths', async () => {
    await makeRunner().prepareInteractive!(spec());
    for (const d of ['bridge', 'bridge/7', 'bridge/7/results', 'bridge/7/inbox', 'gates', 'env']) {
      expect(await mode(join(ws, d))).toBe(0o700);
    }
    const envFile = join(ws, 'env', 'env.sh');
    expect(await mode(envFile)).toBe(0o600);
    const body = await readFile(envFile, 'utf8');
    expect(body).toContain(`export KARST_WORKTREE='${ws}/repo'`);
    expect(body).not.toContain('sk-secret');
  });

  it('refuses a symlinked dir', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'karst-ssh-elsewhere-'));
    await symlink(elsewhere, join(ws, 'gates'));
    await expect(makeRunner().prepareInteractive!(spec())).rejects.toThrow(/symlink/);
    await rm(elsewhere, { recursive: true, force: true });
  });
});

describe('runGate (real sh)', () => {
  it('the first gate writes and reads its exit file, and leaves no pgid or exit file', async () => {
    await makeRunner().prepareInteractive!(spec());
    const out = await makeRunner().runGate!('sh', ['-c', 'echo out; echo err >&2; exit 3'], join(hostWt, 'sub'));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 3 });
    expect(await mode(join(ws, 'gates'))).toBe(0o700);
    expect(await readdir(join(ws, 'gates'))).toEqual([]);
    expect((await readdir(ws)).filter((f) => f.endsWith('.pgid'))).toEqual([]);
  });

  it('runs in the mapped subdir cwd', async () => {
    await makeRunner().prepareInteractive!(spec());
    const out = await makeRunner().runGate!('sh', ['-c', 'pwd; exit 0'], join(hostWt, 'sub'));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 0 });
    expect(out.kind === 'completed' && out.output).toContain(join(ws, 'repo', 'sub'));
  });

  it('a gate before any prepare (no env file) still has a verdict', async () => {
    const out = await makeRunner().runGate!('sh', ['-c', 'exit 0'], hostWt);
    expect(out).toMatchObject({ kind: 'completed' });
    expect(out.kind === 'completed' && out.exitCode).not.toBe(0);
  });

  it('more than 1 MiB of output keeps the real exit code', async () => {
    await makeRunner().prepareInteractive!(spec());
    const out = await makeRunner().runGate!('sh', ['-c', 'head -c 2000000 /dev/zero | tr "\\0" x; exit 4'], hostWt);
    expect(out).toMatchObject({ kind: 'completed', exitCode: 4 });
  });

  it('a timeout kills the remote group and removes its pgid file', async () => {
    await makeRunner().prepareInteractive!(spec());
    const out = await makeRunner().runGate!('sh', ['-c', 'sleep 30'], hostWt, { timeoutMs: 1500, terminationGraceMs: 100 });
    expect(out.kind).toBe('timedOut');
    expect((await readdir(ws)).filter((f) => f.endsWith('.pgid'))).toEqual([]);
  }, 20_000);
});

describe('placeInteractive (real sh, no tmux)', () => {
  it('passes args with spaces, quotes and $ through every quoting layer unchanged', async () => {
    const core = join(fake.remoteRoot, 'fake-core');
    await writeFile(core, '#!/bin/sh\nfor a in "$@"; do printf "<%s>\\n" "$a"; done\nprintf "cwd=%s\\n" "$PWD"\n');
    await chmod(core, 0o755);
    const runner = makeRunner({ coreBin: core });
    await runner.prepareInteractive!(spec());
    const args = ["it's", 'a b', '$HOME', '"q"', `${hostWt}/f`];
    const placed = runner.placeInteractive!(spec({ args }));
    const withoutTty = placed.shellArgs.filter((a) => a !== '-t');
    const { stdout } = await run(placed.shellPath, withoutTty);
    expect(stdout).toBe(`<it's>\n<a b>\n<$HOME>\n<"q">\n<${ws}/repo/f>\ncwd=${ws}/repo\n`);
  });
});

describe('MARKER_EMIT in the remote run dir', () => {
  it('accepts <ws>/bridge/<ticketId> as its run dir and appends a marker for the ticket', async () => {
    const runner = makeRunner();
    await runner.prepareInteractive!(spec());
    const runDir = runner.bridgeRunDir!({ dir: '/h' } as unknown as BridgePaths);
    expect(runDir).toBe(`${remoteDir.replace(/\/+$/, '')}/${NAME}/bridge/7`);
    await writeFile(join(runDir, 'emit-marker.cjs'), MARKER_EMIT);
    const repo = join(ws, 'repo');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const events = join(runDir, 'events.ndjson');
    const script = `cd '${repo}' && KARST_MARKER_WAIT_MS=200 node '${runDir}/emit-marker.cjs' '${events}' impl; exit 0`;
    await run(fake.ssh, sshArgv({ host: 'fake', user: 'karst', mode: 'direct', remoteDir }, '/tmp/x/', script));
    expect(existsSync(events)).toBe(true);
    const line = JSON.parse((await readFile(events, 'utf8')).trim().split('\n')[0]!) as { kind: string; ticket: number };
    expect(line).toMatchObject({ kind: 'marker', ticket: 7 });
  });
});

describe('MARKER_EMIT outside a ticket run dir', () => {
  it('fails against <ws>/bridge/events.ndjson (no numeric ticket dir)', async () => {
    await makeRunner().prepareInteractive!(spec());
    const bridge = join(ws, 'bridge');
    await writeFile(join(bridge, 'emit-marker.cjs'), MARKER_EMIT);
    const repo = join(ws, 'repo');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const script = `cd '${repo}' && KARST_MARKER_WAIT_MS=200 node '${bridge}/emit-marker.cjs' '${bridge}/events.ndjson' impl; echo "rc=$?"`;
    const { stdout } = await run(fake.ssh, sshArgv({ host: 'fake', user: 'karst', mode: 'direct', remoteDir }, '/tmp/x/', script));
    expect(stdout.trim().split('\n').at(-1)).toBe('rc=1');
    expect(existsSync(join(bridge, 'events.ndjson'))).toBe(false);
  });
});
