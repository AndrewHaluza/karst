import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { GateProcessRunner, ProcessOutcome, RunProcessOptions } from '../../workflow/gates/run.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { SHELL_NO_SANDBOX } from '../sandboxShell.js';
import type { BridgePaths } from '../bridge/bridgeDir.js';
import { fakeSshProcess, type FakeSshAnswer } from './fakeSshProcess.js';
import { createSshGateRegistry, sshGateKey } from './sshGateRegistry.js';
import { createSshSessionRunner, interactiveScript, type SshRunnerOptions } from './sshRunner.js';
import { disposeTarget } from './sshDisposeGuard.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const PREFIX = 'karst-0123abcd';
const NAME = `${PREFIX}-7-claude`;
const WS = `/srv/karst/${NAME}`;
const REPO = `${WS}/repo`;
const WT = '/host/wt';
const BRIDGE = '/host/bridge/7';
const RUN_ID = 'aaaaaaaaaaaaaaaa';
const BRIDGE_PATHS = { dir: BRIDGE } as unknown as BridgePaths;

type Ssh = ReturnType<typeof fakeSshProcess>;

/** Decode the `sh -c '<script>'` wrapper back into the script. */
const scriptOf = (args: readonly string[]): string =>
  (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");

function runner(ssh: Ssh, over: Partial<SshRunnerOptions> = {}) {
  return createSshSessionRunner({
    ssh, sshBin: 'ssh', host: fakeSbxProcess(), remote: REMOTE, remoteName: 'devbox', sandboxName: NAME,
    projectPrefix: PREFIX, controlDir: '/tmp/karst-ssh-0/', core: 'claude', ticketId: 7, hostWorktreePath: WT,
    tmux: true, registry: createSshGateRegistry(), newRunId: () => RUN_ID, killGraceSeconds: 0, ...over,
  });
}

const spec = (over: Record<string, unknown> = {}) => ({
  ticketId: 7, hostWorktreePath: WT, command: '/host/bin/claude', args: [`${WT}/x`, '--settings', `${BRIDGE}/s.json`, 'a b'],
  env: { KARST_TICKET_ID: '7', ANTHROPIC_API_KEY: 'sk-secret', HOME: '/Users/me' }, bridgeDir: BRIDGE, ...over,
});

function gate(outcome: ProcessOutcome, chunks: readonly string[] = []): GateProcessRunner & { readonly seen: { cmd: string; args: readonly string[]; cwd: string }[] } {
  const seen: { cmd: string; args: readonly string[]; cwd: string }[] = [];
  const fn = async (cmd: string, args: readonly string[], cwd: string, opts?: RunProcessOptions): Promise<ProcessOutcome> => {
    seen.push({ cmd, args, cwd });
    for (const text of chunks) opts?.onOutput?.({ stream: 'stderr', text });
    return outcome;
  };
  return Object.assign(fn, { seen });
}

const completed = (exitCode: number): ProcessOutcome => ({ kind: 'completed', exitCode, output: '' });
const exitAnswer = (a: FakeSshAnswer): Record<string, FakeSshAnswer> => ({ '# karst-ssh-gate-exit': a });

describe('createSshSessionRunner shape', () => {
  it('is kind ssh, prompted, and has no runHeadless', () => {
    const r = runner(fakeSshProcess());
    expect(r.kind).toBe('ssh');
    expect(r.enforcesSandbox).toBe(false);
    expect(r.autonomous).toBe(false);
    expect('runHeadless' in r).toBe(false);
    expect(r.bridgeRunDir?.(BRIDGE_PATHS)).toBe(`${WS}/bridge/7`);
  });
});

describe('placeInteractive', () => {
  it('launch: kills and recreates the tmux session with an exact target and an sh -c pane', () => {
    const placed = runner(fakeSshProcess()).placeInteractive!(spec());
    expect(placed.shellPath).toBe('ssh');
    expect(placed.env).toEqual({});
    expect(placed.shellArgs).toContain('-t');
    const script = scriptOf(placed.shellArgs);
    expect(script).toContain(`tmux kill-session -t '=${NAME}'`);
    expect(script).toMatch(new RegExp(`exec tmux new-session -s '${NAME}' 'sh -c `));
    expect(script).not.toContain('has-session');
  });

  it('reattach: attaches to a live session and never kills it first', () => {
    const script = scriptOf(runner(fakeSshProcess()).placeInteractive!(spec({ reattach: true })).shellArgs);
    expect(script.startsWith(`if tmux has-session -t '=${NAME}' 2>/dev/null; then exec tmux attach -t '=${NAME}'; else tmux kill-session`)).toBe(true);
  });

  it('no tmux (a): a plain exec of the core, no tmux word', () => {
    const script = scriptOf(runner(fakeSshProcess(), { tmux: false }).placeInteractive!(spec()).shellArgs);
    expect(script).not.toContain('tmux');
    expect(script).toBe(`cd '${REPO}' && . '${WS}/env/env.sh' && exec 'claude' '${REPO}/x' '--settings' '${WS}/bridge/7/s.json' 'a b'`);
  });

  it('runs the remote core binary, never the host command path', () => {
    const script = scriptOf(runner(fakeSshProcess(), { tmux: false, coreBin: '/usr/local/bin/claude' }).placeInteractive!(spec()).shellArgs);
    expect(script).toContain(`exec '/usr/local/bin/claude'`);
    expect(script).not.toContain('/host/bin/claude');
  });

  it('puts no env value (no secret) on the argv', () => {
    const placed = runner(fakeSshProcess()).placeInteractive!(spec());
    expect(placed.shellArgs.join(' ')).not.toContain('sk-secret');
  });

  it('refuses a session name that is not a sandbox name', () => {
    expect(() => interactiveScript({
      paths: { workspace: WS, repo: REPO, bridge: '', env: '', gates: '' }, name: 'x;rm', coreBin: 'claude', args: [], tmux: true, reattach: false,
    })).toThrow(/invalid sandbox name/);
  });
});

describe('prepareInteractive', () => {
  it('sends the env file over stdin with the remote paths, and no secret on the argv', async () => {
    const ssh = fakeSshProcess();
    await runner(ssh).prepareInteractive!(spec({ env: { KARST_TICKET_ID: '7', KARST_WORKTREE: WT, OPENAI_API_KEY: 'sk-o', HOME: '/Users/me' } }));
    const call = ssh.stdinCalls[0]!;
    const body = call.stdin.toString('utf8');
    expect(body).toContain(`export KARST_WORKTREE='${REPO}'`);
    expect(body).toContain(`export KARST_BRIDGE_DIR='${WS}/bridge/7'`);
    expect(body).not.toContain('HOME=');
    expect(call.args.join(' ')).not.toContain('sk-o');
    const script = scriptOf(call.args);
    expect(script).toContain('umask 077');
    expect(script).toContain(`mkd '${WS}/bridge/7/results'`);
    expect(script).toContain('[ -L "$1" ]');
    expect(script).toContain('[ -O "$1" ]');
  });

  it('throws when the remote refuses a dir', async () => {
    const ssh = fakeSshProcess({ '# karst-ssh-prepare': { code: 45, stderr: 'karst: refusing x: it is a symlink' } });
    await expect(runner(ssh).prepareInteractive!(spec())).rejects.toThrow(/launch preparation failed.*symlink/);
  });

  it('sweeps orphan gates and skips the run ids live in the registry', async () => {
    const ssh = fakeSshProcess();
    const registry = createSshGateRegistry();
    registry.add(sshGateKey('devbox', NAME), 'bbbbbbbbbbbbbbbb');
    await runner(ssh, { registry }).prepareInteractive!(spec());
    const sweep = ssh.calls.map((c) => scriptOf(c.args)).find((s) => s.startsWith('# karst-ssh-gate-sweep'))!;
    expect(sweep).toContain(`set -- 'bbbbbbbbbbbbbbbb'`);
    expect(sweep).toContain('kill -KILL -- "-$p"');
  });
});

describe('runGate', () => {
  const run = (r: ReturnType<typeof runner>, cwd = WT, args: readonly string[] = ['run', `${WT}/a.ts`]) =>
    r.runGate!('npx', args, cwd);

  it('maps cwd and args to <ws>/repo, also for a subdir cwd, and uses a fresh run id', async () => {
    const g = gate(completed(0));
    const ssh = fakeSshProcess(exitAnswer({ stdout: `${RUN_ID}:0\n` }));
    await run(runner(ssh, { gateProcess: g }), `${WT}/pkg/api`);
    const script = scriptOf(g.seen[0]!.args);
    expect(script).toContain(`cd '${REPO}/pkg/api'`);
    expect(script).toContain(`${REPO}/a.ts`);
    expect(script).toContain(`setsid -w sh -c`);
    expect(script).toContain(`trap 'rm -f '\\''${WS}/gate-${RUN_ID}.pgid'\\''' EXIT`);
    expect(script).toContain(`${WS}/gates/${RUN_ID}.exit`);
  });

  it('refuses a cwd outside the worktree with no verdict', async () => {
    const g = gate(completed(0));
    const out = await run(runner(fakeSshProcess(), { gateProcess: g }), '/elsewhere');
    expect(out.kind).toBe('spawnFailed');
    expect(g.seen).toHaveLength(0);
  });

  it('takes the verdict from the exit file, not the local ssh code', async () => {
    const ssh = fakeSshProcess(exitAnswer({ stdout: `${RUN_ID}:3\n` }));
    const out = await run(runner(ssh, { gateProcess: gate(completed(0)) }));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 3 });
  });

  it('rejects an exit file of another run id and falls back to the own stderr marker', async () => {
    const ssh = fakeSshProcess(exitAnswer({ stdout: 'cccccccccccccccc:0\n' }));
    const out = await run(runner(ssh, { gateProcess: gate(completed(1), [`KARST_GATE_EXIT=${RUN_ID}:1\n`]) }));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 1 });
  });

  it('ignores a false marker of another run id, and takes the LAST own marker', async () => {
    const ssh = fakeSshProcess(exitAnswer({ code: 3 }));
    const chunks = [`KARST_GATE_EXIT=${RUN_ID}:0\nKARST_GATE_EXIT=dddddddddddddddd:0\n`, `KARST_GATE_EX`, `IT=${RUN_ID}:2\n`];
    const out = await run(runner(ssh, { gateProcess: gate(completed(2), chunks) }));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 2 });
  });

  it('a false marker alone gives no verdict', async () => {
    const ssh = fakeSshProcess(exitAnswer({ code: 3 }));
    const out = await run(runner(ssh, { gateProcess: gate(completed(0), ['KARST_GATE_EXIT=dddddddddddddddd:0\n']) }));
    expect(out.kind).toBe('spawnFailed');
  });

  it('255 with no exit file and no marker is a transport failure, no verdict', async () => {
    const ssh = fakeSshProcess(exitAnswer({ code: 255, transport: true }));
    const out = await run(runner(ssh, { gateProcess: gate(completed(255), ['Connection reset by peer\n']) }));
    expect(out).toMatchObject({ kind: 'spawnFailed', message: 'ssh transport failed: Connection reset by peer' });
  });

  it('255 with an own exit file is a real gate exit 255', async () => {
    const ssh = fakeSshProcess(exitAnswer({ stdout: `${RUN_ID}:255` }));
    const out = await run(runner(ssh, { gateProcess: gate(completed(255)) }));
    expect(out).toMatchObject({ kind: 'completed', exitCode: 255 });
  });

  it.each(['timedOut', 'aborted'] as const)('on %s kills the remote group TERM then KILL, while the pgid file exists', async (kind) => {
    const ssh = fakeSshProcess({ '# karst-ssh-gate-pgid': { stdout: '4242' } });
    const out = await run(runner(ssh, { gateProcess: gate({ kind, output: '' }) }));
    expect(out.kind).toBe(kind);
    const kill = ssh.calls.map((c) => scriptOf(c.args)).find((s) => s.startsWith('# karst-ssh-gate-kill'))!;
    expect(kill).toContain('if [ -f "$f" ]; then kill -TERM -- -4242');
    expect(kill).toContain('if [ -f "$f" ]; then kill -KILL -- -4242');
    expect(kill).toContain(`rm -f -- "$f" '${WS}/gates/${RUN_ID}.exit'`);
  });

  it.each(['', '1', '0', '-1', '12 34', 'abc'])('never kills an invalid pgid %j', async (pgid) => {
    const ssh = fakeSshProcess({ '# karst-ssh-gate-pgid': { stdout: pgid } });
    await run(runner(ssh, { gateProcess: gate({ kind: 'timedOut', output: '' }) }));
    expect(ssh.calls.some((c) => scriptOf(c.args).startsWith('# karst-ssh-gate-kill'))).toBe(false);
  });

  it('adds the run id to the registry while it runs and removes it when it settles', async () => {
    const registry = createSshGateRegistry();
    const key = sshGateKey('devbox', NAME);
    let during: readonly string[] = [];
    const g: GateProcessRunner = async () => {
      during = [...registry.live(key)];
      return completed(0);
    };
    await run(runner(fakeSshProcess(exitAnswer({ stdout: `${RUN_ID}:0` })), { gateProcess: g, registry }));
    expect(during).toEqual([RUN_ID]);
    expect([...registry.live(key)]).toEqual([]);
  });

  it('a gate failure of the host boundary still removes the run id', async () => {
    const registry = createSshGateRegistry();
    const g: GateProcessRunner = async () => { throw new Error('boom'); };
    await expect(run(runner(fakeSshProcess(), { gateProcess: g, registry }))).rejects.toThrow('boom');
    expect([...registry.live(sshGateKey('devbox', NAME))]).toEqual([]);
  });
});

