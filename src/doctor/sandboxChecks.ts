import type { BackendStatus } from '../agent/effectiveBackend.js';
import { PRUNE_CACHE_HINT, REMOVE_IMAGES_HINT } from '../agent/docker/dockerCleanup.js';
import { plural } from '../model/notifyText.js';
import { formatDoctorBytes } from './formatBytes.js';
import type { DoctorCheck } from './types.js';

/**
 * Disk warning threshold for karst sandboxes (a constant, not config). Binary,
 * like the one byte formatter (DR-8): 10 GiB. A decimal 10e9 would warn at a
 * size the page prints as "9.3 GB", so the threshold and the number disagree.
 */
export const SANDBOX_DISK_WARN_BYTES = 10 * 2 ** 30;

export interface SandboxCheckInput {
  /** The sandbox backends some core selects; sbx, docker and ssh can all be on. */
  readonly selected: readonly ('sbx' | 'docker' | 'ssh')[];
  readonly sbx: BackendStatus;
  readonly docker: BackendStatus;
  readonly sandboxCount: number;
  /** Approximate bytes used by this project's sandboxes; undefined when unknown. */
  readonly diskBytes: number | undefined;
  /** Bytes of karst sandbox images and of the docker build cache; undefined when unknown or docker is not in use. */
  readonly imageBytes?: number | undefined;
  readonly cacheBytes?: number | undefined;
  /** The Docker VM's total memory; undefined when unknown or docker is not selected. */
  readonly dockerMemBytes?: number | undefined;
}

/** A VM below this OOM-kills `npm ci` once a couple of Playwright containers run beside it. */
export const DOCKER_MEM_WARN_BYTES = 8 * 2 ** 30;

/**
 * Status of every SELECTED sandbox backend plus sandbox count and disk use
 * (arch:AC-32). Report-only: an unavailable backend means sessions run prompted
 * on host, so it warns with the preflight reason as the fix hint.
 */
export function checkSandboxBackends(input: SandboxCheckInput): DoctorCheck[] {
  if (input.selected.length === 0) return [];
  // No ssh probe exists yet (T1387): the doctor reports only the runners it can check.
  const out: DoctorCheck[] = input.selected
    .filter((backend): backend is 'sbx' | 'docker' => backend !== 'ssh')
    .map((backend) => backendCheck(backend, backend === 'sbx' ? input.sbx : input.docker));
  if (input.selected.includes('docker') && input.dockerMemBytes !== undefined) out.push(memoryCheck(input.dockerMemBytes));
  const extra = (input.imageBytes ?? 0) + (input.cacheBytes ?? 0);
  if (input.sandboxCount > 0 || extra > 0) out.push(diskCheck(input.sandboxCount, input.diskBytes, input.imageBytes, input.cacheBytes));
  return out;
}

function backendCheck(backend: 'sbx' | 'docker', status: BackendStatus): DoctorCheck {
  const name = backend === 'sbx' ? 'Sbx' : 'Docker';
  const title = `Sandbox backend (${backend})`;
  return status.ok
    ? { id: `tools.sandbox-${backend}`, area: 'tools', status: 'ok', title, detail: `${name} sandbox backend ready` }
    : {
        id: `tools.sandbox-${backend}`,
        area: 'tools',
        status: 'warn',
        title,
        detail: `${name} backend unavailable: sessions run prompted on host (${status.reason})`,
        fix: { tier: 'report', summary: `${backend} backend unavailable`, nextStep: status.reason },
      };
}

function memoryCheck(bytes: number): DoctorCheck {
  const low = bytes < DOCKER_MEM_WARN_BYTES;
  return {
    id: 'tools.docker-memory',
    area: 'tools',
    status: low ? 'warn' : 'ok',
    title: 'Docker VM memory',
    detail: `Docker VM memory ${formatDoctorBytes(bytes)}`,
    ...(low
      ? { fix: { tier: 'report' as const, summary: 'Docker VM has under 8 GB: sandbox setup can be OOM-killed (exit 137)', nextStep: 'raise Docker Desktop → Settings → Resources → Memory to 8 GB or more' } }
      : {}),
  };
}

function diskCheck(count: number, bytes: number | undefined, imageBytes: number | undefined, cacheBytes: number | undefined): DoctorCheck {
  const size = bytes === undefined ? 'size unknown' : `~${formatDoctorBytes(bytes)}`;
  const parts = [`${plural(count, 'sandbox', 'sandboxes')}, ${size}`];
  if (imageBytes !== undefined) parts.push(`karst images ~${formatDoctorBytes(imageBytes)}`);
  if (cacheBytes !== undefined) parts.push(`build cache ~${formatDoctorBytes(cacheBytes)}`);
  const total = (bytes ?? 0) + (imageBytes ?? 0) + (cacheBytes ?? 0);
  const over = total > SANDBOX_DISK_WARN_BYTES;
  return {
    id: 'state.sandbox-disk',
    area: 'state',
    status: over ? 'warn' : 'ok',
    title: 'Sandbox disk usage',
    detail: parts.join(', '),
    ...(over
      ? { fix: { tier: 'report' as const, summary: 'sandboxes, karst images and build cache use over 10 GB', nextStep: `remove finished sandboxes from the dashboard or run "Karst: Clean Up Orphan Sandboxes"; remove old image tags with \`${REMOVE_IMAGES_HINT}\`; trim the build cache with \`${PRUNE_CACHE_HINT}\`` } }
      : {}),
  };
}

const UNITS: Readonly<Record<string, number>> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** The leading size of a `docker ps --size` cell (`12.3MB (virtual 1.2GB)`) in bytes. */
export function parseDockerSize(cell: string): number | undefined {
  const m = /^([0-9.]+)\s*([kKMGT]?B)/.exec(cell.trim());
  if (!m) return undefined;
  const unit = UNITS[m[2]!];
  return unit === undefined ? undefined : Number(m[1]) * unit;
}

export interface SetupRepoFact {
  readonly name: string;
  readonly hasLockfile: boolean;
  readonly hasSetup: boolean;
}

/** A sandboxed run starts from a fresh clone: a lockfile repo with no `sandbox.setup` has no deps (report-only). */
export function checkSandboxSetupDeclared(selected: readonly ('sbx' | 'docker' | 'ssh')[], repos: readonly SetupRepoFact[]): DoctorCheck[] {
  if (selected.length === 0) return [];
  return repos
    .filter((r) => r.hasLockfile && !r.hasSetup)
    .map((r) => ({
      id: `manifest.sandbox-setup.${r.name}`,
      area: 'manifest' as const,
      status: 'warn' as const,
      title: 'Sandbox setup',
      detail: `Repository "${r.name}" has a lockfile but no sandbox.setup; sandboxed runs start without installed dependencies`,
      fix: {
        tier: 'report' as const,
        summary: `repository "${r.name}" declares no sandbox.setup`,
        nextStep: "add `sandbox.setup: npm ci` (or your package manager's frozen install) under the repository in karst.yml",
      },
    }));
}
