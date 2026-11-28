import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { buildFileHookSettings } from '../fileHookSettings.js';
import { sandboxMarkerCommand } from '../sandboxInstructions.js';
import { recordRemoteTrust } from './remoteTrust.js';
import {
  bridgeTailScript,
  bridgeUploadFiles,
  startSshBridgeForwarder,
  stopAllSshBridgeForwarders,
  stopSshBridgeForwarder,
  uploadBridgeScripts,
  type SshBridgeForwarderHandle,
} from './sshBridge.js';
import type { SshProcess, SshResult } from './sshProcess.js';
import { MAX_BRIDGE_LINE_BYTES } from '../bridge/bridgeVerifier.js';

/**
 * The D556 forwarder (edit 1) and the script upload (edit 3), driven with a fake
 * stream and injected timers: every reconnect, offset, drop and trust refusal is
 * deterministic, and the test never spawns a real ssh.
 */

const REMOTE: RemoteDef = { host: 'box', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const NAME = 'devbox';
const TICKET = 7;
const WS = '/srv/karst/karst-0123abcd-7-claude';
const RUN_DIR = `${WS}/bridge/${String(TICKET)}`;

class FakeStream extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = 0;
  kill(): boolean {
    this.killed += 1;
    return true;
  }
  push(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }
  close(code = 0): void {
    this.emit('close', code);
  }
}

class FakeSsh implements SshProcess {
  readonly spawns: string[][] = [];
  readonly runs: Array<{ args: string[]; stdin?: string }> = [];
  readonly streams: FakeStream[] = [];
  constructor(private readonly onSpawn?: (stream: FakeStream, index: number) => void) {}
  run(args: readonly string[]): Promise<SshResult> {
    this.runs.push({ args: [...args] });
    return Promise.resolve({ code: 0, stdout: '', stdoutBuffer: Buffer.alloc(0), stderr: '' });
  }
  runWithStdin(args: readonly string[], stdin: Buffer | NodeJS.ReadableStream): Promise<SshResult> {
    this.runs.push({ args: [...args], stdin: Buffer.isBuffer(stdin) ? stdin.toString('utf8') : undefined });
    return Promise.resolve({ code: 0, stdout: '', stdoutBuffer: Buffer.alloc(0), stderr: '' });
  }
  pipe(): Promise<{ fromCode: number; toCode: number }> {
    return Promise.resolve({ fromCode: 0, toCode: 0 });
  }
  spawnStream(args: readonly string[]): ChildProcess {
    this.spawns.push([...args]);
    const index = this.spawns.length;
    const stream = new FakeStream();
    this.streams.push(stream);
    // A real child can never emit before the caller attaches its listeners.
    if (this.onSpawn) setImmediate(() => this.onSpawn!(stream, index));
    return stream as unknown as ChildProcess;
  }
  get sshCalls(): number {
    return this.runs.length + this.spawns.length;
  }
}

/** A promise a test resolves to let the forwarder reconnect. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

let root: string;
let trustDir: string;
let hostBridgeDir: string;
let stateDir: string;
const handles: SshBridgeForwarderHandle[] = [];

const start = async (ssh: FakeSsh, extra: Record<string, unknown> = {}) => {
  const result = await startSshBridgeForwarder({
    ssh, remote: REMOTE, remoteName: NAME, ws: WS, ticketId: TICKET,
    hostBridgeDir, stateDir, trustDir,
    ensureControlDir: () => Promise.resolve({ ok: true }),
    ...extra,
  });
  if (result.ok) handles.push(result.handle);
  return result;
};

const hostLines = async (): Promise<string[]> => {
  const text = await readFile(join(hostBridgeDir, 'events.ndjson'), 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l !== '');
};

const tick = async (): Promise<void> => { await new Promise((r) => setImmediate(r)); };

/** Poll the event loop until `predicate` holds (no wall-clock timers: the sleep seam is injected). */
async function waitFor(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karst-ssh-bridge-'));
  trustDir = join(root, 'trust');
  hostBridgeDir = join(root, 'bridge', 'events', String(TICKET));
  stateDir = join(root, 'bridge', 'state');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(trustDir, { recursive: true });
  await mkdir(hostBridgeDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  while (handles.length > 0) await handles.pop()!.stop();
  await stopAllSshBridgeForwarders();
  await rm(root, { recursive: true, force: true });
});

describe('bridgeTailScript', () => {
  it('starts at offset 0 with tail -c +1 and the quoted remote file', () => {
    const script = bridgeTailScript(`${RUN_DIR}/events.ndjson`, 0);
    expect(script).toContain(`f='${RUN_DIR}/events.ndjson'`);
    expect(script).toContain('tail -c +1 -F "$f"');
  });

  it('starts at offset+1 and detects a truncated file before it tails', () => {
    const script = bridgeTailScript(`${RUN_DIR}/events.ndjson`, 41);
    expect(script).toContain(`f='${RUN_DIR}/events.ndjson'`);
    expect(script).toContain('tail -c +42 -F "$f"');
    expect(script).toContain('wc -c');
    expect(script).toContain('KARST_TAIL_OFFSET=0');
  });
});

