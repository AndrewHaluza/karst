import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GateProcessRunner } from '../workflow/gates/run.js';

/** How long a setup (or a wait on one) may take before the gate list is refused. */
export const SETUP_BOUND_MS = 15 * 60_000;
/** Lines of failed setup output kept in `logs/setup.log` and the refusal reason. */
export const SETUP_LOG_LINES = 40;
const POLL_MS = 5_000;
/** Written by the setup script INSIDE the sandbox so a stale run can be killed. */
const PID_FILE = '/tmp/karst-setup.pid';

export interface SetupState {
  readonly fingerprint: string;
  readonly status: 'running' | 'ok' | 'failed';
  readonly exitCode: number | null;
  readonly at: number;
}

export type SetupResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface SetupDeps {
  /** The sandbox's gate runner: every command here runs INSIDE the sandbox, never on the host. */
  readonly runGate: GateProcessRunner;
  /** `<root>/state/<id>.setup.json`: outside the sandbox mount (arch:AC-34). */
  readonly stateFile: string;
  /** `<bridge dir>/<id>/logs/setup.log`: advisory, agent-readable, never read back. */
  readonly logFile?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly boundMs?: number;
  readonly debug?: (message: string) => void;
}

export interface SetupRequest {
  readonly key: string;
  readonly setup: string;
  /** The repo root in the clone (the gate cwd). */
  readonly cwd: string;
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
    if (s.status !== 'running' && s.status !== 'ok' && s.status !== 'failed') return undefined;
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

const tail = (text: string): string => text.split('\n').filter((l) => l.trim() !== '').slice(-SETUP_LOG_LINES).join('\n');

async function fingerprintOf(deps: SetupDeps, req: SetupRequest): Promise<string | SetupResult> {
  const out = await deps.runGate('sh', ['-c', 'node -e "$0" "$1"', FINGERPRINT_JS, req.setup], req.cwd, { signal: req.signal });
  const hash = out.kind === 'completed' && out.exitCode === 0 ? (out.stdout ?? out.output).trim() : '';
  if (/^[0-9a-f]{64}$/.test(hash)) return hash;
  return { ok: false, reason: `sandbox dependencies not provisioned: could not fingerprint the lockfiles in the sandbox (${out.output.trim().slice(0, 200) || out.kind})` };
}

/** Run the setup command once, record the outcome. The caller holds the lock. */
async function runSetup(deps: SetupDeps, req: SetupRequest, fingerprint: string): Promise<SetupResult> {
  const now = deps.now ?? Date.now;
  await writeState(deps.stateFile, { fingerprint, status: 'running', exitCode: null, at: now() });
  const script = `echo $$ > ${PID_FILE}; exec sh -c "$0"`;
  const out = await deps.runGate('sh', ['-c', script, req.setup], req.cwd, { signal: req.signal, timeoutMs: deps.boundMs ?? SETUP_BOUND_MS });
  const exitCode = out.kind === 'completed' ? out.exitCode : null;
  if (out.kind === 'aborted') {
    await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode, at: now() }).catch(() => undefined);
    return { ok: false, reason: 'sandbox dependencies not provisioned: setup was stopped' };
  }
  if (exitCode === 0) {
    await writeState(deps.stateFile, { fingerprint, status: 'ok', exitCode, at: now() });
    return { ok: true };
  }
  const why = out.kind === 'completed' ? `exit ${exitCode}` : out.kind === 'timedOut' ? 'timed out' : out.message;
  const body = tail(out.output);
  deps.debug?.(`[sandbox] setup failed (${why}):\n${body}`);
  if (deps.logFile) {
    await mkdir(dirname(deps.logFile), { recursive: true });
    await writeFile(deps.logFile, `${req.setup}\n${why}\n${body}\n`, 'utf8').catch(() => undefined);
  }
  await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode, at: now() });
  const last = body.split('\n').pop() ?? '';
  return { ok: false, reason: `sandbox dependencies not provisioned: setup \`${req.setup}\` failed (${why})${last ? `: ${last}` : ''}` };
}

/** Run under the per-ticket lock; a second caller waits on it instead of starting another. */
function startSetup(deps: SetupDeps, req: SetupRequest, fingerprint: string): Promise<SetupResult> {
  const run = runSetup(deps, req, fingerprint).finally(() => locks.delete(req.key));
  locks.set(req.key, run);
  return run;
}

/** Kill a stale sandbox-side setup. False = a setup-looking process may still run (no pid file, `pgrep` hit). */
async function reapStale(deps: SetupDeps, req: SetupRequest): Promise<boolean> {
  const hasPid = await deps.runGate('sh', ['-c', `test -f ${PID_FILE}`], req.cwd, {});
  if (hasPid.kind === 'completed' && hasPid.exitCode === 0) {
    await deps.runGate('sh', ['-c', `kill $(cat ${PID_FILE}) 2>/dev/null; rm -f ${PID_FILE}; true`], req.cwd, {});
    return true;
  }
  const busy = await deps.runGate('sh', ['-c', 'pgrep -f "npm|pnpm|yarn" >/dev/null'], req.cwd, {});
  return !(busy.kind === 'completed' && busy.exitCode === 0);
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
    return { ok: false, reason: `sandbox dependencies not provisioned: the last setup \`${req.setup}\` failed (exit ${state.exitCode ?? 'n/a'}); run "Karst: Re-run sandbox setup"` };
  }
  if (state?.fingerprint === fp && state.status === 'running') {
    // No lock here: state left by a previous host or a crash. Young = another run may be live.
    const deadline = state.at + bound;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const cur = await readState(deps.stateFile);
      if (cur?.status === 'ok' && cur.fingerprint === fp) return { ok: true };
      if (cur?.status === 'failed') return { ok: false, reason: `sandbox dependencies not provisioned: setup \`${req.setup}\` failed (exit ${cur.exitCode ?? 'n/a'})` };
      if (locks.has(req.key)) return waitOnLock(locks.get(req.key)!, deps);
    }
    if (!(await reapStale(deps, req))) return timedOut(bound);
  }
  // Re-check with no await in between: another caller may have taken the lock while this one read state.
  const late = locks.get(req.key);
  if (late) return waitOnLock(late, deps);
  return startSetup(deps, req, fp);
}
