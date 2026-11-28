/**
 * The UAT baseline pre-check (@arch:BASELINE-PRECHECK): before the
 * baseline-review block, the model looks at the ticket's re-recorded
 * screenshot baselines and approves ONLY the ones it judges clearly intended
 * and free of visible defects. Everything else — and every failure of this
 * module — leaves the entry waiting for the user exactly as today.
 *
 * Fail safe, by construction:
 * - only `added`/`modified` PNGs whose latest decision is not a rejection are
 *   ever sent (a deleted, non-PNG or earlier-rejected entry is never approved);
 * - only an explicit per-entry `approve` with a non-empty reason approves, and
 *   the path must match an entry exactly (unknown paths are ignored, a
 *   duplicate path approves neither copy);
 * - unreadable output, a timeout, a usage limit or any thrown error approves
 *   nothing FROM THAT BATCH; the other batches still run, and an abort stops
 *   the rest without discarding the approvals already recorded. This module
 *   never throws to its caller and never parks a stage.
 *
 * Above `PRECHECK_BATCH_SIZE` eligible entries the review is split into
 * batches, sent one at a time (host memory and image tokens, never parallel).
 * Each batch opens its own process run so the prompt metrics and token usage
 * of the pre-check are visible in the process history, and talks to git and
 * the filesystem through injected seams so it is unit-testable without a repo.
 * The Tester's core and model come from Settings; the only capability gate is
 * the catalog-tag check in `modelCanReadImages` (a model tagged `text-only`
 * skips, an untagged or unknown model runs). The pure prompt/schema/parser half
 * lives in `baselinePrecheckPrompt.ts`.
 */

import { mkdir, rm, writeFile as writeFileToDisk } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { AgentProvider } from '../../manifest/types.js';
import {
  GIT_TERMINATION_GRACE_MS,
  GIT_TIMEOUT_MS,
  runGitBytes,
  type GitBytesRunner,
} from '../../integrations/git.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';
import { nowIso } from '../../model/time.js';
import { baselineKey } from '../../store/baselineDecisions.js';
import type { Store } from '../../store/db.js';
import { finishProcessRun, openProcessRun } from '../../store/processRuns.js';
import { stageAttempt } from '../../store/stages.js';
import type { BaselineEntry } from './baselineReview.js';
import {
  BASELINE_PRECHECK_OUTPUT_SCHEMA,
  buildBaselinePrecheckPrompt,
  parseBaselinePrecheckAnswer,
  precheckLabel,
  type BaselinePrecheckTarget,
  type BaselinePrecheckTicket,
} from './baselinePrecheckPrompt.js';

export {
  BASELINE_PRECHECK_OUTPUT_SCHEMA,
  PRECHECK_CHANGED_PATHS_MAX,
  buildBaselinePrecheckPrompt,
  parseBaselinePrecheckAnswer,
  precheckLabel,
} from './baselinePrecheckPrompt.js';
export type {
  BaselinePrecheckPromptInput,
  BaselinePrecheckTarget,
  BaselinePrecheckTicket,
} from './baselinePrecheckPrompt.js';

/**
 * One image call is bounded: a prompt with more image pairs than this is too
 * long for most cores and fails as a unit, so the eligible entries are split
 * into batches of this size and sent one call at a time.
 */
export const PRECHECK_BATCH_SIZE = 40;

/**
 * Above this many eligible entries the pre-check is skipped: image tokens are
 * real money and a partial review still needs a full user pass, so karst never
 * pre-checks only the first few.
 */
export const MAX_PRECHECK_ENTRIES = 200;

/** The pre-check is a small image review; a hung core must not hold the stage for an hour. */
export const DEFAULT_PRECHECK_TIMEOUT_MS = 10 * 60 * 1_000;

/** A screenshot can exceed git's default 1 MiB output cap; 16 MiB is far beyond any baseline. */
const OLD_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

/** `.karst/` is git-excluded, so the temporary old images never dirty the worktree. */
const PRECHECK_DIR = '.karst/baseline-precheck';

const defaultGitBytes: GitBytesRunner = (args, cwd, options) =>
  runGitBytes(args, cwd, GIT_TIMEOUT_MS, OLD_IMAGE_MAX_BYTES, GIT_TERMINATION_GRACE_MS, options?.signal);

export interface BaselinePrecheckFs {
  /** Write one old image, creating its parent directories. */
  writeFile(absPath: string, data: Buffer): Promise<void>;
  /** Recursively remove one temporary run folder. */
  removeDir(absDir: string): Promise<void>;
}

const defaultFs: BaselinePrecheckFs = {
  writeFile: async (absPath, data) => {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFileToDisk(absPath, data);
  },
  removeDir: async (absDir) => {
    await rm(absDir, { recursive: true, force: true });
  },
};

