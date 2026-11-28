import {
  inventorySshDeps, listRemoteSandboxes, parseSandboxContainerName, projectPrefix,
  type ProjectSandbox, type SshInventorySource,
} from '../agent/sandboxInventory.js';
import { probeRemoteWorkspaces } from '../agent/backendProbe.js';
import type { SbxProcess } from '../agent/sbx/sbxProcess.js';
import { sshControlDir } from '../agent/ssh/sshControlDir.js';
import { NODE_SSH_PROCESS, type SshProcess } from '../agent/ssh/sshProcess.js';
import type { RemoteDef } from '../manifest/types.js';
import type { AttributedRow } from './resourceInventory.js';
import { remoteWorkspaceFacts, remoteWorkspaceKey, remoteWorkspaceRows, type RemoteWorkspaceProbeFacts } from './remoteWorkspaces.js';

/**
 * One async sample of the docker containers karst owns. On macOS every
 * container runs inside the Docker VM, so the host `ps` tree only sees the
 * docker CLI client (~0%); `docker stats` is the only per-container reading.
 * It takes ~2 s, so this runs on the slow lane and on panel open — never inside
 * the 2 s fast tick (`@arch:RESMON-CONTAINERS`).
 */
export const CONTAINER_SAMPLE_TIMEOUT_MS = 8_000;

export interface ContainerStat {
  name: string;
  /** Percent of TOTAL host capacity (docker's per-core sum / cores); null when unparsable. */
  cpuPct: number | null;
  rssBytes: number;
}