describe('stop', () => {
  it('kills the tmux session and the gates live in the registry, also those of another runner instance', async () => {
    const registry = createSshGateRegistry();
    registry.add(sshGateKey('devbox', NAME), 'eeeeeeeeeeeeeeee');
    const ssh = fakeSshProcess({ '# karst-ssh-gate-pgid': { stdout: '99' } });
    await runner(ssh, { registry }).stop!();
    const scripts = ssh.calls.map((c) => scriptOf(c.args));
    expect(scripts.some((s) => s.includes(`tmux kill-session -t '=${NAME}'`))).toBe(true);
    expect(scripts.some((s) => s.includes('eeeeeeeeeeeeeeee') && s.startsWith('# karst-ssh-gate-pgid'))).toBe(true);
    expect(scripts.some((s) => s.startsWith('# karst-ssh-gate-kill') && s.includes('-99'))).toBe(true);
  });
});

describe('dispose guard', () => {
  it.each([
    ['/', NAME], ['/srv', NAME], ['/srv/../etc', NAME], ['/srv/./k', NAME], ['/srv//k', NAME], ['/srv/k/', NAME], ['srv/k', NAME],
    ['/srv/k', `${NAME}/x`], ['/srv/k', '..'], ['/srv/k', 'karst-ffffffff-7-claude'], ['/srv/k', 'other'],
  ])('refuses remoteDir %j name %j', (dir, name) => {
    expect(disposeTarget(dir, name, PREFIX).ok).toBe(false);
  });

  it('deletes exactly <remoteDir>/<name>', async () => {
    expect(disposeTarget('/srv/karst', NAME, PREFIX)).toEqual({ ok: true, path: `/srv/karst/${NAME}` });
    const ssh = fakeSshProcess();
    const out = await runner(ssh).dispose!({ hostWorktreePath: WT, branch: 'b' } as never);
    expect(out.ok).toBe(true);
    expect(ssh.calls.map((c) => scriptOf(c.args))).toContain(`# karst-ssh-dispose\nrm -rf -- '${WS}'`);
  });

  it('sends no rm for a refused name', async () => {
    const ssh = fakeSshProcess();
    const out = await runner(ssh, { projectPrefix: 'karst-ffffffff' }).dispose!({ hostWorktreePath: WT, branch: 'b' } as never);
    expect(out.ok).toBe(false);
    expect(ssh.calls.some((c) => scriptOf(c.args).includes('rm -rf'))).toBe(false);
  });
});

