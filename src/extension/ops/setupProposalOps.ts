import { readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import { parseManifestText } from '../../manifest/load.js';
import {
  MAX_SETUP_PROPOSAL_BYTES,
  validateSetupProposal,
  type ChangeProposal,
  type ManifestProposal,
} from '../../setup/proposal.js';
import { adoptedProtectedFields, applyManifestProposal, droppedProtectedFields, sameManifest } from '../../setup/manifestApply.js';
import { writeProposalResult, type ProposalResult } from '../../setup/ledger.js';
import type { ChangeDir } from '../../setup/changeTarget.js';
import { describeChangeProposal, describeManifestProposal, type ProposalDescription } from '../../setup/review.js';
import { restoreKarstFiles, snapshotKarstFiles } from '../../setup/karstGuard.js';
import { withVerification } from '../../setup/review.js';
import { firstFailure, sha256Of, verifyAfterApply, verifyBeforeConsent, verifyEditsBeforeConsent } from '../../setup/verify/verify.js';
import { buildEdits } from '../../cli/setupEdit/build.js';
import { describeEdits } from '../../cli/setupEdit/describe.js';
import type { EditOpFile } from '../../setup/editOps.js';
import type { RecheckDeps, VerifyDeps, VerifyRecord, VerifyResult } from '../../setup/verify/types.js';
import type { Notify } from './notify.js';

/**
 * The host side of the setup session's outbox: scan each setup scratch's
 * `outbox/`, validate what the agent proposed, and act ONLY after the user
 * approves. Mirrors `planningOutbox` in posture — the agent writes files, the
 * host is the sole writer of durable state, and a proposal is never trusted.
 *
 * A manifest proposal is validated against the real loader/schema (its YAML
 * text is parsed in memory) and applied through the injected `applyManifest`
 * seam, which preserves protected identity fields. A change proposal is shown
 * as its exact command or patch and applied only on consent. A rejected or
 * invalid proposal is removed and reported; nothing is left to re-scan.
 */

export interface SetupProposalFs {
  readdir: (dir: string) => string[];
  readFile: (path: string) => string;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  /** Modification time, ms: orders a session's manifest proposals for superseding. */
  mtime: (path: string) => number;
  /** Persist a ledger entry into `<outbox>/results/`. */
  writeResult: (outbox: string, result: ProposalResult) => void;
}

/**
 * The real filesystem seam. Exported so its bounded reads can be unit-tested.
 *
 * `readFile` is BOUNDED: the outbox lives under the agent's writable cwd, so the
 * agent can drop a multi-GB `*.json` there directly. The CLI writer enforces the
 * cap, but the host must not trust it — stat first and refuse anything over the
 * cap, so a hostile file cannot block the extension host or exhaust memory.
 */
export const defaultSetupProposalFs: SetupProposalFs = {
  readdir: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readFile: (path) => {
    const size = statSync(path).size;
    if (size > MAX_SETUP_PROPOSAL_BYTES) {
      throw new Error(`proposal is ${size} bytes, over the ${MAX_SETUP_PROPOSAL_BYTES}-byte cap`);
    }
    return readFileSync(path, 'utf8');
  },
  remove: (path) => {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort: a claimed file that vanished is already handled */
    }
  },
  exists: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  mtime: (path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  },
  writeResult: writeProposalResult,
};

/**
 * What the host needs to run its checklist. The outbox is not a trust boundary:
 * the agent can write a proposal file there directly, so the host verifies each
 * proposal itself, whatever wrote the file.
 */
export interface SetupVerifyWiring extends RecheckDeps {
  deps: VerifyDeps;
  /** Persist the authoritative host-side record (extension storage, never the agent's outbox). */
  writeRecord: (record: VerifyRecord) => void;
}