export interface BaselinePrecheckDeps {
  /** Byte-preserving `git show` for the old images. */
  gitBytes?: GitBytesRunner;
  fs?: BaselinePrecheckFs;
  now?: () => string;
  /** The opening host pid; the store records it on the process run. */
  pid?: number;
}

export interface BaselinePrecheckInput {
  store: Store;
  ticketId: number;
  /** `uat.baselineReview.precheck`; false skips the whole pre-check. */
  enabled: boolean;
  /** The pending baseline entries (everything not approved yet). */
  entries: readonly BaselineEntry[];
  /** `latestBaselineDecisions` (or any map keyed by `baselineKey`). */
  decisions: ReadonlyMap<string, { decision: 'approved' | 'rejected' }>;
  ticket: BaselinePrecheckTicket;
  /** The branch's whole changed-file list (baseline images already left out). */
  changedPaths: readonly string[];
  /** The Tester's assignment and adapter; the pre-check runs as that process. */
  tester?: { assignment: ProcessAssignmentSnapshot; adapter: AgentAdapter };
  /**
   * The loaded model catalog (`catalog: () => modelCatalog` in the host), read
   * only to decide whether the Tester's model can read images. The UAT step
   * passes the bundled catalog when the host has none (this layer may not
   * value-import `agent/`).
   */
  catalog: () => ModelCatalog;
  debug?: (message: string) => void;
  onLiveOutput?: (chunk: HeadlessOutputChunk) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The stage run batch this pre-check belongs to, when one is open. */
  stageRunId?: number | null;
  /** The UAT attempt; defaults to the store's value. */
  attempt?: number;
}

export interface BaselinePrecheckApproval {
  repo: string;
  path: string;
  sha256: string;
  /** The model's own reason, raw; the UAT step prefixes `pre-check: `. */
  reason: string;
}

export interface BaselinePrecheckResult {
  /** The union of every finished batch's approvals; a failed batch contributes none. */
  approved: BaselinePrecheckApproval[];
  /**
   * Targets a model call actually received, including a failed or aborted
   * batch's (its call was started) but never a batch that never started.
   */
  sent: number;
  /** Batches whose call produced nothing usable (unreadable answer, timeout, usage limit, error). */
  failedBatches: number;
  /** Batches that opened a process run — the denominator of "every batch failed". */
  batches: number;
  /** The first failed batch's reason, for the block reason the user sees. */
  firstFailureReason?: string;
  /** Set when the whole pre-check did not run; the caller logs it once. */
  skippedReason?: string;
}

/**
 * The entries the pre-check may see: an added/modified PNG (extension matched
 * case-insensitively) whose latest decision is not a rejection. Never a
 * deletion, a non-PNG, or one the user already rejected.
 */
export function eligibleBaselineEntries(
  entries: readonly BaselineEntry[],
  decisions: ReadonlyMap<string, { decision: 'approved' | 'rejected' }>,
): BaselineEntry[] {
  return entries.filter(
    (entry) =>
      (entry.status === 'added' || entry.status === 'modified') &&
      entry.path.toLowerCase().endsWith('.png') &&
      decisions.get(baselineKey(entry.repo, entry.path))?.decision !== 'rejected',
  );
}

/**
 * Whether the Tester's model can read images, from the catalog's capability
 * tags only. The catalog is keyed by provider (the same id exists under more
 * than one core), so an id that is not found under THIS provider is unknown.
 *
 * Fail open by design: an unknown provider section, an unknown id, a model with
 * no tags (a CLI-discovered or custom model) and an empty tag list all read as
 * "may read images" — the prompt rule ("cannot see the pixels → human") and the
 * approve-only parser protect that case. Only a KNOWN tag list without `vision`
 * or `multimodal` (for example `text-only`) says the model cannot see them.
 */
export function modelCanReadImages(
  provider: AgentProvider,
  modelId: string | null | undefined,
  catalog: ModelCatalog,
): boolean {
  if (modelId === null || modelId === undefined || modelId === '') return true;
  const model = (catalog[provider] ?? []).find((option) => option.id === modelId);
  if (model === undefined) return true;
  const tags = model.tags;
  if (tags === undefined || tags.length === 0) return true;
  return tags.includes('vision') || tags.includes('multimodal');
}

/**
 * Run the pre-check. Never throws and never parks: a skipped pre-check says
 * why, and a failed one approves nothing so the stage blocks exactly as today.
 */
