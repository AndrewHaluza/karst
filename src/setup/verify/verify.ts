import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { karstWriteViolation, patchTargets } from '../karstGuard.js';
import { validateChangeProposal, type ChangeProposal } from '../proposal.js';
import { diffItems, snapshotOf } from './items.js';
import type {
  ItemChange,
  LoadOutcome,
  RecheckDeps,
  StepId,
  StepStatus,
  VerifyDeps,
  VerifyResult,
  VerifyStep,
} from './types.js';

/**
 * The host's fixed checklist for a setup proposal (T1218). The HOST decides
 * if a proposal is correct, and the same proposal gives the same result on each
 * run. Nothing here reads an agent claim as a fact: the agent's `clears` list
 * is a claim that the host compares with the list it computes.
 *
 * Before consent (P1-P6) the steps run on the current karst.yml text and an
 * in-memory render of the proposal. File probes root at the manifest
 * directory, so a relative `repoPath` resolves as it does for the real file.
 * After the apply (A1-A3) the steps run on the real files.
 */

const LABELS: Record<StepId, string> = {
  P1: 'shape',
  P2: 'write scope',
  P3: 'dry apply',
  P4: 'result loads',
  P5: 'protected fields',
  P6: 'effect',
  A1: 'apply',
  A2: 'items re-run',
  A3: 'record',
};

const PRE_STEPS: readonly StepId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

export const sha256Of = (text: string | undefined): string | null =>
  text === undefined ? null : createHash('sha256').update(text).digest('hex');

const step = (id: StepId, status: StepStatus, detail: string): VerifyStep => ({ id, label: LABELS[id], status, detail });

export interface VerifyContext {
  /** True for the first setup (no manifest yet, or the unedited scaffold): protected fields are then proposable. */
  firstSetup: boolean;
  /** Where a change runs; required for a change proposal. */
  dir?: string;
  /** Directories whose `.karst/` a change must not write. */
  karstRoots?: readonly string[];
}

export interface VerifyRun {
  result: VerifyResult;
}

/** Paths that a unified diff creates (`--- /dev/null` then `+++ b/<path>`), relative to the patch directory. */
export function createdPaths(patch: string): string[] {
  const out: string[] = [];
  const lines = patch.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/^--- \/dev\/null\s*$/.test(line)) return;
    const next = /^\+\+\+ (.+)$/.exec(lines[i + 1] ?? '');
    if (next === null) return;
    const path = next[1]!.split('\t')[0]!.trim().replace(/^b\//, '');
    if (path !== '' && path !== '/dev/null') out.push(path);
  });
  return out;
}

/** Runs the steps in order; the first failure skips the rest. */
class Checklist {
  readonly steps: VerifyStep[] = [];
  private failed: VerifyStep | undefined;

  run(id: StepId, body: () => Promise<Omit<VerifyStep, 'id' | 'label'> | undefined> | Omit<VerifyStep, 'id' | 'label'> | undefined): Promise<void> {
    return this.exec(id, body);
  }

  private async exec(id: StepId, body: () => unknown): Promise<void> {
    if (this.failed !== undefined) {
      this.steps.push(step(id, 'skipped', `not run: ${this.failed.id} failed`));
      return;
    }
    let out: { status: StepStatus; detail: string };
    try {
      out = (await body()) as { status: StepStatus; detail: string };
    } catch (e) {
      out = { status: 'fail', detail: e instanceof Error ? e.message : String(e) };
    }
    const s = step(id, out.status, out.detail);
    this.steps.push(s);
    if (s.status === 'fail') this.failed = s;
  }
}

const ok = (detail: string) => ({ status: 'ok' as const, detail });
const info = (detail: string) => ({ status: 'info' as const, detail });
const skipped = (detail: string) => ({ status: 'skipped' as const, detail });
const failed = (detail: string) => ({ status: 'fail' as const, detail });

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** P6's refusal rule, shared by both kinds. */
function effectStep(changes: ItemChange[], claimed: readonly string[] | undefined): { status: StepStatus; detail: string } {
  if (changes.length === 0) {
    return failed('the proposal changes no readiness item the host can compute; a proposal that is not a setup command must change one');
  }
  const cleared = changes.filter((c) => c.kind === 'cleared').map((c) => c.id);
  if (claimed !== undefined && !same(claimed, cleared)) {
    return failed(
      `the proposal claims it clears [${claimed.join(', ')}] but the host computes [${cleared.join(', ')}]`,
    );
  }
  return ok(changes.map((c) => `${c.kind} ${c.id}`).join('; '));
}

