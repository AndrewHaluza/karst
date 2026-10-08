import { readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../../manifest/types.js';
import { parseManifestText } from '../../manifest/load.js';
import {
  MAX_SETUP_PROPOSAL_BYTES,
  validateSetupProposal,
  type ChangeProposal,
  type ManifestProposal,
} from '../../setup/proposal.js';
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
};

export interface SetupProposalOpsDeps {
  /** The setup scratch dirs to scan; each holds an `outbox/` subdir. */
  outboxes: () => string[];
  readCurrentManifest: () => Manifest | undefined;
  /** Show the proposal to the user; resolve true only on explicit approval. */
  confirm: (description: ProposalDescription) => Promise<boolean>;
  /** Apply an approved manifest proposal (write karst.yml, preserving identity). */
  applyManifest: (proposal: ManifestProposal, proposed: Manifest) => void;
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

  async function handleManifest(file: string, proposal: ManifestProposal): Promise<void> {
    let proposed: Manifest;
    try {
      proposed = parseManifestText(proposal.yaml, proposal.targetPath).manifest;
    } catch (e) {
      deps.notify.warn(`Karst: the setup agent proposed an invalid manifest (${(e as Error).message}); ignored.`);
      debug(`rejected invalid manifest proposal ${file}`);
      fs.remove(file);
      return;
    }
    const current = deps.readCurrentManifest();
    const description = describeManifestProposal(current, proposal, proposed);
    const approved = await deps.confirm(description);
    if (!approved) {
      debug(`user declined manifest proposal ${file}`);
      fs.remove(file);
      return;
    }
    try {
      deps.applyManifest(proposal, proposed);
      debug(`applied manifest proposal ${file}`);
    } catch (e) {
      deps.notify.warn(`Karst: could not apply the manifest proposal (${(e as Error).message}).`);
    }
    fs.remove(file);
  }

  async function handleChange(file: string, change: ChangeProposal): Promise<void> {
    const approved = await deps.confirm(describeChangeProposal(change));
    if (!approved) {
      debug(`user declined change proposal ${file}`);
      fs.remove(file);
      return;
    }
    try {
      if (change.command !== undefined) await deps.runCommand(change.repo, change.command);
      else if (change.patch !== undefined) await deps.applyPatch(change.repo, change.patch);
      debug(`applied change proposal ${file}`);
    } catch (e) {
      deps.notify.warn(`Karst: could not apply the change for "${change.repo}" (${(e as Error).message}).`);
    }
    fs.remove(file);
  }

  async function scanOnce(): Promise<void> {
    for (const scratch of deps.outboxes()) {
      const dir = join(scratch, 'outbox');
      for (const name of fs.readdir(dir)) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const file = join(dir, name);
        if (!fs.exists(file)) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(fs.readFile(file));
        } catch (e) {
          debug(`skipped unreadable proposal ${name}: ${e instanceof Error ? e.message : String(e)}`);
          fs.remove(file);
          continue;
        }
        const checked = validateSetupProposal(raw);
        if (!checked.ok) {
          deps.notify.warn(`Karst: ignored an invalid setup proposal (${checked.reason}).`);
          debug(`rejected proposal ${name}: ${checked.reason}`);
          fs.remove(file);
          continue;
        }
        if (checked.value.kind === 'manifest') await handleManifest(file, checked.value);
        else await handleChange(file, checked.value);
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
