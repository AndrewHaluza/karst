import { describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { GateProcessRunner, ProcessOutcome } from '../../workflow/gates/run.js';
import { fakeSbxProcess } from '../sbx/fakeSbxProcess.js';
import { START_SCRIPT_SD, serviceToken } from '../sandboxServices.js';
import { fakeSshProcess, type FakeSshAnswer, type FakeSshProcess } from './fakeSshProcess.js';
import { fakeTunnels, type FakeTunnels } from './fakeTunnels.js';
import { createSshGateRegistry } from './sshGateRegistry.js';
import { createSshSessionRunner, type SshRunnerOptions } from './sshRunner.js';
import {
  PORTS_SCRIPT,
  parseListeningPorts,
  serviceEnvBody,
  sshHostServicesRefusal,
  sshSetupWindowInfo,
  stopServicesScript,
} from './sshServices.js';

const REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const OPT_IN: RemoteDef = { ...REMOTE, allowHostServices: true };
const PREFIX = 'karst-0123abcd';
const NAME = `${PREFIX}-7-claude`;
const WS = `/srv/karst/${NAME}`;
const WT = '/host/wt';
const RUN_ID = 'aaaaaaaaaaaaaaaa';

const scriptOf = (args: readonly string[]): string =>
  (args.at(-1) ?? '').replace(/^sh -c '/s, '').replace(/'$/s, '').split(`'\\''`).join("'");

const tunnels = fakeTunnels;
type Tunnels = FakeTunnels;

const present: Record<string, FakeSshAnswer> = { '# karst-ssh-probe': { code: 0 } };

function runner(ssh: FakeSshProcess, t: Tunnels, over: Partial<SshRunnerOptions> = {}) {
  return createSshSessionRunner({
    ssh, sshBin: 'ssh', host: fakeSbxProcess(), remote: REMOTE, remoteName: 'devbox', sandboxName: NAME,
    projectPrefix: PREFIX, controlDir: '/tmp/karst-ssh-0/', core: 'claude', ticketId: 7, hostWorktreePath: WT,
    tmux: true, registry: createSshGateRegistry(), newRunId: () => RUN_ID, killGraceSeconds: 0,
    tunnels: t.registry, ...over,
  });
}

const flag = (argv: readonly string[], f: string): string => argv[argv.indexOf(f) + 1]!;

describe('direct services: members and state dir', () => {
  it('has the service members and a <ws>/svc state dir', () => {
    const r = runner(fakeSshProcess(), tunnels());
    expect(r.serviceStateDir).toBe(`${WS}/svc`);
    for (const k of ['canHostServices', 'publishPort', 'unpublishPort', 'listPorts', 'stopServices', 'allowHostPorts', 'probeRemotePorts', 'setupWindow', 'writeServiceEnv', 'removeServiceEnv'] as const) {
      expect(typeof r[k]).toBe('function');
    }
  });

  it('canHostServices follows the workspace probe', async () => {
    expect(await runner(fakeSshProcess(present), tunnels()).canHostServices!()).toBe(true);
    expect(await runner(fakeSshProcess({ '# karst-ssh-probe': { code: 44 } }), tunnels()).canHostServices!()).toBe(false);
  });
});

describe('direct publishPort / unpublishPort / listPorts', () => {
  it('opens one -L tunnel per sandbox and host port on 127.0.0.1, lists it, and closes only that key', async () => {
    const t = tunnels();
    const r = runner(fakeSshProcess(present), t);
    expect(await r.publishPort!({ hostPort: 18080, sandboxPort: 8080 })).toEqual({ ok: true });
    expect(await r.publishPort!({ hostPort: 18081, sandboxPort: 8081 })).toEqual({ ok: true });
    expect(t.spawned).toHaveLength(2);
    expect(flag(t.spawned[0]!.argv, '-L')).toBe('127.0.0.1:18080:127.0.0.1:8080');
    expect(t.spawned[0]!.argv.join(' ')).not.toContain('0.0.0.0');
    expect(t.registry.list(`${NAME}:L:`).map((h) => h.key).sort()).toEqual([`${NAME}:L:18080`, `${NAME}:L:18081`]);
    expect(await r.listPorts!()).toEqual([{ hostPort: 18080, sandboxPort: 8080 }, { hostPort: 18081, sandboxPort: 8081 }]);
    await r.unpublishPort!({ hostPort: 18080, sandboxPort: 8080 });
    expect(await r.listPorts!()).toEqual([{ hostPort: 18081, sandboxPort: 8081 }]);
    expect(t.spawned[1]!.kills).toBe(0);
  });

  it('a host bind failure is portTaken: true; another failure is portTaken: false', async () => {
    const taken = tunnels({ connect: false, onSpawn: (c) => queueMicrotask(() => { c.stderr.emit('data', 'bind [127.0.0.1]:18080: Address already in use\n'); c.emit('exit', 255, null); }) });
    expect(await runner(fakeSshProcess(present), taken).publishPort!({ hostPort: 18080, sandboxPort: 8080 }))
      .toMatchObject({ ok: false, portTaken: true });
    const refused = tunnels({ connect: false, onSpawn: (c) => queueMicrotask(() => { c.stderr.emit('data', 'Permission denied (publickey).\n'); c.emit('exit', 255, null); }) });
    expect(await runner(fakeSshProcess(present), refused).publishPort!({ hostPort: 18080, sandboxPort: 8080 }))
      .toMatchObject({ ok: false, portTaken: false });
  });

  it('listPorts is null when the probe is unknown, and leaves a down tunnel out', async () => {
    const t = tunnels();
    expect(await runner(fakeSshProcess({ '# karst-ssh-probe': { code: 255, transport: true } }), t).listPorts!()).toBeNull();
    const r = runner(fakeSshProcess(present), t);
    await r.publishPort!({ hostPort: 18080, sandboxPort: 8080 });
    await t.registry.list(`${NAME}:L:`)[0]!.close();
    expect(await r.listPorts!()).toEqual([]);
  });
});

describe('direct probeRemotePorts', () => {
  it('parses ss and netstat listings into the busy subset in one ssh call', async () => {
    const ss = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
      'LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*',
      'LISTEN 0      511             [::]:3000         [::]:*',
      'LISTEN 0      128                *:22              *:*',
    ].join('\n');
    const ssh = fakeSshProcess({ '# karst-ssh-ports': { stdout: ss } });
    expect(await runner(ssh, tunnels()).probeRemotePorts!([5432, 3000, 8080])).toEqual([5432, 3000]);
    expect(ssh.calls).toHaveLength(1);
    expect(scriptOf(ssh.calls[0]!.args)).toBe(PORTS_SCRIPT);
    const netstat = 'Proto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN\n';
    expect([...parseListeningPorts(netstat)]).toEqual([8080]);
  });

  it('fails closed: a failed probe throws, no ports means no ssh call', async () => {
    await expect(runner(fakeSshProcess({ '# karst-ssh-ports': { code: 46, stderr: 'karst: neither ss nor netstat' } }), tunnels()).probeRemotePorts!([5432]))
      .rejects.toThrow(/remote port probe failed \(exit 46\)/);
    await expect(runner(fakeSshProcess({ '# karst-ssh-ports': { code: 255, transport: true, stderr: 'Connection reset' } }), tunnels()).probeRemotePorts!([5432]))
      .rejects.toThrow(/transport failed/);
    const idle = fakeSshProcess();
    expect(await runner(idle, tunnels()).probeRemotePorts!([])).toEqual([]);
    expect(idle.calls).toHaveLength(0);
    await expect(runner(idle, tunnels()).probeRemotePorts!([0])).rejects.toThrow(/not a TCP port/);
  });
});

