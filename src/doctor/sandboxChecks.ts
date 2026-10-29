import type { BackendStatus } from '../agent/effectiveBackend.js';
import type { DoctorCheck } from './types.js';

/** Disk warning threshold for karst sandboxes (a constant, not config). */
export const SANDBOX_DISK_WARN_BYTES = 10e9;

export interface SandboxCheckInput {
  /** The sandbox backends some core selects; sbx and docker can both be on. */
  readonly selected: readonly ('sbx' | 'docker')[];
  readonly sbx: BackendStatus;
  readonly docker: BackendStatus;
  readonly sandboxCount: number;
  /** Approximate bytes used by this project's sandboxes; undefined when unknown. */
  readonly diskBytes: number | undefined;
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
  const out: DoctorCheck[] = input.selected.map((backend) => backendCheck(backend, backend === 'sbx' ? input.sbx : input.docker));
  if (input.selected.includes('docker') && input.dockerMemBytes !== undefined) out.push(memoryCheck(input.dockerMemBytes));
  if (input.sandboxCount > 0) out.push(diskCheck(input.sandboxCount, input.diskBytes));
  return out;
}

function backendCheck(backend: 'sbx' | 'docker', status: BackendStatus): DoctorCheck {
  return status.ok
    ? { id: `tools.sandbox-${backend}`, area: 'tools', status: 'ok', detail: `${backend} sandbox backend ready` }
    : {
        id: `tools.sandbox-${backend}`,
        area: 'tools',
        status: 'warn',
        detail: `${backend} backend unavailable: sessions run prompted on host (${status.reason})`,
        fix: { tier: 'report', summary: `${backend} backend unavailable`, nextStep: status.reason },
      };
}

function memoryCheck(bytes: number): DoctorCheck {
  const gb = (bytes / 2 ** 30).toFixed(1);
  const low = bytes < DOCKER_MEM_WARN_BYTES;
  return {
    id: 'tools.docker-memory',
    area: 'tools',
    status: low ? 'warn' : 'ok',
    detail: `Docker VM memory ${gb} GB`,
    ...(low
      ? { fix: { tier: 'report' as const, summary: 'Docker VM has under 8 GB: sandbox setup can be OOM-killed (exit 137)', nextStep: 'raise Docker Desktop → Settings → Resources → Memory to 8 GB or more' } }
      : {}),
  };
}

function diskCheck(count: number, bytes: number | undefined): DoctorCheck {
  const noun = count === 1 ? 'sandbox' : 'sandboxes';
  const size = bytes === undefined ? 'size unknown' : `~${formatGb(bytes)}`;
  const over = bytes !== undefined && bytes > SANDBOX_DISK_WARN_BYTES;
  return {
    id: 'state.sandbox-disk',
    area: 'state',
    status: over ? 'warn' : 'ok',
    detail: `${count} ${noun}, ${size}`,
    ...(over
      ? { fix: { tier: 'report' as const, summary: 'sandboxes use over 10 GB', nextStep: 'remove finished sandboxes from the dashboard or run "Karst: Clean Up Orphan Sandboxes"' } }
      : {}),
  };
}

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
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
export function checkSandboxSetupDeclared(selected: readonly ('sbx' | 'docker')[], repos: readonly SetupRepoFact[]): DoctorCheck[] {
  if (selected.length === 0) return [];
  return repos
    .filter((r) => r.hasLockfile && !r.hasSetup)
    .map((r) => ({
      id: `manifest.sandbox-setup.${r.name}`,
      area: 'manifest' as const,
      status: 'warn' as const,
      detail: `repository "${r.name}" has a lockfile but no sandbox.setup; sandboxed runs start without installed dependencies`,
      fix: {
        tier: 'report' as const,
        summary: `repository "${r.name}" declares no sandbox.setup`,
        nextStep: "add `sandbox.setup: npm ci` (or your package manager's frozen install) under the repository in karst.yml",
      },
    }));
}
