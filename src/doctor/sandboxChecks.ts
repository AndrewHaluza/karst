import type { BackendStatus } from '../agent/effectiveBackend.js';
import { PRUNE_CACHE_HINT, REMOVE_IMAGES_HINT } from '../agent/docker/dockerCleanup.js';
import type { SshPreflightFacts } from '../agent/ssh/sshPreflight.js';
import { plural } from '../model/notifyText.js';
import { formatDoctorBytes } from './formatBytes.js';
import type { DoctorCheck } from './types.js';

/** Re-exported so a caller can name the facts a remote check reports without reaching into the runner. */
export type { SshPreflightFacts };

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

/** A remote workspace stopped this long is disk the user probably forgot about (edit 12). */
export const STALE_REMOTE_WORKSPACE_DAYS = 14;

/** The result of one trusted remote's preflight, or the reason it did not run. */
export interface SshRemoteFact {
  readonly name: string;
  /** `isRemoteTrusted` said yes: an unconfirmed remote gets no ssh call at all (D553 C1). */
  readonly trusted: boolean;
  /** Present for a trusted remote: the D554 preflight's answer. */
  readonly preflight?: { readonly ok: true; readonly facts: SshPreflightFacts; readonly warnings: readonly string[] } | { readonly ok: false; readonly reason: string };
}

/** `tools.sandbox-ssh-<remote>`: the D554 preflight, report-only, warn + reason as the fix hint. */
export function checkSshRemotes(remotes: readonly SshRemoteFact[]): DoctorCheck[] {
  return remotes.map((r) => {
    const title = `Sandbox remote (${r.name})`;
    const id = `tools.sandbox-ssh-${r.name}`;
    if (!r.trusted) {
      return {
        id,
        area: 'tools',
        status: 'warn',
        title,
        detail: `ssh ${r.name}: not confirmed (confirm it in the editor)`,
        fix: { tier: 'report', summary: `ssh remote '${r.name}' is not confirmed`, nextStep: 'confirm it in the editor' },
      };
    }
    const preflight = r.preflight;
    if (preflight === undefined) {
      return { id, area: 'tools', status: 'skipped', title, detail: `ssh ${r.name}: preflight did not run` };
    }
    if (!preflight.ok) {
      return {
        id,
        area: 'tools',
        status: 'warn',
        title,
        detail: preflight.reason,
        fix: { tier: 'report', summary: `ssh remote '${r.name}' is not usable`, nextStep: preflight.reason },
      };
    }
    if (preflight.warnings.length > 0) {
      return {
        id,
        area: 'tools',
        status: 'warn',
        title,
        detail: preflight.warnings.join('; '),
        fix: { tier: 'report', summary: `ssh remote '${r.name}' works with a warning`, nextStep: preflight.warnings.join('; ') },
      };
    }
    const f = preflight.facts;
    return {
      id,
      area: 'tools',
      status: 'ok',
      title,
      detail: `ssh ${r.name} ready (git ${f.git}, node ${f.node}, ${f.freeMb === null ? 'free disk unknown' : `${String(f.freeMb)} MB free`})`,
    };
  });
}

/** One trusted remote's disk reading (`du -sk` over this install's workspaces only, and `df`). */
export type RemoteDiskFact =
  | { readonly remote: string; readonly workspaces: number; readonly usedKb: number | undefined; readonly freeKb: number | undefined }
  | { readonly remote: string; readonly error: string };

const KIB = 1024;

/** `state.sandbox-disk.<remote>`: report-only, so a full remote cannot silently pass. */
export function checkRemoteDiskFacts(facts: readonly RemoteDiskFact[]): DoctorCheck[] {
  return facts.map((fact) => {
    const title = `Remote sandbox disk (${fact.remote})`;
    const id = `state.sandbox-disk.${fact.remote}`;
    if ('error' in fact) {
      return { id, area: 'state', status: 'warn', title, detail: fact.error, fix: { tier: 'report', summary: `cannot read the disk of ${fact.remote}`, nextStep: fact.error } };
    }
    const size = fact.usedKb === undefined ? 'size unknown' : `~${formatDoctorBytes(fact.usedKb * KIB)}`;
    const free = fact.freeKb === undefined ? 'free disk unknown' : `${formatDoctorBytes(fact.freeKb * KIB)} free`;
    const over = fact.usedKb !== undefined && fact.usedKb * KIB > SANDBOX_DISK_WARN_BYTES;
    return {
      id,
      area: 'state',
      status: over ? 'warn' : 'ok',
      title,
      detail: `ssh ${fact.remote}: ${plural(fact.workspaces, 'workspace', 'workspaces')}, ${size}, ${free}`,
      ...(over
        ? { fix: { tier: 'report' as const, summary: `sandboxes on ${fact.remote} use over 10 GB`, nextStep: 'remove finished remote workspaces from the dashboard or run "Karst: Clean Up Orphan Sandboxes"' } }
        : {}),
    };
  });
}