describe('direct service env (no value on any argv)', () => {
  const SECRET = 'pg-secret-value';

  it('writeServiceEnv sends the values on stdin into a 0600 file under <ws>/svc, after the dir check', async () => {
    const ssh = fakeSshProcess();
    const file = await runner(ssh, tunnels()).writeServiceEnv!('web', { DATABASE_URL: SECRET, 'bad-name': 'x' });
    expect(file).toBe(`${WS}/svc/karst-svc-web.env`);
    const call = ssh.stdinCalls[0]!;
    expect(call.stdin.toString('utf8')).toBe(`export DATABASE_URL='${SECRET}'\n`);
    expect(call.args.join(' ')).not.toContain(SECRET);
    const script = scriptOf(call.args);
    expect(script.indexOf('umask 077')).toBeLessThan(script.indexOf('mkdir -p -m 700 "$sd"'));
    expect(script.indexOf('[ -O "$sd" ]')).toBeLessThan(script.indexOf('cat > "$f.tmp"'));
    expect(script).toContain('chmod 600 "$f.tmp" && mv -f "$f.tmp" "$f"');
  });

  it('refuses an invalid key and fails on a refused dir', async () => {
    await expect(runner(fakeSshProcess(), tunnels()).writeServiceEnv!('../x', {})).rejects.toThrow(/invalid service key/);
    await expect(runner(fakeSshProcess({ '# karst-ssh-svc-env': { code: 1, stderr: 'karst: refusing /srv: it is a symlink' } }), tunnels()).writeServiceEnv!('web', {}))
      .rejects.toThrow(/service env write failed/);
  });

  it('a service start: write the env file, then a gate that sources it; no env value in any argv', async () => {
    const ssh = fakeSshProcess({ ...present, '# karst-ssh-gate-exit': { stdout: `${RUN_ID}:0` } });
    const seen: (readonly string[])[] = [];
    const gateProcess: GateProcessRunner = async (_bin, args): Promise<ProcessOutcome> => {
      seen.push(args);
      return { kind: 'completed', exitCode: 0, output: '' };
    };
    const t = tunnels();
    const r = runner(ssh, t, { gateProcess });
    const key = serviceToken('web');
    const envFile = await r.writeServiceEnv!(key, { DATABASE_URL: SECRET, PORT: '8080' });
    await r.runGate!('sh', ['-c', START_SCRIPT_SD, 'karst-svc', r.serviceStateDir!, key, WT, 'npm', 'run', 'dev'], WT, { envFile });
    expect(ssh.stdinCalls).toHaveLength(1);
    const startScript = scriptOf(seen[0]!);
    expect(startScript).toContain(`. '${WS}/env/env.sh' && . '${WS}/svc/karst-svc-${key}.env'`);
    expect(startScript).toContain(`'${WS}/svc'`);
    const allArgv = [...ssh.calls, ...ssh.stdinCalls].map((c) => c.args.join(' ')).concat(seen.map((a) => a.join(' ')), t.spawned.map((c) => c.argv.join(' ')));
    for (const a of allArgv) expect(a).not.toContain(SECRET);
    expect(ssh.stdinCalls[0]!.stdin.toString('utf8')).toContain(SECRET);
    await r.removeServiceEnv!(key);
    expect(scriptOf(ssh.calls.at(-1)!.args)).toContain(`rm -f -- '${WS}/svc/karst-svc-${key}.env'`);
  });

  it('serviceEnvBody quotes like remoteEnvScript', () => {
    expect(serviceEnvBody({ B: "it's", A: '$(x)' })).toBe(`export A='$(x)'\nexport B='it'\\''s'\n`);
    expect(serviceEnvBody({})).toBe('');
  });
});