/** The typed edit list of a setup session (@arch:CLI-21): ops in, one popup, one write of the built text. */
export interface SetupEditWiring {
  /** The pending ops of one scratch, in order. */
  readOps: (scratch: string) => EditOpFile[];
  /** Remove the named op files (applied, declined or invalid). */
  removeOps: (scratch: string, ids: readonly string[]) => void;
  /** The stamped scaffold text the host writes first when karst.yml does not exist. */
  scaffoldText?: () => string | undefined;
  /** Write the built karst.yml text (with a backup); returns the sha256 of the file written. */
  applyText: (text: string, scratch: string) => string;
}

/** The edit list waits this long after its newest op: the agent usually adds several ops, and one popup shows them all. */
export const EDIT_QUIET_MS = 4000;

export interface SetupProposalOpsDeps {
  /** Clock for the edit quiet window; defaults to `Date.now`. */
  now?: () => number;
  /** Typed edit list support; absent, the outbox edit list is ignored. */
  edits?: SetupEditWiring;
  /** The verify wiring for one setup scratch: each scratch targets its own karst.yml. */
  verify: (scratch: string) => SetupVerifyWiring;
  /** The setup scratch dirs to scan (already filtered to this window's own); each holds an `outbox/` subdir. */
  outboxes: () => string[];
  readCurrentManifest: () => Manifest | undefined;
  /** Show the proposal to the user; resolve true only on explicit approval. */
  confirm: (description: ProposalDescription) => Promise<boolean>;
  /** Write the approved manifest (already merged by `applyManifestProposal`); returns the sha256 of the file written. */
  applyManifest: (applied: Manifest, scratch: string) => string;
  /** Top-level sections of karst.yml that writing `applied` changes, defaults the writer adds included. Shown before consent. */
  writtenSections?: (applied: Manifest, scratch: string) => string[];
  /** Key paths in karst.yml that writing `applied` removes (retired and legacy keys). Named in the consent detail. */
  removedKeys?: (applied: Manifest, scratch: string) => string[];
  /** Directories whose `.karst/` a change must not write: the workspace root and every repo. */
  karstRoots?: () => string[];
  /** True when `current` is still the unedited scaffold (protected fields are then proposable). */
  isScaffold?: (current: Manifest) => boolean;
  /** Run an approved change command. */
  runCommand: (cwd: string, command: string) => Promise<void>;
  /** Apply an approved change patch. */
  applyPatch: (cwd: string, patch: string) => Promise<void>;
  /** Where a change runs: the explicit `path`, else the repo's directory. `ok: false` marks the proposal invalid. */
  resolveDir: (change: ChangeProposal) => ChangeDir;
  notify: Notify;
  fs?: SetupProposalFs;
  debug?: (message: string) => void;
}

export interface SetupProposalOps {
  scan(): Promise<void>;
  /** After a scan: ms until a held edit list is due, or undefined when none waits. The caller scans again then. */
  editWaitMs(): number | undefined;
}

