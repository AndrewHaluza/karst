import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GateProcessRunner } from '../workflow/gates/run.js';
import { blockedHostsFromOutput, blockedSuffix, failedTail, npmDebugLogPath, quoteLine } from './sandboxSetupDiagnose.js';
import type { SetupWindow } from './sessionRunner.js';

/** How long a setup (or a wait on one) may take before the gate list is refused. */
export const SETUP_BOUND_MS = 15 * 60_000;
/** Wait before the single automatic retry of a killed (exit 137) setup. */
export const KILL_RETRY_DELAY_MS = 60_000;
const POLL_MS = 5_000;
/** Written by the setup script INSIDE the sandbox so a stale run can be killed. */
const PID_FILE = '/tmp/karst-setup.pid';

export interface SetupState {
  readonly fingerprint: string;
  readonly status: 'running' | 'ok' | 'failed' | 'deferred';
  readonly exitCode: number | null;
  readonly at: number;
}

export type SetupResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The network window around the setup step (arch:AC-36): open for the declared hosts, close when it ends. */
export interface SetupWindowPort {
  readonly open: (hosts: readonly string[]) => Promise<SetupWindow>;
  /** docker: the window recreates the proxy, so it only opens while no agent turn is active. */
  readonly needsIdle: boolean;
  readonly turnActive: () => boolean;
}

export interface SetupDeps {
  readonly window?: SetupWindowPort;
  /** The sandbox's gate runner: every command here runs INSIDE the sandbox, never on the host. */
  readonly runGate: GateProcessRunner;
  /** `<root>/state/<id>.setup.json`: outside the sandbox mount (arch:AC-34). */
  readonly stateFile: string;
  /** `<bridge dir>/<id>/logs/setup.log`: advisory, agent-readable, never read back. */
  readonly logFile?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly boundMs?: number;
  readonly killRetryDelayMs?: number;
  /** docker only, best-effort: "Docker VM 4.8 GB, 2 other containers running" for a kill's reason; never throws. */
  readonly killContext?: () => Promise<string | undefined>;
  readonly debug?: (message: string) => void;
}

export interface SetupRequest {
  readonly key: string;
  readonly setup: string;
  /** The repo root in the clone (the gate cwd). */
  readonly cwd: string;
  /** Hosts opened for the setup step (default `DEFAULT_SETUP_HOSTS` at the caller). */
  readonly hosts?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * sha256 over the PRESENT lockfiles (path-sorted: the list below is already sorted) plus the
 * setup text. Plain `node`, not `sha256sum`, which the image may lack.
 */
const FINGERPRINT_JS =
  "const fs=require('fs'),h=require('crypto').createHash('sha256');" +
  "for(const f of ['package-lock.json','pnpm-lock.yaml','yarn.lock'])" +
  "if(fs.existsSync(f)){h.update(f+'\\0');h.update(fs.readFileSync(f));h.update('\\0')}" +
  "h.update(process.argv[1]);process.stdout.write(h.digest('hex'))";

/**
 * `$0` = FINGERPRINT_JS, `$1` = the setup text. A non-Node repo's image may have no `node`: then the same
 * bytes (lockfiles, setup text) go through `sha256sum` / `shasum`. Either way the result is a 64-hex digest.
 */
const FINGERPRINT_SH =
  'if command -v node >/dev/null 2>&1; then exec node -e "$0" "$1"; fi; ' +
  '{ for f in package-lock.json pnpm-lock.yaml yarn.lock; do ' +
  '[ -f "$f" ] && { printf \'%s\\0\' "$f"; cat "$f"; printf \'\\0\'; }; done; printf \'%s\' "$1"; } ' +
  '| { sha256sum 2>/dev/null || shasum -a 256; } | cut -d\' \' -f1';

/** The in-memory per-ticket setup lock (owned by this extension host); it wins over the state file. */
const locks = new Map<string, Promise<SetupResult>>();

/** Test seam: forget every held lock. */
export function resetSetupLocks(): void {
  locks.clear();
}

export function setupInProgress(key: string): boolean {
  return locks.has(key);
}

async function readState(file: string): Promise<SetupState | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    const s = raw as Partial<SetupState>;
    if (typeof s.fingerprint !== 'string' || typeof s.at !== 'number') return undefined;
    if (s.status !== 'running' && s.status !== 'ok' && s.status !== 'failed' && s.status !== 'deferred') return undefined;
    return { fingerprint: s.fingerprint, status: s.status, exitCode: s.exitCode ?? null, at: s.at };
  } catch {
    return undefined;
  }
}