describe('direct setupWindow', () => {
  it('is ok, unenforced, and logs one INFO line per runner', async () => {
    const info = vi.fn();
    const ssh = fakeSshProcess();
    const r = runner(ssh, tunnels(), { info });
    const w1 = await r.setupWindow!(['registry.npmjs.org']);
    const w2 = await r.setupWindow!(['registry.npmjs.org']);
    expect(w1).toMatchObject({ ok: true, enforced: false });
    expect(w2).toMatchObject({ ok: true, enforced: false });
    if (w1.ok) await w1.close();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(sshSetupWindowInfo('devbox'));
    expect(ssh.calls).toHaveLength(0);
  });
});

describe('direct allowHostPorts', () => {
  it('refuses a non-empty list without allowHostServices and opens nothing', async () => {
    const t = tunnels();
    expect(await runner(fakeSshProcess(), t).allowHostPorts!([5432])).toEqual({ ok: false, reason: sshHostServicesRefusal('devbox') });
    expect(sshHostServicesRefusal('devbox')).toBe('ssh devbox: baseline host services need remotes.devbox.allowHostServices');
    expect(t.spawned).toHaveLength(0);
    expect(await runner(fakeSshProcess(), t).allowHostPorts!([])).toEqual({ ok: true });
  });

  it('two tickets on one port share one -R tunnel; the first release keeps it, the second closes it', async () => {
    const t = tunnels();
    const a = runner(fakeSshProcess(), t, { remote: OPT_IN });
    const b = runner(fakeSshProcess(), t, { remote: OPT_IN, ticketId: 8, sandboxName: `${PREFIX}-8-claude` });
    expect(await a.allowHostPorts!([5432])).toEqual({ ok: true });
    expect(await a.allowHostPorts!([5432])).toEqual({ ok: true });
    expect(await b.allowHostPorts!([5432])).toEqual({ ok: true });
    expect(t.spawned).toHaveLength(1);
    expect(flag(t.spawned[0]!.argv, '-R')).toBe('127.0.0.1:5432:127.0.0.1:5432');
    expect(t.registry.list('devbox:R:').map((h) => h.key)).toEqual(['devbox:R:5432']);
    expect(await a.allowHostPorts!([])).toEqual({ ok: true });
    expect(t.spawned[0]!.kills).toBe(0);
    expect(t.registry.heldR('devbox', 8)).toEqual([5432]);
    await b.stopServices!();
    expect(t.spawned[0]!.kills).toBe(1);
    expect(t.registry.list('devbox:R:')).toEqual([]);
  });

  it('-L keys stay per sandbox: two sandboxes on one host-side port name two keys', async () => {
    const t = tunnels();
    await runner(fakeSshProcess(), t).publishPort!({ hostPort: 18080, sandboxPort: 8080 });
    await runner(fakeSshProcess(), t, { ticketId: 8, sandboxName: `${PREFIX}-8-claude` }).publishPort!({ hostPort: 18090, sandboxPort: 8080 });
    expect(t.registry.forSandbox(NAME).map((h) => h.key)).toEqual([`${NAME}:L:18080`]);
    expect(t.registry.forSandbox(`${PREFIX}-8-claude`).map((h) => h.key)).toEqual([`${PREFIX}-8-claude:L:18090`]);
  });
});

