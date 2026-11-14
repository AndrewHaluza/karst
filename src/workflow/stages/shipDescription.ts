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
import { recordUsageLimitOpPark } from '../../store/usageLimitParks.js';
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
import {
  GATE_SET_CHANGED_LINE,
  PR_DESCRIPTION_OUTPUT_SCHEMA,
  parsePrDescriptionAnswer,
  renderNarrative,
} from '../prDescriptionAnswer.js';
import { headlessPreview } from '../../agent/headlessSpawn.js';
import { structuredOutputFormOf } from '../../agent/surfaces.js';
import { upsertDesignRulesSection, type ArchCitation } from '../../model/archCitations.js';
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

/** What one describe call produced: the body, and a note when the AI answer was not used. */
interface DescribeResult {
  body: string;
  note?: string;
}

/**
 * Ask the agent (cheap model) for the PR description DATA; code renders the body.
 *
 * The agent answers with one JSON object (`prDescriptionAnswer.ts`). Fallback
 * ladder, never a failed ship: text that is not JSON goes through the
 * sanitizer as before; JSON that fails validation yields the template body and
 * a describe-step note (the sanitizer would publish raw JSON in a public PR);
 * a failed agent call keeps the caller's path. `prDescription.ts` owns the
 * prompt and the sanitizer.
 */
async function describePr(
  adapter: AgentAdapter,
  cwd: string,
  ctx: PrDescriptionContext,
  ticketId: number,
  processRunId: number | null | undefined,
  model: string | undefined,
  effort: string | undefined,
  fallbackBody: (() => string) | undefined,
  debug: ((message: string) => void) | undefined,
): Promise<DescribeResult> {
  const form = structuredOutputFormOf(adapter);
  const r = await adapter.runHeadless({
    prompt: buildPrDescriptionPrompt(ctx, form),
    cwd,
    minimalContext: true,
    model,
    effort,
    ...(form !== undefined ? { outputSchema: PR_DESCRIPTION_OUTPUT_SCHEMA } : {}),
    tracking: { callSite: 'pr-description', ticketId, processRunId: processRunId ?? undefined },
  });
  const parsed = parsePrDescriptionAnswer(r.raw);
  if (parsed.kind === 'ok') return { body: renderNarrative(parsed.answer, ctx) };
  if (parsed.kind === 'not-json') {
    debug?.(`[ship] ticket ${ticketId}: PR description answer is not JSON — sanitized text used: ${headlessPreview(r.raw)}`);
    const text = sanitizePrDescription(r.raw, ctx.title);
    return { body: ctx.gateSetChanged ? `${text}\n\n${GATE_SET_CHANGED_LINE}` : text };
  }
  debug?.(`[ship] ticket ${ticketId}: PR description answer is invalid (${parsed.reason}) — template body used: ${headlessPreview(r.raw)}`);
  return {
    body: fallbackBody ? fallbackBody() : ctx.title,
    note: `AI description answer was invalid (${parsed.reason}) — template body used`,
  };
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** First line of an error message, capped, for a one-line step detail. */
function oneLine(text: string): string {
  const first = text.split(/\r?\n/u)[0]?.trim() ?? '';
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
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
  fallbackBody?: () => string,
  debug?: (message: string) => void,
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
    const { body, note } = await describePr(
      adapter,
      cwd,
      ctx,
      ticketId,
      processRun.id,
      assignment?.model,
      assignment?.effort,
      fallbackBody,
      debug,
    );
    finishProcessRun(store, processRun.id, 'passed', nowIso());
    if (note !== undefined) {
      finishShipRepoStep(store, step.id, { status: 'note', detail: note, endedAt: nowIso() });
      onProgress({ repo, step: 'describe', status: 'note', detail: note });
    } else {
      finishShipRepoStep(store, step.id, { status: 'passed', detail: 'generated', endedAt: nowIso() });
      onProgress({ repo, step: 'describe', status: 'pass' });
    }
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
    // K11: a quota exhaustion is a re-runnable park — record the op park (stage
    // `ship`) so a later session can offer Pick / Retry same. The failure still
    // propagates as today, with the typed message.
    recordUsageLimitOpPark(store, err, {
      ticketId,
      stage: 'ship',
      provider: assignment?.provider ?? null,
      model: assignment?.model ?? null,
      target: repo,
    });
    finishProcessRun(store, processRun.id, 'failed', nowIso());
    onInsideProgress({
      kind: 'cleared',
      ticketId,
      stage: 'ship',
      processId: 'pr-description',
    });
    // The PR is the irreversible, useful part; the prose is cosmetic. Any
    // non-abort describe failure degrades to the template body and the step
    // is a note — the process run above stays `failed` for spend/evidence.
    if (fallbackBody && !isAbort(err)) {
      const noteDetail = `AI description unavailable (${oneLine(detail)}) — template body used`;
      finishShipRepoStep(store, step.id, { status: 'note', detail: noteDetail, endedAt: nowIso() });
      onProgress({ repo, step: 'describe', status: 'note', detail: noteDetail });
      return fallbackBody();
    }
    finishShipRepoStep(store, step.id, { status: 'failed', detail, endedAt: nowIso() });
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
  fallbackBody?: () => string,
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

  let body: string;
  try {
    body = await buildBody();
  } catch (err) {
    if (fallbackBody === undefined || isAbort(err)) throw err;
    body = fallbackBody();
  }

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

/**
 * Bring the `## Design rules checked` section of an OPEN PR in line with the
 * ticket's citations, so a citation added in a fix round reaches the PR on the
 * next ship or deliver. Only that section changes; prose around it is kept.
 * Nothing cited, an unreadable body or a failed edit leaves the PR as it is: a
 * note is the worst outcome, never a failed ship.
 */
export async function syncDesignRules(
  gh: GhRunner,
  repo: string,
  cwd: string,
  prUrl: string,
  citations: readonly ArchCitation[],
  onProgress: ShipProgress,
): Promise<void> {
  if (citations.length === 0) return;
  const note = (detail: string): void => onProgress({ repo, step: 'describe', status: 'note', detail });
  try {
    const current = await fetchPrBody(gh, prUrl, cwd);
    if (current === null) return note('PR description could not be read — design rules section left unchanged');
    const next = upsertDesignRulesSection(current, citations);
    if (bodyHash(next) === bodyHash(current)) return;
    const attempt = await updatePrBody(gh, prUrl, cwd, next);
    if (!attempt.ok) note('design rules section could not be updated on the PR');
  } catch {
    note('design rules section could not be updated on the PR');
  }
}
