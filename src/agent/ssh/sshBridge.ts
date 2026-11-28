import { constants as fsConstants } from 'node:fs';
import { open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { RemoteDef } from '../../manifest/types.js';
import { MAX_BRIDGE_LINE_BYTES } from '../bridge/bridgeVerifier.js';
import { isRemoteTrusted, readRemoteTrust } from './remoteTrust.js';
import { ensureSshControlDir, sshControlDir, type SshControlResult } from './sshControlDir.js';
import { sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote half of the evidence bridge (D556, edit 1): one `tail -F` over ssh
 * copies the remote `<ws>/bridge/<ticketId>/events.ndjson` into the host's ONE
 * verified append-only file. The verifier, the poller and the sink do not
 * change, so a forwarded marker is handled exactly like a local one.
 *
 * There is no host listener and no `ssh -R`: the remote never connects to the
 * host. The remote byte offset lives in `<stateDir>/<ticketId>.ssh-forward.json`
 * (temp + rename), outside the agent-writable bridge dir, and a reconnect
 * continues from it. A remote file shorter than the offset restarts from 0 (the
 * remote script reports the effective offset, and the host obeys it).
 *
 * Trust is first, at start and at every reconnect (D553): an unconfirmed remote
 * makes ZERO ssh calls. One forwarder per ticket per window; only the window
 * that controls the ticket starts it (@arch:AC-37, @arch:GLOBAL).
 *
 * The module keeps its forward specs in a list so a later step can add more
 * paths (`claude-projects/**`, D556 edit 5) without changing the lifecycle.
 */

export interface ForwardSpec {
  /** Path below the remote run dir. */
  readonly rel: string;
  /** Path below the host bridge dir; defaults to `rel`. */
  readonly hostRel: string;
}

/** The paths this step forwards. Edit 5 adds the transcript tree here. */
export function forwardSpecs(): readonly ForwardSpec[] {
  return [{ rel: 'events.ndjson', hostRel: 'events.ndjson' }];
}

const NEWLINE = 0x0a;
/** The same cap the poller and the verifier apply (64 KiB). */
const MAX_LINE = MAX_BRIDGE_LINE_BYTES;
/** A `ControlPath` retry never needs to wait longer than this, and a dead remote gets one attempt a minute. */
export const SSH_BRIDGE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const TAIL_MARKER = /^KARST_TAIL_OFFSET=(\d+)$/;

const HOST_EVENTS_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const READ_NOFOLLOW = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const HOST_SCRIPT_MODE = 0o666;

/** Last non-empty stderr line, capped like the other ssh reasons. */
function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 200);
}

/**
 * The remote `tail -F` script. The stored offset is a literal, so a reconnect's
 * argv says exactly where it resumes (`tail -c +<offset+1>`). The size probe
 * only runs for a non-zero offset and restarts from 0 when the file is shorter
 * (truncated or recreated); the effective offset is printed on the first line so
 * the host counts from the same byte.
 */
export function bridgeTailScript(remoteFile: string, offset: number): string {
  const file = sshQuote(remoteFile);
  const n = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
  const lines = ['# karst-ssh-bridge-tail', `f=${file}`];
  if (n === 0) {
    lines.push('printf "KARST_TAIL_OFFSET=0\\n"', 'exec tail -c +1 -F "$f"');
    return lines.join('\n');
  }
  lines.push(
    's=$(wc -c < "$f" 2>/dev/null || echo 0)',
    `if [ "$s" -lt ${String(n)} ]; then printf "KARST_TAIL_OFFSET=0\\n"; exec tail -c +1 -F "$f"; fi`,
    `printf "KARST_TAIL_OFFSET=${String(n)}\\n"`,
    `exec tail -c +${String(n + 1)} -F "$f"`,
  );
  return lines.join('\n');
}

export interface SshBridgeForwarderOptions {
  readonly ssh: SshProcess;
  readonly remote: RemoteDef;
  /** The manifest name of the remote; every reason names it (`ssh remote <name> …`). */
  readonly remoteName: string;
  /** The remote per-ticket workspace (`<remoteDir>/<sandboxName>`). */
  readonly ws: string;
  readonly ticketId: number;
  /** The HOST per-ticket bridge dir (`<root>/events/<ticketId>`). */
  readonly hostBridgeDir: string;
  /** The HOST state dir (`<root>/state`), outside the agent-writable bridge dir. */
  readonly stateDir: string;
  /** `<globalStorage>`: the dir of `ssh-trust.json` (D553). */
  readonly trustDir: string;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  readonly signal?: AbortSignal;
  /** Injected so a test's reconnect is instant and deterministic. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly debug?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface SshBridgeForwarderHandle {
  readonly ticketId: number;
  /** True once the forwarder is stopped (window close, stop, archive, trust revoked). */
  readonly stopped: boolean;
  stop(): Promise<void>;
}