function finish(list: Checklist, changes: ItemChange[], pinned: string | null): VerifyRun {
  const result: VerifyResult = {
    ok: list.steps.every((s) => s.status !== 'fail'),
    steps: list.steps,
    changes,
    clears: changes.filter((c) => c.kind === 'cleared').map((c) => c.id),
    pinnedSha256: pinned,
  };
  return { result };
}

/**
 * Steps P1-P6 for one host-built change (a typed `run` or `write-file`). Pure
 * over the injected deps; never writes a file. A karst.yml change is not a
 * change: it goes through the typed edit list (`verifyEditsBeforeConsent`).
 */
export async function verifyBeforeConsent(raw: unknown, ctx: VerifyContext, deps: VerifyDeps): Promise<VerifyRun> {
  const list = new Checklist();
  const currentText = deps.readCurrentText();
  const pinned = sha256Of(currentText);
  let change: ChangeProposal | undefined;
  await list.run('P1', () => {
    const checked = validateChangeProposal(raw);
    if (!checked.ok) return failed(checked.reason);
    change = checked.value;
    return ok('a valid change proposal');
  });
  if (change === undefined) {
    for (const id of PRE_STEPS.slice(1)) await list.run(id, () => skipped('no valid proposal'));
    return finish(list, [], pinned);
  }
  return verifyChange(list, change, ctx, deps, currentText, pinned);
}

