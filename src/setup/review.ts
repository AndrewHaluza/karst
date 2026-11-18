import type { VerifyResult, VerifyStep } from './verify/types.js';
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
  fields: { dropped?: readonly string[]; adopted?: readonly string[]; writtenSections?: readonly string[]; removedKeys?: readonly string[] } = {},
): ProposalDescription {
  const diff = diffManifest(current, proposed);
  const lines: string[] = [];
  // The dropped line comes first: the agent summary may promise a change that never lands.
  if (fields.dropped !== undefined && fields.dropped.length > 0) {
    lines.push(`Protected fields NOT applied (kept from the current manifest): ${fields.dropped.join(', ')}.`, '');
  }
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
  if (fields.adopted !== undefined && fields.adopted.length > 0) {
    lines.push('', 'First setup: this proposal also sets protected fields (may include commands that run):');
    const prop = proposed as unknown as Record<string, unknown>;
    for (const f of fields.adopted) lines.push(`  ${f}: ${JSON.stringify(prop[f])}`);
  }
  if (fields.writtenSections !== undefined && fields.writtenSections.length > 0) {
    lines.push('', `Sections of karst.yml that this write changes: ${fields.writtenSections.join(', ')}.`);
  }
  if (fields.removedKeys !== undefined && fields.removedKeys.length > 0) {
    lines.push('', `Retired or legacy keys that this write removes from karst.yml: ${fields.removedKeys.join(', ')}.`);
  }
  const repos = Object.keys(proposed.repositories).length;
  const services = Object.values(proposed.repositories).filter((r) => r.service !== undefined).length;
  return {
    message: `Apply the proposed karst.yml? ${repos} repositories, ${services} with a service.`,
    detail: lines.join('\n'),
    startCommandsChanged: diff.startCommandsChanged,
  };
}

export function describeChangeProposal(change: ChangeProposal, dir: string): ProposalDescription {
  const lines: string[] = [`Directory: ${dir}`, change.reason];
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

const MARK: Record<VerifyStep['status'], string> = { ok: 'ok', fail: 'FAIL', skipped: 'skipped', info: 'info' };

/**
 * The host's own checklist result for the popup: each step with ok/fail and the
 * readiness item changes the host computed. These are the host's findings; the
 * agent's summary below them is only a claim. Only the steps that ran before
 * consent can show: a command proposal says it is not dry-run.
 */
export function describeVerification(result: VerifyResult): string {
  const lines = [result.ok ? 'Host checks (all passed):' : 'Host checks (FAILED):'];
  for (const step of result.steps) lines.push(`  ${step.id} ${step.label}: ${MARK[step.status]} - ${step.detail}`);
  lines.push('Readiness item changes the host computed:');
  if (result.changes.length === 0) lines.push('  none');
  for (const change of result.changes) lines.push(`  ${change.kind} ${change.id}`);
  return lines.join('\n');
}

/** The description with the host checks first, so a long agent diff cannot push them out of view. */
export function withVerification(description: ProposalDescription, result: VerifyResult): ProposalDescription {
  return { ...description, detail: `${describeVerification(result)}\n\n${description.detail}` };
}
