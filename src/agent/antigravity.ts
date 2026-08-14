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
import { renderWorkflowCommand, KARST_PLUGIN_NAME } from './workflowCommand.js';
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
      cpSync(dirname(src), dirname(dest), { recursive: true });
    } else {
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
    if (artifacts.length === 0 && !hasWorkflow && !solo) {
      return { extraArgs: [], ownedPaths: [] };
    }
    if (opts.pkg.id === KARST_PLUGIN_NAME) {
      throw new Error(`materializeApproach: approach id "${KARST_PLUGIN_NAME}" is reserved`);
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
      // Same rule as the <id> plugin: a checked-in `karst` plugin is the
      // repository's, so leave it alone rather than rewriting its skills.
      if (!existsSync(karstDir)) {
        ownedKarstDir = karstDir;
        const skillDir = join(karstDir, 'skills', opts.pkg.id);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(karstDir, 'plugin.json'),
          JSON.stringify({ name: KARST_PLUGIN_NAME }, null, 2),
        );
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
          `name: ${opts.pkg.id}`,
          `description: Run the ${opts.pkg.label} workflow for a Karst ticket.`,
          '---',
          '',
          body,
        ].join('\n');
        writeFileSync(join(skillDir, 'SKILL.md'), skill);
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
      ...(hasWorkflow ? { invocation: `$${opts.pkg.id}` } : {}),
    };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = ['-p', opts.prompt];
    if (opts.resume) args.push('--conversation', opts.resume);
    if (opts.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    if (opts.effort) args.push('--effort', opts.effort);
    // allowedTools mapped or omitted if unsupported.

    // The prompt is ticket prose — never logged in full. The debug line names
    // the invocation and redacts the prompt to its length (§ debug logging).
    opts.debug?.(
      `[agent:antigravity] spawn: ${args
        .map((a) => (a === opts.prompt ? `<prompt:${opts.prompt.length} chars>` : a))
        .join(' ')} (cwd ${opts.cwd})`,
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