export function createSetupProposalOps(deps: SetupProposalOpsDeps): SetupProposalOps {
  const fs = deps.fs ?? defaultSetupProposalFs;
  const debug = (m: string): void => deps.debug?.(`[setup] ${m}`);

  const record = (
    scratch: string,
    file: string,
    kind: ProposalResult['kind'],
    status: ProposalResult['status'],
    extra: Partial<ProposalResult> = {},
  ): void => {
    try {
      fs.writeResult(join(scratch, 'outbox'), {
        id: basename(file, '.json'),
        kind,
        status,
        dropped: [],
        at: new Date().toISOString(),
        ...extra,
      });
    } catch (e) {
      debug(`could not record ${status} result for ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const isFirstSetup = (current: Manifest | undefined): boolean =>
    current === undefined || (deps.isScaffold?.(current) ?? false);

  const failureReason = (result: VerifyResult): string => {
    const f = firstFailure(result);
    return f === undefined ? 'host verification failed' : `${f.id} ${f.label}: ${f.detail}`;
  };

  const hostRecord = (
    scratch: string,
    file: string,
    kind: VerifyRecord['kind'],
    status: VerifyRecord['status'],
    result: VerifyResult,
  ): void => {
    try {
      deps.verify(scratch).writeRecord({
        id: basename(file, '.json'),
        kind,
        status,
        steps: result.steps,
        changes: result.changes,
        pinnedSha256: result.pinnedSha256,
        at: new Date().toISOString(),
      });
    } catch (e) {
      debug(`could not write the verify record for ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** The karst.yml text changed since the checklist ran on it. */
  const manifestMoved = (scratch: string, pinned: string | null): boolean =>
    sha256Of(deps.verify(scratch).deps.readCurrentText()) !== pinned;

  /** Runs A1-A3 and writes both records; the ledger shows verified or unverified. */
  async function finishVerify(
    file: string,
    scratch: string,
    kind: VerifyRecord['kind'],
    before: VerifyResult,
    outcome: { applied: boolean; error?: string; restored: readonly string[] },
    extra: Partial<ProposalResult>,
    invalid?: string,
  ): Promise<void> {
    const after = await verifyAfterApply(before, kind, outcome, {
      recheck: deps.verify(scratch).recheck,
      readCurrentText: deps.verify(scratch).deps.readCurrentText,
      record: (r) => deps.verify(scratch).writeRecord({
        id: basename(file, '.json'), kind, status: r.ok ? 'verified' : 'unverified',
        steps: r.steps, changes: r.changes, pinnedSha256: r.pinnedSha256, at: new Date().toISOString(),
      }),
    });
    if (invalid !== undefined) {
      record(scratch, file, kind, 'invalid', { ...extra, reason: invalid });
      return;
    }
    record(scratch, file, kind, after.ok ? 'verified' : 'unverified', {
      ...extra,
      ...(after.ok ? {} : { reason: failureReason(after) }),
    });
    if (!after.ok) deps.notify.warn(`Karst: the setup proposal was applied but did not verify (${failureReason(after)}).`);
  }

  /** Files superseded by a newer proposal; a modal still open on one must not record 'withdrawn'. */
  const superseded = new Set<string>();

  async function handleManifest(file: string, scratch: string, proposal: ManifestProposal): Promise<void> {
    let proposed: Manifest;
    try {
      proposed = parseManifestText(proposal.yaml, proposal.targetPath).manifest;
    } catch (e) {
      const reason = (e as Error).message;
      deps.notify.warn(`Karst: the setup agent proposed an invalid manifest (${reason}); ignored.`);
      debug(`rejected invalid manifest proposal ${file}`);
      fs.remove(file);
      record(scratch, file, 'manifest', 'invalid', { reason });
      return;
    }
    const current = deps.readCurrentManifest();
    const firstSetup = isFirstSetup(current);
    const dropped = droppedProtectedFields(current, proposed, firstSetup);
    const effective = applyManifestProposal(current, proposed, firstSetup);
    let writtenSections: string[] = [];
    let removedKeys: string[] = [];
    try {
      writtenSections = deps.writtenSections?.(effective, scratch) ?? [];
      removedKeys = deps.removedKeys?.(effective, scratch) ?? [];
    } catch (e) {
      debug(`could not preview written sections: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A raw delta counts: a retired key that the loader drops in memory still changes the file.
    if (current !== undefined && sameManifest(effective, current) && removedKeys.length === 0) {
      // Nothing would change: offer no Apply, write no file, and say so in the ledger.
      const reason =
        dropped.length > 0
          ? `no effective change; protected fields not applied: ${dropped.join(', ')}. The user changes them in Settings.`
          : 'no effective change';
      debug(`manifest proposal ${file} has no effective change`);
      deps.notify.warn(`Karst: the setup proposal changes nothing (${reason}).`);
      fs.remove(file);
      record(scratch, file, 'manifest', 'no-change', { reason, dropped });
      return;
    }
    const run = await verifyBeforeConsent(proposal, { firstSetup }, deps.verify(scratch).deps);
    if (!run.result.ok) {
      const reason = failureReason(run.result);
      deps.notify.warn(`Karst: the setup agent's manifest proposal failed the host checks (${reason}); ignored.`);
      debug(`refused manifest proposal ${file}: ${reason}`);
      fs.remove(file);
      hostRecord(scratch, file, 'manifest', 'refused', run.result);
      record(scratch, file, 'manifest', 'invalid', { reason, dropped });
      return;
    }
    const description = withVerification(
      describeManifestProposal(current, proposal, proposed, {
        dropped,
        adopted: adoptedProtectedFields(proposed, firstSetup),
        writtenSections,
        removedKeys,
      }),
      run.result,
    );
    const approved = await deps.confirm(description);
    if (!fs.exists(file)) {
      debug(`manifest proposal ${file} was withdrawn while its consent was open`);
      if (superseded.has(file)) return;
      record(scratch, file, 'manifest', 'withdrawn', { reason: 'withdrawn while awaiting consent' });
      return;
    }
    if (!approved) {
      debug(`user declined manifest proposal ${file}`);
      fs.remove(file);
      record(scratch, file, 'manifest', 'declined', { reason: 'declined by the user', dropped });
      return;
    }
    try {
      const latest = deps.readCurrentManifest();
      const latestFirst = isFirstSetup(latest);
      const latestDropped = droppedProtectedFields(latest, proposed, latestFirst);
      if (manifestMoved(scratch, run.result.pinnedSha256)) {
        throw new Error('karst.yml changed after the host checks ran; propose again');
      }
      if (latestFirst !== firstSetup || latestDropped.join() !== dropped.join()) {
        throw new Error('karst.yml changed while awaiting consent; protected fields differ from what was shown');
      }
      const sha256 = deps.applyManifest(applyManifestProposal(latest, proposed, latestFirst), scratch);
      debug(`applied manifest proposal ${file}`);
      await finishVerify(file, scratch, 'manifest', run.result, { applied: true, restored: [] }, { dropped, sha256 });
    } catch (e) {
      const reason = (e as Error).message;
      deps.notify.warn(`Karst: could not apply the manifest proposal (${reason}).`);
      hostRecord(scratch, file, 'manifest', 'refused', run.result);
      record(scratch, file, 'manifest', 'invalid', { reason: `apply failed: ${reason}`, dropped });
    }
    fs.remove(file);
  }

  let editWait: number | undefined;

  const sameIds = (a: readonly EditOpFile[], ids: readonly string[]): boolean =>
    a.length === ids.length && a.every((op, i) => op.id === ids[i]);

  /** One popup for the whole edit list; applies only the ops that the popup showed. */
  async function handleEdits(scratch: string, edits: SetupEditWiring): Promise<void> {
    const ops = edits.readOps(scratch);
    if (ops.length === 0) return;
    const quiet = (deps.now ?? Date.now)() - Math.max(...ops.map((o) => Number(o.seq)));
    if (Number.isFinite(quiet) && quiet < EDIT_QUIET_MS) {
      editWait = Math.min(editWait ?? EDIT_QUIET_MS, EDIT_QUIET_MS - quiet);
      return;
    }
    const ids = ops.map((o) => o.id);
    const first = `${ids[0]!}.json`;
    const settle = (status: ProposalResult['status'], reason?: string): void => {
      edits.removeOps(scratch, ids);
      for (const id of ids) record(scratch, `${id}.json`, 'edit', status, reason === undefined ? {} : { reason });
    };
    const wiring = deps.verify(scratch);
    const current = deps.readCurrentManifest();
    const firstSetup = isFirstSetup(current);
    const scaffoldText = edits.scaffoldText?.();
    const built = buildEdits(
      wiring.deps.readCurrentText(),
      ops.map((o) => ({ id: o.id, tool: o.tool, input: o.input })),
      { firstSetup, ...(scaffoldText !== undefined ? { scaffoldText } : {}) },
      wiring.deps.loadText,
    );
    const input = built.ok ? { ok: true as const, text: built.text, fixes: built.fixes } : { ok: false as const, reason: built.reason };
    const run = await verifyEditsBeforeConsent(ops.length, input, { firstSetup }, wiring.deps);
    if (!built.ok || !run.result.ok) {
      const reason = built.ok ? failureReason(run.result) : built.reason;
      deps.notify.warn(`Karst: the setup edits failed the host checks (${reason}); ignored.`);
      hostRecord(scratch, first, 'edit', 'refused', run.result);
      settle('invalid', reason);
      return;
    }
    if (built.changes.length === 0 && built.fixes.length === 0) {
      deps.notify.warn('Karst: the setup edits change nothing.');
      settle('no-change', 'no effective change');
      return;
    }
    const approved = await deps.confirm(withVerification(describeEdits(built, ops.length), run.result));
    const latest = edits.readOps(scratch);
    if (!sameIds(latest, ids)) {
      // An op was withdrawn or added while the popup was open: nothing applies; the next scan shows the new list.
      debug('the edit list changed while its consent was open');
      return;
    }
    if (!approved) {
      settle('declined', 'declined by the user');
      return;
    }
    try {
      if (manifestMoved(scratch, run.result.pinnedSha256)) {
        throw new Error('karst.yml changed after the host checks ran; edit again');
      }
      const sha256 = edits.applyText(built.text, scratch);
      edits.removeOps(scratch, ids);
      await finishVerify(first, scratch, 'edit', run.result, { applied: true, restored: [] }, { sha256 });
      for (const id of ids.slice(1)) record(scratch, `${id}.json`, 'edit', 'applied', { sha256 });
    } catch (e) {
      const reason = (e as Error).message;
      deps.notify.warn(`Karst: could not apply the setup edits (${reason}).`);
      hostRecord(scratch, first, 'edit', 'refused', run.result);
      settle('invalid', `apply failed: ${reason}`);
    }
  }

  async function handleChange(file: string, scratch: string, change: ChangeProposal): Promise<void> {
    const target = deps.resolveDir(change);
    if (!target.ok) {
      deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${target.reason}).`);
      record(scratch, file, 'change', 'invalid', { reason: target.reason });
      fs.remove(file);
      return;
    }
    const roots = [...new Set([target.dir, ...(deps.karstRoots?.() ?? [])])];
    const run = await verifyBeforeConsent(
      change,
      { firstSetup: false, dir: target.dir, karstRoots: roots },
      deps.verify(scratch).deps,
    );
    if (!run.result.ok) {
      const reason = failureReason(run.result);
      deps.notify.warn(`Karst: refused the change for "${change.repo}" (${reason}).`);
      hostRecord(scratch, file, 'change', 'refused', run.result);
      record(scratch, file, 'change', 'invalid', { reason });
      fs.remove(file);
      return;
    }
    const approved = await deps.confirm(withVerification(describeChangeProposal(change, target.dir), run.result));
    if (!fs.exists(file)) {
      record(scratch, file, 'change', 'withdrawn', { reason: 'withdrawn while awaiting consent' });
      return;
    }
    if (!approved) {
      debug(`user declined change proposal ${file}`);
      fs.remove(file);
      record(scratch, file, 'change', 'declined', { reason: 'declined by the user' });
      return;
    }
    if (manifestMoved(scratch, run.result.pinnedSha256)) {
      const reason = 'karst.yml changed after the host checks ran; propose again';
      deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${reason}).`);
      hostRecord(scratch, file, 'change', 'refused', run.result);
      record(scratch, file, 'change', 'invalid', { reason: `apply failed: ${reason}` });
      fs.remove(file);
      return;
    }
    const snapshots = change.command !== undefined ? snapshotKarstFiles(roots) : [];
    let failure: string | undefined;
    try {
      if (change.command !== undefined) await deps.runCommand(target.dir, change.command);
      else if (change.patch !== undefined) await deps.applyPatch(target.dir, change.patch);
    } catch (e) {
      failure = (e as Error).message;
    }
    const restored = restoreKarstFiles(snapshots);
    if (restored.length > 0) {
      failure = `command wrote ${restored.join(', ')}; the host restored it. Use \`manifest propose\` to change karst.yml`;
    }
    if (failure === undefined) {
      debug(`applied change proposal ${file}`);
    } else {
      deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${failure}).`);
    }
    await finishVerify(
      file,
      scratch,
      'change',
      run.result,
      { applied: failure === undefined, ...(failure !== undefined ? { error: failure } : {}), restored },
      {},
      failure === undefined
        ? undefined
        : restored.length > 0
          ? `invalid: command wrote ${restored.join(', ')}`
          : `apply failed: ${failure}`,
    );
    fs.remove(file);
  }

  interface Pending {
    file: string;
    mtime: number;
    value: ManifestProposal | ChangeProposal;
  }

  /** Read and validate one scratch's outbox; unreadable and invalid files are removed and recorded. */
  function loadPending(scratch: string): Pending[] {
    const dir = join(scratch, 'outbox');
    const pending: Pending[] = [];
    for (const name of fs.readdir(dir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const file = join(dir, name);
      if (!fs.exists(file)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFile(file));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        debug(`skipped unreadable proposal ${name}: ${reason}`);
        fs.remove(file);
        record(scratch, file, 'unknown', 'invalid', { reason: `unreadable: ${reason}` });
        continue;
      }
      const checked = validateSetupProposal(raw);
      if (!checked.ok) {
        deps.notify.warn(`Karst: ignored an invalid setup proposal (${checked.reason}).`);
        debug(`rejected proposal ${name}: ${checked.reason}`);
        fs.remove(file);
        record(scratch, file, 'unknown', 'invalid', { reason: checked.reason });
        continue;
      }
      pending.push({ file, mtime: fs.mtime(file), value: checked.value });
    }
    return pending;
  }

  async function scanOnce(): Promise<void> {
    editWait = undefined;
    for (const scratch of deps.outboxes()) {
      // The edit list is never superseded: each op stays until it is applied, declined or withdrawn.
      if (deps.edits !== undefined) await handleEdits(scratch, deps.edits);
      const pending = loadPending(scratch);
      // Only the newest manifest proposal of a session is live; older pending ones are superseded.
      const manifests = pending
        .filter((p) => p.value.kind === 'manifest')
        .sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
      const newest = manifests[manifests.length - 1];
      for (const old of manifests.slice(0, -1)) {
        superseded.add(old.file);
        fs.remove(old.file);
        record(scratch, old.file, 'manifest', 'superseded', {
          reason: `superseded by ${basename(newest!.file, '.json')}`,
        });
      }
      for (const p of pending) {
        if (p.value.kind === 'manifest') {
          if (p === newest) await handleManifest(p.file, scratch, p.value);
        } else await handleChange(p.file, scratch, p.value);
      }
    }
  }

  // One scan at a time. `scanOnce` awaits the consent modal, which can stay open
  // for a long time; an fs event during that wait (the agent writes another
  // proposal, the instructions file, a `.tmp-*` rename) must NOT start a second
  // pass that re-reads the same still-on-disk file, shows it twice, and — on a
  // second approval — runs the agent's command or writes the manifest twice.
  // Concurrent calls coalesce into this promise; one extra pass after it settles
  // picks up anything written while the modal was open.
  let running: Promise<void> | undefined;
  let rerun = false;

  const scan = (): Promise<void> => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        await scanOnce();
      } finally {
        running = undefined;
      }
      if (rerun) {
        rerun = false;
        await scan();
      }
    })();
    return running;
  };

  return { scan, editWaitMs: () => editWait };
}
