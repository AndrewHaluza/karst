import type { Store } from '../store/db.js';
import type { ServerRecord } from '../runtime/supervisor.js';
import { markServerStopped, stopTicketServers } from '../runtime/supervisor.js';
import { PUBLISH_HOST } from './sandboxPorts.js';
import type { PortMapping, SessionRunner } from './sessionRunner.js';

/**
 * A ticket's hot services inside its sandbox (arch:AC-32). The service runs in
 * the sandbox; the host reaches it ONLY on its published `127.0.0.1:<hostPort>`.
 * The server row is written only after publish + health, and records the
 * sandbox handle (`servers.sandbox`), never a host pid.
 */

export type SandboxServiceRunner = Pick<SessionRunner, 'kind' | 'publishPort' | 'unpublishPort' | 'listPorts' | 'runGate' | 'allowHostPorts' | 'hasSandbox' | 'canHostServices'>;

export class SandboxServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxServiceError';
  }
}

/** `servers.sandbox`: `<kind>:<name>:<sandboxPort>` — the runner and the port inside it. */
export function sandboxHandle(kind: string, name: string, sandboxPort: number): string {
  return `${kind}:${name}:${sandboxPort}`;
}

export function parseSandboxHandle(handle: string): { kind: string; name: string; sandboxPort: number } | null {
  const match = /^(sbx|docker):([a-z0-9-]+):(\d{1,5})$/.exec(handle);
  return match ? { kind: match[1]!, name: match[2]!, sandboxPort: Number(match[3]) } : null;
}

