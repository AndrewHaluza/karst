import type { WorkflowPhase } from '../manifest/types.js';
import { MARKER_REFUSED, GATE_DECIDED_BY_EXIT_CODES, GUIDE_POINTER_INTRO } from './promptText.js';

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
 * Basename of the generated start-task orchestrator — the human-facing
 * launch's entry point. RESERVED: an approach id that slugs to this name
 * would overwrite the generated file, so every adapter throws on it, exactly
 * as they do for `KARST_PLUGIN_NAME`.
 */
export const START_TASK_BASENAME = 'start-task';
export const RESUME_BASENAME = 'resume';
export const FIX_BASENAME = 'fix';
export const RESOLVE_CONFLICT_BASENAME = 'resolve-conflict';

/**
 * Every reserved basename — an approach id that slugs to any of these would
 * overwrite a generated file, so every adapter's guard checks this list.
 */
export const RESERVED_BASENAMES = [
  START_TASK_BASENAME,
  RESUME_BASENAME,
  FIX_BASENAME,
  RESOLVE_CONFLICT_BASENAME,
] as const;

/**
 * Display-only description rendered beside the command in claude's picker.
 * Nothing parses or completes from it; codex, opencode and antigravity ignore
 * the field.
 */
export const START_TASK_DESCRIPTION =
  'Open a Karst ticket stage — load live operational context, work the brief, close the stage.';
export const RESUME_DESCRIPTION =
  'Resume work on a Karst ticket already in progress — reload live context and continue.';
export const FIX_DESCRIPTION =
  'Run the fix brief, load its output as the work, and close the failed stage.';
export const RESOLVE_CONFLICT_DESCRIPTION =
  'Resolve a named merge conflict for a Karst ticket and close the stage.';

/**
 * Display-only hint rendered beside the command in claude's picker (the
 * convention already checked in at `.agents/skills/karst-rpi-plan/SKILL.md:4`).
 * Nothing parses or completes from it; codex, opencode and antigravity ignore
 * the field.
 */
export const START_TASK_ARGUMENT_HINT = '<ticket-key> <brief>';
export const RESUME_ARGUMENT_HINT = '<ticket-key>';
export const FIX_ARGUMENT_HINT = '<ticket-key>';
export const RESOLVE_CONFLICT_ARGUMENT_HINT = '<ticket-key> <repo>';

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
    `on its own — you must fire this marker explicitly. Do NOT fire it while you are ` +
    'waiting for the user to answer a question: a stage whose agent is waiting on the ' +
    `user is not complete, and the ${MARKER_REFUSED}. If access to the Karst registry ` +
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
    `This stage is ${GATE_DECIDED_BY_EXIT_CODES}, not by anything you report — ` +
    'there is no marker command to run here. Your job is to make the gates pass: ' +
    'do the work the gate is checking for, and Karst will detect the result and ' +
    'advance the ticket on its own once the checks are green.'
  );
}

/**
 * Shared core paragraphs emitted by all four human-facing command renderers.
 * NOT exported — an implementation detail kept private so the four bodies
 * share one copy of the context-pull, authoritative-output, re-run,
 * worktree-prohibition, and session-ending prose.
 */
function renderCommandCore(contextCommand: string, guideCommand?: string): string {
  const lines: string[] = [
    `Load the ticket's full context by running:`,
    '',
    '```bash',
    `${contextCommand} <key> --md`,
    '```',
    '',
    'where `<key>` is that first token.',
    '',
    'The output is authoritative for the current stage, repositories in scope, worktrees and branches you must work inside, running servers, open pull requests, attachments, and how this stage ends — the `## How this stage ends` section names either the exact done-marker command to run or states that the stage is decided by gate exit codes.',
    '',
    'Re-run this command whenever those facts may have moved. Do not work outside the worktree it names.',
    '',
    `A session ending does not advance the ticket — you must fire the marker explicitly. Do NOT fire it while you are waiting for the user to answer a question: a stage whose agent is waiting on the user is not complete, and the ${MARKER_REFUSED}.`,
  ];
  if (guideCommand) {
    lines.push('', `${GUIDE_POINTER_INTRO}, run \`${guideCommand}\`.`);
  }
  return lines.join('\n');
}

