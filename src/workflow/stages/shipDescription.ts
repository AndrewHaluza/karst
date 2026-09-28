import { createHash } from 'node:crypto';
import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import { executionView } from '../../model/inside/agent.js';
import { type InsideProgressEvent } from '../../model/inside/progress.js';
import { nowIso } from '../../model/time.js';
import {
  fetchPrBody,
  updatePrBody,
  type ExistingPr,
  type GhRunner,
} from '../../integrations/github.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import {
  finalizeShipOperationIntent,
  finishShipRepoStep,
  markShipOperationApplied,
  openShipRepoStep,
  reconcileShipOperation,
  type ShipRun,
} from '../../store/shipRuns.js';
import {
  buildPrDescriptionPrompt,
  sanitizePrDescription,
  type PrDescriptionContext,
} from '../prDescription.js';
import { openStepWithPreparation, type ShipProgress } from './shipStore.js';

/**
 * PR-description generation and backfill for the ship stage (NDL-40 split):
 * the agent call that drafts a PR body, its durable `describe` step/process
 * run, and the "fill in a description only if the PR has none" backfill used
 * both when a PR is adopted and when `openPr` reports one existed already.
 * Pulled out of `ship.ts` because it is already fairly self-contained — it
 * touches the saga tables (via `shipStore.ts`'s `openStepWithPreparation`)
 * and the AI adapter, but none of the git/GitHub orchestration around it.
 */

/**
 * Ask the agent (cheap model) for a PR description; falls back to the title.
 *
 * The answer is sanitized, not trusted: an agent asked a chat-shaped question
 * answers with chat-shaped scaffolding (a "no PR open yet … copy-paste ready"
 * status line, a preamble, the whole body inside a code fence), and this text
 * goes straight into public GitHub metadata. `prDescription.ts` owns both halves
 * — the prompt, which hands the model the branch facts and asks for a clean
 * body, and the filter that enforces it.
 */
async function describePr(
  adapter: AgentAdapter,
  cwd: string,
  ctx: PrDescriptionContext,
  ticketId: number,
  processRunId?: number | null,
  model?: string,
  effort?: string,
): Promise<string> {
  const r = await adapter.runHeadless({
    prompt: buildPrDescriptionPrompt(ctx),
    cwd,
    model,
    effort,
    tracking: { callSite: 'pr-description', ticketId, processRunId: processRunId ?? undefined },
  });
  return sanitizePrDescription(r.raw, ctx.title);
}

/** Deterministic body fingerprint for describe-step reconciliation. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Run the description model call under a durable `describe` step and its
 * `pr-description` process run, so the AI execution has the same evidence every
 * other AI process carries.
 */
export async function generateDescription(
  store: Store,
  run: ShipRun,
  repo: string,
  adapter: AgentAdapter,
  cwd: string,
  ctx: PrDescriptionContext,
  ticketId: number,
  onProgress: ShipProgress,
  onInsideProgress: (event: InsideProgressEvent) => void = () => {},
  assignment?: ProcessAssignmentSnapshot,
): Promise<string> {
  onProgress({ repo, step: 'describe', status: 'run' });
  onInsideProgress({
    kind: 'active',
    ticketId,
    stage: 'ship',
    processId: 'pr-description',
    live: {
      status: 'run',
      label: 'Pull request description',
      detail: repo,
      // The chip a running headless AI step is entitled to show while it
      // runs, not only in the completed row afterward (869e-confusing-ui).
      ...(assignment
        ? {
            execution: executionView(
              assignment.provider,
              assignment.model ?? null,
              assignment.agentName,
            ),
          }
        : {}),
    },
  });
  const at = nowIso();
  const processRun = openProcessRun(store, {
    ticketId,
    stageKey: 'ship',
    processId: 'pr-description',
    attempt: run.attempt,
    // Task 3: the configured assignment is snapshotted into the run the moment
    // it opens — a later manifest edit never rewrites the identity that ran.
    agentName: assignment?.agentName ?? null,
    provider: assignment?.provider ?? null,
    model: assignment?.model ?? null,
    // v34: the host that owns the call, so `reconcileProcessRuns` can mark a
    // describe run killed by process death stale like every other process.
    pid: process.pid,
    startedAt: at,
  });
  const step = openShipRepoStep(store, {
    shipRunId: run.id,
    repo,
    step: 'describe',
    detail: 'generate',
    processRunId: processRun.id,
    startedAt: at,
  });
  try {
    const body = await describePr(
      adapter,
      cwd,
      ctx,
      ticketId,
      processRun.id,
      assignment?.model,
      assignment?.effort,
    );
    finishProcessRun(store, processRun.id, 'passed', nowIso());
    finishShipRepoStep(store, step.id, { status: 'passed', detail: 'generated', endedAt: nowIso() });
    onProgress({ repo, step: 'describe', status: 'pass' });
    // Retract the header, never `completed`: `pr-description` names no row
    // in the ship ledger (the real "Pull request" row is `id: 'pr'`, opened
    // by a LATER step), so a `completed` event here used to reuse that same
    // `id` and overlayProcesses merged it onto the real row — a finished
    // describe call briefly relabeled and passed the still-pending "Pull
    // request" row until the next snapshot corrected it (869e-confusing-ui).
    onInsideProgress({
      kind: 'cleared',
      ticketId,
      stage: 'ship',
      processId: 'pr-description',
    });
    return body;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    finishProcessRun(store, processRun.id, 'failed', nowIso());
    finishShipRepoStep(store, step.id, { status: 'failed', detail, endedAt: nowIso() });
    onInsideProgress({
      kind: 'cleared',
      ticketId,
      stage: 'ship',
      processId: 'pr-description',
    });
    throw err;
  }
}

