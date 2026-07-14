import type { WorkflowPhase } from '../manifest/types.js';

/**
 * Name of the karst-authored plugin that hosts every generated orchestrator
 * command. A Claude plugin named `karst` exposes its command files as
 * `/karst:<basename>`; the orchestrator file for approach `<id>` is `<id>.md`,
 * so it registers as `/karst:<id>` (§ Design 2 — two plugins). This constant is
 * the SINGLE source of truth shared by the materializer (plugin dir name), the
 * seed invocation, the command title, and the Settings chips, so they can't drift.
 */
export const KARST_PLUGIN_NAME = 'karst';

/** Basename (no `.md`) of the generated orchestrator file for an approach. */
export function orchestratorCommandBasename(approachId: string): string {
  return approachId;
}

/**
 * The seed's first line for a workflow approach: the slash command that actually
 * gets registered (`/karst:<id>`) followed by the ticket key. Trimmed so a null
 * key yields just the command.
 */
export function buildWorkflowInvocation(approachId: string, ticketKey: string): string {
  return `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(approachId)} ${ticketKey}`.trim();
}

/**
 * Render the markdown body for the generated `/karst:<id>` slash command. Pure:
 * no fs, no side effects. Written to `karst/commands/<id>.md` inside the
 * karst-authored plugin at materialize time.
 *
 * When `contextCommand` is given, the body opens with a CONCRETE loader step:
 * run `<contextCommand> $ARGUMENTS` to pull the ticket's live context
 * (prompt/brief/repos plus worktrees/branches/services/PRs) from the local
 * store — so the command is re-runnable mid-session (or in a foreign session)
 * to refresh state the launch seed captured only once. Absent → the prior
 * generic "read and describe the ticket" instruction.
 */
export function renderWorkflowCommand(input: {
  id: string;
  label: string;
  phases: WorkflowPhase[];
  contextCommand?: string;
  /**
   * When given, a CLOSING marker step is appended: run `<stageCommand>
   * $ARGUMENTS` once implementation is complete to advance impl→uat (the
   * explicit §5.4 marker — a session ending is NOT a verdict, so the agent must
   * fire this itself). Absent → no marker step (the impl boundary stays manual).
   */
  stageCommand?: string;
}): string {
  const { id, label, phases, contextCommand, stageCommand } = input;
  const loadInstruction = contextCommand
    ? 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      `First, load the ticket's full context by running \`${contextCommand} $ARGUMENTS\` ` +
      'and read the result — re-run it any time you need to refresh live worktree, ' +
      'branch, service, or PR state.'
    : 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      'First, read and describe the ticket identified by `$ARGUMENTS` so you understand ' +
      'what is being asked before proceeding.';
  const lines: string[] = [
    `# /${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)} — ${label}`,
    '',
    loadInstruction,
    '',
    'Then work through the following phases in order:',
    '',
  ];
  phases.forEach((phase, i) => {
    const step = i + 1;
    const parts: string[] = [`**${phase.name}**`];
    if (phase.description !== undefined) parts.push(phase.description);
    if (phase.command !== undefined) parts.push(`Run the \`${phase.command}\` slash command.`);
    else parts.push('Handle this step manually (no native slash command for this phase).');
    lines.push(`${step}. ${parts.join(' — ')}`);
  });
  if (stageCommand) {
    lines.push(
      '',
      'When implementation is complete and the code is ready for review, run ' +
        `\`${stageCommand} $ARGUMENTS\` to record the implement-done marker and advance ` +
        'the ticket to the UAT gate. A session ending does not advance the ticket on its ' +
        'own — you must fire this marker explicitly.',
    );
  }
  return lines.join('\n');
}