/**
 * Render the markdown body for the generated start-task orchestrator — the
 * ticket-independent entry point every adapter materializes. Returns BODY
 * ONLY (no frontmatter): `skillDocument(name, description, body)` prepends
 * the `---` block, so emitting frontmatter here would produce a second block.
 *
 * Pure: no fs, no date, no randomness — identical inputs yield identical bytes
 * so `writeGeneratedArtifact` stamping stays meaningful.
 */
export function renderStartTaskCommand(input: {
  contextCommand: string;
  guideCommand?: string;
}): string {
  const { contextCommand, guideCommand } = input;
  const grammarParagraph =
    'The first whitespace-delimited token in `$ARGUMENTS` is the ticket key; everything after it is the brief the user wrote, and the brief is the work.';
  return grammarParagraph + '\n\n' + renderCommandCore(contextCommand, guideCommand);
}

/**
 * Render the markdown body for the generated resume command. The session is
 * resuming work already in progress — there is no brief to restate.
 * Returns BODY ONLY (no frontmatter).
 *
 * When `ticketKey` is given, the `$ARGUMENTS` grammar paragraph is replaced
 * with a sentence naming the concrete key, and `<key>` in the command lines
 * is substituted with the actual key — for per-ticket alias files.
 */
export function renderResumeCommand(input: {
  contextCommand: string;
  guideCommand?: string;
  ticketKey?: string;
}): string {
  const { contextCommand, guideCommand, ticketKey } = input;
  if (ticketKey) {
    const core = renderCommandCore(contextCommand, guideCommand)
      .replace(/<key>/g, ticketKey);
    return `This command is for ticket \`${ticketKey}\`.\n\n${core}`;
  }
  const grammarParagraph =
    'The first whitespace-delimited token in `$ARGUMENTS` is the ticket key. ' +
    'This session is resuming work already in progress — there is no brief.';
  return grammarParagraph + '\n\n' + renderCommandCore(contextCommand, guideCommand);
}

/**
 * Render the markdown body for the generated fix command. The brief is produced
 * by running `fixBriefCommand <key>` FIRST; its output is the work.
 * Returns BODY ONLY (no frontmatter).
 *
 * When `ticketKey` is given, the `$ARGUMENTS` grammar paragraph is replaced
 * with a sentence naming the concrete key, and `<key>` in the command lines
 * is substituted with the actual key — for per-ticket alias files.
 */
export function renderFixCommand(input: {
  contextCommand: string;
  fixBriefCommand: string;
  guideCommand?: string;
  ticketKey?: string;
}): string {
  const { contextCommand, fixBriefCommand, guideCommand, ticketKey } = input;
  if (ticketKey) {
    const core = renderCommandCore(contextCommand, guideCommand)
      .replace(/<key>/g, ticketKey);
    const briefLine = `Run \`${fixBriefCommand} ${ticketKey}\` FIRST and treat its output as the work — the brief names the gate that failed and what it reported.`;
    return `This command is for ticket \`${ticketKey}\`.\n\n${briefLine}\n\n${core}`;
  }
  const grammarParagraph =
    'The first whitespace-delimited token in `$ARGUMENTS` is the ticket key. ' +
    `Run \`${fixBriefCommand} <key>\` FIRST and treat its output as the work — the brief ` +
    'names the gate that failed and what it reported.';
  return grammarParagraph + '\n\n' + renderCommandCore(contextCommand, guideCommand);
}

/**
 * Render the markdown body for the generated resolve-conflict command. The
 * `$ARGUMENTS` grammar is `<key> <repo>`, the first two whitespace-delimited
 * tokens. Returns BODY ONLY (no frontmatter).
 *
 * When `ticketKey` is given, the `$ARGUMENTS` grammar paragraph is replaced
 * with a sentence naming the concrete key, and `<key>` in the command lines
 * is substituted with the actual key — for per-ticket alias files.
 */