export type SshBridgeStartResult =
  | { readonly ok: true; readonly handle: SshBridgeForwarderHandle }
  | { readonly ok: false; readonly reason: string };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/** The remote bridge run dir of the forwarder: `<ws>/bridge/<ticketId>`. */
export function forwardRunDir(ws: string, ticketId: number): string {
  return `${ws.replace(/\/+$/, '')}/bridge/${String(ticketId)}`;
}

interface ForwarderState {
  offsets: Record<string, number>;
}

function stateFileFor(stateDir: string, ticketId: number): string {
  return `${stateDir.replace(/\/+$/, '')}/${String(ticketId)}.ssh-forward.json`;
}

async function loadOffsets(file: string): Promise<ForwarderState> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { offsets?: unknown };
    const offsets: Record<string, number> = {};
    if (parsed.offsets !== null && typeof parsed.offsets === 'object') {
      for (const [rel, value] of Object.entries(parsed.offsets)) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) offsets[rel] = value;
      }
    }
    return { offsets };
  } catch {
    return { offsets: {} };
  }
}

async function saveOffsets(file: string, state: ForwarderState): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify({ v: 1, offsets: state.offsets }));
  await rename(tmp, file);
}

const FORWARDERS = new Map<number, ActiveForwarder>();

/**
 * Start the forwarder of one ticket. Idempotent for a live ticket: a second
 * start returns the SAME handle and spawns nothing. An unconfirmed remote is
 * refused before any ssh call.
 */