async function verifyChange(
  list: Checklist,
  change: ChangeProposal,
  ctx: VerifyContext,
  deps: VerifyDeps,
  currentText: string | undefined,
  pinned: string | null,
): Promise<VerifyRun> {
  const dir = ctx.dir ?? '';
  const isCommand = change.command !== undefined;
  await list.run('P2', () => {
    if (isCommand) return info('a command is not dry-run; the host restores .karst/ files after it runs');
    const patch = change.patch ?? '';
    const roots = [...new Set([dir, ...(ctx.karstRoots ?? [])])];
    const violation = karstWriteViolation(patch, dir, roots);
    if (violation !== undefined) return failed(violation);
    const manifestFile = resolve(deps.manifestPath);
    const hit = patchTargets(patch).find((t) => [t, t.replace(/^[ab]\//, '')].some((c) => resolve(isAbsolute(c) ? c : join(dir, c)) === manifestFile));
    return hit === undefined ? ok('the patch writes no .karst/ file and not karst.yml') : failed(`the patch writes ${hit}, the manifest; use the typed setup tools`);
  });
  await list.run('P3', async () => {
    if (isCommand) return info('not dry-run: the command runs only after you approve');
    const applied = await deps.gitApplyCheck(dir, change.patch ?? '');
    return applied.ok ? ok('git apply --check passed') : failed(`git apply --check failed: ${applied.error ?? 'unknown error'}`);
  });
  const created = isCommand ? [] : createdPaths(change.patch ?? '').map((p) => resolve(dir, p));
  let before: LoadOutcome | undefined;
  let after: LoadOutcome | undefined;
  await list.run('P4', () => {
    if (isCommand) return skipped('a command has no result to load before it runs');
    if (currentText === undefined) return skipped('no karst.yml yet');
    before = deps.loadText(currentText);
    after = deps.loadText(currentText, { createdFiles: created });
    return after.ok ? ok('the manifest loads with the files the patch creates') : failed(after.error);
  });
  await list.run('P5', () => skipped('a change does not write karst.yml'));
  let changes: ItemChange[] = [];
  await list.run('P6', async () => {
    if (isCommand) return info('a setup command: its effect is not dry-run');
    changes = diffItems(await snapshotOf(before), await snapshotOf(after));
    // A host-built file write need not clear an item; only a claimed clear must match.
    if (changes.length === 0 && change.clears === undefined) return info('a file write: it changes no readiness item');
    return effectStep(changes, change.clears);
  });
  return finish(list, changes, pinned);
}

/** The host's build of an edit list, injected: the build code lives in the CLI layer. */
export type EditBuildInput =
  | { ok: true; text: string; fixes: readonly string[] }
  | { ok: false; reason: string };

/**
 * Steps P1-P6 for an edit list. The host built `build` from the ops on the latest
 * karst.yml. P5 holds the `id` rule (the build refuses an `id` change outside the
 * first setup); a protected change is allowed and the popup lists it. P6 reports
 * the item changes and needs none, except that each `fix` code must clear.
 */
export async function verifyEditsBeforeConsent(
  opCount: number,
  build: EditBuildInput,
  ctx: VerifyContext,
  deps: VerifyDeps,
): Promise<VerifyRun> {
  const list = new Checklist();
  const currentText = deps.readCurrentText();
  const pinned = sha256Of(currentText);
  let current: LoadOutcome | undefined;
  let after: LoadOutcome | undefined;
  await list.run('P1', () => (opCount > 0 ? ok(`${opCount} edit(s) in the list`) : failed('the edit list is empty')));
  await list.run('P2', () =>
    basename(deps.manifestPath) === 'karst.yml'
      ? ok(`the host writes ${deps.manifestPath} and nothing else`)
      : failed(`the host manifest path ${deps.manifestPath} is not a karst.yml`),
  );
  await list.run('P3', () => {
    if (!build.ok) return failed(build.reason);
    if (currentText !== undefined) current = deps.loadText(currentText);
    return ok(`built ${build.text.length} characters of karst.yml from the edits`);
  });
  await list.run('P4', () => {
    if (!build.ok) return failed(build.reason);
    after = deps.loadText(build.text);
    return after.ok ? ok('the result loads, validates and resolves its references') : failed(after.error);
  });
  await list.run('P5', () =>
    ctx.firstSetup
      ? info('first setup: id and protected fields are settable')
      : ok('id is unchanged; each protected change is listed for your consent'),
  );
  let changes: ItemChange[] = [];
  await list.run('P6', async () => {
    changes = diffItems(await snapshotOf(current), await snapshotOf(after));
    const cleared = new Set(changes.filter((c) => c.kind === 'cleared').map((c) => c.id));
    const open = build.ok ? build.fixes.filter((code) => !cleared.has(code)) : [];
    if (open.length > 0) return failed(`the fix does not clear: ${open.join(', ')}`);
    return changes.length === 0 ? info('no readiness item changes') : ok(changes.map((c) => `${c.kind} ${c.id}`).join('; '));
  });
  return finish(list, changes, pinned);
}

export interface ApplyOutcome {
  /** The apply ran and exited 0. */
  applied: boolean;
  error?: string;
  /** `.karst/` files the host restored after a command. */
  restored: readonly string[];
}

export interface AfterApplyDeps extends RecheckDeps {
  /** The current karst.yml text, read again. */
  readCurrentText: () => string | undefined;
  /** Persist the record. A throw makes A3 fail. */
  record: (result: VerifyResult) => void;
}

/** Steps A1-A3 on the real files. `before` is the result of `verifyBeforeConsent`; its steps stay. */
export async function verifyAfterApply(
  before: VerifyResult,
  kind: 'manifest' | 'change' | 'edit',
  outcome: ApplyOutcome,
  deps: AfterApplyDeps,
): Promise<VerifyResult> {
  const list = new Checklist();
  await list.run('A1', () => {
    if (!outcome.applied) return failed(`the apply failed: ${outcome.error ?? 'unknown error'}`);
    if (outcome.restored.length > 0) return failed(`the command wrote ${outcome.restored.join(', ')}; the host restored it`);
    if (kind === 'change' && sha256Of(deps.readCurrentText()) !== before.pinnedSha256) {
      return failed('a change proposal changed karst.yml');
    }
    return ok(kind === 'change' ? 'the change ran and karst.yml is unchanged' : 'karst.yml written');
  });
  const namedChanges = before.changes.filter((c) => c.kind === 'cleared' || c.kind === 'added');
  const named = namedChanges.map((c) => c.id);
  await list.run('A2', async () => {
    if (named.length === 0) return info('the proposal named no item to re-run');
    const items = await deps.recheck(named);
    const bad = namedChanges
      .filter((change) => {
        const item = items.find((i) => i.id === change.id);
        // A cleared warning item leaves the list when its cause goes; an added item must be there.
        if (item === undefined) return change.kind === 'added';
        return item.status === 'fail';
      })
      .map((c) => c.id);
    return bad.length === 0 ? ok(`re-ran ${named.join(', ')}`) : failed(`still failing or missing: ${bad.join(', ')}`);
  });
  const result: VerifyResult = {
    ...before,
    ok: false,
    steps: [...before.steps, ...list.steps, step('A3', 'ok', 'recorded')],
  };
  result.ok = result.steps.every((s) => s.status !== 'fail');
  try {
    deps.record(result);
  } catch (e) {
    const steps = result.steps.slice(0, -1);
    return { ...result, ok: false, steps: [...steps, step('A3', 'fail', `could not record: ${e instanceof Error ? e.message : String(e)}`)] };
  }
  return result;
}

/** The failing step of a result, for a refusal reason. */
export function firstFailure(result: VerifyResult): VerifyStep | undefined {
  return result.steps.find((s) => s.status === 'fail');
}
