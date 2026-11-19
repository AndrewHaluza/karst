/**
 * The one popup of a typed edit list (@arch:CLI-21). Pure: the text the user
 * reads is unit-tested. Protected changes come first, in their own block, with
 * old -> new values. Every start command the result runs is listed.
 */

import { listStartCommands } from '../../setup/manifestApply.js';
import type { ProposalDescription } from '../../setup/review.js';
import type { BuildSuccess } from './build.js';
import { formatChange } from '../../setup/pathDiff.js';
import { splitProtected } from './protection.js';

const COMMENT_NOTE = 'The host writes karst.yml with js-yaml: it drops the comments of the file.';
const SCAFFOLD_NOTE = 'karst.yml does not exist: the host writes the scaffold first, then applies the edits.';

export function describeEdits(built: BuildSuccess, opCount: number): ProposalDescription {
  const { protectedChanges, otherChanges } = splitProtected(built.changes);
  const lines: string[] = [];
  if (protectedChanges.length > 0) {
    lines.push('PROTECTED fields this write changes:');
    for (const change of protectedChanges) lines.push(`  ${formatChange(change)}`);
    lines.push('');
  }
  lines.push(otherChanges.length > 0 ? 'Changes:' : 'No other field changes.');
  for (const change of otherChanges) lines.push(`  ${formatChange(change)}`);
  if (built.fixes.length > 0) lines.push('', `Fixes: ${built.fixes.join(', ')}.`);
  const startCommands = listStartCommands(built.manifest);
  const before = listStartCommands(built.before);
  const key = (list: typeof startCommands): string => list.map((s) => `${s.repo}=${s.command}`).join('|');
  lines.push('', 'Start commands this manifest will run:');
  if (startCommands.length === 0) lines.push('  (none)');
  for (const s of startCommands) lines.push(`  ${s.repo}: ${s.command}`);
  const startCommandsChanged = key(before) !== key(startCommands);
  if (startCommandsChanged) lines.push('', 'These start commands differ from the current manifest.');
  lines.push('', COMMENT_NOTE);
  if (built.scaffolded) lines.push(SCAFFOLD_NOTE);
  const protectedNote = protectedChanges.length > 0 ? `, ${protectedChanges.length} protected` : '';
  return {
    message: `Apply ${opCount} setup edit(s) to karst.yml? ${built.changes.length} field change(s)${protectedNote}.`,
    detail: lines.join('\n'),
    startCommandsChanged,
  };
}
