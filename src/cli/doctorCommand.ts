import type { BackendWant } from '../agent/backendChoices.js';
import { selectedSandboxBackends, wantedBackends } from '../agent/backendChoices.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest, RemoteDef } from '../manifest/types.js';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
import { nodeEnvProbe } from '../manifest/nodeEnvProbe.js';
import { dependencyRegistry, binaryExists, commandSucceeds, readCommandOutput } from '../runtime/deps.js';
import { SCHEMA_VERSION } from '../store/schemaVersion.js';
import { checkTools } from '../doctor/toolsChecks.js';
import { checkAgyPermissions } from '../doctor/agyPermissionChecks.js';
import {
  checkClaudeInstall,
  claudeLinkProbe,
} from '../doctor/claudeInstallCheck.js';
import { checkGitHealth, type GitRepoHealth } from '../doctor/gitHealthCheck.js';
import { checkInotifyWatches } from '../doctor/inotifyWatchCheck.js';
import { checkManifest } from '../doctor/manifestChecks.js';
import { checkState } from '../doctor/stateChecks.js';
import { checkStorage, type StorageUsage } from '../doctor/storageCheck.js';
import { checkStuckTickets, STUCK_IDLE_MINUTES } from '../doctor/stuckCheck.js';
import { checkWiring } from '../doctor/wiringChecks.js';
import { parseDoctorArea, renderDoctorText, runDoctor } from '../doctor/run.js';
import {
  checkForeignRemoteWorkspaces,
  checkRemoteDiskFacts,
  checkSandboxBackends,
  checkSandboxSetupDeclared,
  checkSshRemotes,
  checkStaleRemoteWorkspaces,
  type ForeignRemoteWorkspaceFact,
  type RemoteDiskFact,
  type RemoteWorkspaceFact,
} from '../doctor/sandboxChecks.js';
import {
  probeBackends,
  probeDockerDisk,
  probeDockerMemory,
  probeDockerImageDisk,
  probeRemoteDisk,
  probeRemoteWorkspaces,
  type BackendProbes,
  type RemoteDiskFacts,
  type RemoteProbeError,
  type RemoteWorkspaceProbe,
} from '../agent/backendProbe.js';
import { doneMergedTicketIds } from '../store/doneMerged.js';
import { checkSandboxOrphans } from '../doctor/sandboxOrphanCheck.js';
import { listProjectSandboxes, type ProjectSandbox, type SandboxInventory } from '../agent/sandboxInventory.js';
import { readExistingInstallId } from '../agent/ssh/sshNames.js';
import { NODE_SBX_PROCESS } from '../agent/sbx/sbxProcess.js';
import { NODE_DOCKER_PROCESS } from '../agent/docker/dockerProcess.js';
import { SSH_CORES, type SshCore } from '../agent/sandboxCores.js';
import { listForeignRemoteDirs, type ForeignListing } from '../agent/ssh/sshForeign.js';
import { sshPreflight, type SshPreflightResult } from '../agent/ssh/sshPreflight.js';
import { sshControlDir } from '../agent/ssh/sshControlDir.js';
import { isRemoteTrusted, readRemoteTrust } from '../agent/ssh/remoteTrust.js';
import { NODE_SSH_PROCESS, type SshProcess } from '../agent/ssh/sshProcess.js';
import { parseDbTimeMs, type FixEffects } from '../doctor/applyFixes.js';
import * as probes from '../doctor/probes.js';
import type { DoctorArea, DoctorCheck } from '../doctor/types.js';

/** agy's global settings — the only place its headless allow-rules live. */
function readAgyAllowRules(settingsPath: string): string[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions?: { allow?: unknown } };
    const allow = parsed.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return undefined;
  }
}

/** Defaults until a manifest field exists for them. */
export const DOCTOR_STUCK_MINUTES = STUCK_IDLE_MINUTES;
export const DOCTOR_WAL_LIMIT_BYTES = 64 * 1024 * 1024;

