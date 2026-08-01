import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, cpSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
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
import { renderWorkflowCommand, KARST_PLUGIN_NAME, orchestratorCommandBasename } from './workflowCommand.js';
import { writeHookSettings } from './settings.js';
import { describeHeadlessFailure } from './cliFailure.js';
import { sanitizeSessionName } from './sessionName.js';

/** The Claude Code CLI binary; auth inherits the user's login (M0/T0.1). */
const CLAUDE_BIN = 'claude';

/**
 * Reject a `soloAgent.name` that could escape the plugin's `agents/` dir when
 * joined into a path: separators, `..` segments, or an absolute path. Kept
 * local (not imported from `approaches/sanitize.ts` or `agents/pkg.ts`) so
 * this agent-adapter seam stays free of the approaches module — the name
 * arrives from `PoolAgent.name` (already guarded on write), but a defensive
 * check here means a plugin-dir escape can never happen even if that
 * invariant is ever violated upstream.
 */
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

/** Result of a headless CLI invocation (stdout captured, exit code checked). */
export interface HeadlessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The headless-spawn seam: runs the CLI and captures stdout. Injected so
 * `runHeadless` is unit-testable without spawning a real process; the default
 * shells out to `claude`.
 */
export type SpawnHeadless = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<HeadlessSpawnResult>;

/** The real `child_process.spawn` signature, injected so the default spawner
 * is unit-testable without spawning a real process. */
export type SpawnImpl = typeof spawn;

/**
 * Build the default headless spawner from an injectable `spawn` implementation.
 * `stdio: ['ignore', 'pipe', 'pipe']` explicitly closes the child's stdin —
 * without it, Node defaults stdin to an open, never-written, never-ended pipe,
 * and `claude -p` (headless) on a non-TTY stdin hangs waiting on it before
 * erroring "no stdin data received". With stdin ignored, `child.stdin` is
 * `null`, so it is never referenced below.
 */
export function makeDefaultSpawn(spawnImpl: SpawnImpl): SpawnHeadless {
  return (command, args, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawnImpl(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: unknown) => (stdout += String(d)));
      child.stderr?.on('data', (d: unknown) => (stderr += String(d)));
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
}

/** Default spawner: run `claude` in `cwd`, buffering stdout/stderr. */
const defaultSpawn: SpawnHeadless = makeDefaultSpawn(spawn);