describe('startSshBridgeForwarder', () => {
  it('appends complete lines only and lets a partial last line wait', async () => {
    const ssh = new FakeSsh((stream, index) => {
      if (index === 1) {
        stream.push('KARST_TAIL_OFFSET=0\n{"a":1}\n{"b":2');
      }
    });
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    const result = await start(ssh);
    expect(result.ok).toBe(true);
    await waitFor(async () => (await hostLines()).length === 1, 'the first line');
    expect(await hostLines()).toEqual(['{"a":1}']);
    ssh.streams[0]!.push('}\n');
    await waitFor(async () => (await hostLines()).length === 2, 'the second line');
    expect(await hostLines()).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops a line over 64 KiB and logs it, appending the next one', async () => {
    const ssh = new FakeSsh((stream, index) => {
      if (index === 1) stream.push(`KARST_TAIL_OFFSET=0\n${'x'.repeat(MAX_BRIDGE_LINE_BYTES + 1)}\n{"ok":true}\n`);
    });
    const logged: string[] = [];
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { debug: (m: string) => logged.push(m) });
    await waitFor(async () => (await hostLines()).length === 1, 'the line after the drop');
    expect(await hostLines()).toEqual(['{"ok":true}']);
    expect(logged.join('\n')).toMatch(/oversized/);
  });

  it('reconnects from the stored offset after the stream closes', async () => {
    const gate = deferred();
    let sleepCalls = 0;
    const ssh = new FakeSsh((stream, index) => {
      if (index === 1) {
        stream.push('KARST_TAIL_OFFSET=0\n{"a":1}\n');
        setImmediate(() => stream.close());
      }
    });
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, {
      sleep: () => { sleepCalls += 1; gate.resolve(); return gate.promise; },
    });
    await waitFor(() => sleepCalls === 1, 'the first backoff');
    await waitFor(() => ssh.spawns.length === 2, 'the reconnect');
    const script = ssh.spawns[1]!.at(-1)!;
    expect(script).toContain('tail -c +9 -F');
  });

  it('a remote truncation restarts from 0', async () => {
    const gate = deferred();
    const ssh = new FakeSsh((stream, index) => {
      if (index === 1) {
        stream.push('KARST_TAIL_OFFSET=0\n{"a":1}\n');
        setImmediate(() => stream.close());
      } else if (index === 2) {
        // The remote itself says the file is shorter than the stored offset.
        stream.push('KARST_TAIL_OFFSET=0\n{"b":2}\n');
      }
    });
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { sleep: () => { gate.resolve(); return gate.promise; } });
    await waitFor(() => ssh.spawns.length === 2, 'the reconnect');
    await waitFor(async () => (await hostLines()).length === 2, 'the line after the truncation');
    expect(await hostLines()).toEqual(['{"a":1}', '{"b":2}']);
    await stopSshBridgeForwarder(TICKET);
    const state = JSON.parse(await readFile(join(stateDir, `${String(TICKET)}.ssh-forward.json`), 'utf8')) as { offsets: Record<string, number> };
    expect(state.offsets['events.ndjson']).toBe(8);
  });

  it('abort stops the stream and never reconnects', async () => {
    const controller = new AbortController();
    let sleepCalls = 0;
    const ssh = new FakeSsh((_stream, index) => {
      if (index === 1) setImmediate(() => controller.abort());
    });
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { signal: controller.signal, sleep: () => { sleepCalls += 1; return Promise.resolve(); } });
    await waitFor(() => ssh.streams.length === 1, 'the stream');
    await waitFor(() => ssh.streams[0]!.killed === 1, 'the kill');
    expect(sleepCalls).toBe(0);
    expect(ssh.spawns).toHaveLength(1);
  });

  it('two starts for one ticket give one forwarder', async () => {
    const ssh = new FakeSsh();
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    const first = await start(ssh);
    const second = await start(ssh);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.handle).toBe(first.handle);
    await waitFor(() => ssh.spawns.length === 1, 'the one stream');
    expect(ssh.spawns).toHaveLength(1);
  });

  it('refuses an unconfirmed remote at start with zero ssh calls', async () => {
    const ssh = new FakeSsh();
    const result = await start(ssh);
    expect(result).toEqual({ ok: false, reason: `ssh remote ${NAME} not confirmed` });
    expect(ssh.sshCalls).toBe(0);
  });

  it('re-checks trust at each reconnect and runs no ssh once it is revoked', async () => {
    const gate = deferred();
    let sleepCalls = 0;
    const ssh = new FakeSsh((stream, index) => {
      if (index === 1) {
        stream.push('KARST_TAIL_OFFSET=0\n{"a":1}\n');
        setImmediate(() => stream.close());
      }
    });
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { sleep: () => { sleepCalls += 1; return gate.promise; } });
    await waitFor(() => sleepCalls === 1, 'the first backoff');
    await writeFile(join(trustDir, 'ssh-trust.json'), '{}\n');
    gate.resolve();
    await tick();
    await tick();
    expect(ssh.spawns).toHaveLength(1);
  });
});