export interface ParsedDoctorArgs {
  fix: boolean;
  json: boolean;
  areas: DoctorArea[];
  /** Check ids for `--fix --only <id>` (repeatable; never comma-split — ids hold repo names). */
  only: string[];
}

export function parseDoctorArgs(rest: readonly string[]): ParsedDoctorArgs {
  const out: ParsedDoctorArgs = { fix: false, json: false, areas: [], only: [] };
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === '--fix') out.fix = true;
    else if (t === '--json') out.json = true;
    else if (t === '--only') {
      const v = rest[++i];
      if (v === undefined) throw new Error('karst doctor: --only needs a value');
      out.only.push(v);
    } else if (t === '--area') {
      const v = rest[++i];
      if (v === undefined) throw new Error('karst doctor: --area needs a value');
      out.areas.push(parseDoctorArea(v));
    } else throw new Error(`karst doctor: unexpected argument '${t}'`);
  }
  if (out.only.length > 0 && !out.fix) throw new Error('karst doctor: --only needs --fix');
  return out;
}

/** Thrown to carry doctor's exit code through the CLI's single catch. */
export class DoctorExit extends Error {
  constructor(
    readonly output: string,
    readonly code: 0 | 1,
  ) {
    super(output);
  }
}

interface TicketRow { id: number; key: string; stage_current: string | null; agent_state: string | null; archived_at: string | null; paused_at: string | null; updated_at: string }