export type ContainerSample =
  | { ok: true; stats: ContainerStat[] }
  | { ok: false; reason: 'daemon-down' | 'timeout' | 'no-docker' };

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** `12.3MiB / 1.9GiB` → bytes of the used half, or null. */
export function parseMemUsage(value: string): number | null {
  const m = /^\s*([0-9.]+)\s*([a-zA-Z]+)/.exec(value.split('/')[0] ?? '');
  const unit = m ? UNIT_BYTES[m[2]!.toLowerCase()] : undefined;
  if (!m || unit === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.round(n * unit) : null;
}

/** Parse `docker stats --no-stream --format '{{json .}}'` output (one JSON object per line). */
export function parseDockerStats(stdout: string, cpuCoreCount: number): ContainerStat[] {
  const cores = Math.max(1, Math.floor(cpuCoreCount));
  const stats: ContainerStat[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let raw: { Name?: unknown; CPUPerc?: unknown; MemUsage?: unknown };
    try {
      raw = JSON.parse(line) as typeof raw;
    } catch {
      continue;
    }
    if (typeof raw.Name !== 'string' || typeof raw.MemUsage !== 'string') continue;
    const rss = parseMemUsage(raw.MemUsage);
    if (rss === null) continue;
    const cpu = typeof raw.CPUPerc === 'string' ? Number.parseFloat(raw.CPUPerc) : Number.NaN;
    stats.push({
      name: raw.Name,
      cpuPct: Number.isFinite(cpu) ? Math.round(cpu / cores) : null,
      rssBytes: rss,
    });
  }
  return stats;
}

/** `NODE_SBX_PROCESS` resolves a spawn failure (ENOENT) to this code. */
const NOT_INSTALLED = 127;
const TIMED_OUT = Symbol('timeout');

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve(TIMED_OUT);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work(ctl.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Remote workspaces as Resources rows (D824, edits 7 and 12): the remote, its
 * state (with the age since the last launch when stopped) and its disk in the
 * label, with `cost: null` so it never counts toward host memory pressure or
 * the totals. `probes` is keyed by `remote/name` from a trusted probe; absent =
 * `disk unknown` and no age.
 */
export function sampleRemoteWorkspaces(
  sandboxes: readonly ProjectSandbox[],
  probes?: ReadonlyMap<string, RemoteWorkspaceProbeFacts>,
): AttributedRow[] {
  return remoteWorkspaceRows(remoteWorkspaceFacts(sandboxes, probes));
}

/** One remote-workspace sample: rows per remote that listed, and the remotes whose listing failed. */
export interface RemoteWorkspaceSample {
  readonly rows: ReadonlyMap<string, readonly AttributedRow[]>;
  readonly failed: ReadonlySet<string>;
}

/**
 * List this project's workspaces on every declared remote (ssh only, trust
 * first) and turn them into Resources rows, with each workspace's `du -sk`
 * disk. A remote whose listing failed is in
 * `failed`, so the caller keeps its previous rows. A per-remote failure never
 * throws; only an unexpected fault does, and the caller logs it.
 */
export async function sampleProjectRemoteWorkspaces(
  source: SshInventorySource | undefined,
  projectRoot: string | undefined,
): Promise<RemoteWorkspaceSample> {
  const deps = inventorySshDeps(source);
  const remotes = Object.keys(deps.remotes ?? {});
  if (projectRoot === undefined || remotes.length === 0) return { rows: new Map(), failed: new Set() };
  const inv = await listRemoteSandboxes({ projectRoot, ...deps });
  const failed = new Set(remotes.filter((r) => inv.errors.some((e) => e.startsWith(`ssh ${r}:`))));
  const listed = remotes.filter((r) => !failed.has(r));
  const rows = new Map(await Promise.all(listed.map(async (r) => {
    const boxes = inv.sandboxes.filter((s) => s.remote === r);
    const probes = boxes.length === 0 ? undefined : await remoteProbes(r, deps.remotes![r]!, { ...deps, projectRoot });
    return [r, sampleRemoteWorkspaces(boxes, probes)] as const;
  })));
  return { rows, failed };
}

/**
 * The `du -sk` and the last-launch age of each workspace on one listed remote,
 * keyed by `remote/name`. The probe checks trust again; a failed probe gives no
 * facts, so the rows say `disk unknown` and the listing still counts (the remote answered).
 */
async function remoteProbes(
  remote: string,
  def: RemoteDef,
  deps: { readonly projectRoot: string; readonly installId?: string; readonly trustDir?: string; readonly ssh?: SshProcess; readonly controlDir?: string; readonly warn?: (message: string) => void },
): Promise<ReadonlyMap<string, RemoteWorkspaceProbeFacts> | undefined> {
  if (deps.installId === undefined || deps.trustDir === undefined) return undefined;
  const probe = await probeRemoteWorkspaces(deps.ssh ?? NODE_SSH_PROCESS, remote, def, {
    projectRoot: deps.projectRoot, installId: deps.installId, trustDir: deps.trustDir, controlDir: deps.controlDir ?? sshControlDir(),
  });
  if ('error' in probe) {
    deps.warn?.(`${probe.error} (workspace sizes)`);
    return undefined;
  }
  return new Map(probe.map((w) => [remoteWorkspaceKey(remote, w.name), { sizeKb: w.sizeKb, ageDays: w.ageDays }] as const));
}

export async function sampleContainers(deps: {
  docker: SbxProcess;
  projectRoot: string;
  /** `servers.container` names of running dev-server containers (not under the sandbox prefix). */
  serverContainers: readonly string[];
  cpuCoreCount: number;
  timeoutMs?: number;
}): Promise<ContainerSample> {
  const { docker, projectRoot, serverContainers, cpuCoreCount } = deps;
  const result = await withTimeout(async (signal) => {
    const ps = await docker.run(
      'docker',
      ['ps', '--filter', `name=${projectPrefix(projectRoot)}`, '--format', '{{.Names}}'],
      { signal },
    );
    if (ps.code === NOT_INSTALLED) return NOT_INSTALLED;
    if (ps.code !== 0) return null;
    const sandboxNames = ps.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((n) => n !== '' && parseSandboxContainerName(n, projectRoot) !== undefined);
    const names = [...new Set([...sandboxNames, ...serverContainers])];
    if (names.length === 0) return [] as ContainerStat[];
    const out = await docker.run(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}', ...names],
      { signal },
    );
    return out.code === 0 ? parseDockerStats(out.stdout, cpuCoreCount) : null;
  }, deps.timeoutMs ?? CONTAINER_SAMPLE_TIMEOUT_MS);
  if (result === TIMED_OUT) return { ok: false, reason: 'timeout' };
  if (result === NOT_INSTALLED) return { ok: false, reason: 'no-docker' };
  if (result === null) return { ok: false, reason: 'daemon-down' };
  return { ok: true, stats: result };
}