export function renderResolveConflictCommand(input: {
  contextCommand: string;
  conflictBriefCommand: string;
  guideCommand?: string;
  ticketKey?: string;
}): string {
  const { contextCommand, conflictBriefCommand, guideCommand, ticketKey } = input;
  if (ticketKey) {
    const core = renderCommandCore(contextCommand, guideCommand)
      .replace(/<key>/g, ticketKey);
    const briefLine = `Run \`${conflictBriefCommand} ${ticketKey} <repo>\` FIRST — resolving the named conflict is the whole job and it must not drift into other work.`;
    return `This command is for ticket \`${ticketKey}\`.\n\n${briefLine}\n\n${core}`;
  }
  const grammarParagraph =
    'The first two whitespace-delimited tokens in `$ARGUMENTS` are `<key>` and `<repo>`. ' +
    `Run \`${conflictBriefCommand} <key> <repo>\` FIRST — resolving the named conflict is the ` +
    'whole job and it must not drift into other work.';
  return grammarParagraph + '\n\n' + renderCommandCore(contextCommand, guideCommand);
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
  // Every CLI command this body inlines shares the same `node "<cli>"` head. Emit
  // that shared invocation ONCE as the `KARST` alias at the top of the body, then
  // write the informational steps (context load, guide, phase-enter markers) as
  // `$KARST <tail>` — the same command the agent runs, without the repeated
  // absolute path. Only the steps that USE the alias (`context`/`guide`/`phase`)
  // drive it; the done-marker is never aliased (see the closing note below).
  const aliasCommands = [
    contextCommand,
    guideCommand,
    ...(phaseCommand ? phases.map((p) => phaseCommand(p.name)) : []),
  ].filter((c): c is string => typeof c === 'string');
  let karstAlias: string | undefined;
  let expand = (cmd: string): string => cmd;
  if (aliasCommands.length > 0) {
    // The shared head `node "<cli>"`. Guarded: an unexpected first command that
    // is not a `node` invocation simply disables the alias instead of crashing.
    const head = /^node ("[^"]+"|[^\s]+)/.exec(aliasCommands[0]!)?.[0];
    if (head) {
      karstAlias = head;
      expand = (cmd) => `$KARST ${cmd.slice(head.length).trim()}`;
    }
  }
  const karstBlock = karstAlias
    ? [
        '`$KARST` is the CLI invocation defined once here — expand it in place when you run a command:',
        '',
        `KARST = ${karstAlias}`,
        '',
      ]
    : [];
  const loadInstruction = contextCommand
    ? 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      `First, load the ticket's full context by running \`${expand(contextCommand)} $ARGUMENTS\` ` +
      'and read the result — re-run it any time you need to refresh live worktree, ' +
      'branch, service, or PR state.'
    : 'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      'First, read and describe the ticket identified by `$ARGUMENTS` so you understand ' +
      'what is being asked before proceeding.';
  const guideClause = guideCommand
    ? ` ${GUIDE_POINTER_INTRO}, run \`${expand(guideCommand)}\`.`
    : '';
  const lines: string[] = [
    `# ${label}`,
    '',
    ...karstBlock,
    loadInstruction + guideClause,
    '',
    ...(phaseCommand
      ? [
          'Phase marker commands write Karst state outside the worktree. If the workspace ' +
            'sandbox denies one, request approval to run that exact phase marker command — ' +
            'with `$KARST` expanded to its full invocation — outside the workspace sandbox.',
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
      parts.push(
        `First run \`${expand(phaseCommand(phase.name))} $ARGUMENTS\` to report entering it.`,
      );
    }
    if (phase.command !== undefined) parts.push(`Run the \`${phase.command}\` slash command.`);
    else parts.push('Handle this step manually (no native slash command for this phase).');
    lines.push(`${step}. ${parts.join(' — ')}`);
  });
  // The done-marker is the ONE command that MUST run: firing it is what advances
  // the ticket, and the same instruction is seeded verbatim (where no alias is
  // defined). It is therefore rendered as a fully-expanded invocation a shell can
  // execute as written — a documented alias is not in scope for the fresh shell a
  // marker is run in. The phase-enter markers above are informational and may use
  // `$KARST`; this closing instruction never does.
  if (stageCommand) {
    lines.push('', renderDoneMarkerInstruction(stageCommand, '$ARGUMENTS'));
  }
  return lines.join('\n');
}