function stateProbes(store: Store, dbPath: string) {
  const rows = <T>(sql: string): T[] => store.db.prepare(sql).all() as T[];
  const worktrees = rows<{ ticket_id: number; key: string; stage_current: string | null; repo: string; path: string; branch: string | null }>(
    'SELECT w.ticket_id, t.key, t.stage_current, w.repo, w.path, w.branch FROM worktrees w JOIN tickets t ON t.id = w.ticket_id',
  ).map((w) => ({ ticketId: w.ticket_id, ticketKey: w.key, ticketStage: w.stage_current, repo: w.repo, path: w.path, branch: w.branch }));
  const servers = rows<{ id: number; ticket_id: number | null; stage_current: string | null; repo: string; port: number | null; pid: number | null; status: string; started_at: string; kind: string }>(
    'SELECT s.id, s.ticket_id, t.stage_current, s.repo, s.port, s.pid, s.status, s.started_at, s.kind FROM servers s LEFT JOIN tickets t ON t.id = s.ticket_id',
  ).map((s) => ({ id: s.id, ticketId: s.ticket_id, ticketStage: s.stage_current, repo: s.repo, port: s.port, pid: s.pid, status: s.status, startedAt: s.started_at, kind: s.kind }));
  const dbVersion = (store.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0;
  return {
    worktrees, servers,
    pathExists: probes.pathExists, branchExists: probes.branchExists,
    unrecordedWorktreeDirs: [] as string[], // needs the host's worktree root; the CLI cannot know it
    pidAlive: probes.pidAlive, pidStartedAtMs: probes.pidStartedAtMs, worktreeState: probes.worktreeState,
    dbSchemaVersion: dbVersion, extensionSchemaVersion: SCHEMA_VERSION,
    walBytes: probes.fileBytes(`${dbPath}-wal`), walLimitBytes: DOCTOR_WAL_LIMIT_BYTES,
    staleOutboxFiles: [] as string[], // scratch dirs are host-owned; the CLI cannot enumerate them
  };
}

function stuckProbes(store: Store, nowMs: number) {
  const tickets = (store.db.prepare(
    'SELECT id, key, stage_current, agent_state, archived_at, paused_at, updated_at FROM tickets',
  ).all() as TicketRow[]).map((t) => {
    const count = (sql: string): boolean => ((store.db.prepare(sql).get(t.id) as { n: number }).n > 0);
    return {
      id: t.id, key: t.key, stage: t.stage_current,
      updatedAtMs: parseDbTimeMs(t.updated_at),
      archived: t.archived_at !== null, paused: t.paused_at !== null,
      hasLiveSession: t.agent_state === 'running',
      hasRunningGate: count('SELECT COUNT(*) AS n FROM gate_runs WHERE ticket_id = ? AND started_at IS NOT NULL AND ended_at IS NULL'),
      awaitingMerge: t.stage_current === 'ship',
      needsHumanRebase: count("SELECT COUNT(*) AS n FROM merge_checks WHERE ticket_id = ? AND state = 'conflicted'"),
      hasOpenBlockingSubtask: count("SELECT COUNT(*) AS n FROM tickets WHERE subtask_parent_id = ? AND blocks_parent = 1 AND stage_current IS NOT 'done'"),
    };
  });
  return { nowMs, thresholdMs: DOCTOR_STUCK_MINUTES * 60_000, tickets };
}

function runnableJs(p: string): boolean {
  try { return statSync(p).isFile() && p.endsWith('.js'); } catch { return false; }
}

function fixEffects(store: Store): FixEffects {
  return {
    // Null the pid like `supervisor.markServerStopped` and `reconcile` do: the
    // fix ran because the recorded process is gone, so a `stopped` row keeping a
    // pid would be the one shape that lies about the row's lifecycle — and the
    // only one a `pid IS NULL` reap (runtime/supervisor.ts `pruneDeadServers`)
    // would leave behind.
    markServerStopped: (id) => { store.db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(id); },
    pidStartedAtMs: probes.pidStartedAtMs,
    killProcess: (pid) => { process.kill(pid, 'SIGTERM'); },
    worktreeState: probes.worktreeState,
    pruneWorktree: (a) => {
      // No --force: git itself refuses a dirty tree. `branch -d` refuses unmerged work.
      execFileSync('git', ['-C', a.repo, 'worktree', 'remove', a.path], { stdio: 'ignore' });
      if (a.branch) { try { execFileSync('git', ['-C', a.repo, 'branch', '-d', a.branch], { stdio: 'ignore' }); } catch { /* unmerged branch is kept */ } }
      store.db.prepare('DELETE FROM worktrees WHERE ticket_id = ? AND path = ?').run(a.ticketId, a.path);
    },
    quarantineOutbox: () => { throw new Error('outbox quarantine is host-side only'); },
    recreateLauncher: () => { throw new Error('launcher is not available in this build'); },
  };
}

/** This project's sandboxes (async, never `spawnSync`); injected by tests. */
export interface ListSandboxesContext {
  /** The globalStorage dir: `ssh/install-id` (read only) and `ssh-trust.json` live there. */
  readonly globalStorageDir: string;
  /** The manifest's `remotes`: every declared remote is listed too (D824). */
  readonly remotes: Readonly<Record<string, RemoteDef>> | undefined;
}
export type ListSandboxes = (projectRoot: string, ctx?: ListSandboxesContext) => Promise<SandboxInventory>;

const listSandboxesNode: ListSandboxes = async (projectRoot, ctx) => {
  const remotes = ctx?.remotes;
  // Read only: a host step never creates the install id (D826); a missing one lists no ssh remote.
  const installId = ctx === undefined || remotes === undefined || Object.keys(remotes).length === 0
    ? undefined
    : await readExistingInstallId(ctx.globalStorageDir).catch(() => undefined);
  return listProjectSandboxes({
    projectRoot, sbx: NODE_SBX_PROCESS, docker: NODE_DOCKER_PROCESS,
    ...(remotes === undefined ? {} : { remotes }),
    ...(installId === undefined ? {} : { installId }),
    ...(ctx === undefined ? {} : { trustDir: ctx.globalStorageDir }),
  });
};

/** Orphans: this project's sandboxes whose ticket is not live (arch:AC-32). Only with a sandbox backend. */
async function sandboxOrphanChecks(store: Store, manifestPath: string | undefined, manifest: Manifest | undefined, list: () => Promise<SandboxInventory>): Promise<DoctorCheck[]> {
  if (manifestPath === undefined || manifest?.agentBackends === undefined) return [];
  const merged = doneMergedTicketIds(store);
  const live = new Set((store.db.prepare('SELECT id FROM tickets WHERE archived_at IS NULL').all() as { id: number }[]).map((r) => r.id).filter((id) => !merged.has(id)));
  const inv = await list();
  return checkSandboxOrphans(inv.sandboxes.filter((s) => !live.has(s.ticketId)));
}

/** Backend readiness + docker disk use; injected by tests. */
export interface SandboxProbe {
  readonly backends: (want: BackendWant) => Promise<BackendProbes>;
  readonly dockerDisk: () => Promise<number | undefined>;
  readonly dockerMemory?: () => Promise<number | undefined>;
  readonly dockerImageDisk?: () => Promise<{ readonly imageBytes: number | undefined; readonly cacheBytes: number | undefined }>;
}

const SANDBOX_PROBE_NODE: SandboxProbe = { backends: probeBackends, dockerDisk: probeDockerDisk, dockerMemory: probeDockerMemory, dockerImageDisk: probeDockerImageDisk };

/** The identity and trust record the remote probes read; captured once per doctor run. */
export interface RemoteProbeContext {
  /** The manifest path: the same string the launcher hashes for the ssh names (D555). */
  readonly projectRoot: string;
  /** Read only: a host step never creates the install id (D826). */
  readonly installId: string | undefined;
  readonly trustDir: string;
  readonly controlDir: string;
}

/** The remote facts `karst doctor` collects; injected so a test can fake any answer. */
export interface RemoteProbe {
  readonly preflight: (name: string, def: RemoteDef, core: SshCore) => Promise<SshPreflightResult>;
  readonly disk: (name: string, def: RemoteDef) => Promise<RemoteDiskFacts | RemoteProbeError>;
  readonly workspaces: (name: string, def: RemoteDef) => Promise<readonly RemoteWorkspaceProbe[] | RemoteProbeError>;
  readonly foreign: (name: string, def: RemoteDef) => Promise<ForeignListing>;
}

/** The node bindings: every remote probe checks D553 trust first (the probes themselves re-check). */
export function remoteProbeFor(ssh: SshProcess, ctx: RemoteProbeContext): RemoteProbe {
  const installId = ctx.installId ?? '';
  return {
    preflight: (name, def, core) => sshPreflight(name, def, ssh, { controlDir: ctx.controlDir, core }),
    disk: (name, def) => probeRemoteDisk(ssh, name, def, { projectRoot: ctx.projectRoot, installId, trustDir: ctx.trustDir, controlDir: ctx.controlDir }),
    workspaces: (name, def) => probeRemoteWorkspaces(ssh, name, def, { projectRoot: ctx.projectRoot, installId, trustDir: ctx.trustDir, controlDir: ctx.controlDir }),
    foreign: (name, def) => listForeignRemoteDirs(ssh, name, def, { controlDir: ctx.controlDir, trustDir: ctx.trustDir, projectRoot: ctx.projectRoot, installId }),
  };
}

/** The core whose `<core> --version` the `mode: direct` preflight probes: the one this remote serves, else claude. */
function remoteCore(manifest: Manifest | undefined, remote: string): SshCore {
  for (const [core, backend] of Object.entries(manifest?.agentBackends ?? {})) {
    if (backend === `ssh:${remote}` && (SSH_CORES as readonly string[]).includes(core)) return core as SshCore;
  }
  return 'claude';
}

/** Stopped ssh workspaces of one remote with the age and size a trusted probe reported. */
function staleFacts(remote: string, sandboxes: readonly ProjectSandbox[], ages: readonly RemoteWorkspaceProbe[]): RemoteWorkspaceFact[] {
  const byName = new Map(ages.map((a) => [a.name, a]));
  return sandboxes
    .filter((s): s is ProjectSandbox & { remote: string } => s.runner === 'ssh' && s.remote === remote)
    .flatMap((s) => {
      const age = byName.get(s.name);
      return age === undefined ? [] : [{ remote: s.remote, name: s.name, ticketId: s.ticketId, state: s.state, ageDays: age.ageDays, sizeKb: age.sizeKb }];
    });
}

/**
 * The ssh half of the doctor (edits 6, 12 and 13): `tools.sandbox-ssh-<remote>`
 * with the D554 preflight, remote disk + stale workspaces + foreign dirs in the
 * state area. Trust first: an unconfirmed remote is a WARN in tools and every
 * probe is skipped, so it makes zero ssh calls.
 */
async function sshRemoteChecks(area: DoctorArea, manifest: Manifest | undefined, io: CollectorInput, list: () => Promise<SandboxInventory>): Promise<DoctorCheck[]> {
  const remotes = Object.entries(manifest?.remotes ?? {});
  if (remotes.length === 0) return [];
  const trust = readRemoteTrust(io.globalStorageDir);
  if (area === 'tools') {
    const out: DoctorCheck[] = [];
    for (const [name, def] of remotes) {
      if (!isRemoteTrusted(trust, name, def)) {
        out.push(...checkSshRemotes([{ name, trusted: false }]));
        continue;
      }
      const preflight = await io.remote.preflight(name, def, remoteCore(manifest, name));
      out.push(...checkSshRemotes([{ name, trusted: true, preflight }]));
    }
    return out;
  }
  if (area !== 'state') return [];

  const inventory = await list();
  const out: DoctorCheck[] = [];
  for (const [name, def] of remotes) {
    // An unconfirmed remote is reported by the tools area; the state area makes no ssh call for it.
    if (!isRemoteTrusted(trust, name, def)) continue;
    if (io.remoteContext.installId === undefined || io.remoteContext.projectRoot === '') {
      out.push(...checkRemoteDiskFacts([{ remote: name, error: `ssh ${name}: install id missing` }]));
      continue;
    }
    const [disk, ages, foreign] = await Promise.all([io.remote.disk(name, def), io.remote.workspaces(name, def), io.remote.foreign(name, def)]);
    out.push(...checkRemoteDiskFacts([('error' in disk ? { remote: name, error: disk.error } : { remote: name, ...disk }) as RemoteDiskFact]));
    if (!('error' in ages)) out.push(...checkStaleRemoteWorkspaces(staleFacts(name, inventory.sandboxes, ages)));
    const foreignFacts: ForeignRemoteWorkspaceFact[] = foreign.dirs.map((d) => ({ remote: name, name: d.name, ageDays: d.ageDays, sizeKb: d.sizeKb }));
    out.push(...checkForeignRemoteWorkspaces({ dirs: foreignFacts, errors: foreign.error === undefined ? [] : [foreign.error] }));
  }
  return out;
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

/** Lockfile repos of a sandbox-backed manifest that declare no `sandbox.setup` (host repo; the lockfile is committed). */
function sandboxSetupChecks(manifest: Manifest | undefined): DoctorCheck[] {
  const selected = selectedSandboxBackends(manifest?.agentBackends);
  if (!manifest || selected.length === 0) return [];
  const repos = Object.entries(manifest.repositories).map(([name, r]) => ({
    name,
    hasSetup: Boolean(r.sandbox?.setup),
    hasLockfile: LOCKFILES.some((f) => existsSync(join(r.repoPath, f))),
  }));
  return checkSandboxSetupDeclared(selected, repos);
}

/** Selected backend status and sandbox disk use (arch:AC-32); only with a sandbox backend, and only the checks of `area`. */
async function sandboxBackendChecks(area: DoctorArea, manifestPath: string | undefined, manifest: Manifest | undefined, io: CollectorInput, list: () => Promise<SandboxInventory>): Promise<DoctorCheck[]> {
  const selected = selectedSandboxBackends(manifest?.agentBackends);
  if (manifestPath === undefined || selected.length === 0) return [];
  const [probes, inv] = await Promise.all([io.probe.backends(wantedBackends(manifest?.agentBackends)), list()]);
  const docker = inv.sandboxes.filter((s) => s.runner === 'docker').length > 0 ? await io.probe.dockerDisk() : undefined;
  const dockerMemBytes = selected.includes('docker') ? await io.probe.dockerMemory?.() : undefined;
  const images = selected.includes('docker') ? await io.probe.dockerImageDisk?.() : undefined;
  return checkSandboxBackends({ selected, ...probes, sandboxCount: inv.sandboxes.length, diskBytes: docker, dockerMemBytes, ...images })
    .filter((c) => c.area === area);
}

export type GitHealthProbe = (name: string, repoPath: string) => GitRepoHealth | undefined;

/** Bytes per direct child of the storage root (`dirname(dbPath)`); injected by tests. */
export type StorageUsageProbe = (root: string) => StorageUsage;

interface CollectorInput {
  readonly manifestPath: string | undefined;
  readonly gitHealth: GitHealthProbe;
  readonly listSandboxes: ListSandboxes;
  readonly probe: SandboxProbe;
  readonly remote: RemoteProbe;
  readonly remoteContext: RemoteProbeContext;
  /** The dir of `ssh-trust.json` (globalStorage); the ssh checks read it once per area. */
  readonly globalStorageDir: string;
  readonly storageUsage?: StorageUsageProbe | undefined;
}

/** One entry per distinct git common dir of the manifest repositories (first name wins). */
function gitHealthChecks(manifest: Manifest | undefined, probe: GitHealthProbe, nowMs: number): DoctorCheck[] {
  if (!manifest) return [];
  const seen = new Set<string>();
  const repos: GitRepoHealth[] = [];
  for (const [name, r] of Object.entries(manifest.repositories)) {
    const h = probe(name, r.repoPath);
    if (!h || seen.has(h.commonDir)) continue;
    seen.add(h.commonDir);
    repos.push(h);
  }
  return checkGitHealth(repos, nowMs);
}

function collector(store: Store, dbPath: string, manifest: Manifest | undefined, manifestError: string | undefined, env: Readonly<Record<string, string | undefined>>, io: CollectorInput) {
  return async (areas: readonly DoctorArea[]): Promise<DoctorCheck[]> => {
    const out: DoctorCheck[] = [];
    const nowMs = Date.now();
    // ONE listing per run: the orphan, disk and stale checks share it (each remote listing is ssh round trips).
    let cached: Promise<SandboxInventory> | undefined;
    const list = (): Promise<SandboxInventory> => {
      if (io.manifestPath === undefined) return Promise.resolve({ sandboxes: [], errors: [] });
      cached ??= io.listSandboxes(io.manifestPath);
      return cached;
    };
    if (areas.includes('tools')) {
      out.push(...(await sandboxBackendChecks('tools', io.manifestPath, manifest, io, list)));
      out.push(...(await sshRemoteChecks('tools', manifest, io, list)));
      out.push(...checkTools({
        registry: dependencyRegistry('claude'), // the CLI has no host settings; claude is the default core
        probe: binaryExists, ready: commandSucceeds, readOutput: readCommandOutput, version: probes.toolVersion,
      }));
      // A karst-isolated run can relink the user's global claude into karst
      // storage; warn and name the relink, never rewrite it (@arch:AC-17).
      out.push(checkClaudeInstall(claudeLinkProbe(dbPath, {
        homeDir: homedir(),
        pathExists: probes.pathExists,
        linkExists: probes.linkExists,
        readLink: probes.readLink,
        realpath: probes.realpath,
        resolveCommand: probes.resolveCommand,
        env,
      })));
      // Only when agy is installed: its headless review/UAT lanes need allow-rules karst cannot own.
      if (binaryExists('agy')) {
        const settingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
        out.push(...checkAgyPermissions({ settingsPath, allow: readAgyAllowRules(settingsPath) }));
      }
      out.push(...checkInotifyWatches({
        platform: process.platform,
        maxUserWatches: probes.maxUserWatches,
        countInotifyWatches: () => probes.countInotifyWatches(),
      }));
    }
    if (areas.includes('manifest')) {
      out.push(...sandboxSetupChecks(manifest));
      const live = new Set((store.db.prepare("SELECT pid FROM servers WHERE status = 'running' AND pid IS NOT NULL").all() as { pid: number }[]).map((r) => r.pid));
      const envProbe = nodeEnvProbe(io.manifestPath ? dirname(io.manifestPath) : undefined);
      out.push(...checkManifest({
        manifest, ...(manifestError ? { manifestError } : {}),
        pathExists: probes.pathExists, isGitRepo: probes.isGitRepo, branchExists: probes.branchExists, binaryResolves: probes.binaryResolves,
        hasRemote: envProbe.hasRemote, fileExists: envProbe.fileExists,
        portHolder: (port) => { const pids = probes.listeningPids(port); return pids.length === 0 ? 'free' : pids.every((p) => live.has(p)) ? 'karst' : 'foreign'; },
      }));
    }
    if (areas.includes('state')) {
      out.push(...checkState(stateProbes(store, dbPath)));
      // The storage root is the store file's directory. `':memory:'` would resolve
      // to '.', so without an injected probe it reports an empty usage rather than
      // walking the whole checkout.
      const usage = io.storageUsage
        ? io.storageUsage(dirname(dbPath))
        : dbPath === ':memory:'
          ? { totalBytes: 0, entries: [], partial: false }
          : probes.storageUsage(dirname(dbPath));
      out.push(checkStorage(usage));
      out.push(...checkStuckTickets(stuckProbes(store, nowMs)));
      out.push(...(await sandboxOrphanChecks(store, io.manifestPath, manifest, list)));
      out.push(...(await sandboxBackendChecks('state', io.manifestPath, manifest, io, list)));
      out.push(...(await sshRemoteChecks('state', manifest, io, list)));
      out.push(...gitHealthChecks(manifest, io.gitHealth, nowMs));
    }
    if (areas.includes('wiring')) {
      out.push(...checkWiring({ karstCli: env.KARST_CLI ?? process.argv[1], isRunnableJsFile: runnableJs }));
    }
    return out;
  };
}

/** `karst doctor` — read-only unless `--fix`. Throws `DoctorExit` so main sets the exit code. */
export async function runDoctorCommand(
  store: Store,
  dbPath: string,
  manifestPath: string | undefined,
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  listSandboxes: ListSandboxes = listSandboxesNode,
  probe: SandboxProbe = SANDBOX_PROBE_NODE,
  gitHealth: GitHealthProbe = probes.gitHealthProbe,
  storageUsage?: StorageUsageProbe,
  ssh: SshProcess = NODE_SSH_PROCESS,
): Promise<never> {
  const args = parseDoctorArgs(rest);
  let manifest: Manifest | undefined;
  let manifestError: string | undefined;
  if (manifestPath) {
    try { manifest = loadManifestWithDiagnostics(manifestPath).manifest; }
    catch (e) { manifestError = (e as Error).message; }
  }
  const globalStorageDir = dirname(dbPath);
  // The ssh listing needs the same globalStorage (install id + trust) and the manifest's remotes; a test lister ignores the context.
  const listWithSsh: ListSandboxes = (projectRoot) =>
    listSandboxes(projectRoot, { globalStorageDir, remotes: manifest?.remotes });
  // Read only: a host step never creates the install id (D826). A missing one lists no ssh remote.
  const installId = manifest?.remotes === undefined || Object.keys(manifest.remotes).length === 0
    ? undefined
    : await readExistingInstallId(globalStorageDir).catch(() => undefined);
  const remoteContext: RemoteProbeContext = {
    projectRoot: manifestPath ?? '',
    installId,
    trustDir: globalStorageDir,
    controlDir: sshControlDir(),
  };
  const report = await runDoctor({
    areas: args.areas, fix: args.fix,
    ...(args.only.length > 0 ? { only: args.only } : {}),
    collect: collector(store, dbPath, manifest, manifestError, env, {
      manifestPath, listSandboxes: listWithSsh, probe, gitHealth, storageUsage,
      remote: remoteProbeFor(ssh, remoteContext), remoteContext, globalStorageDir,
    }),
    effects: fixEffects(store),
  });
  throw new DoctorExit(args.json ? JSON.stringify(report) : renderDoctorText(report), report.exitCode);
}
