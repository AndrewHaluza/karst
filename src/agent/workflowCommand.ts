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

/**
 * Slug an approach id into a command/skill basename that is legal in every
 * agent's command namespace. An approach id like `superpowers:writing-plans` is
 * legal in the manifest and as a package directory, but the `:` (a namespace
 * separator on claude, codex, and agy) and any other non-word punctuation break
 * the generated command/skill name — claude parsed `/karst:superpowers:writing-plans`
 * as plugin `karst` + command `superpowers` with `:writing-plans` left over as
 * args, reporting "Unknown command" (UNKNOWN-COMMAND-ISSUE). Lowercased kebab
 * matches what every agent discovers under its own plugin/skills dir.
 */
export function slugCommandName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * Basename (no `.md`) of the generated orchestrator file for an approach,
 * slugged so the slash command it registers is valid on every core.
 */
export function orchestratorCommandBasename(approachId: string): string {
  return slugCommandName(approachId);
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
 * The explicit done-marker instruction (§5.4). A session ending is NOT a verdict,
 * so the agent must fire `<stageCommand> <ticketArg>` itself once the stage's
 * work is done — code, research, OR a bare confirmation (a zero-code ticket has
 * no "implementation complete" moment, so the trigger must not hinge on one, or
 * research/confirm tickets strand).
 *
 * The wording names no stage: `stageCommand` already carries the one the agent is
 * working on (`stage impl pass`, `stage fix pass`, …), and the same text seeds
 * the generated workflow command (arg = `$ARGUMENTS`, substituted by the agent
 * CLI), a `direct`/no-approach launch, AND a fix resume (arg = the concrete
 * ticket key) — so it must not promise any one destination.
 */
export function renderDoneMarkerInstruction(stageCommand: string, ticketArg: string): string {
  return (
    "When you have finished this stage's work — whether that is code, research, or a " +
    `confirmation — run \`${stageCommand} ${ticketArg}\` to record the done marker and ` +
    'advance the ticket to its next stage. A session ending does not advance the ticket ' +
    'on its own — you must fire this marker explicitly. Do NOT fire it while you are ' +
    'waiting for the user to answer a question: a stage whose agent is waiting on the ' +
    'user is not complete, and the marker will be refused. If access to the Karst registry ' +
    'is denied, request approval to run this exact marker command outside the workspace sandbox.'
  );
}

/**
 * The non-marker counterpart to `renderDoneMarkerInstruction` (§5.4, 869edna84):
 * seeded when `markerStageFor` returns null, i.e. the ticket's current stage is
 * a gate (`uat`/`review`/`ship`) with no done marker to fire at all. Without
 * this, a session opened at a gate stage was told nothing about how the stage
 * ends. Names NO command — a gate's verdict comes only from its exit codes,
 * never from the agent self-reporting — so there is nothing to run here.
 */
export function renderGateOnlyInstruction(): string {
  return (
    "This stage is decided by its gate exit codes, not by anything you report — " +
    'there is no marker command to run here. Your job is to make the gates pass: ' +
    'do the work the gate is checking for, and Karst will detect the result and ' +
    'advance the ticket on its own once the checks are green.'
  );
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
   * $ARGUMENTS` once the ticket's work is done to advance impl→uat (the explicit
   * §5.4 marker — a session ending is NOT a verdict, so the agent must fire this
   * itself). The generated command is materialized once and only ever covers the
   * impl boundary, so its `stageCommand` is always the `impl` one. Absent → no
   * marker step (the impl boundary stays manual).
   */
  stageCommand?: string;
  /**
   * When given, each phase step gains ONE extra clause: run
   * `<phaseCommand(name)> $ARGUMENTS` on entering that phase, so karst has
   * deterministic evidence of where inside a long impl stage the session is.
   *
   * A function of the phase name, not a fixed prefix, because the name is baked
   * into the middle of the composed command (`… phase research --db … --ticket`)
   * exactly as the stage token is in `stageCommand` — the caller owns the whole
   * wire format, this function only appends the ticket arg.
   *
   * Absent → the steps render byte-identically to a build with no marker
   * support at all. That matters: an approach materialized by a host that cannot
   * accept marks must not be told to run a command that does not exist.
   */
  phaseCommand?: (phaseName: string) => string;
  /**
   * When given, the load instruction gains ONE clause pointing the agent at
   * the manual: run `<guideCommand>` to learn how Karst works, what the flow
   * is, and what the CLI can do. One short clause on purpose — the guide is
   * pulled on demand, never embedded in the command body.
   */
  guideCommand?: string;
}): string {
  const { id, label, phases, contextCommand, stageCommand, phaseCommand, guideCommand } = input;
  const loadInstruction = contextCommand
    ? 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      `First, load the ticket's full context by running \`${contextCommand} $ARGUMENTS\` ` +
      'and read the result — re-run it any time you need to refresh live worktree, ' +
      'branch, service, or PR state.'
    : 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      'First, read and describe the ticket identified by `$ARGUMENTS` so you understand ' +
      'what is being asked before proceeding.';
  const guideClause = guideCommand
    ? ` To understand how Karst works and what this CLI can do, run \`${guideCommand}\`.`
    : '';
  const lines: string[] = [
    `# ${label}`,
    '',
    loadInstruction + guideClause,
    '',
    ...(phaseCommand
      ? [
          'Phase marker commands write Karst state outside the worktree. If the workspace ' +
            'sandbox denies one, request approval to run that exact marker command outside ' +
            'the workspace sandbox.',
          '',
        ]
      : []),
    'Then work through the following phases in order:',
    '',
  ];
  phases.forEach((phase, i) => {
    const step = i + 1;
    const parts: string[] = [`**${phase.name}**`];
    if (phase.description !== undefined) parts.push(phase.description);
    // Placed BEFORE the phase's own instruction so reading order is execution
    // order. Worded "first" but printed last, the agent meets "run the slash
    // command" before it is told to report, and the marker is the clause most
    // easily skipped — non-compliance is what makes this whole feature record
    // nothing (§8).
    //
    // One short clause, deliberately: these markers compete with the actual work
    // (§8, command-line noise). "Report entering" — a mark says the agent said
    // it was starting this phase, never that it completed one.
    if (phaseCommand) {
      parts.push(`First run \`${phaseCommand(phase.name)} $ARGUMENTS\` to report entering it.`);
    }
    if (phase.command !== undefined) parts.push(`Run the \`${phase.command}\` slash command.`);
    else parts.push('Handle this step manually (no native slash command for this phase).');
    lines.push(`${step}. ${parts.join(' — ')}`);
  });
  if (stageCommand) {
    lines.push('', renderDoneMarkerInstruction(stageCommand, '$ARGUMENTS'));
  }
  return lines.join('\n');
}