describe('probeSandbox', () => {
  it.each([
    [{ code: 0 }, 'present'], [{ code: 44 }, 'absent'], [{ code: 1 }, 'unknown'], [{ code: 255, transport: true }, 'unknown'],
  ] as const)('%j -> %s', async (answer, state) => {
    const r = runner(fakeSshProcess({ '# karst-ssh-probe': answer }));
    expect((await r.probeSandbox!()).state).toBe(state);
  });

  it('shellCommand: no clone gives the no-sandbox reason; a clone opens a login shell in the repo', async () => {
    const absent = runner(fakeSshProcess({ '# karst-ssh-probe': { code: 44 } }));
    expect(await absent.shellCommand!({ hostWorktreePath: WT, branch: 'b' } as never)).toEqual({ ok: false, reason: SHELL_NO_SANDBOX });
    const present = await runner(fakeSshProcess()).shellCommand!({ hostWorktreePath: WT, branch: 'b' } as never);
    expect(present.ok && scriptOf(present.args)).toBe(`cd '${REPO}' && exec "$SHELL" -l`);
  });
});

describe('SPEC coverage: args, env keys, services, two instances', () => {
  it('rewrites a host path embedded in an arg (key=value and inline JSON), at a path boundary only', () => {
    const json = JSON.stringify({ hooks: { cmd: `node ${BRIDGE}/claude/bridge.cjs ${BRIDGE}/events.ndjson` } });
    const placed = runner(fakeSshProcess(), { tmux: false }).placeInteractive!(spec({ args: [`--settings=${BRIDGE}/s.json`, json, `${WT}x/keep`] }));
    const script = scriptOf(placed.shellArgs);
    expect(script).toContain(`'--settings=${WS}/bridge/7/s.json'`);
    expect(script).toContain(`node ${WS}/bridge/7/claude/bridge.cjs ${WS}/bridge/7/events.ndjson`);
    expect(script).toContain(`'${WT}x/keep'`);
    expect(script).not.toContain(BRIDGE);
  });

  it('env file: secrets dropped, OPENCODE_PURE, KARST_* and KARST_LAUNCH_ID kept, KARST_BRIDGE_DIR set', async () => {
    const ssh = fakeSshProcess();
    await runner(ssh).prepareInteractive!(spec({ env: {
      FOO_SECRET: 'f', AWS_SECRET_ACCESS_KEY: 'a', OPENCODE_PURE: '1', KARST_TICKET_ID: '7', KARST_LAUNCH_ID: 'L1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: 'ask' }, cwd: WT }),
    } }));
    const body = ssh.stdinCalls[0]!.stdin.toString('utf8');
    expect(body).not.toMatch(/FOO_SECRET|AWS_SECRET_ACCESS_KEY/);
    expect(body).toContain(`export OPENCODE_PURE='1'`);
    expect(body).toContain(`export KARST_TICKET_ID='7'`);
    expect(body).toContain(`export KARST_LAUNCH_ID='L1'`);
    expect(body).toContain(`export KARST_BRIDGE_DIR='${WS}/bridge/7'`);
    expect(body).toContain('"permission":{"edit":"ask"}');
    expect(body).not.toContain(WT);
    expect(ssh.stdinCalls[0]!.args.join(' ')).not.toMatch(/L1|"permission"/);
  });

  it.each([
    ['opencode', { OPENCODE_PERMISSION: JSON.stringify({ external_directory: { [`${WT}/**`]: 'allow' } }), OPENCODE_CONFIG_DIR: `${BRIDGE}/opencode` }],
    ['opencode2', { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'ask' }, dir: `${WT}/sub` }) }],
  ] as const)('a direct %s launch keeps its config keys with no host path in the value', async (core, env) => {
    const ssh = fakeSshProcess();
    await runner(ssh, { core, sandboxName: `${PREFIX}-7-${core}` }).prepareInteractive!(spec({ env: { ...env } }));
    const body = ssh.stdinCalls[0]!.stdin.toString('utf8');
    for (const key of Object.keys(env)) expect(body).toContain(`export ${key}=`);
    expect(body).not.toContain(WT);
    expect(body).not.toContain(BRIDGE);
  });

  it('a service start with a subdir serviceCwd runs cd <ws>/repo/<sub> with its args rewritten', async () => {
    const g = gate(completed(0));
    const r = runner(fakeSshProcess(exitAnswer({ stdout: `${RUN_ID}:0` })), { gateProcess: g });
    await r.runGate!('sh', ['-c', 'cd "$2"', 'karst-svc', 'tok', `${WT}/apps/web`, 'npm', 'run', 'dev'], `${WT}/apps/web`);
    const script = scriptOf(g.seen[0]!.args);
    expect(script).toContain(`cd '${REPO}/apps/web'`);
    expect(script).toContain(`${REPO}/apps/web`);
    expect(script).not.toContain(WT);
  });

  it('two concurrent gates: neither kills the other, each reads its own exit file', async () => {
    const ids = ['1111111111111111', '2222222222222222'];
    let next = 0;
    const ssh = fakeSshProcess({ [`${WS}/gates/${ids[0]!}.exit`]: { stdout: `${ids[0]!}:0` }, [`${WS}/gates/${ids[1]!}.exit`]: { stdout: `${ids[1]!}:1` } });
    const r = runner(ssh, { gateProcess: gate(completed(0)), newRunId: () => ids[next++]! });
    const [a, b] = await Promise.all([r.runGate!('true', [], WT), r.runGate!('false', [], WT)]);
    expect(a).toMatchObject({ exitCode: 0 });
    expect(b).toMatchObject({ exitCode: 1 });
    expect(ssh.calls.some((c) => scriptOf(c.args).startsWith('# karst-ssh-gate-kill'))).toBe(false);
  });

  it('two runner instances: stop on the second kills the live gate of the first; the sweep never kills it', async () => {
    const registry = createSshGateRegistry();
    const ssh = fakeSshProcess({ '# karst-ssh-gate-pgid': { stdout: '777' } });
    let release: (o: ProcessOutcome) => void = () => undefined;
    const hanging: GateProcessRunner = () => new Promise((resolve) => { release = resolve; });
    const first = runner(ssh, { registry, gateProcess: hanging });
    const pending = first.runGate!('sleep', ['99'], WT);
    await Promise.resolve();
    const second = runner(ssh, { registry, newRunId: () => 'ffffffffffffffff' });
    await second.prepareInteractive!(spec({ reattach: true }));
    const sweep = ssh.calls.map((c) => scriptOf(c.args)).find((s) => s.startsWith('# karst-ssh-gate-sweep'))!;
    expect(sweep).toContain(`set -- '${RUN_ID}'`);
    await second.stop!();
    const kill = ssh.calls.map((c) => scriptOf(c.args)).find((s) => s.startsWith('# karst-ssh-gate-kill'))!;
    expect(kill).toContain(`${WS}/gate-${RUN_ID}.pgid`);
    expect(kill).toContain('kill -TERM -- -777');
    release({ kind: 'aborted', output: '' });
    await pending;
  });
});