describe('direct stopServices and dispose', () => {
  it('kills every pid group in <ws>/svc, then closes this sandbox -L tunnels and this ticket -R keys', async () => {
    const t = tunnels();
    const ssh = fakeSshProcess(present);
    const r = runner(ssh, t, { remote: OPT_IN });
    const other = runner(fakeSshProcess(present), t, { ticketId: 8, sandboxName: `${PREFIX}-8-claude` });
    await r.publishPort!({ hostPort: 18080, sandboxPort: 8080 });
    await other.publishPort!({ hostPort: 18090, sandboxPort: 8080 });
    await r.allowHostPorts!([5432]);
    await r.stopServices!();
    const stop = ssh.calls.map((c) => scriptOf(c.args)).find((s) => s.startsWith('# karst-ssh-svc-stop'))!;
    expect(stop).toBe(stopServicesScript(`${WS}/svc`));
    expect(stop).toContain('kill -TERM -"$p"');
    expect(stop).not.toContain('kill -TERM --');
    expect(t.registry.forSandbox(NAME)).toEqual([]);
    expect(t.registry.heldR('devbox', 7)).toEqual([]);
    expect(t.registry.forSandbox(`${PREFIX}-8-claude`)).toHaveLength(1);
  });

  it('dispose stops the services and closes the tunnels before the workspace removal', async () => {
    const t = tunnels();
    const ssh = fakeSshProcess(present);
    const r = runner(ssh, t);
    await r.publishPort!({ hostPort: 18080, sandboxPort: 8080 });
    await r.dispose!({ hostWorktreePath: WT, branch: 'b' });
    const scripts = ssh.calls.map((c) => scriptOf(c.args).split('\n')[0]);
    expect(scripts.indexOf('# karst-ssh-svc-stop')).toBeLessThan(scripts.indexOf('# karst-ssh-dispose'));
    expect(t.spawned[0]!.kills).toBe(1);
    expect(t.registry.forSandbox(NAME)).toEqual([]);
  });
});
