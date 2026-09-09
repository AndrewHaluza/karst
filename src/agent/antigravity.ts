import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  readFileSync,
} from 'node:fs';
import { join, dirname, isAbsolute, basename, extname } from 'node:path';
import type {
  AgentAdapter,
  AgentCapabilities,
  InteractiveCommand,
  InteractiveCommandOpts,
  MaterializeOpts,
  Materialized,
  RunHeadlessOpts,
  HeadlessResult,
} from './adapter.js';
import {
  renderWorkflowCommand,
  renderStartTaskCommand,
  renderResumeCommand,
  renderFixCommand,
  renderResolveConflictCommand,
  KARST_PLUGIN_NAME,
  slugCommandName,
  START_TASK_BASENAME,
  START_TASK_DESCRIPTION,
  START_TASK_ARGUMENT_HINT,
  RESUME_BASENAME,
  RESUME_DESCRIPTION,
  RESUME_ARGUMENT_HINT,
  FIX_BASENAME,
  FIX_DESCRIPTION,
  FIX_ARGUMENT_HINT,
  RESOLVE_CONFLICT_BASENAME,
  RESOLVE_CONFLICT_DESCRIPTION,
  RESOLVE_CONFLICT_ARGUMENT_HINT,
  RESERVED_BASENAMES,
} from './workflowCommand.js';
import { withStamp, writeGeneratedArtifact } from './generatedArtifact.js';
import { renderTestSkill } from './testSkill.js';
import { SUPPORTED, unsupported, type AdapterSurfaces } from './surfaces.js';
import { describeHeadlessFailure } from './cliFailure.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { attachUsage, extractTokenUsage } from './tokenUsage.js';

const AGY_BIN = 'agy';

function assertSafeAgentName(name: string): void {
  if (
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '..' ||
    name.split(/[/\\]/).includes('..') ||
    isAbsolute(name)
  ) {
    throw new Error(`materializeApproach: unsafe soloAgent.name "${name}"`);
  }
}

/** Writes the neutral package's artifacts + solo agent into a plugin dir this
 *  terminal owns. Never called for a directory that already exists. */
