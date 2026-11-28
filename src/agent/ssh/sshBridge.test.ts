import { EventEmitter } from 'node:events';
import { mkdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { buildFileHookSettings } from '../fileHookSettings.js';
import { encodeClaudeProjectDir } from '../claudeTranscriptWatch.js';
import { sweepClaudeTranscript } from '../claudeTranscriptSweep.js';
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
  constructor(
    private readonly onSpawn?: (stream: FakeStream, index: number) => void,
    private readonly onRun?: (args: readonly string[]) => { code?: number; stdout?: string; stderr?: string } | undefined,
  ) {}
  run(args: readonly string[]): Promise<SshResult> {
    this.runs.push({ args: [...args] });
    const custom = this.onRun?.(args);
    return Promise.resolve({
      code: custom?.code ?? 0,
      stdout: custom?.stdout ?? '',
      stdoutBuffer: Buffer.from(custom?.stdout ?? ''),
      stderr: custom?.stderr ?? '',
    });
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

describe('transcript forwarding (edit 5)', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';
  const REMOTE_REPO = `${WS}/repo`;
  const ENC = encodeClaudeProjectDir(REMOTE_REPO);
  const CLAUDE_REL = `${ENC}/${SESSION}.jsonl`;
  const claudeHostFile = (): string => join(hostBridgeDir, 'claude-projects', ENC, `${SESSION}.jsonl`);
  const textOf = async (file: string): Promise<string | undefined> => {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const assistantLine = (uuid: string, input: number, output: number): string =>
    JSON.stringify({ type: 'assistant', uuid, message: { usage: { input_tokens: input, output_tokens: output } } });
  /** Answer the claude tree listing with `names`; every other script keeps the default. */
  const listing = (names: readonly string[]) => (args: readonly string[]): { stdout: string } | undefined => {
    const script = args.at(-1) ?? '';
    return script.includes('# karst-ssh-transcripts') ? { stdout: `${names.join('\n')}\n` } : undefined;
  };

  it('forwards a remote .jsonl and the host sweep meters it exactly once', async () => {
    const line = assistantLine('u1', 10, 5);
    const ssh = new FakeSsh(
      (stream, index) => {
        if ((ssh.spawns[index - 1]!.at(-1) ?? '').includes('claude-projects')) {
          stream.push(`KARST_TAIL_OFFSET=0\n${line}\n`);
        }
      },
      listing([CLAUDE_REL]),
    );
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh);
    await waitFor(async () => (await textOf(claudeHostFile())) === `${line}\n`, 'the forwarded transcript');

    const state = { transcriptPath: null as string | null, eventId: null as string | null, fingerprint: null as { mtimeMs: number; size: number } | null };
    const dispatched: Array<{ hook_event_name: string; usage: Record<string, unknown> }> = [];
    const sweep = () => sweepClaudeTranscript(
      {
        stat: async (p) => { const st = await stat(p); return { mtimeMs: st.mtimeMs, size: st.size }; },
        readFile: (p) => readFile(p, 'utf8'),
        debug: () => undefined,
        onError: () => undefined,
        onTranscript: () => undefined,
        dispatch: (payload) => { dispatched.push(payload as unknown as { hook_event_name: string; usage: Record<string, unknown> }); },
      },
      { ticketId: TICKET, sessionId: SESSION, transcriptPath: claudeHostFile(), cwd: '/host/wt', state },
    );
    expect(await sweep()).toBe('swept');
    expect(await sweep()).toBe('unchanged');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ hook_event_name: 'UsageUpdate', usage: { event_id: 'u1', input: 10, output: 5 } });
  });

  it('skips dot-dot, a third part and a space, and logs every refused name', async () => {
    const line = assistantLine('u2', 1, 1);
    const logged: string[] = [];
    const ssh = new FakeSsh(
      (stream, index) => {
        if ((ssh.spawns[index - 1]!.at(-1) ?? '').includes('claude-projects')) {
          stream.push(`KARST_TAIL_OFFSET=0\n${line}\n`);
        }
      },
      listing(['../escape.jsonl', 'a/b/c.jsonl', 'bad name/x.jsonl', CLAUDE_REL]),
    );
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { debug: (m: string) => logged.push(m) });
    await waitFor(async () => (await textOf(claudeHostFile())) === `${line}\n`, 'the one accepted transcript');
    expect(logged.join('\n')).toMatch(/skipped a refused name "\.\.\/escape\.jsonl"/);
    expect(logged.join('\n')).toMatch(/skipped a refused name "a\/b\/c\.jsonl"/);
    expect(logged.join('\n')).toMatch(/skipped a refused name "bad name\/x\.jsonl"/);
    const transcriptStreams = ssh.spawns.filter((args) => (args.at(-1) ?? '').includes('claude-projects'));
    expect(transcriptStreams).toHaveLength(1);
  });

  it('refuses a host-side symlink at the forwarded name and logs it', async () => {
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, 'ORIGINAL\n');
    mkdirSync(join(hostBridgeDir, 'claude-projects', ENC), { recursive: true });
    symlinkSync(outside, claudeHostFile());
    const logged: string[] = [];
    const ssh = new FakeSsh(
      (stream, index) => {
        if ((ssh.spawns[index - 1]!.at(-1) ?? '').includes('claude-projects')) {
          stream.push(`KARST_TAIL_OFFSET=0\n${assistantLine('u3', 2, 2)}\n`);
        }
      },
      listing([CLAUDE_REL]),
    );
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh, { debug: (m: string) => logged.push(m) });
    await waitFor(() => logged.some((m) => /refused the host copy/.test(m)), 'the refusal log');
    expect(await readFile(outside, 'utf8')).toBe('ORIGINAL\n');
  });

  it('forwards a codex rollout into <hostBridge>/codex-sessions/', async () => {
    const codexRel = `2026/11/28/rollout-2026-11-28T09-00-00-${SESSION}.jsonl`;
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } });
    const onRun = (args: readonly string[]): { stdout: string } | undefined =>
      (args.at(-1) ?? '').includes('# karst-ssh-codex-list') ? { stdout: `${codexRel}\n` } : undefined;
    const ssh = new FakeSsh(
      (stream, index) => {
        if ((ssh.spawns[index - 1]!.at(-1) ?? '').includes('.codex/sessions')) {
          stream.push(`KARST_TAIL_OFFSET=0\n${line}\n`);
        }
      },
      onRun,
    );
    await recordRemoteTrust(trustDir, NAME, REMOTE);
    await start(ssh);
    const host = join(hostBridgeDir, 'codex-sessions', codexRel.split('/').at(-1)!);
    await waitFor(async () => (await textOf(host)) === `${line}\n`, 'the forwarded rollout');
    expect(await textOf(host)).toBe(`${line}\n`);
  });
});
