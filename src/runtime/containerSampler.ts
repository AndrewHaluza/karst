import { parseSandboxContainerName, projectPrefix } from '../agent/sandboxInventory.js';
import type { SbxProcess } from '../agent/sbx/sbxProcess.js';

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