export async function startSshBridgeForwarder(opts: SshBridgeForwarderOptions): Promise<SshBridgeStartResult> {
  const existing = FORWARDERS.get(opts.ticketId);
  if (existing !== undefined && !existing.stopped) return { ok: true, handle: existing.handle };
  const trust = readRemoteTrust(opts.trustDir, opts.warn);
  if (!isRemoteTrusted(trust, opts.remoteName, opts.remote)) {
    return { ok: false, reason: `ssh remote ${opts.remoteName} not confirmed` };
  }
  const forwarder = new ActiveForwarder(opts);
  FORWARDERS.set(opts.ticketId, forwarder);
  void forwarder.run().catch((err: unknown) => {
    opts.warn?.(`ssh remote ${opts.remoteName}: bridge forwarder stopped: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { ok: true, handle: forwarder.handle };
}

/** Stop the ticket's forwarder (stop, dispose, archive, Forget, window close). */
export async function stopSshBridgeForwarder(ticketId: number): Promise<void> {
  const forwarder = FORWARDERS.get(ticketId);
  if (forwarder === undefined) return;
  FORWARDERS.delete(ticketId);
  await forwarder.handle.stop();
}

/** Window close/deactivate: stop every stream this window started. */
export async function stopAllSshBridgeForwarders(): Promise<void> {
  const all = [...FORWARDERS.values()];
  FORWARDERS.clear();
  await Promise.all(all.map((f) => f.handle.stop()));
}

class ActiveForwarder {
  readonly handle: SshBridgeForwarderHandle;
  stopped = false;
  private readonly opts: SshBridgeForwarderOptions;
  private readonly offsets: ForwarderState = { offsets: {} };
  private readonly stateFile: string;
  private readonly dbg: (message: string) => void;
  private currentChild: ChildProcess | undefined;
  private finishStream: (() => void) | undefined;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: SshBridgeForwarderOptions) {
    this.opts = opts;
    this.stateFile = stateFileFor(opts.stateDir, opts.ticketId);
    this.dbg = (message) => opts.debug?.(`[ssh ${opts.remoteName}] ${message}`);
    const forwarder = this;
    this.handle = {
      ticketId: opts.ticketId,
      get stopped() { return forwarder.stopped; },
      stop: () => forwarder.stop(),
    };
  }

  private aborted(): boolean {
    return this.opts.signal?.aborted === true;
  }

  private trusted(): boolean {
    return isRemoteTrusted(readRemoteTrust(this.opts.trustDir, this.opts.warn), this.opts.remoteName, this.opts.remote);
  }

  async run(): Promise<void> {
    try {
      this.offsets.offsets = (await loadOffsets(this.stateFile)).offsets;
      const specs = forwardSpecs();
      await Promise.all(specs.map((spec) => this.runSpec(spec)));
    } finally {
      this.stopped = true;
      if (FORWARDERS.get(this.opts.ticketId) === this) FORWARDERS.delete(this.opts.ticketId);
      await this.persistChain;
    }
  }

  private async runSpec(spec: ForwardSpec): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      if (this.aborted()) return;
      // D553: trust is re-read at every reconnect, and a revoked remote runs no ssh.
      if (!this.trusted()) {
        this.opts.warn?.(`ssh remote ${this.opts.remoteName} not confirmed`);
        return;
      }
      const controlDir = this.opts.controlDir ?? sshControlDir();
      const control = await (this.opts.ensureControlDir ?? ensureSshControlDir)(controlDir).catch(
        (err: unknown): SshControlResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
      );
      if (!control.ok) {
        this.dbg(`forwarder ${spec.rel}: ${control.reason}`);
        attempt += 1;
        if (!(await this.wait(attempt))) return;
        continue;
      }
      const offset = this.offsets.offsets[spec.rel] ?? 0;
      const remoteFile = `${forwardRunDir(this.opts.ws, this.opts.ticketId)}/${spec.rel}`;
      const argv = sshArgv(this.opts.remote, controlDir, bridgeTailScript(remoteFile, offset));
      attempt = 0;
      await this.streamOnce(spec, argv, offset);
      if (this.stopped || this.aborted()) return;
      attempt += 1;
      this.dbg(`forwarder ${spec.rel} closed; reconnect in ${String(backoff(attempt))} ms`);
      if (!(await this.wait(attempt))) return;
    }
  }

  /** Resolves true when the loop may continue, false when it must stop. */
  private async wait(attempt: number): Promise<boolean> {
    if (this.stopped) return false;
    await (this.opts.sleep ?? realSleep)(backoff(attempt));
    return !this.stopped && !this.aborted();
  }

  /**
   * One connection: read the remote stream, append complete host lines, and
   * persist the first unconsumed byte after each append. Partial lines wait in
   * memory; if the connection drops they are re-read from the stored offset.
   */
  private streamOnce(spec: ForwardSpec, argv: readonly string[], storedOffset: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let child: ChildProcess | undefined;
      let received = 0;
      let carry: Buffer = Buffer.alloc(0);
      let discarding = false;
      let markerSeen = false;
      let base = storedOffset;
      let hostHandle: FileHandle | undefined;

      const done = (): void => {
        if (settled) return;
        settled = true;
        this.opts.signal?.removeEventListener('abort', onAbort);
        this.currentChild = undefined;
        this.finishStream = undefined;
        // The carry is not persisted: the next connection re-reads it.
        void persist(base + received - carry.length).then(() => {
          const handle = hostHandle;
          hostHandle = undefined;
          void handle?.close().catch(() => undefined);
          resolve();
        });
      };
      const onAbort = (): void => {
        try { child?.kill(); } catch { /* already gone */ }
        done();
      };

      try {
        child = this.opts.ssh.spawnStream(argv, this.opts.signal ? { signal: this.opts.signal } : {});
      } catch (err) {
        this.dbg(`forwarder ${spec.rel}: cannot spawn: ${err instanceof Error ? err.message : String(err)}`);
        resolve();
        return;
      }
      this.currentChild = child;
      this.finishStream = done;
      this.opts.signal?.addEventListener('abort', onAbort, { once: true });

      let work: Promise<void> = Promise.resolve();

      const append = async (line: Buffer): Promise<void> => {
        if (line.length > MAX_LINE) {
          this.dbg(`forwarder ${spec.rel}: dropped an oversized line (${String(line.length)} bytes)`);
          return;
        }
        try {
          hostHandle ??= await open(`${this.opts.hostBridgeDir}/${spec.hostRel}`, HOST_EVENTS_FLAGS, HOST_SCRIPT_MODE);
          await hostHandle.write(`${line.toString('utf8')}\n`);
        } catch (err) {
          this.dbg(`forwarder ${spec.rel}: append failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const persist = (position: number): Promise<void> => {
        this.offsets.offsets[spec.rel] = Math.max(0, Math.trunc(position));
        this.persistChain = this.persistChain
          .then(() => saveOffsets(this.stateFile, this.offsets))
          .catch((err: unknown) => this.dbg(`forwarder ${spec.rel}: offset persist failed: ${err instanceof Error ? err.message : String(err)}`));
        return this.persistChain;
      };

      const consume = async (chunk: Buffer): Promise<void> => {
        received += chunk.length;
        carry = Buffer.concat([carry, chunk]);
        if (!markerSeen) {
          const nl = carry.indexOf(NEWLINE);
          if (nl === -1) {
            // A marker line is short: an unterminated first chunk is still the marker waiting for its newline.
            return;
          }
          const first = carry.subarray(0, nl).toString('utf8');
          carry = carry.subarray(nl + 1);
          markerSeen = true;
          const marked = TAIL_MARKER.exec(first);
          if (marked !== null) {
            const effective = Number(marked[1]);
            if (effective !== base) this.dbg(`forwarder ${spec.rel}: remote offset ${String(effective)} (stored ${String(base)})`);
            // The remote decides the start (a truncation restarts from 0). The
            // marker line is protocol, not file content, so it never counts.
            base = effective;
            received -= first.length + 1;
          } else if (first !== '') {
            await append(Buffer.from(first, 'utf8'));
          }
        }
        if (discarding) {
          const nl = carry.indexOf(NEWLINE);
          if (nl === -1) {
            carry = Buffer.alloc(0);
            await persist(base + received);
            return;
          }
          carry = carry.subarray(nl + 1);
          discarding = false;
        }
        for (let nl = carry.indexOf(NEWLINE); nl !== -1; nl = carry.indexOf(NEWLINE)) {
          const line = carry.subarray(0, nl);
          carry = carry.subarray(nl + 1);
          if (line.length > 0) await append(line);
        }
        if (carry.length > MAX_LINE) {
          this.dbg(`forwarder ${spec.rel}: dropped an oversized unterminated line (${String(carry.length)} bytes)`);
          discarding = true;
          carry = Buffer.alloc(0);
          await persist(base + received);
          return;
        }
        // The partial tail stays unpersisted, so a reconnect re-reads it.
        await persist(base + received - carry.length);
      };

      child.stdout?.on('data', (buf: Buffer) => {
        work = work.then(() => consume(buf)).catch((err: unknown) => {
          this.dbg(`forwarder ${spec.rel}: read failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      child.stderr?.on('data', (buf: Buffer) => {
        const text = buf.toString('utf8');
        const line = tail(text);
        if (line !== '') this.dbg(`forwarder ${spec.rel}: remote: ${line}`);
      });
      child.on('error', (err: Error) => {
        this.dbg(`forwarder ${spec.rel}: stream error: ${err.message}`);
        void work.then(done);
      });
      child.on('close', () => { void work.then(done); });
    });
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    const child = this.currentChild;
    if (child !== undefined) {
      try { child.kill(); } catch { /* already gone */ }
    }
    // A fake (or a child that ignores the signal) must not leave the wait pending.
    this.finishStream?.();
    await this.persistChain;
  }
}

function backoff(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1) - 1, SSH_BRIDGE_BACKOFF_MS.length - 1);
  return SSH_BRIDGE_BACKOFF_MS[index]!;
}

/**
 * The script and plugin upload of D556 edit 3, at every launch (`@arch:AC-18`).
 *
 * The adapters write their generated files into the HOST bridge dir
 * (`<hostBridgeDir>/<core>/…`) and name the REMOTE run dir in the hook config
 * (`<ws>/bridge/<ticketId>/<core>/…`). This copies the exact bytes over stdin,
 * atomically (temp + `mv`), so the marker command the instruction rendered
 * (`sandboxMarkerCommand`) names a file that exists on the remote.
 *
 * `mode: docker` sees the same remote dir through the D822 mount at
 * `/karst-bridge/<ticketId>`; only the container path differs, the remote
 * directory is identical.
 */
export interface BridgeUpload {
  /** The host file, relative to the host bridge dir. */
  readonly hostRel: string;
  /** The remote file, absolute, below the run dir. */
  readonly target: string;
}

const BRIDGE_SCRIPTS = ['bridge.cjs', 'emit-marker.cjs', 'emit-ack.cjs'] as const;

/** Every file a launch uploads for one core, with its exact remote path. */
export function bridgeUploadFiles(runDir: string, core: string): readonly BridgeUpload[] {
  const dir = `${runDir.replace(/\/+$/, '')}/${core}`;
  const files: BridgeUpload[] = BRIDGE_SCRIPTS.map((name) => ({ hostRel: `${core}/${name}`, target: `${dir}/${name}` }));
  if (core === 'claude') files.push({ hostRel: `${core}/statusline.cjs`, target: `${dir}/statusline.cjs` });
  if (core === 'opencode' || core === 'opencode2') {
    files.push({ hostRel: `${core}/opencode-config/plugins/karst-bridge.js`, target: `${dir}/opencode-config/plugins/karst-bridge.js` });
  }
  return files;
}

/** One remote file, written atomically: stdin into a private temp, then `mv`. */
export function bridgeUploadScript(target: string): string {
  const dir = target.slice(0, target.lastIndexOf('/'));
  return [
    '# karst-ssh-bridge-upload',
    'umask 077',
    `d=${sshQuote(dir)}`,
    'mkdir -p -m 700 "$d" || exit 1',
    `t=${sshQuote(target)}.tmp.$$`,
    `trap 'rm -f "$t"' EXIT`,
    'cat > "$t" || exit 1',
    'chmod 600 "$t" || exit 1',
    `mv -f "$t" ${sshQuote(target)}`,
  ].join('\n');
}

export interface SshBridgeUploadOptions {
  readonly ssh: SshProcess;
  readonly remote: RemoteDef;
  readonly remoteName: string;
  readonly core: string;
  /** The HOST per-ticket bridge dir the adapters wrote to. */
  readonly hostBridgeDir: string;
  /** The REMOTE bridge run dir (`<ws>/bridge/<ticketId>`). */
  readonly runDir: string;
  /**
   * `<globalStorage>`. Optional because the ssh runner that calls this at launch
   * was itself created only after `isRemoteTrusted` (D553): the launch path has
   * already made the decision by the time the terminal is prepared.
   */
  readonly trustDir?: string;
  readonly controlDir?: string;
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  readonly debug?: (message: string) => void;
}

export type SshBridgeUploadResult =
  | { readonly ok: true; readonly uploaded: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Read a host file without following a planted symlink (the bridge dir is agent-writable). */
async function readHostFileNoFollow(file: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, READ_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Upload the generated bridge files of one core at launch. Trust first: an
 * unconfirmed remote makes no ssh call. A missing optional file (claude's
 * statusline wrapper) is skipped; a missing required script is an error, so a
 * launch never proceeds with a marker command it cannot run.
 */
export async function uploadBridgeScripts(opts: SshBridgeUploadOptions): Promise<SshBridgeUploadResult> {
  const trust = opts.trustDir === undefined ? undefined : readRemoteTrust(opts.trustDir);
  if (trust !== undefined && !isRemoteTrusted(trust, opts.remoteName, opts.remote)) {
    return { ok: false, reason: `ssh remote ${opts.remoteName} not confirmed` };
  }
  if (opts.runDir === '' || opts.runDir.includes('\0') || opts.runDir.includes('\n')) {
    return { ok: false, reason: 'ssh bridge: invalid remote bridge dir' };
  }
  const controlDir = opts.controlDir ?? sshControlDir();
  const control = await (opts.ensureControlDir ?? ensureSshControlDir)(controlDir).catch(
    (err: unknown): SshControlResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
  );
  if (!control.ok) return { ok: false, reason: control.reason };
  const uploaded: string[] = [];
  const files = bridgeUploadFiles(opts.runDir, opts.core);
  let missing = false;
  let present = false;
  for (const file of files) {
    let body: Buffer | undefined;
    try {
      body = await readHostFileNoFollow(`${opts.hostBridgeDir.replace(/\/+$/, '')}/${file.hostRel}`);
    } catch (err) {
      return { ok: false, reason: `ssh ${opts.remoteName}: cannot read ${file.hostRel}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (body === undefined) {
      if ((BRIDGE_SCRIPTS as readonly string[]).includes(file.hostRel.slice(file.hostRel.lastIndexOf('/') + 1))) {
        missing = true;
        opts.debug?.(`[ssh ${opts.remoteName}] bridge upload: ${file.hostRel} is missing`);
      }
      continue;
    }
    present = true;
    const out = await opts.ssh.runWithStdin(
      sshArgv(opts.remote, controlDir, bridgeUploadScript(file.target)),
      body,
      { maxStdoutBytes: 4 * 1024 },
    );
    if (out.transport === true || out.code !== 0) {
      const why = out.transport === true ? 'transport failed' : `exit ${String(out.code)}`;
      return { ok: false, reason: `ssh ${opts.remoteName}: bridge upload of ${file.hostRel} failed (${why})${tail(out.stderr) === '' ? '' : `: ${tail(out.stderr)}`}` };
    }
    uploaded.push(file.target);
  }
  // No core dir at all (a test launch with a bridge dir, or an adapter that wrote
  // nothing): nothing to copy, and no reason to fail the launch on it.
  if (!present) return { ok: true, uploaded: [] };
  if (missing) return { ok: false, reason: `ssh ${opts.remoteName}: the bridge scripts are missing on the host` };
  opts.debug?.(`[ssh ${opts.remoteName}] uploaded ${String(uploaded.length)} bridge file(s) for ${opts.core}`);
  return { ok: true, uploaded };
}

