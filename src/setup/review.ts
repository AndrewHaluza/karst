import type { Manifest } from '../manifest/types.js';
import { diffManifest } from './manifestApply.js';
import type { ChangeProposal, ManifestProposal } from './proposal.js';

/**
 * Human-facing descriptions of a setup proposal — what the extension shows
 * before the user approves. Pure and deterministic so the exact text the user
 * reads is unit-tested, not assembled ad hoc in the host binding.
 *
 * The manifest description ALWAYS lists every start command the proposal would
 * run: accepting the diff is the user's approval to write the file AND to run
 * those commands, so they must be visible first.
 */

export interface ProposalDescription {
  /** The one-line question shown in the modal. */
  message: string;
  /** The expanded detail: the diff, the start commands, or the exact change. */
  detail: string;
  /** True when a revision changed the start commands vs the current manifest. */
  startCommandsChanged: boolean;
}

export function describeManifestProposal(
  current: Manifest | undefined,
  proposal: ManifestProposal,
  proposed: Manifest,
): ProposalDescription {
  const diff = diffManifest(current, proposed);
  const lines: string[] = [];
  if (proposal.summary.trim() !== '') lines.push(proposal.summary.trim(), '');
  if (diff.entries.length === 0) {
    lines.push('No repository changes.');
  } else {
    for (const entry of diff.entries) {
      lines.push(`${entry.kind.toUpperCase()} ${entry.repo}: ${entry.details.join('; ')}`);
    }
  }
  lines.push('', 'Start commands this manifest will run:');
  if (diff.startCommands.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of diff.startCommands) lines.push(`  ${s.repo}: ${s.command}`);
  }
  if (diff.startCommandsChanged) {
    lines.push('', 'These start commands differ from the current manifest.');
  }
  const repos = Object.keys(proposed.repositories).length;
  const services = Object.values(proposed.repositories).filter((r) => r.service !== undefined).length;
  return {
    message: `Apply the proposed karst.yml? ${repos} repositories, ${services} with a service.`,
    detail: lines.join('\n'),
    startCommandsChanged: diff.startCommandsChanged,
  };
}

export function describeChangeProposal(change: ChangeProposal): ProposalDescription {
  const lines: string[] = [change.reason];
  if (change.command !== undefined) {
    lines.push('', `Command: ${change.command}`);
  }
  if (change.patch !== undefined) {
    lines.push('', 'Patch:', change.patch);
  }
  return {
    message: `Apply this change to "${change.repo}"?`,
    detail: lines.join('\n'),
    startCommandsChanged: false,
  };
}