async function writeState(file: string, state: SetupState): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, file);
}

async function fingerprintOf(deps: SetupDeps, req: SetupRequest): Promise<string | SetupResult> {
  const out = await deps.runGate('sh', ['-c', FINGERPRINT_SH, FINGERPRINT_JS, req.setup], req.cwd, { signal: req.signal });
  const hash = out.kind === 'completed' && out.exitCode === 0 ? (out.stdout ?? out.output).trim() : '';
  if (/^[0-9a-f]{64}$/.test(hash)) return hash;
  return { ok: false, reason: `sandbox dependencies not provisioned: could not fingerprint the lockfiles in the sandbox (${out.output.trim().slice(0, 200) || out.kind})` };
}

/**
 * docker only: with an agent turn live the window cannot open (it recreates the proxy). Record `deferred` and
 * wait, bounded; undefined = go ahead, a result = refuse.
 */
async function waitForIdle(deps: SetupDeps, req: SetupRequest, fingerprint: string): Promise<SetupResult | undefined> {
  const win = deps.window;
  if (!win?.needsIdle || !win.turnActive()) return undefined;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (deps.boundMs ?? SETUP_BOUND_MS);
  await writeState(deps.stateFile, { fingerprint, status: 'deferred', exitCode: null, at: now() });
  while (win.turnActive()) {
    if (req.signal?.aborted || now() >= deadline) {
      return { ok: false, reason: req.signal?.aborted ? 'sandbox dependencies not provisioned: setup was stopped' : 'sandbox setup deferred: agent turn active' };
    }
    await sleep(POLL_MS);
  }
  return undefined;
}

/** Exit 0 when `node_modules` is absent or writable; else print its owner and exit 1. Never chowns (needs sudo in the agent's clone). */
const WRITABLE_SH = 'if [ ! -e node_modules ] || [ -w node_modules ]; then exit 0; fi; stat -c %U node_modules 2>/dev/null || ls -ld node_modules | awk \'{print $3}\'; exit 1';

async function unwritableNodeModules(deps: SetupDeps, req: SetupRequest): Promise<string | undefined> {
  const out = await deps.runGate('sh', ['-c', WRITABLE_SH], req.cwd, { signal: req.signal });
  if (out.kind !== 'completed' || out.exitCode === 0) return undefined; // a probe that cannot run is not a verdict
  const owner = (out.stdout ?? out.output).trim() || 'unknown';
  return `sandbox dependencies not provisioned: ${req.cwd}/node_modules is not writable by the sandbox user (owner ${owner}); fix its ownership inside the sandbox (e.g. \`sudo chown -R agent:agent node_modules\`), then re-run setup`;
}

