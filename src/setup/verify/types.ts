import type { Manifest } from '../../manifest/types.js';
import type { CodedWarning } from '../../manifest/warningCode.js';
import type { ReadinessItem } from '../readiness/types.js';

/** The fixed checklist: P1-P6 run before consent on a copy; A1-A3 run after the apply. */
export type StepId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'A1' | 'A2' | 'A3';
/** `info` is a step that cannot fail for this proposal (for example, a command that is not dry-run). */
export type StepStatus = 'ok' | 'fail' | 'skipped' | 'info';

export interface VerifyStep {
  id: StepId;
  label: string;
  status: StepStatus;
  detail: string;
}

/** Readiness item states a copy can show: `pending` items need the real machine (git, remote, worktree, services, cores). */
export type SnapshotStatus = 'ok' | 'warn' | 'fail' | 'pending';
export type ItemSnapshot = ReadonlyMap<string, SnapshotStatus>;

export type ItemChangeKind = 'cleared' | 'introduced' | 'added' | 'removed';
export interface ItemChange {
  id: string;
  kind: ItemChangeKind;
}

export interface VerifyResult {
  /** True when no step failed. */
  ok: boolean;
  steps: VerifyStep[];
  /** The host's own item changes (sorted by id). */
  changes: ItemChange[];
  /** The ids of the `cleared` changes: what a proposal's `clears` must equal. */
  clears: string[];
  /** sha256 of the karst.yml text the checklist ran on; null when the file did not exist. */
  pinnedSha256: string | null;
}

export type LoadOutcome =
  | { ok: true; manifest: Manifest; codedWarnings: readonly CodedWarning[] }
  | { ok: false; error: string };

export interface LoadOptions {
  /** Absolute paths a patch would create. A file probe reports them as present. */
  createdFiles?: readonly string[];
}

export interface GitApplyOutcome {
  ok: boolean;
  error?: string;
}

/** The facts the pure checklist needs from the machine, injected. */
export interface VerifyDeps {
  /** The karst.yml this host writes. */
  manifestPath: string;
  /** The current karst.yml text; undefined when the file does not exist. */
  readCurrentText: () => string | undefined;
  /** Parse, migrate, validate and resolve `text` with file probes rooted at the manifest directory. */
  loadText: (text: string, options?: LoadOptions) => LoadOutcome;
  /** `git apply --check` in `cwd`. */
  gitApplyCheck: (cwd: string, patch: string) => Promise<GitApplyOutcome>;
}

/** What A2 needs: the real readiness items, re-run on the real files. */
export interface RecheckDeps {
  recheck: (ids: readonly string[]) => Promise<readonly ReadinessItem[]>;
}

/** The host-side record of one proposal: authoritative, unlike the outbox ledger that the agent can write. */
export interface VerifyRecord {
  id: string;
  kind: 'manifest' | 'change';
  status: 'verified' | 'unverified' | 'refused';
  steps: VerifyStep[];
  changes: ItemChange[];
  pinnedSha256: string | null;
  at: string;
}
