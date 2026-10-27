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
import { adoptedProtectedFields, applyManifestProposal, droppedProtectedFields } from '../../setup/manifestApply.js';
import { writeProposalResult, type ProposalResult } from '../../setup/ledger.js';
import { describeChangeProposal, describeManifestProposal, type ProposalDescription } from '../../setup/review.js';
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

export interface SetupProposalOpsDeps {
  /** The setup scratch dirs to scan (already filtered to this window's own); each holds an `outbox/` subdir. */
  outboxes: () => string[];
  readCurrentManifest: () => Manifest | undefined;
  /** Show the proposal to the user; resolve true only on explicit approval. */
  confirm: (description: ProposalDescription) => Promise<boolean>;
  /** Write the approved manifest (already merged by `applyManifestProposal`); returns the sha256 of the file written. */
  applyManifest: (applied: Manifest, scratch: string) => string;
  /** True when `current` is still the unedited scaffold (protected fields are then proposable). */
  isScaffold?: (current: Manifest) => boolean;
  /** Run an approved change command. */
  runCommand: (repo: string, command: string) => Promise<void>;
  /** Apply an approved change patch. */
  applyPatch: (repo: string, patch: string) => Promise<void>;
  notify: Notify;
  fs?: SetupProposalFs;
  debug?: (message: string) => void;
}

export interface SetupProposalOps {
  scan(): Promise<void>;
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
    const description = describeManifestProposal(current, proposal, proposed, {
      dropped,
      adopted: adoptedProtectedFields(proposed, firstSetup),
    });
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
      if (latestFirst !== firstSetup || latestDropped.join() !== dropped.join()) {
        throw new Error('karst.yml changed while awaiting consent; protected fields differ from what was shown');
      }
      const sha256 = deps.applyManifest(applyManifestProposal(latest, proposed, latestFirst), scratch);
      debug(`applied manifest proposal ${file}`);
      record(scratch, file, 'manifest', 'applied', { dropped, sha256 });
    } catch (e) {
      const reason = (e as Error).message;
      deps.notify.warn(`Karst: could not apply the manifest proposal (${reason}).`);
      record(scratch, file, 'manifest', 'invalid', { reason: `apply failed: ${reason}`, dropped });
    }
    fs.remove(file);
  }

  async function handleChange(file: string, scratch: string, change: ChangeProposal): Promise<void> {
    const approved = await deps.confirm(describeChangeProposal(change));
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
    try {
      if (change.command !== undefined) await deps.runCommand(change.repo, change.command);
      else if (change.patch !== undefined) await deps.applyPatch(change.repo, change.patch);
      debug(`applied change proposal ${file}`);
      record(scratch, file, 'change', 'applied');
    } catch (e) {
      const reason = (e as Error).message;
      deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${reason}).`);
      record(scratch, file, 'change', 'invalid', { reason: `apply failed: ${reason}` });
    }
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
    for (const scratch of deps.outboxes()) {
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

  return { scan };
}