/** Run the setup command once, record the outcome. The caller holds the lock. */
async function runSetup(deps: SetupDeps, req: SetupRequest, fingerprint: string): Promise<SetupResult> {
  const now = deps.now ?? Date.now;
  const refused = await waitForIdle(deps, req, fingerprint);
  if (refused) return refused;
  const blocked = await unwritableNodeModules(deps, req);
  if (blocked) {
    await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode: null, at: now() });
    return { ok: false, reason: blocked };
  }
  await writeState(deps.stateFile, { fingerprint, status: 'running', exitCode: null, at: now() });
  // The window closes in `finally`: after a failed, timed-out or aborted setup too.
  const opened = deps.window ? await deps.window.open(req.hosts ?? []) : undefined;
  if (opened && !opened.ok) {
    await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode: null, at: now() });
    return { ok: false, reason: `sandbox dependencies not provisioned: could not open the setup network window: ${opened.reason}` };
  }
  try {
    return await runSetupCommand(deps, req, fingerprint, opened);
  } finally {
    await opened?.close().catch((err: unknown) => deps.debug?.(`[sandbox] closing the setup network window failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** SIGKILL (exit 137, the OOM killer) or a signal kill: likely transient memory pressure. */
const isKill = (exitCode: number | null): boolean => exitCode === 137;

async function classify(deps: SetupDeps, why: string, exitCode: number | null): Promise<string> {
  if (isKill(exitCode)) {
    const ctx = await deps.killContext?.().catch(() => undefined);
    return `killed (exit 137) — likely out of memory${ctx ? ` (${ctx})` : ''}`;
  }
  return exitCode === 143 ? 'terminated (exit 143)' : why;
}

const abortableDelay = (deps: SetupDeps, signal: AbortSignal | undefined, ms: number): Promise<void> => {
  const sleep = deps.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n)));
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return Promise.race([sleep(ms), new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))]);
};

async function runSetupCommand(deps: SetupDeps, req: SetupRequest, fingerprint: string, window: SetupWindow | undefined, retried = false): Promise<SetupResult> {
  const now = deps.now ?? Date.now;
  const script = `echo $$ > ${PID_FILE}; exec sh -c "$0"`;
  const out = await deps.runGate('sh', ['-c', script, req.setup], req.cwd, { signal: req.signal, timeoutMs: deps.boundMs ?? SETUP_BOUND_MS });
  const exitCode = out.kind === 'completed' ? out.exitCode : null;
  if (out.kind === 'aborted') {
    // A stop is not a failure: drop the record so the next drive reruns, and kill what may still run in the sandbox.
    await reapStale(deps, req).catch(() => undefined);
    await rm(deps.stateFile, { force: true }).catch(() => undefined);
    return { ok: false, reason: 'sandbox dependencies not provisioned: setup was stopped' };
  }
  if (exitCode === 0) {
    await writeState(deps.stateFile, { fingerprint, status: 'ok', exitCode, at: now() });
    return { ok: true };
  }
  if (isKill(exitCode) && !retried) {
    deps.debug?.('[sandbox] setup killed (exit 137): retrying once');
    await abortableDelay(deps, req.signal, deps.killRetryDelayMs ?? KILL_RETRY_DELAY_MS);
    if (req.signal?.aborted) {
      await rm(deps.stateFile, { force: true }).catch(() => undefined);
      return { ok: false, reason: 'sandbox dependencies not provisioned: setup was stopped' };
    }
    return runSetupCommand(deps, req, fingerprint, window, true);
  }
  const raw = out.kind === 'completed' ? `exit ${exitCode}` : out.kind === 'timedOut' ? 'timed out' : out.message;
  const why = await classify(deps, raw, exitCode);
  const body = failedTail(out.output);
  // Both reads need the sandbox / window alive: this runs before the caller's `finally` closes the window.
  const denied = await deniedBy(window);
  const blocked = blockedSuffix(denied ?? [], blockedHostsFromOutput(out.output), req.hosts ?? []);
  const npmLog = deps.logFile ? await copyNpmDebugLog(deps, req, out.output) : undefined;
  deps.debug?.(`[sandbox] setup failed (${why}${blocked}):\n${body}`);
  if (deps.logFile) {
    await mkdir(dirname(deps.logFile), { recursive: true });
    const extra = `${blocked ? `${blocked.slice(2)}\n` : ''}${npmLog ? `npm debug log: ${npmLog}\n` : ''}`;
    await writeFile(deps.logFile, `${why}\n${req.setup}\n${extra}${body}\n`, 'utf8').catch(() => undefined);
  }
  await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode, at: now() });
  const last = quoteLine(body);
  return { ok: false, reason: `sandbox dependencies not provisioned: setup \`${req.setup}\` failed (${why})${blocked}${last ? `: ${last}` : ''}` };
}

/** Best-effort: the hosts the window's proxy refused (docker); an error is no hosts. */
async function deniedBy(window: SetupWindow | undefined): Promise<string[]> {
  try {
    return window?.ok ? (await window.deniedHosts?.()) ?? [] : [];
  } catch {
    return [];
  }
}

const NPM_DEBUG_LOG_FILE = 'setup-npm-debug.log';
const NPM_DEBUG_LOG_LINES = 2000;
const NPM_DEBUG_LOG_BYTES = 1024 * 1024;

/**
 * Best-effort: copy npm's debug log (named in the failed output) out of the sandbox, which is lost when it is
 * removed, to `<bridge dir>/logs/setup-npm-debug.log`. Returns the sandbox path on success; a failure is a debug line.
 */
async function copyNpmDebugLog(deps: SetupDeps, req: SetupRequest, output: string): Promise<string | undefined> {
  const path = npmDebugLogPath(output);
  if (!path || !deps.logFile) return undefined;
  try {
    const script = `tail -n ${NPM_DEBUG_LOG_LINES} "$0" | tail -c ${NPM_DEBUG_LOG_BYTES}`;
    const out = await deps.runGate('sh', ['-c', script, path], req.cwd, { signal: req.signal });
    if (out.kind !== 'completed' || out.exitCode !== 0) throw new Error(out.kind === 'completed' ? `exit ${out.exitCode}` : out.kind);
    const dir = dirname(deps.logFile);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, NPM_DEBUG_LOG_FILE), out.stdout ?? out.output, 'utf8');
    return path;
  } catch (err) {
    deps.debug?.(`[sandbox] copying the npm debug log ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Run under the per-ticket lock; a second caller waits on it instead of starting another. */
function startSetup(deps: SetupDeps, req: SetupRequest, fingerprint: string): Promise<SetupResult> {
  const run = runSetup(deps, req, fingerprint).finally(() => locks.delete(req.key));
  locks.set(req.key, run);
  return run;
}

/**
 * Best-effort kill of a stale or stopped sandbox-side setup: its children first, then the pid-file process.
 * The setup script writes the pid file before anything else, so no pid file means no setup of ours to kill.
 */
async function reapStale(deps: SetupDeps, req: SetupRequest): Promise<void> {
  const script = `p=$(cat ${PID_FILE} 2>/dev/null); [ -n "$p" ] && { pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; }; rm -f ${PID_FILE}; true`;
  await deps.runGate('sh', ['-c', script], req.cwd, {});
}

const timedOut = (boundMs: number): SetupResult => ({ ok: false, reason: `sandbox setup timed out after ${Math.round(boundMs / 60_000)} min` });

/** Wait for the held lock, bounded; the lock's own result is the answer. */
async function waitOnLock(lock: Promise<SetupResult>, deps: SetupDeps): Promise<SetupResult> {
  const bound = deps.boundMs ?? SETUP_BOUND_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<SetupResult>((resolve) => { timer = setTimeout(() => resolve(timedOut(bound)), bound); });
  try {
    return await Promise.race([lock, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Before a sandboxed gate list (and in the background at create/reattach): make sure the
 * repo's `sandbox.setup` has run in the sandbox for the CURRENT lockfiles. Never starts a
 * second setup while one is held; a failed or timed-out setup refuses the list, so a missing
 * dependency never reaches the gates' exit-127 park.
 */
export async function ensureSandboxSetup(deps: SetupDeps, req: SetupRequest): Promise<SetupResult> {
  const bound = deps.boundMs ?? SETUP_BOUND_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const held = locks.get(req.key);
  if (held) return waitOnLock(held, deps);

  const fp = await fingerprintOf(deps, req);
  if (typeof fp !== 'string') return fp;
  const raced = locks.get(req.key);
  if (raced) return waitOnLock(raced, deps);

  const state = await readState(deps.stateFile);
  if (state?.fingerprint === fp && state.status === 'ok') return { ok: true };
  if (state?.fingerprint === fp && state.status === 'failed') {
    return { ok: false, reason: `sandbox dependencies not provisioned: the last setup \`${req.setup}\` failed (${state.exitCode === 137 ? 'killed (exit 137) — likely out of memory' : `exit ${state.exitCode ?? 'n/a'}`}); run "Karst: Re-run sandbox setup"` };
  }
  if (state?.fingerprint === fp && state.status === 'running') {
    // No lock here: state left by a previous host or a crash. Young = another run may be live.
    const deadline = state.at + bound;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const cur = await readState(deps.stateFile);
      if (cur?.status === 'ok' && cur.fingerprint === fp) return { ok: true };
      if (cur?.status === 'failed') return { ok: false, reason: `sandbox dependencies not provisioned: setup \`${req.setup}\` failed (${cur.exitCode === 137 ? 'killed (exit 137) — likely out of memory' : `exit ${cur.exitCode ?? 'n/a'}`})` };
      if (locks.has(req.key)) return waitOnLock(locks.get(req.key)!, deps);
    }
    await reapStale(deps, req);
  }
  // Re-check with no await in between: another caller may have taken the lock while this one read state.
  const late = locks.get(req.key);
  if (late) return waitOnLock(late, deps);
  return startSetup(deps, req, fp);
}