export async function precheckBaselines(
  input: BaselinePrecheckInput,
  deps: BaselinePrecheckDeps = {},
): Promise<BaselinePrecheckResult> {
  const debug = input.debug;
  const skipped = (reason: string): BaselinePrecheckResult => {
    debug?.(`[gate] uat baseline pre-check ticket ${input.ticketId}: skipped — ${reason}`);
    return { approved: [], sent: 0, failedBatches: 0, batches: 0, skippedReason: reason };
  };

  if (!input.enabled) return skipped('pre-check disabled');
  const tester = input.tester;
  if (tester === undefined) return skipped('no UAT tester');
  const catalog = input.catalog;
  // An unreadable catalog is an UNKNOWN capability, and unknown runs: the gate
  // never throws to its caller, exactly like every other failure here.
  let canReadImages: boolean;
  try {
    canReadImages = modelCanReadImages(tester.assignment.provider, tester.assignment.model, catalog());
  } catch {
    canReadImages = true;
  }
  if (!canReadImages) {
    return skipped(`model ${tester.assignment.model ?? '?'} cannot read images (catalog tags)`);
  }
  const eligible = eligibleBaselineEntries(input.entries, input.decisions);
  if (eligible.length === 0) return skipped('no eligible entries');
  if (eligible.length > MAX_PRECHECK_ENTRIES) {
    return skipped(`more than ${MAX_PRECHECK_ENTRIES} eligible entries`);
  }

  const gitBytes = deps.gitBytes ?? defaultGitBytes;
  const fs = deps.fs ?? defaultFs;
  const now = deps.now ?? nowIso;
  const batches: BaselineEntry[][] = [];
  for (let start = 0; start < eligible.length; start += PRECHECK_BATCH_SIZE) {
    batches.push(eligible.slice(start, start + PRECHECK_BATCH_SIZE));
  }

  /**
   * One batch: open its own process run, materialize its old images in a folder
   * of that run, send one call, and remove the folder in a `finally`. Never
   * throws: a failure closes the run and returns the reason instead.
   */
  const runBatch = async (
    batch: readonly BaselineEntry[],
    index: number,
  ): Promise<{ approved: BaselinePrecheckApproval[]; sent: number; failure?: string }> => {
    const run = openProcessRun(input.store, {
      ticketId: input.ticketId,
      stageKey: 'uat',
      processId: 'tester',
      attempt: input.attempt ?? stageAttempt(input.store, input.ticketId, 'uat'),
      stageRunId: input.stageRunId ?? null,
      agentName: tester.assignment.agentName ?? null,
      provider: tester.assignment.provider,
      model: tester.assignment.model ?? null,
      pid: deps.pid ?? process.pid,
      startedAt: now(),
      // `precheckEntries` is THIS batch's size; `precheckBatch` is its `i/n`.
      promptTelemetry: {
        precheckEntries: batch.length,
        precheckBatch: `${index + 1}/${batches.length}`,
      },
    });
    debug?.(
      `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} — ` +
        `${batch.length} eligible, process run ${run.id} opened ` +
        `(${tester.assignment.agentName ?? '?'}/${tester.assignment.provider})`,
    );

    const runRoots = new Set<string>();
    let closed = false;
    const finish = (status: 'passed' | 'failed' | 'interrupted', resultKind: string, detail?: string): void => {
      if (closed) return;
      closed = true;
      finishProcessRun(input.store, run.id, status, now(), resultKind, null, detail ?? null);
    };
    /** Targets this batch's call received; an unreadable old image is never sent. */
    let sent = 0;

    try {
      const targets: BaselinePrecheckTarget[] = [];
      for (const entry of batch) {
        if (entry.status !== 'added' && entry.status !== 'modified') continue;
        const root = join(entry.cwd, PRECHECK_DIR, String(run.id));
        runRoots.add(root);
        let oldImagePath: string | null = null;
        if (entry.status === 'modified') {
          const shown = await gitBytes(['show', `${entry.mergeBase}:${entry.path}`], entry.cwd);
          if (shown.exitCode !== 0 || shown.stdoutTruncated) {
            debug?.(
              `[gate] uat baseline pre-check ticket ${input.ticketId}: ${entry.repo}:${entry.path} ` +
                `has no readable old image (git show exit ${shown.exitCode}) — not sent`,
            );
            continue;
          }
          oldImagePath = join(root, 'old', entry.path);
          try {
            await fs.writeFile(oldImagePath, shown.stdout);
          } catch (error) {
            debug?.(
              `[gate] uat baseline pre-check ticket ${input.ticketId}: ${entry.repo}:${entry.path} ` +
                `old image could not be written (${collapseDiagnostic(String(error))}) — not sent`,
            );
            continue;
          }
        }
        targets.push({
          repo: entry.repo,
          path: entry.path,
          label: precheckLabel(entry.repo, entry.path),
          status: entry.status,
          newSha256: entry.newSha256,
          oldImagePath,
          newImagePath: join(entry.cwd, entry.path),
        });
      }

      if (targets.length === 0) {
        debug?.(
          `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} — ` +
            'no entry left to send, no approvals',
        );
        finish('passed', 'no-eligible-entries');
        return { approved: [], sent: 0 };
      }

      sent = targets.length;
      const prompt = buildBaselinePrecheckPrompt({ ticket: input.ticket, changedPaths: input.changedPaths, targets });
      const structured = tester.adapter.surfaces?.structuredOutput?.supported === true;
      debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} asking ` +
          `${targets.length} entr${targets.length === 1 ? 'y' : 'ies'}${structured ? ' with a structured answer' : ''} — ` +
          `${prompt.length} prompt chars`,
      );
      const result = await tester.adapter.runHeadless({
        prompt,
        cwd: batch[0]!.cwd,
        model: tester.assignment.model,
        effort: tester.assignment.effort,
        signal: input.signal,
        timeoutMs: input.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS,
        policy: 'uat-tester',
        ...(tester.assignment.context === 'minimal'
          ? { minimalContext: 'skills-and-subagents' as const }
          : {}),
        onOutput: input.onLiveOutput,
        ...(structured ? { outputSchema: BASELINE_PRECHECK_OUTPUT_SCHEMA } : {}),
        tracking: { callSite: 'uat-tester', ticketId: input.ticketId, processRunId: run.id },
      });

      const reasons = parseBaselinePrecheckAnswer(
        result.raw,
        targets.map((target) => target.label),
        result.finalMessage,
      );
      if (reasons === null) {
        debug?.(
          `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} ` +
            'unreadable answer — no approvals from it',
        );
        finish('passed', 'unreadable-output');
        return { approved: [], sent, failure: 'unreadable answer' };
      }
      const approved: BaselinePrecheckApproval[] = [];
      for (const target of targets) {
        const reason = reasons.get(target.label);
        if (reason === undefined) continue;
        approved.push({ repo: target.repo, path: target.path, sha256: target.newSha256, reason });
      }
      finish('passed', approved.length > 0 ? 'approved' : 'no-approvals');
      debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} — ` +
          `${approved.length} of ${targets.length} approved`,
      );
      return { approved, sent };
    } catch (error) {
      const detail = collapseDiagnostic(error instanceof Error ? error.message : String(error));
      if (input.signal?.aborted === true) {
        finish('interrupted', 'interrupted', detail);
        debug?.(
          `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} ` +
            'interrupted — no approvals from it',
        );
        // Not a failure: the run was stopped, and the caller reports it as such.
        return { approved: [], sent };
      }
      finish('failed', 'execution-failed', detail);
      debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: batch ${index + 1}/${batches.length} ` +
          `failed (${detail}) — no approvals from it`,
      );
      return { approved: [], sent, failure: detail };
    } finally {
      for (const root of runRoots) {
        try {
          await fs.removeDir(root);
        } catch (error) {
          debug?.(
            `[gate] uat baseline pre-check ticket ${input.ticketId}: could not remove ${root} ` +
              `(${collapseDiagnostic(String(error))})`,
          );
        }
      }
    }
  };

  const approved: BaselinePrecheckApproval[] = [];
  let sent = 0;
  let failedBatches = 0;
  let openedBatches = 0;
  let firstFailureReason: string | undefined;
  // Serial by design: host memory and image tokens, never parallel batches. A
  // failed batch never stops the ones after it; an abort stops all the rest.
  for (let index = 0; index < batches.length; index += 1) {
    if (input.signal?.aborted === true) {
      debug?.(
        `[gate] uat baseline pre-check ticket ${input.ticketId}: stopped — ` +
          `${batches.length - index} batch(es) not started`,
      );
      break;
    }
    openedBatches += 1;
    const batch = await runBatch(batches[index]!, index);
    sent += batch.sent;
    approved.push(...batch.approved);
    if (batch.failure !== undefined) {
      failedBatches += 1;
      firstFailureReason ??= batch.failure;
    }
  }

  // Only when no batch sent a single target is the whole review skipped: a
  // stopped run reports itself as interrupted instead, never as skipped.
  if (sent === 0 && input.signal?.aborted !== true) return skipped('no eligible entries');
  debug?.(
    `[gate] uat baseline pre-check ticket ${input.ticketId}: ${approved.length} of ${sent} approved` +
      `${failedBatches > 0 ? `, ${failedBatches} batch(es) failed` : ''} — done`,
  );
  return {
    approved,
    sent,
    failedBatches,
    batches: openedBatches,
    ...(firstFailureReason === undefined ? {} : { firstFailureReason }),
  };
}