/**
 * Claude Code implementation of the agent boundary (MVP's one adapter, §2.6).
 * Keeps every Claude-specific flag here so nothing leaks past `AgentAdapter`.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly capabilities: AgentCapabilities = { lifecycleEvents: true, resume: true };
  readonly requiredBinary = CLAUDE_BIN;

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  /**
   * Interactive session command for a VS Code terminal (T3.3). No `-p` — this is
   * a live session, not a headless run. When a `settingsPath` is supplied it is
   * threaded as `--settings <path>` so the HTTP hook channel is registered and
   * liveness/needs-you actually fire for interactive sessions (closes T0.2).
   */
  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand {
    const args: string[] = [];
    if (opts.hookChannel) {
      args.push(
        '--settings',
        writeHookSettings(
          opts.hookChannel.endpointUrl,
          opts.hookChannel.configDir,
        ),
      );
    }
    if (opts.resume && opts.resume.length > 0) {
      // Continue a previously-captured session instead of a cold start (§5.3).
      args.push('--resume', opts.resume);
    }
    // The terminal's rendered display name, threaded as claude's `-n/--name` so
    // the session shows the ticket in the `/resume` picker instead of a summary
    // of its first message. Passed on a resume too: the ticket may have been
    // renamed since, and a stale label is the thing this is meant to fix.
    const sessionName = sanitizeSessionName(opts.sessionName);
    if (sessionName) args.push('--name', sessionName);
    if (opts.model && opts.model.length > 0) {
      // Per-ticket (or manifest-default) launch model. Absent → the CLI picks
      // its own default. An option, so it goes before the `--`/positional seed.
      args.push('--model', opts.model);
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      // Agent-specific launch additions from materializeApproach (e.g. a plugin
      // dir). Appended before the `--`/positional so they parse as options.
      args.push(...opts.extraArgs);
    }
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      // `--` ends option parsing so the prompt is always a positional, even when
      // it starts with dashes (e.g. a doc's `---` YAML frontmatter) — otherwise
      // commander reads `---…` as an unknown option and `claude` exits 1.
      args.push('--', opts.initialPrompt);
    }
    return { command: CLAUDE_BIN, args, env: {} };
  }

  /**
   * Translate a neutral approach package into Claude Code **plugin** director(y/ies)
   * and return one `--plugin-dir <dir>` per plugin. This is the ONLY place the
   * plugin format exists (§ agent-agnostic seam). The `<id>` plugin dir, built
   * under `sessionDir/.karst-plugin/<id>/`, holds `.claude-plugin/plugin.json` +
   * the neutral `agents/ skills/ commands/` copied verbatim (structure preserved
   * — a skill IS its folder) plus the chosen single-subagent (when present).
   * When the manifest has a `workflow`, the generated orchestrator is written
   * instead into a SIBLING `karst` plugin (`sessionDir/.karst-plugin/karst/`,
   * `commands/<id>.md`) via `renderWorkflowCommand` so it registers as
   * `/karst:<id>` rather than colliding with the approach's own namespace
   * (§ Design 2 — two plugins). It is trusted, karst-authored content, so it
   * does NOT go through the untrusted-source `sanitizeFrontmatter` pass. A
   * package with no artifacts AND no workflow yields empty `extraArgs` (bare
   * launch) — UNLESS a `soloAgent` is present (§ single-subagent launch),
   * which is itself a reason to build the `<id>` plugin (it writes into `agents/`).
   */
  materializeApproach(opts: MaterializeOpts): Materialized {
    const artifacts = opts.pkg.artifacts ?? [];
    const hasWorkflow = (opts.pkg.workflow?.length ?? 0) > 0;
    const solo = opts.soloAgent;
    if (solo) assertSafeAgentName(solo.name);
    if (artifacts.length === 0 && !hasWorkflow && !solo) {
      return { extraArgs: [], ownedPaths: [] };
    }
    if (opts.pkg.id === KARST_PLUGIN_NAME) {
      // `karst` is reserved for the generated orchestrator's sibling plugin
      // (`.karst-plugin/karst/`, built below when `hasWorkflow`). An approach
      // with this id would collide: `idPluginDir` and `karstDir` resolve to the
      // SAME directory, so `extraArgs` would return two identical
      // `--plugin-dir` entries and the launch would break.
      throw new Error(
        `materializeApproach: approach id "${KARST_PLUGIN_NAME}" is reserved — it collides ` +
          `with the generated orchestrator plugin (§ Design 2 — two plugins)`,
      );
    }

    // The <id> plugin dir holds ONLY the approach's own artifacts + solo agent.
    const idPluginDir = join(opts.sessionDir, '.karst-plugin', opts.pkg.id);
    // A repository may check in its own plugin tree at this exact path (karst's
    // own repo does). That directory belongs to the repository, not this
    // terminal: writing into it corrupts tracked files, and claiming it would
    // make session cleanup delete them. Launch against it, never own it.
    const ownsIdPlugin = !existsSync(idPluginDir);
    if (ownsIdPlugin) {
      const metaDir = join(idPluginDir, '.claude-plugin');
      mkdirSync(metaDir, { recursive: true });
      const manifest = {
        name: opts.pkg.id,
        version: '0.0.0',
        ...(opts.pkg.description !== undefined ? { description: opts.pkg.description } : {}),
      };
      writeFileSync(join(metaDir, 'plugin.json'), JSON.stringify(manifest, null, 2));

      // Copy artifacts into the plugin, structure preserved. A skill IS its folder
      // (SKILL.md + referenced siblings), so copy the whole `skills/<name>/` dir;
      // agents/commands are single files.
      for (const art of artifacts) {
        const src = join(opts.baseDir, opts.pkg.id, art.relPath);
        const dest = join(idPluginDir, art.relPath);
        if (art.kind === 'skill') {
          cpSync(dirname(src), dirname(dest), { recursive: true });
        } else {
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(src, dest);
        }
      }

      // Materialize the chosen single-subagent (§ single-subagent launch) into
      // the plugin's `agents/` dir. Its body was already sanitized when written
      // to disk (agent file / approach artifact) — no second sanitize pass here
      // keeps this seam free of the untrusted-source module.
      if (solo) {
        const agentsPluginDir = join(idPluginDir, 'agents');
        mkdirSync(agentsPluginDir, { recursive: true });
        writeFileSync(join(agentsPluginDir, `${solo.name}.md`), solo.body);
      }
    }

    const pluginDirs: string[] = [idPluginDir];
    const owned: string[] = ownsIdPlugin ? [idPluginDir] : [];

    if (hasWorkflow) {
      // Design 2: the generated orchestrator lives in a SIBLING `karst` plugin so
      // it registers as `/karst:<id>` (not `/<id>:karst`). Native commands stay
      // in the <id> plugin as `/<id>:<name>`.
      const karstDir = join(opts.sessionDir, '.karst-plugin', KARST_PLUGIN_NAME);
      const ownsKarst = !existsSync(karstDir);
      if (ownsKarst) {
        const karstMeta = join(karstDir, '.claude-plugin');
        const karstCommands = join(karstDir, 'commands');
        mkdirSync(karstMeta, { recursive: true });
        mkdirSync(karstCommands, { recursive: true });
        writeFileSync(
          join(karstMeta, 'plugin.json'),
          JSON.stringify({ name: KARST_PLUGIN_NAME, version: '0.0.0' }, null, 2),
        );
        const body = renderWorkflowCommand({
          id: opts.pkg.id,
          label: opts.pkg.label,
          phases: opts.pkg.workflow!,
          ...(opts.cliContextPrefix ? { contextCommand: opts.cliContextPrefix } : {}),
          ...(opts.cliStagePrefix ? { stageCommand: opts.cliStagePrefix } : {}),
          ...(opts.cliPhasePrefix ? { phaseCommand: opts.cliPhasePrefix } : {}),
        });
        writeFileSync(join(karstCommands, `${orchestratorCommandBasename(opts.pkg.id)}.md`), body);
        owned.push(karstDir);
      }
      pluginDirs.push(karstDir);
    }

    return {
      extraArgs: pluginDirs.flatMap((d) => ['--plugin-dir', d]),
      ownedPaths: owned,
      ...(hasWorkflow
        ? {
            invocation: `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(
              opts.pkg.id,
            )}`,
          }
        : {}),
    };
  }

  /**
   * Headless, structured run (§5.5). Runs `claude -p <prompt> --output-format
   * json` in `cwd`, capturing stdout and parsing ClickUp-style JSON — the CLI's
   * envelope carries `session_id` and `result`. Rejects on a nonzero exit or
   * unparseable output so a failure is loud (the classify-gate then falls back
   * to manual signal entry). Verdict parsing is a stage-machine concern (M4);
   * here it is left null.
   */
  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = ['-p', opts.prompt, '--output-format', 'json'];
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    const r = await this.spawnHeadless(CLAUDE_BIN, args, opts.cwd);
    if (r.exitCode !== 0) {
      // The whole `--output-format json` envelope used to land on the stage
      // verdict; a 429 read as an internal crash. `describeHeadlessFailure`
      // unwraps it (shared by every agent core) — see cliFailure.ts.
      throw new Error(
        describeHeadlessFailure({
          tool: 'Claude',
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
        }),
      );
    }

    let parsed: { session_id?: string; result?: string };
    try {
      parsed = JSON.parse(r.stdout) as { session_id?: string; result?: string };
    } catch (e) {
      throw new Error(`claude output was not valid JSON: ${(e as Error).message}`);
    }

    return {
      sessionId: parsed.session_id ?? '',
      verdict: null,
      raw: parsed.result ?? '',
    };
  }
}
