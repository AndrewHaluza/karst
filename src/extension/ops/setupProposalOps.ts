import { readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import {
  MAX_SETUP_PROPOSAL_BYTES,
  validateSetupProposal,
  type ChangeProposal,
  type SetupProposal,
} from '../../setup/proposal.js';
import { buildWriteFilePatch } from '../../setup/writeFile.js';
import { asKind, writeProposalResult, type ProposalResult } from '../../setup/ledger.js';
import type { ChangeDir } from '../../setup/changeTarget.js';
import { describeRunProposal, describeWriteFileProposal, type ProposalDescription } from '../../setup/review.js';
import { restoreKarstFiles, snapshotKarstFiles } from '../../setup/karstGuard.js';
import { withVerification } from '../../setup/review.js';
import { firstFailure, sha256Of, verifyAfterApply, verifyBeforeConsent, verifyEditsBeforeConsent } from '../../setup/verify/verify.js';
import { buildEdits } from '../../cli/setupEdit/build.js';
import { describeEdits } from '../../cli/setupEdit/describe.js';
import type { EditOpFile } from '../../setup/editOps.js';
import type { PendingSkipRequest } from '../../setup/checklist/skips.js';
import type { SkipRecord } from '../../setup/checklist/types.js';
import type { RecheckDeps, VerifyDeps, VerifyRecord, VerifyResult } from '../../setup/verify/types.js';
import type { Notify } from './notify.js';

/**
 * The host side of the setup session's outbox: scan each setup scratch's
 * `outbox/`, validate what the agent proposed, and act ONLY after the user
 * approves. Mirrors `planningOutbox` in posture — the agent writes files, the
 * host is the sole writer of durable state, and a proposal is never trusted.
 *
 * The outbox carries only the typed `run` and `write-file` proposals. A run is
 * shown as its purpose and exact command; a write-file is shown as the diff
 * that the HOST builds. Both apply only on consent. A `manifest` or `change`
 * file is refused as invalid: the agent changes karst.yml through the typed
 * edit tools. A rejected or invalid proposal is removed and reported.
 */

export interface SetupProposalFs {
  readdir: (dir: string) => string[];
  readFile: (path: string) => string;
  remove: (path: string) => void;
  exists: (path: string) => boolean;
  /** Modification time, ms. */
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
  scaffoldText: () => string | undefined;
  /** Write the built karst.yml text (with a backup); returns the sha256 of the file written. */
  applyText: (text: string, scratch: string) => string;
}

/**
 * Skip requests of a setup session (@arch:CLI-21). The agent only files a request;
 * the user's approval in the popup is what the host records, in extension storage.
 */
export interface SetupSkipWiring {
  /** The valid pending requests of one scratch. */
  read: (scratch: string) => PendingSkipRequest[];
  /** Remove one request file (answered). */
  remove: (file: string) => void;
  /** Persist an approved skip host-side. */
  record: (scratch: string, skip: SkipRecord) => void;
}

/** The repo name that a path-only run carries in its host-built change. */
const PATH_RUN_REPO = 'path-run';

const kindOfRaw = (raw: unknown): ReturnType<typeof asKind> =>
  asKind(typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined);

/** The edit list waits this long after its newest op: the agent usually adds several ops, and one popup shows them all. */
export const EDIT_QUIET_MS = 4000;

export interface SetupProposalOpsDeps {
  /** Clock for the edit quiet window; defaults to `Date.now`. */
  now?: () => number;
  /** Typed edit list support; absent, the outbox edit list is ignored. */
  edits?: SetupEditWiring;
  /** Skip request support; absent, skip requests are ignored. */
  skips?: SetupSkipWiring;
  /** The verify wiring for one setup scratch: each scratch targets its own karst.yml. */
  verify: (scratch: string) => SetupVerifyWiring;
  /** The setup scratch dirs to scan (already filtered to this window's own); each holds an `outbox/` subdir. */
  outboxes: () => string[];
  readCurrentManifest: () => Manifest | undefined;
  /** Show the proposal to the user; resolve true only on explicit approval. */
  confirm: (description: ProposalDescription) => Promise<boolean>;
  /** Directories whose `.karst/` a change must not write: the workspace root and every repo. */
  karstRoots?: () => string[];
  /** True when `current` is still the unedited scaffold (protected fields are then proposable). */
  isScaffold?: (current: Manifest) => boolean;
  /** Run an approved change command. */
  runCommand: (cwd: string, command: string) => Promise<void>;
  /** Apply an approved change patch. */
  applyPatch: (cwd: string, patch: string) => Promise<void>;
  /** Where a run or a write-file goes: the explicit `path`, else the repo's directory. `ok: false` marks the proposal invalid. */
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
    ledgerKind: ProposalResult['kind'] = kind,
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
      record(scratch, file, ledgerKind, 'invalid', { ...extra, reason: invalid });
      return;
    }
    record(scratch, file, ledgerKind, after.ok ? 'verified' : 'unverified', {
      ...extra,
      ...(after.ok ? {} : { reason: failureReason(after) }),
    });
    if (!after.ok) deps.notify.warn(`The setup proposal was applied, but the check after it failed (${failureReason(after)}).`);
  }

  let editWait: number | undefined;

  const sameIds = (a: readonly EditOpFile[], ids: readonly string[]): boolean =>
    a.length === ids.length && a.every((op, i) => op.id === ids[i]);

  /** One popup for the whole edit list; applies only the ops that the popup showed. */
  async function handleEdits(scratch: string, edits: SetupEditWiring): Promise<void> {
    const ops = edits.readOps(scratch);
    if (ops.length === 0) return;
    const now = (deps.now ?? Date.now)();
    // A seq in the future (a clock jump or a bad file) never holds the list: only a seq at or before now counts.
    const stamps = ops.map((o) => Number(o.seq)).filter((n) => Number.isFinite(n) && n <= now);
    const quiet = now - Math.max(...stamps); // no stamp: -Infinity, so quiet is Infinity
    if (quiet < EDIT_QUIET_MS) {
      editWait = Math.min(editWait ?? EDIT_QUIET_MS, EDIT_QUIET_MS - quiet);
      return;
    }
    const ids = ops.map((o) => o.id);
    const first = `${ids[0]!}.json`;
    const settle = (status: ProposalResult['status'], reason: string, only: readonly string[]): void => {
      edits.removeOps(scratch, only);
      for (const id of only) record(scratch, `${id}.json`, 'edit', status, { reason });
    };
    const wiring = deps.verify(scratch);
    const current = deps.readCurrentManifest();
    const firstSetup = isFirstSetup(current);
    const scaffoldText = edits.scaffoldText();
    const built = buildEdits(
      wiring.deps.readCurrentText(),
      ops.map((o) => ({ id: o.id, tool: o.tool, input: o.input })),
      { firstSetup, scaffoldText },
      wiring.deps.loadText,
    );
    const input = built.ok ? { ok: true as const, text: built.text, fixes: built.fixes } : { ok: false as const, reason: built.reason };
    const run = await verifyEditsBeforeConsent(ops.length, input, { firstSetup }, wiring.deps);
    if (!built.ok || !run.result.ok) {
      const reason = built.ok ? failureReason(run.result) : built.reason;
      deps.notify.warn(`The setup edits were ignored because they failed the checks (${reason}).`);
      hostRecord(scratch, first, 'edit', 'refused', run.result);
      // A failure that names one op drops only that op; the valid ops stay and show in the next popup.
      const culprit = built.ok ? undefined : built.opId;
      settle('invalid', reason, culprit === undefined ? ids : [culprit]);
      return;
    }
    if (built.changes.length === 0 && built.fixes.length === 0) {
      deps.notify.warn('The setup edits change nothing, so none was applied.');
      settle('no-change', 'no effective change', ids);
      return;
    }
    const approved = await deps.confirm(withVerification(describeEdits(built, ops.length), run.result));
    const latest = edits.readOps(scratch);
    if (!sameIds(latest, ids)) {
      // An op was withdrawn or added while the popup was open: nothing applies; the next scan shows the new list.
      debug('the edit list changed while its consent was open');
      deps.notify.warn('The setup edit list changed while the popup was open, so no edit was applied. The new list shows next.');
      return;
    }
    if (!approved) {
      settle('declined', 'declined by the user', ids);
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
      deps.notify.warn(`The setup edits were not applied (${reason}).`);
      hostRecord(scratch, first, 'edit', 'refused', run.result);
      settle('invalid', `apply failed: ${reason}`, ids);
    }
  }

  /** What a typed proposal becomes: the host-built change and the popup text, or a refusal. */
  type Prepared = { ok: true; change: ChangeProposal; describe: ProposalDescription } | { ok: false; reason: string };

  /** Verify, ask, run or apply, and record. `target` names the repo and path that `resolveDir` reads. */
  async function handleChange(
    file: string,
    scratch: string,
    kind: ProposalResult['kind'],
    label: string,
    target: ChangeProposal,
    prepare: (dir: string) => Prepared,
  ): Promise<void> {
    const where = deps.resolveDir(target);
    if (!where.ok) {
      deps.notify.warn(`The change for "${label}" was not applied (${where.reason}).`);
      record(scratch, file, kind, 'invalid', { reason: where.reason });
      fs.remove(file);
      return;
    }
    const prepared = prepare(where.dir);
    if (!prepared.ok) {
      deps.notify.warn(`The change for "${label}" was refused (${prepared.reason}).`);
      record(scratch, file, kind, 'invalid', { reason: prepared.reason });
      fs.remove(file);
      return;
    }
    const { change } = prepared;
    const roots = [...new Set([where.dir, ...(deps.karstRoots?.() ?? [])])];
    const run = await verifyBeforeConsent(change, { firstSetup: false, dir: where.dir, karstRoots: roots }, deps.verify(scratch).deps);
    if (!run.result.ok) {
      const reason = failureReason(run.result);
      deps.notify.warn(`The change for "${label}" was refused (${reason}).`);
      hostRecord(scratch, file, 'change', 'refused', run.result);
      record(scratch, file, kind, 'invalid', { reason });
      fs.remove(file);
      return;
    }
    const approved = await deps.confirm(withVerification(prepared.describe, run.result));
    if (!fs.exists(file)) {
      record(scratch, file, kind, 'withdrawn', { reason: 'withdrawn while awaiting consent' });
      return;
    }
    if (!approved) {
      debug(`user declined proposal ${file}`);
      fs.remove(file);
      record(scratch, file, kind, 'declined', { reason: 'declined by the user' });
      return;
    }
    if (manifestMoved(scratch, run.result.pinnedSha256)) {
      const reason = 'karst.yml changed after the host checks ran; ask again';
      deps.notify.warn(`The change for "${label}" was not applied (${reason}).`);
      hostRecord(scratch, file, 'change', 'refused', run.result);
      record(scratch, file, kind, 'invalid', { reason: `apply failed: ${reason}` });
      fs.remove(file);
      return;
    }
    let snapshots: ReturnType<typeof snapshotKarstFiles> = [];
    let failure: string | undefined;
    try {
      // The byte copy comes first: when it fails, the command does not run.
      snapshots = snapshotKarstFiles(roots);
      if (change.command !== undefined) await deps.runCommand(where.dir, change.command);
      else if (change.patch !== undefined) await deps.applyPatch(where.dir, change.patch);
    } catch (e) {
      failure = (e as Error).message;
    }
    const restored = restoreKarstFiles(snapshots);
    if (restored.length > 0) {
      failure = `command wrote ${restored.join(', ')}; the host restored it. Use the typed setup tools to change karst.yml`;
    }
    if (failure === undefined) {
      debug(`applied proposal ${file}`);
    } else {
      deps.notify.warn(`The change for "${label}" was not applied (${failure}).`);
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
      kind,
    );
    fs.remove(file);
  }

  /** A run: the host shows the purpose and the exact command, and the command is not dry-run. */
  function handleRun(file: string, scratch: string, run: Extract<SetupProposal, { kind: 'run' }>): Promise<void> {
    const label = run.repo ?? run.path ?? PATH_RUN_REPO;
    // A path-only run has no repo name; the change shape needs one, and `path` wins in `resolveDir`.
    const target: ChangeProposal = {
      kind: 'change', repo: run.repo ?? PATH_RUN_REPO, reason: `run: ${run.purpose}`, command: run.command, ...(run.path !== undefined ? { path: run.path } : {}),
    };
    return handleChange(file, scratch, 'run', label, target, (dir) => ({
      ok: true,
      change: target,
      describe: describeRunProposal(run, dir),
    }));
  }

  /** A write-file: the host builds the patch from the path and the content, so the agent never writes patch text. */
  function handleWriteFile(file: string, scratch: string, write: Extract<SetupProposal, { kind: 'write-file' }>): Promise<void> {
    const target: ChangeProposal = { kind: 'change', repo: write.repo, reason: 'write-file', patch: '' };
    return handleChange(file, scratch, 'write-file', write.repo, target, (dir) => {
      const built = buildWriteFilePatch(dir, write.path, write.content);
      if (!built.ok) return { ok: false, reason: built.reason };
      return {
        ok: true,
        change: { ...target, reason: `write-file: ${write.path}`, patch: built.patch },
        describe: describeWriteFileProposal(write, dir, built.patch),
      };
    });
  }

  interface Pending {
    file: string;
    mtime: number;
    value: SetupProposal;
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
        deps.notify.warn(`An invalid setup proposal was ignored (${checked.reason}).`);
        debug(`rejected proposal ${name}: ${checked.reason}`);
        fs.remove(file);
        // Keep the kind of a refused old-kind file so the ledger shows what the agent wrote.
        record(scratch, file, kindOfRaw(raw), 'invalid', { reason: checked.reason });
        continue;
      }
      pending.push({ file, mtime: fs.mtime(file), value: checked.value });
    }
    return pending;
  }

  // A request file that could not be removed must not show its popup again on the next scan.
  const answeredSkips = new Set<string>();

  async function handleSkips(scratch: string, skips: SetupSkipWiring): Promise<void> {
    for (const req of skips.read(scratch)) {
      const file = req.file;
      if (answeredSkips.has(file)) continue;
      answeredSkips.add(file);
      if ('error' in req) {
        skips.remove(file);
        record(scratch, file, 'skip', 'invalid', { reason: req.error });
        continue;
      }
      const { code, target, reason } = req.value;
      const approved = await deps.confirm({
        message: `Skip the setup item ${code}${target !== undefined ? ` for ${target}` : ''}?`,
        detail: `The agent proposes to skip this item.\nReason: ${reason}`,
        startCommandsChanged: false,
      });
      if (!skips.read(scratch).some((p) => p.id === req.id)) {
        record(scratch, file, 'skip', 'withdrawn', { reason: 'withdrawn while awaiting consent' });
        continue;
      }
      skips.remove(file);
      if (!approved) {
        record(scratch, file, 'skip', 'declined', { reason: 'declined by the user' });
        continue;
      }
      try {
        skips.record(scratch, { code, ...(target !== undefined ? { target } : {}), reason, at: new Date().toISOString() });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        deps.notify.warn(`The skip of ${code} was approved but was not saved (${why}).`);
        record(scratch, file, 'skip', 'invalid', { reason: `the host could not save the skip: ${why}` });
        continue;
      }
      record(scratch, file, 'skip', 'applied');
    }
  }

  async function scanOnce(): Promise<void> {
    editWait = undefined;
    for (const scratch of deps.outboxes()) {
      // The edit list is never superseded: each op stays until it is applied, declined or withdrawn.
      if (deps.edits !== undefined) await handleEdits(scratch, deps.edits);
      if (deps.skips !== undefined) await handleSkips(scratch, deps.skips);
      const pending = loadPending(scratch);
      for (const p of pending) {
        if (p.value.kind === 'run') await handleRun(p.file, scratch, p.value);
        else await handleWriteFile(p.file, scratch, p.value);
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
