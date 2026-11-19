import type { VerifyResult, VerifyStep } from './verify/types.js';
import type { ChangeProposal, RunProposal, WriteFileProposal } from './proposal.js';

/**
 * Human-facing descriptions of a setup proposal: what the extension shows
 * before the user approves. Pure and deterministic so the exact text the user
 * reads is unit-tested, not assembled ad hoc in the host binding.
 *
 * A run shows its purpose and its exact command, and says it is not dry-run.
 * A write-file shows the diff that the host built itself.
 */

export interface ProposalDescription {
  /** The one-line question shown in the modal. */
  message: string;
  /** The expanded detail: the diff, the start commands, or the exact change. */
  detail: string;
  /** True when a revision changed the start commands vs the current manifest (the edit list sets it). */
  startCommandsChanged: boolean;
}

export function describeRunProposal(run: RunProposal, dir: string): ProposalDescription {
  return {
    message: run.repo !== undefined ? `Run this command for "${run.repo}"?` : `Run this command in "${run.path}"?`,
    detail: [
      `Directory: ${dir}`,
      `Purpose: ${run.purpose}`,
      '',
      `Command: ${run.command}`,
      '',
      'This command is not dry-run: the host cannot preview what it does. It runs only after you approve.',
      'The host keeps a copy of the .karst/ files and restores them if the command changes them.',
    ].join('\n'),
    startCommandsChanged: false,
  };
}

/** The diff is the host's own build from the path and the content; the agent never wrote patch text. */
export function describeWriteFileProposal(write: WriteFileProposal, dir: string, patch: string): ProposalDescription {
  return {
    message: `Write "${write.path}" in "${write.repo}"?`,
    detail: [`Directory: ${dir}`, '', 'Diff built by the host:', patch].join('\n'),
    startCommandsChanged: false,
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