/** A unit key (`repo` or `repo/service`) as a file-name-safe token inside the sandbox. */
export function serviceToken(unitKey: string): string {
  return unitKey.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** Fixed scripts; every variable part is an argv element. */
/** Stops a previous instance first: a restart must not race its own old process for the port. */
export const START_SCRIPT =
  'k=$1; d=$2; shift 2; f="/tmp/karst-svc-$k.pid"; ' +
  'if [ -f "$f" ]; then p=$(cat "$f"); kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; fi; ' +
  'cd "$d" || exit 1; ' +
  'if command -v setsid >/dev/null 2>&1; then setsid nohup "$@" >"/tmp/karst-svc-$k.log" 2>&1 & ' +
  'else nohup "$@" >"/tmp/karst-svc-$k.log" 2>&1 & fi; echo $! >"$f"';
export const STOP_SCRIPT =
  'f="/tmp/karst-svc-$1.pid"; if [ -f "$f" ]; then p=$(cat "$f"); ' +
  'kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; rm -f "$f"; fi; exit 0';

const EXEC_TIMEOUT_MS = 30_000;

export interface SandboxServiceStart {
  readonly store: Store;
  readonly runner: SandboxServiceRunner;
  /** The sandbox name (`servers.sandbox` handle part). */
  readonly sandboxName: string;
  readonly ticketId: number;
  /** Service unit key — the row's identity, never the repoPath. */
  readonly service: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Only karst-resolved vars + the repo `.env` + overrides — never the host process env. */
  readonly env: Readonly<Record<string, string>>;
  /** Host ticket worktree (the gate cwd) and the service's own dir inside it. */
  readonly worktree: string;
  readonly serviceCwd: string;
  /** The allocated port: the service listens on it inside the sandbox. */
  readonly port: number;
  readonly healthUrlFor: (hostPort: number) => string;
  readonly logPath: string;
  /** One reallocation of the HOST port on a publish conflict (the existing allocator). */
  readonly reallocate: (taken: number) => Promise<number>;
  readonly waitHealthy: (url: string, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly debug?: (message: string) => void;
}

function needs<K extends keyof SandboxServiceRunner>(runner: SandboxServiceRunner, key: K): NonNullable<SandboxServiceRunner[K]> {
  const fn = runner[key];
  if (!fn) throw new SandboxServiceError(`karst: the ${runner.kind} runner cannot ${String(key)}`);
  return fn as NonNullable<SandboxServiceRunner[K]>;
}

/** Publish, reallocating the host port once when it is taken; a second failure throws. */
async function publish(input: SandboxServiceStart): Promise<PortMapping> {
  const publishPort = needs(input.runner, 'publishPort');
  const first: PortMapping = { hostPort: input.port, sandboxPort: input.port };
  const r1 = await publishPort(first);
  if (r1.ok) return first;
  if (!r1.portTaken) throw new SandboxServiceError(`${input.service}: ${r1.reason}`);
  const hostPort = await input.reallocate(input.port);
  input.debug?.(`[runtime] ticket ${input.ticketId}: ${input.service} host port ${input.port} taken, reallocated ${hostPort}`);
  const second: PortMapping = { hostPort, sandboxPort: input.port };
  const r2 = await publishPort(second);
  if (r2.ok) return second;
  throw new SandboxServiceError(`${input.service}: cannot publish a host port after one reallocation: ${r2.reason}`);
}

function envArgv(env: Readonly<Record<string, string>>): string[] {
  const pairs = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).sort().map((k) => `${k}=${env[k]!}`);
  return pairs.length > 0 ? ['env', ...pairs] : [];
}

async function execIn(runner: SandboxServiceRunner, worktree: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  const out = await needs(runner, 'runGate')('sh', args, worktree, { timeoutMs: EXEC_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (out.kind === 'completed' && out.exitCode === 0) return null;
  return out.kind === 'completed' ? `exit ${out.exitCode}: ${out.output.trim()}` : `${out.kind}: ${out.output.trim()}`;
}

export async function startSandboxService(input: SandboxServiceStart): Promise<ServerRecord> {
  if (input.runner.canHostServices && !(await input.runner.canHostServices())) {
    throw new SandboxServiceError(
      `${input.service}: the ${input.runner.kind} sandbox is not running — open the ticket's session first, then start the service`,
    );
  }
  const mapping = await publish(input);
  const token = serviceToken(input.service);
  const unpublish = () => input.runner.unpublishPort?.(mapping) ?? Promise.resolve();
  const started = await execIn(input.runner, input.worktree, [
    '-c', START_SCRIPT, 'karst-svc', token, input.serviceCwd, ...envArgv(input.env), input.command, ...input.args,
  ], input.signal);
  if (started !== null) {
    await unpublish();
    throw new SandboxServiceError(`${input.service}: start inside the sandbox failed (${started})`);
  }
  try {
    await input.waitHealthy(input.healthUrlFor(mapping.hostPort), input.signal);
  } catch (err) {
    await execIn(input.runner, input.worktree, ['-c', STOP_SCRIPT, 'karst-svc-stop', token]);
    await unpublish();
    throw new SandboxServiceError(`${input.service}: not healthy on ${PUBLISH_HOST}:${mapping.hostPort}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const handle = sandboxHandle(input.runner.kind, input.sandboxName, mapping.sandboxPort);
  input.store.db.prepare('DELETE FROM servers WHERE repo = ? AND ticket_id IS ?').run(input.service, input.ticketId);
  const info = input.store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, cwd, started_at, sandbox)
       VALUES (?, ?, ?, ?, NULL, 'running', ?, ?, ?, ?)`,
    )
    .run(input.ticketId, input.service, PUBLISH_HOST, mapping.hostPort, input.logPath, input.worktree, new Date().toISOString(), handle);
  input.debug?.(`[runtime] ticket ${input.ticketId}: ${input.service} healthy in ${handle} on ${PUBLISH_HOST}:${mapping.hostPort}`);
  return {
    id: Number(info.lastInsertRowid), ticketId: input.ticketId, service: input.service,
    host: PUBLISH_HOST, port: mapping.hostPort, pid: null, status: 'running', logPath: input.logPath, container: null,
  };
}

interface SandboxRow {
  readonly id: number;
  readonly repo: string;
  readonly port: number;
  readonly cwd: string;
  readonly sandbox: string;
}

function sandboxRows(store: Store, ticketId: number): SandboxRow[] {
  return store.db
    .prepare("SELECT id, repo, port, cwd, sandbox FROM servers WHERE ticket_id = ? AND status = 'running' AND sandbox IS NOT NULL")
    .all(ticketId) as SandboxRow[];
}

function mappingOf(row: SandboxRow): PortMapping | null {
  const parsed = parseSandboxHandle(row.sandbox);
  return parsed ? { hostPort: row.port, sandboxPort: parsed.sandboxPort } : null;
}

/** Stop one sandboxed service: in the sandbox, then its mapping, then the row. */
export async function stopSandboxService(store: Store, serverId: number, runner: SandboxServiceRunner): Promise<void> {
  const row = store.db
    .prepare('SELECT id, repo, port, cwd, sandbox FROM servers WHERE id = ? AND sandbox IS NOT NULL')
    .get(serverId) as SandboxRow | undefined;
  if (!row) return;
  await execIn(runner, row.cwd, ['-c', STOP_SCRIPT, 'karst-svc-stop', serviceToken(row.repo)]);
  const mapping = mappingOf(row);
  if (mapping) await runner.unpublishPort?.(mapping);
  markServerStopped(store, row.id);
}

/** Stop every sandboxed service of ONE ticket; other tickets' rows and mappings are untouched. */
export async function stopTicketSandboxServices(store: Store, ticketId: number, runner: SandboxServiceRunner): Promise<void> {
  for (const row of sandboxRows(store, ticketId)) await stopSandboxService(store, row.id, runner);
}

/**
 * Stop ALL of a ticket's servers: its sandboxed ones inside the sandbox (and
 * their 127.0.0.1 mappings) first, then the host path for everything else.
 * Without a runner a sandbox row can only be marked stopped by the host path.
 */
export async function stopAllTicketServers(store: Store, ticketId: number, runner: SandboxServiceRunner | undefined): Promise<void> {
  if (runner) await stopTicketSandboxServices(store, ticketId, runner);
  await stopTicketServers(store, ticketId);
}

export interface ReverifyResult {
  readonly republished: string[];
  readonly dropped: string[];
}

/**
 * After a sandbox restart (reattach): every recorded mapping is checked
 * against the live listing; a missing one is republished; a row whose service
 * is then not healthy is removed. A listing the sandbox cannot give (stopped)
 * changes nothing — "cannot tell" is never "gone".
 */
export async function reverifySandboxServices(
  store: Store,
  ticketId: number,
  runner: SandboxServiceRunner,
  isHealthy: (row: { repo: string; port: number }) => Promise<boolean>,
): Promise<ReverifyResult | null> {
  const rows = sandboxRows(store, ticketId);
  if (rows.length === 0) return { republished: [], dropped: [] };
  const live = await needs(runner, 'listPorts')();
  if (live === null) return null;
  const republished: string[] = [];
  const dropped: string[] = [];
  for (const row of rows) {
    const mapping = mappingOf(row);
    const present = mapping !== null && live.some((m) => m.hostPort === mapping.hostPort && m.sandboxPort === mapping.sandboxPort);
    let reachable = mapping !== null;
    if (mapping && !present) {
      const r = await needs(runner, 'publishPort')(mapping);
      if (r.ok) republished.push(row.repo);
      // A mapping that cannot be restored leaves the row pointing at nothing.
      else reachable = false;
    }
    if (!reachable || !(await isHealthy(row))) {
      if (mapping) await runner.unpublishPort?.(mapping);
      store.db.prepare('DELETE FROM servers WHERE id = ?').run(row.id);
      dropped.push(row.repo);
    }
  }
  return { republished, dropped };
}

/** Runs a declared `reset` in the service's own dir; the command text is one argv element. */
export const RESET_SCRIPT = 'cd "$1" || exit 1; exec sh -c "$2"';

/**
 * Decision 8: between agent and user UAT, run each RUNNING sandboxed service's
 * declared `reset` on that same instance (no restart). A service without one is
 * left as the Tester left it. Returns one warning per failed reset.
 */
export async function resetSandboxServices(
  store: Store,
  ticketId: number,
  runner: SandboxServiceRunner,
  resetOf: (unitKey: string) => { readonly reset?: string; readonly cwd?: string } | undefined,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const row of sandboxRows(store, ticketId)) {
    const def = resetOf(row.repo);
    if (!def?.reset) continue;
    const dir = def.cwd ? `${row.cwd}/${def.cwd}` : row.cwd;
    const failed = await execIn(runner, row.cwd, ['-c', RESET_SCRIPT, 'karst-reset', dir, def.reset]);
    if (failed !== null) warnings.push(`${row.repo}: reset failed (${failed})`);
  }
  return warnings;
}