/**
 * Say that the PR step found a PR rather than opening one, so the live view never
 * shows a plain `pass` for work that did not happen.
 */
export function noteReusedPr(repo: string, onProgress: ShipProgress): void {
  onProgress({
    repo,
    step: 'pr',
    status: 'note',
    detail: 'a PR for this branch already existed — reused it',
  });
}

/**
 * Give an adopted PR a description if — and only if — it has none.
 *
 * The asymmetry is the whole point. A PR opened by hand commonly has an empty
 * body and nothing else will ever fill it, so skipping the describe step
 * wholesale (what adoption used to do) leaves a permanently blank PR. But
 * overwriting prose a human wrote is unrecoverable, so anything gh reports as
 * non-empty is kept verbatim, and a body gh did NOT report (null) is treated as
 * "unknown", not as "empty" — a degraded probe must never authorize a write.
 *
 * Never throws: the PR is already open, which means ship's irreversible part
 * already succeeded. A refused edit is a note on a working ship, and ship has no
 * `failed` edge to park at anyway.
 */
export async function backfillDescription(
  gh: GhRunner,
  repo: string,
  cwd: string,
  existing: ExistingPr,
  buildBody: () => Promise<string>,
  onProgress: ShipProgress,
  saga?: { store: Store; run: ShipRun },
): Promise<void> {
  const note = (detail: string): void =>
    onProgress({ repo, step: 'describe', status: 'note', detail });

  if (existing.body === null) {
    note('existing PR description could not be read — left unchanged');
    return;
  }
  // Whitespace is not a description someone wrote — it is the same emptiness with
  // invisible characters in it.
  if (existing.body.trim() !== '') {
    note('existing PR already has a description — kept');
    return;
  }

  const body = await buildBody();

  // Durable describe step + intent around the body UPDATE: the pre-state is
  // the body as it was read, the intent is the exact prose about to be written,
  // so a crash between update and result can be reconciled by body hash.
  if (saga !== undefined) {
    const at = nowIso();
    const { stepId, intentId } = openStepWithPreparation(saga.store, {
      run: saga.run,
      repo,
      step: 'describe',
      operationKey: `${saga.run.id}:${repo}:describe`,
      preState: { step: 'describe', prUrl: existing.url, preBodyHash: bodyHash(existing.body) },
      detail: 'backfill',
      at,
    });
    finalizeShipOperationIntent(saga.store, intentId, {
      step: 'describe',
      prUrl: existing.url,
      preBodyHash: bodyHash(existing.body),
      intendedBody: body,
    }, at);
    const attempt = await updatePrBody(gh, existing.url, cwd, body);
    if (attempt.ok) {
      // Adopt only the exact intended prose; a third body is a human edit.
      const current = await fetchPrBody(gh, existing.url, cwd).catch(() => null);
      if (current !== null && bodyHash(current) === bodyHash(body)) {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso(), resolvedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'reconciled', { resolvedAt: nowIso() });
        finishShipRepoStep(saga.store, stepId, {
          status: 'passed',
          detail: 'existing PR had no description — filled in',
          endedAt: nowIso(),
        });
      } else if (current !== null) {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'ambiguous', {
          resolvedAt: nowIso(),
          detail: 'PR description updated, then edited — left as is',
        });
        finishShipRepoStep(saga.store, stepId, {
          status: 'note',
          detail: 'PR description updated, then edited — left as is',
          endedAt: nowIso(),
        });
      } else {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'ambiguous', {
          resolvedAt: nowIso(),
          detail: 'PR description updated but could not be verified — left as is',
        });
        finishShipRepoStep(saga.store, stepId, {
          status: 'note',
          detail: 'PR description updated but could not be verified — left as is',
          endedAt: nowIso(),
        });
      }
      onProgress({
        repo,
        step: 'describe',
        status: 'pass',
        detail: 'existing PR had no description — filled in',
      });
      return;
    }
    reconcileShipOperation(saga.store, intentId, 'failed', {
      resolvedAt: nowIso(),
      detail: attempt.reason,
    });
    finishShipRepoStep(saga.store, stepId, {
      status: 'failed',
      detail: `existing PR had no description — update failed: ${attempt.reason}`,
      endedAt: nowIso(),
    });
    note(`existing PR had no description — update failed: ${attempt.reason}`);
    return;
  }

  const attempt = await updatePrBody(gh, existing.url, cwd, body);
  if (attempt.ok) {
    onProgress({
      repo,
      step: 'describe',
      status: 'pass',
      detail: 'existing PR had no description — filled in',
    });
    return;
  }
  note(`existing PR had no description — update failed: ${attempt.reason}`);
}
