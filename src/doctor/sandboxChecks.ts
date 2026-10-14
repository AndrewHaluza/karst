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
}

/**
 * Status of every SELECTED sandbox backend plus sandbox count and disk use
 * (arch:AC-32). Report-only: an unavailable backend means sessions run prompted
 * on host, so it warns with the preflight reason as the fix hint.
 */
export function checkSandboxBackends(input: SandboxCheckInput): DoctorCheck[] {
  if (input.selected.length === 0) return [];
  const out: DoctorCheck[] = input.selected.map((backend) => backendCheck(backend, backend === 'sbx' ? input.sbx : input.docker));
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