function writeApproachPlugin(
  opts: MaterializeOpts,
  pluginDir: string,
  artifacts: NonNullable<MaterializeOpts['pkg']['artifacts']>,
  solo: MaterializeOpts['soloAgent'],
): void {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: opts.pkg.id }, null, 2));

  for (const art of artifacts) {
    const src = join(opts.baseDir, opts.pkg.id, art.relPath);
    if (art.kind === 'command') {
      // Antigravity has no workspace `commands/` customization surface.
      // Preserve the command as an on-demand skill instead of silently
      // copying it to an undiscoverable directory.
      const name = basename(art.relPath, extname(art.relPath));
      const dest = join(pluginDir, 'skills', name, 'SKILL.md');
      mkdirSync(dirname(dest), { recursive: true });
      const body = readFileSync(src, 'utf8');
      writeFileSync(
        dest,
        [
          '---',
          `name: ${name}`,
          `description: Run the ${name} command from the ${opts.pkg.label} approach.`,
          '---',
          '',
          body,
        ].join('\n'),
      );
      continue;
    }
    const dest = join(pluginDir, art.relPath);
    if (art.kind === 'skill') {
      // A skill IS its folder (SKILL.md + referenced siblings).
      cpSync(dirname(src), dirname(dest), { recursive: true });
    } else {
      // `agent` — a single file, kept at its neutral `agents/<name>.md` path,
      // the same place a solo agent is written below (869ej1zpv G6: this was
      // the unnamed else-branch, so an approach shipping agents behaved
      // differently per core with nothing stating the intent).
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }

  if (solo) {
    const dest = join(pluginDir, 'agents', `${solo.name}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, solo.body);
  }
}

export interface HeadlessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SpawnHeadless = (
  command: string,
  args: string[],
  cwd: string,
  opts?: HeadlessSpawnOptions,
) => Promise<HeadlessSpawnResult>;

export type SpawnImpl = typeof spawn;

export function makeDefaultSpawn(spawnImpl: SpawnImpl): SpawnHeadless {
  return (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts, spawnImpl);
}

const defaultSpawn: SpawnHeadless = makeDefaultSpawn(spawn);

export class AntigravityAdapter implements AgentAdapter {
  // agy 1.1.12 persists per-call token usage in the conversation DB's
  // steps.metadata (field-9 submessage — see agyUsageWatch.ts), read by the
  // same sweep that reads lifecycle events (agyConversationWatch.ts). The hooks
  // remain non-executing; the DB is the channel.
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
    interactiveUsage: true,
  };
  readonly requiredBinary = AGY_BIN;

  /** Declared seam positions (869ej1zpv R1) — pinned against argv by the conformance suite. */
  readonly surfaces: AdapterSurfaces = {
    exactModel: SUPPORTED,
    model: SUPPORTED,
    effortHeadless: SUPPORTED,
    effortInteractive: SUPPORTED,
    allowedTools: unsupported(
      'the agy CLI exposes no per-run tool allowlist flag; only the whole-session ' +
        '`--dangerously-skip-permissions` switch, which permissionMode carries',
    ),
    permissionMode: SUPPORTED,
    resume: SUPPORTED,
    sessionName: unsupported('the agy CLI has no launch-time session-naming flag'),
    consoleStream: unsupported(
      'agy runs plain `-p`: its stdout is prose, not a line-per-event stream, so there ' +
        'is nothing for consoleFormat to render live',
    ),
    structuredOutput: unsupported(
      '`agy -p` returns the final answer as plain prose only; it exposes no JSON Schema ' +
        'flag, so the prose output contract + salvage parse stay the only path',
    ),
    hookChannel: unsupported(
      'agy loads hooks.json but never RUNS the hook commands in the CLI conversation ' +
        'path; lifecycle is READ from its conversation DB (agyConversationWatch.ts)',
    ),
    endpointRebind: unsupported(
      'no hook channel to rebind — the conversation watch runs in the extension host and ' +
        'is re-established by activation itself',
    ),
    mcpIsolationHeadless: unsupported(
      'the agy CLI has no per-invocation MCP-isolation flag; `agy mcp` only manages the ' +
        'persistent, cross-session server list (add/remove/list/enable/disable), so a ' +
        'headless -p run still inherits whatever servers are currently enabled',
    ),
    toolActivity: unsupported(
      'agy has no hook channel; lifecycle is READ from its conversation DB, ' +
        'which has no PostToolUse equivalent — tool activity per turn is unobservable',
    ),
    skillDiscovery: SUPPORTED,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  // `opts.sessionName` is deliberately dropped: the agy CLI has no launch-time
  // session-naming flag, so there is nothing to carry the terminal name into.
  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand {
    const args: string[] = [];
    // Lifecycle signals do not ride the launch: the conversation watch
    // (agyConversationWatch.ts) reads them from the CLI's conversation DB.

    if (opts.resume && opts.resume.length > 0) {
      args.push('--conversation', opts.resume);
    }
    if (opts.model && opts.model.length > 0) {
      args.push('--model', opts.model);
    }
    if (opts.effort && opts.effort.length > 0) {
      args.push('--effort', opts.effort);
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      args.push('-i', opts.initialPrompt);
    }
    return { command: AGY_BIN, args, env: {} };
  }

  materializeApproach(opts: MaterializeOpts): Materialized {
    const artifacts = opts.pkg.artifacts ?? [];
    const hasWorkflow = (opts.pkg.workflow?.length ?? 0) > 0;
    const solo = opts.soloAgent;
    if (solo) assertSafeAgentName(solo.name);
    if (artifacts.length === 0 && !hasWorkflow && !solo && !opts.cliContextPrefix) {
      return { extraArgs: [], ownedPaths: [] };
    }
    if (opts.pkg.id === KARST_PLUGIN_NAME) {
      throw new Error(`materializeApproach: approach id "${KARST_PLUGIN_NAME}" is reserved`);
    }
    if (RESERVED_BASENAMES.includes(slugCommandName(opts.pkg.id) as typeof RESERVED_BASENAMES[number])) {
      throw new Error(
        `materializeApproach: approach id "${opts.pkg.id}" slugs to reserved ` +
          `"${slugCommandName(opts.pkg.id)}" — it collides with a generated file`,
      );
    }

    // Antigravity discovers workspace customizations below `.agents/`. Keep
    // each neutral package as a namespaced plugin so its agents and skills do
    // not collide with customizations already present in the worktree.
    const pluginDir = join(opts.sessionDir, '.agents', 'plugins', opts.pkg.id);
    // A repository may check in its own plugin tree at this exact path. That
    // directory belongs to the repository, not this terminal: writing into it
    // corrupts tracked files, and claiming it would make session cleanup delete
    // them. Discover it as-is, never own it.
    const ownsPlugin = !existsSync(pluginDir);
    if (ownsPlugin) {
      writeApproachPlugin(opts, pluginDir, artifacts, solo);
    }

    let ownedKarstDir: string | undefined;
    if (hasWorkflow) {
      const karstDir = join(opts.sessionDir, '.agents', 'plugins', KARST_PLUGIN_NAME);
      // The dir is SHARED across approaches (it is named for the plugin), so a
      // re-launch under a second approach must still get ITS skill written —
      // skipping the whole dir left the seed invoking a skill that was never
      // generated (UNKNOWN-COMMAND-ISSUE). Ownership is claimed only when karst
      // created the dir; the per-FILE guard below keeps a repository's own
      // checked-in skill safe.
      {
        if (!existsSync(karstDir)) ownedKarstDir = karstDir;
        // The approach id is legal as a manifest/package id, but a `:` (or other
        // non-word punctuation) would break the generated skill name, its dir,
        // and its `$`-invocation on agy — slug it into kebab (UNKNOWN-COMMAND-ISSUE).
        const idSlug = slugCommandName(opts.pkg.id);
        const skillDir = join(karstDir, 'skills', idSlug);
        mkdirSync(skillDir, { recursive: true });
        const pluginJson = join(karstDir, 'plugin.json');
        if (!existsSync(pluginJson)) {
          writeFileSync(pluginJson, JSON.stringify({ name: KARST_PLUGIN_NAME }, null, 2));
        }
        const body = renderWorkflowCommand({
          id: opts.pkg.id,
          label: opts.pkg.label,
          phases: opts.pkg.workflow!,
          ...(opts.cliContextPrefix ? { contextCommand: opts.cliContextPrefix } : {}),
          ...(opts.cliStagePrefix ? { stageCommand: opts.cliStagePrefix } : {}),
          ...(opts.cliPhasePrefix ? { phaseCommand: opts.cliPhasePrefix } : {}),
          ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
        });
        const skill = [
          '---',
          `name: ${idSlug}`,
          `description: Run the ${opts.pkg.label} workflow for a Karst ticket.`,
          '---',
          '',
          withStamp(body),
        ].join('\n');
        writeGeneratedArtifact(join(skillDir, 'SKILL.md'), skill);
      }
    }

    // The test-family skill carries the resolved CLI prefix so the agent
    // never composes the --db/--manifest boilerplate itself. Written to the
    // shared karst plugin alongside the workflow skill.
    if (opts.cliTestPrefix) {
      const karstDir = join(opts.sessionDir, '.agents', 'plugins', KARST_PLUGIN_NAME);
      if (!existsSync(karstDir)) {
        mkdirSync(karstDir, { recursive: true });
        writeFileSync(join(karstDir, 'plugin.json'), JSON.stringify({ name: KARST_PLUGIN_NAME }, null, 2));
        if (!ownedKarstDir) ownedKarstDir = karstDir;
      }
      const testSkillDir = join(karstDir, 'skills', 'karst-test');
      mkdirSync(testSkillDir, { recursive: true });
      writeGeneratedArtifact(
        join(testSkillDir, 'SKILL.md'),
        renderTestSkill(opts.cliTestPrefix),
      );
    }

    let startTaskInvocation: string | undefined;
    let resumeInvocation: string | undefined;
    let fixInvocation: string | undefined;
    let resolveConflictInvocation: string | undefined;
    if (opts.cliContextPrefix) {
      const karstDir = join(opts.sessionDir, '.agents', 'plugins', KARST_PLUGIN_NAME);
      if (!existsSync(karstDir)) {
        mkdirSync(karstDir, { recursive: true });
        writeFileSync(join(karstDir, 'plugin.json'), JSON.stringify({ name: KARST_PLUGIN_NAME }, null, 2));
        if (!ownedKarstDir) ownedKarstDir = karstDir;
      }
      mkdirSync(join(karstDir, 'commands'), { recursive: true });

      const commandEntries: {
        basename: string;
        body: string;
        description: string;
        argumentHint?: string;
      }[] = [
        {
          basename: START_TASK_BASENAME,
          body: renderStartTaskCommand({
            contextCommand: opts.cliContextPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: START_TASK_DESCRIPTION,
          argumentHint: START_TASK_ARGUMENT_HINT,
        },
        {
          basename: RESUME_BASENAME,
          body: renderResumeCommand({
            contextCommand: opts.cliContextPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: RESUME_DESCRIPTION,
          argumentHint: RESUME_ARGUMENT_HINT,
        },
      ];

      if (opts.cliFixBriefPrefix) {
        commandEntries.push({
          basename: FIX_BASENAME,
          body: renderFixCommand({
            contextCommand: opts.cliContextPrefix,
            fixBriefCommand: opts.cliFixBriefPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: FIX_DESCRIPTION,
          argumentHint: FIX_ARGUMENT_HINT,
        });
      }

      if (opts.cliConflictBriefPrefix) {
        commandEntries.push({
          basename: RESOLVE_CONFLICT_BASENAME,
          body: renderResolveConflictCommand({
            contextCommand: opts.cliContextPrefix,
            conflictBriefCommand: opts.cliConflictBriefPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: RESOLVE_CONFLICT_DESCRIPTION,
          argumentHint: RESOLVE_CONFLICT_ARGUMENT_HINT,
        });
      }

      for (const entry of commandEntries) {
        const filePath = join(karstDir, 'commands', `${entry.basename}.md`);
        const frontmatterLines = [
          '---',
          `description: ${entry.description}`,
        ];
        if (entry.argumentHint) {
          frontmatterLines.push(`argument-hint: "${entry.argumentHint}"`);
        }
        frontmatterLines.push('---', '');
        const fullBody = frontmatterLines.join('\n') + entry.body;
        writeGeneratedArtifact(filePath, withStamp(fullBody));
      }

      // Per-ticket alias files for the manual-recovery commands (resume, fix,
      // resolve-conflict). Each alias is a copy whose basename includes the
      // ticket key so the command picker fuzzy-matches on it.
      if (opts.aliasTickets && opts.aliasTickets.length > 0) {
        const renderers: Record<string, (ticketKey: string) => string> = {
          [RESUME_BASENAME]: (tk) =>
            renderResumeCommand({
              contextCommand: opts.cliContextPrefix!,
              ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
              ticketKey: tk,
            }),
          ...(opts.cliFixBriefPrefix
            ? {
                [FIX_BASENAME]: (tk: string) =>
                  renderFixCommand({
                    contextCommand: opts.cliContextPrefix!,
                    fixBriefCommand: opts.cliFixBriefPrefix!,
                    ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
                    ticketKey: tk,
                  }),
              }
            : {}),
          ...(opts.cliConflictBriefPrefix
            ? {
                [RESOLVE_CONFLICT_BASENAME]: (tk: string) =>
                  renderResolveConflictCommand({
                    contextCommand: opts.cliContextPrefix!,
                    conflictBriefCommand: opts.cliConflictBriefPrefix!,
                    ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
                    ticketKey: tk,
                  }),
              }
            : {}),
        };
        const descriptions: Record<string, string> = {
          [RESUME_BASENAME]: RESUME_DESCRIPTION,
          [FIX_BASENAME]: FIX_DESCRIPTION,
          [RESOLVE_CONFLICT_BASENAME]: RESOLVE_CONFLICT_DESCRIPTION,
        };
        for (const ticket of opts.aliasTickets) {
          const slug = slugCommandName(ticket.key);
          if (!slug) continue;
          for (const [basename, render] of Object.entries(renderers)) {
            const aliasBasename = `${basename}-${slug}`;
            const filePath = join(karstDir, 'commands', `${aliasBasename}.md`);
            const frontmatterLines = [
              '---',
              `description: ${descriptions[basename] ?? ''}`,
            ];
            frontmatterLines.push('---', '');
            const fullBody = frontmatterLines.join('\n') + render(ticket.key);
            writeGeneratedArtifact(filePath, withStamp(fullBody));
          }
        }
      }

      startTaskInvocation = `/${KARST_PLUGIN_NAME}:${START_TASK_BASENAME}`;
      resumeInvocation = `/${KARST_PLUGIN_NAME}:${RESUME_BASENAME}`;
      if (opts.cliFixBriefPrefix) {
        fixInvocation = `/${KARST_PLUGIN_NAME}:${FIX_BASENAME}`;
      }
      if (opts.cliConflictBriefPrefix) {
        resolveConflictInvocation = `/${KARST_PLUGIN_NAME}:${RESOLVE_CONFLICT_BASENAME}`;
      }
    }

    // Sessions launch with `cwd === sessionDir`, so Antigravity discovers this
    // workspace plugin without an additional `--add-dir`.
    return {
      extraArgs: [],
      ownedPaths: [
        ...(ownsPlugin ? [pluginDir] : []),
        ...(ownedKarstDir ? [ownedKarstDir] : []),
      ],
      ...(hasWorkflow ? { invocation: `$${slugCommandName(opts.pkg.id)}` } : {}),
      ...(startTaskInvocation ? { startTaskInvocation } : {}),
      ...(resumeInvocation ? { resumeInvocation } : {}),
      ...(fixInvocation ? { fixInvocation } : {}),
      ...(resolveConflictInvocation ? { resolveConflictInvocation } : {}),
    };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = ['-p', opts.prompt];
    if (opts.resume) args.push('--conversation', opts.resume);
    // A resolved model must pin the run exactly as it does on every other core
    // (869ef1e6x, fixed for claude alone; this path kept falling back to the
    // CLI's own default, so an agy ticket's classify / PR-description / gate
    // calls ignored the model the ticket resolved — 869ej1zpv G1).
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    if (opts.effort) args.push('--effort', opts.effort);
    // `allowedTools` is declared unsupported on `surfaces` — the agy CLI has no
    // per-run tool allowlist flag. Declared, never silently dropped.

    // The prompt is ticket prose — never logged in full. The debug line names
    // the invocation and redacts the prompt to its length (§ debug logging).
    opts.debug?.(
      `[agent:antigravity] spawn: ${args
        .map((a) => (a === opts.prompt ? `<prompt:${opts.prompt.length} chars>` : a))
        .join(' ')} (cwd ${opts.cwd})`,
    );
    opts.debug?.(
      opts.onOutput
        ? `[agent:antigravity] console stream: forwarding live chunks`
        : `[agent:antigravity] console stream: none — no onOutput hook`,
    );
    const r = await this.spawnHeadless(AGY_BIN, args, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onDebug: opts.debug,
      onSpawned: opts.onSpawned,
      onOutput: opts.onOutput,
    });
    if (r.exitCode !== 0) {
      opts.debug?.(
        `[agent:antigravity] exit ${r.exitCode} — stdout: ${headlessPreview(r.stdout)}; stderr: ${headlessPreview(r.stderr)}`,
      );
      throw attachUsage(
        new Error(
          describeHeadlessFailure({
            tool: 'Antigravity',
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
          }),
        ),
        extractTokenUsage(r.stdout),
      );
    }

    // `agy -p` prints bare prose, so this is usually null and the instrumented
    // wrapper falls back to a MARKED estimate (§ token consumption stats). It is
    // still attempted: a future `agy` that reports counts must be believed over
    // any estimate, without another change here.
    const usage = extractTokenUsage(r.stdout);

    return {
      sessionId: '', // agy -p doesn't emit a parseable sessionId in stdout
      verdict: null,
      raw: r.stdout,
      ...(usage ? { usage } : {}),
    };
  }
}