describe('script and plugin upload (edit 3)', () => {
  it('derives the remote script paths of all four cores inside the run dir', () => {
    for (const core of ['claude', 'codex', 'opencode', 'opencode2'] as const) {
      const files = bridgeUploadFiles(RUN_DIR, core);
      const marker = files.find((f) => f.target.endsWith('/emit-marker.cjs'));
      expect(marker?.target).toBe(`${RUN_DIR}/${core}/emit-marker.cjs`);
      const command = sandboxMarkerCommand({ runDir: RUN_DIR, core, stage: 'impl' });
      expect(command).toContain(marker!.target);
      expect(files.map((f) => f.target)).toEqual(expect.arrayContaining([
        `${RUN_DIR}/${core}/bridge.cjs`,
        `${RUN_DIR}/${core}/emit-ack.cjs`,
      ]));
    }
  });

  it('uploads the opencode plugin under the run dir the OPENCODE_CONFIG_DIR points at', () => {
    for (const core of ['opencode', 'opencode2'] as const) {
      const plugin = bridgeUploadFiles(RUN_DIR, core).find((f) => f.target.endsWith('/plugins/karst-bridge.js'));
      expect(plugin?.target).toBe(`${RUN_DIR}/${core}/opencode-config/plugins/karst-bridge.js`);
    }
  });

  it('sends each host script to its remote path over stdin, atomic temp + mv, and skips a missing optional file', async () => {
    const { mkdir } = await import('node:fs/promises');
    const hostCore = join(hostBridgeDir, 'opencode2');
    await mkdir(join(hostCore, 'opencode-config', 'plugins'), { recursive: true });
    await writeFile(join(hostCore, 'bridge.cjs'), 'bridge-body');
    await writeFile(join(hostCore, 'emit-marker.cjs'), 'marker-body');
    await writeFile(join(hostCore, 'emit-ack.cjs'), 'ack-body');
    await writeFile(join(hostCore, 'opencode-config', 'plugins', 'karst-bridge.js'), 'plugin-body');
    const ssh = new FakeSsh();
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    const out = await uploadBridgeScripts({
      ssh, remote: REMOTE, remoteName: NAME, core: 'opencode2', hostBridgeDir, runDir: RUN_DIR,
      trustDir, ensureControlDir: () => Promise.resolve({ ok: true }),
    });
    expect(out.ok).toBe(true);
    expect(out.ok && out.uploaded).toEqual([
      `${RUN_DIR}/opencode2/bridge.cjs`,
      `${RUN_DIR}/opencode2/emit-marker.cjs`,
      `${RUN_DIR}/opencode2/emit-ack.cjs`,
      `${RUN_DIR}/opencode2/opencode-config/plugins/karst-bridge.js`,
    ]);
    expect(ssh.runs.map((r) => r.stdin)).toEqual(['bridge-body', 'marker-body', 'ack-body', 'plugin-body']);
    for (const r of ssh.runs) {
      expect(r.args.at(-1)).toContain(`mv -f`);
      expect(r.args.at(-1)).toContain(`${RUN_DIR}/opencode2/`);
    }
  });

  it('refuses to upload for an unconfirmed remote, with zero ssh calls', async () => {
    const ssh = new FakeSsh();
    const out = await uploadBridgeScripts({
      ssh, remote: REMOTE, remoteName: NAME, core: 'claude', hostBridgeDir, runDir: RUN_DIR,
      trustDir, ensureControlDir: () => Promise.resolve({ ok: true }),
    });
    expect(out).toEqual({ ok: false, reason: `ssh remote ${NAME} not confirmed` });
    expect(ssh.sshCalls).toBe(0);
  });

  it('the claude file-channel settings name the remote script paths, never a host path', () => {
    const settings = buildFileHookSettings({ endpointUrl: `file://${RUN_DIR}/events.ndjson`, configDir: hostBridgeDir, runDir: RUN_DIR }, 'claude');
    expect(settings).toContain(`${RUN_DIR}/claude/bridge.cjs`);
    expect(settings).not.toContain(hostBridgeDir);
  });
});