/** One stopped ssh workspace with its age and size (the doctor's stale check input). */
export interface RemoteWorkspaceFact {
  readonly remote: string;
  readonly name: string;
  /** The ticket of the listed workspace: the Remove action removes this ticket's sandbox. */
  readonly ticketId: number;
  readonly state: 'running' | 'stopped';
  /** Whole days since `<ws>/env/env.sh` was last written. */
  readonly ageDays: number;
  readonly sizeKb: number;
}

/** `state.sandbox-stale.<remote>.<name>`: a stopped workspace older than 14 days, never removed automatically. */
export function checkStaleRemoteWorkspaces(workspaces: readonly RemoteWorkspaceFact[]): DoctorCheck[] {
  return workspaces
    .filter((w) => w.state === 'stopped' && w.ageDays > STALE_REMOTE_WORKSPACE_DAYS)
    .map((w) => ({
      id: `state.sandbox-stale.${w.remote}.${w.name}`,
      area: 'state' as const,
      status: 'warn' as const,
      title: 'Stale remote workspace',
      detail: `ssh ${w.remote}: ${w.name} stopped ${String(w.ageDays)} days, ${formatDoctorBytes(w.sizeKb * KIB)}`,
      // Remove runs the normal guarded removal (sync first, confirm); karst never removes it automatically.
      fix: {
        tier: 'action' as const,
        summary: 'stale remote workspace',
        label: 'Remove',
        action: { kind: 'remove-sandbox' as const, ticketId: w.ticketId },
        nextStep: `open the dashboard and choose "Remove sandbox" for ${w.name} on ${w.remote} (it syncs first and asks you to confirm); karst never removes it automatically`,
      },
    }));
}

/** One foreign `karst-*` dir of a trusted remote (another install's workspace). */
export interface ForeignRemoteWorkspaceFact {
  readonly remote: string;
  readonly name: string;
  readonly ageDays: number;
  readonly sizeKb: number;
}

/**
 * `state.sandbox-foreign.<remote>[.<name>]`: foreign dirs belong to another
 * install and are never a stray of this one, so they get their own ids.
 */
export function checkForeignRemoteWorkspaces(input: {
  readonly dirs: readonly ForeignRemoteWorkspaceFact[];
  readonly errors: readonly string[];
}): DoctorCheck[] {
  const out: DoctorCheck[] = input.dirs.map((d) => ({
    id: `state.sandbox-foreign.${d.remote}.${d.name}`,
    area: 'state' as const,
    status: 'warn' as const,
    title: 'Foreign remote workspace',
    detail: `ssh ${d.remote}: foreign workspace ${d.name} (another karst install), ${String(d.ageDays)} days old, ${formatDoctorBytes(d.sizeKb * KIB)}`,
    fix: {
      tier: 'report' as const,
      summary: 'foreign remote workspace',
      nextStep: 'run "Karst: Clean Up Foreign Remote Workspaces" and confirm (it lists every dir and needs a second confirm for commits no base ref holds)',
    },
  }));
  for (const error of input.errors) {
    const remote = /^ssh ([^:]+):/.exec(error)?.[1] ?? 'unknown';
    out.push({
      id: `state.sandbox-foreign.${remote}`,
      area: 'state',
      status: 'warn',
      title: 'Foreign remote workspaces',
      detail: error,
      fix: { tier: 'report', summary: `cannot list foreign workspaces on ${remote}`, nextStep: error },
    });
  }
  return out;
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
