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
import { withStamp, writeGeneratedArtifact } from './generatedArtifact.js';
import { renderTestSkill } from './testSkill.js';
import { writeHookSettings } from './settings.js';
import { describeHeadlessFailure } from './cliFailure.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { sanitizeSessionName } from './sessionName.js';
import { SUPPORTED, unsupported, type AdapterSurfaces } from './surfaces.js';
import { attachUsage, extractTokenUsage } from './tokenUsage.js';
import { claudeConsoleLine } from './consoleFormat.js';

/** The Claude Code CLI binary; auth inherits the user's login (M0/T0.1). */
const CLAUDE_BIN = 'claude';
const CLAUDE_CONSOLE_CHUNK_BYTES = 64 * 1024;

/** Emit UTF-8 byte-bounded console messages without splitting a code point. */
function emitConsoleText(
  onOutput: NonNullable<RunHeadlessOpts['onOutput']>,
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  const encoded = Buffer.from(text, 'utf8');
  let start = 0;
  while (start < encoded.byteLength) {
    let end = Math.min(start + CLAUDE_CONSOLE_CHUNK_BYTES, encoded.byteLength);
    // When the byte cut lands inside a multi-byte sequence, walk back to the
    // leading byte. `start` is always a boundary, and UTF-8 code points are at
    // most four bytes, so a 64 KiB chunk can never walk all the way to start.
    while (end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
    onOutput({ stream, text: encoded.subarray(start, end).toString('utf8') });
    start = end;
  }
}

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
  opts?: HeadlessSpawnOptions,
) => Promise<HeadlessSpawnResult>;

/** The real `child_process.spawn` signature, injected so the default spawner
 * is unit-testable without spawning a real process. */
export type SpawnImpl = typeof spawn;

/**
 * Build the default headless spawner from an injectable `spawn` implementation.
 * The spawn closes the child's stdin (`stdio: ['ignore', 'pipe', 'pipe']`),
 * enforced inside `spawnHeadlessCli` — without it, Node defaults stdin to an
 * open, never-written, never-ended pipe, and `claude -p` (headless) on a non-TTY
 * stdin hangs waiting on it before erroring "no stdin data received". With stdin
 * ignored, `child.stdin` is `null`, so it is never referenced below.
 */
export function makeDefaultSpawn(spawnImpl: SpawnImpl): SpawnHeadless {
  return (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts, spawnImpl);
}

/** Default spawner: run `claude` in `cwd`, buffering stdout/stderr. */
const defaultSpawn: SpawnHeadless = makeDefaultSpawn(spawn);

/**
 * Claude Code implementation of the agent boundary (MVP's one adapter, §2.6).
 * Keeps every Claude-specific flag here so nothing leaks past `AgentAdapter`.
 */
export class ClaudeAdapter implements AgentAdapter {
  // Interactive usage for claude is measured by reading Claude Code's session
  // transcript (claudeTranscriptWatch.ts) — the hooks remain lifecycle-only
  // (settings.ts registers no UsageUpdate hook), the transcript is the channel.
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
    interactiveUsage: true,
  };
  readonly requiredBinary = CLAUDE_BIN;

  /** Declared seam positions (869ej1zpv R1) — pinned against argv by the conformance suite. */
  readonly surfaces: AdapterSurfaces = {
    exactModel: SUPPORTED,
    model: SUPPORTED,
    effortHeadless: SUPPORTED,
    effortInteractive: SUPPORTED,
    allowedTools: SUPPORTED,
    permissionMode: SUPPORTED,
    resume: SUPPORTED,
    sessionName: SUPPORTED,
    consoleStream: SUPPORTED,
    structuredOutput: SUPPORTED,
    hookChannel: SUPPORTED,
    endpointRebind: unsupported(
      'the channel is a --settings FILE read once by the CLI at launch, not a script ' +
        'karst controls; a rebound port needs a relaunch (see docs/agent-cores/HOOK-CONTRACT.md)',
    ),
    skillDiscovery: SUPPORTED,
  };

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
    if (opts.effort && opts.effort.length > 0) {
      args.push('--effort', opts.effort);
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
      // The dir is SHARED: it is named for the plugin, not the approach, so a
      // worktree first launched under one approach already holds it when the
      // ticket is re-launched under another. Skipping the whole dir on that
      // second launch wrote no command for the new approach while the seed
      // still invoked it — "Unknown command: /karst:<id>" (UNKNOWN-COMMAND-ISSUE).
      // Ownership is still claimed only when karst created the dir, and the
      // per-FILE guard (`writeGeneratedArtifact`) keeps a repository's own
      // checked-in command safe.
      const ownsKarst = !existsSync(karstDir);
      {
        const karstMeta = join(karstDir, '.claude-plugin');
        const karstCommands = join(karstDir, 'commands');
        mkdirSync(karstMeta, { recursive: true });
        mkdirSync(karstCommands, { recursive: true });
        const pluginJson = join(karstMeta, 'plugin.json');
        if (!existsSync(pluginJson)) {
          writeFileSync(
            pluginJson,
            JSON.stringify({ name: KARST_PLUGIN_NAME, version: '0.0.0' }, null, 2),
          );
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
        writeGeneratedArtifact(
          join(karstCommands, `${orchestratorCommandBasename(opts.pkg.id)}.md`),
          withStamp(body),
        );
        if (ownsKarst) owned.push(karstDir);
      }
      pluginDirs.push(karstDir);
    }

    // The test-family skill carries the resolved CLI prefix so the agent
    // never composes the --db/--manifest boilerplate itself. Written to the
    // shared karst plugin so it is available regardless of whether the
    // approach defines a workflow.
    if (opts.cliTestPrefix) {
      const karstDir = join(opts.sessionDir, '.karst-plugin', KARST_PLUGIN_NAME);
      if (!existsSync(karstDir)) {
        const karstMeta = join(karstDir, '.claude-plugin');
        mkdirSync(karstMeta, { recursive: true });
        const pluginJson = join(karstMeta, 'plugin.json');
        if (!existsSync(pluginJson)) {
          writeFileSync(
            pluginJson,
            JSON.stringify({ name: KARST_PLUGIN_NAME, version: '0.0.0' }, null, 2),
          );
        }
        owned.push(karstDir);
      }
      // Always ensure the karst plugin dir is in pluginDirs so Claude discovers
      // the test skill — even on re-launch when the dir already exists.
      if (!pluginDirs.includes(karstDir)) pluginDirs.push(karstDir);
      const testSkillDir = join(karstDir, 'skills', 'karst-test');
      writeGeneratedArtifact(
        join(testSkillDir, 'SKILL.md'),
        renderTestSkill(opts.cliTestPrefix),
      );
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
    const args = ['-p', '--output-format', 'json'];
    if (opts.resume) args.push('--resume', opts.resume);
    // A resolved launch model must pin the run: without `--model` the CLI falls
    // back to its own default (settings.json `"model"`, or the alias), which was
    // measured at opus pricing on a PR-description call (869ef1e6x). The ticket's
    // resolved model is a deliberate, visible choice; the CLI default is not.
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(','));
    }
    // Native structured output (Prompt 09): when a caller (the findings / UAT
    // tester lane) supplies a JSON Schema, hand it to `--json-schema` so the CLI
    // constrains its FINAL response to that shape — the salvage parser then
    // reads a clean whole-document array instead of coaxing one out of prose.
    // The JSON text is a single argv entry, never shell-interpolated.
    if (opts.outputSchema) {
      args.push('--json-schema', JSON.stringify(opts.outputSchema));
      opts.debug?.(
        `[agent:claude] structured output: enforcing the supplied JSON Schema on the final response`,
      );
    }
    // `--` ends option parsing so the prompt is always a positional, even when
    // it starts with dashes (e.g. a reviewer prompt's `---` YAML frontmatter) —
    // otherwise the CLI reads `---…` as an unknown option and exits 1 (same fix
    // as buildInteractiveCommand above).
    args.push('--', opts.prompt);

    // The prompt is ticket prose — never logged in full. The debug line names
    // the invocation and redacts the prompt to its length (§ debug logging).
    opts.debug?.(
      `[agent:claude] spawn: ${args
        .map((a) => (a === opts.prompt ? `<prompt:${opts.prompt.length} chars>` : a))
        .join(' ')} (cwd ${opts.cwd})`,
    );
    // Claude emits one newline-free JSON document rather than JSONL. Do NOT
    // pass the live chunks to a document buffer: HeadlessSpawnOptions.onOutput
    // sees bytes before the spawner's BoundedOutput cap. Format only the
    // already-bounded settle-time stdout so a runaway core cannot grow a
    // second, unbounded copy in the extension host.
    opts.debug?.(
      opts.onOutput
        ? `[agent:claude] console output: rendering the bounded JSON result as readable text`
        : `[agent:claude] console stream: none — no onOutput hook`,
    );
    // stdout is intentionally ignored here; only the spawner's bounded final
    // stdout is formatted below. stderr is unstructured diagnostics, so stream
    // it immediately: AgentConsole bounds/persists it as it arrives, including
    // before an abort, timeout or extension-host restart.
    const consoleOutput = opts.onOutput;
    let streamedStderr = false;
    const r = await this.spawnHeadless(CLAUDE_BIN, args, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onDebug: opts.debug,
      onSpawned: opts.onSpawned,
      onOutput: consoleOutput
        ? (chunk) => {
            if (chunk.stream !== 'stderr' || chunk.text.length === 0) return;
            streamedStderr = true;
            emitConsoleText(consoleOutput, 'stderr', chunk.text);
          }
        : undefined,
    });
    if (consoleOutput) {
      if (r.stdout.length > 0) {
        emitConsoleText(consoleOutput, 'stdout', claudeConsoleLine(r.stdout));
      }
      if (!streamedStderr && r.stderr.length > 0) {
        emitConsoleText(consoleOutput, 'stderr', r.stderr);
      }
    }
    if (r.exitCode !== 0) {
      opts.debug?.(
        `[agent:claude] exit ${r.exitCode} — stdout: ${headlessPreview(r.stdout)}; stderr: ${headlessPreview(r.stderr)}`,
      );
      // The whole `--output-format json` envelope used to land on the stage
      // verdict; a 429 read as an internal crash. `describeHeadlessFailure`
      // unwraps it (shared by every agent core) — see cliFailure.ts.
      // The counts ride out on the rejection: a 429 is reported AFTER the
      // provider has already billed the input (§ token consumption stats).
      throw attachUsage(
        new Error(
          describeHeadlessFailure({
            tool: 'Claude',
            exitCode: r.exitCode,
            stdout: r.stdout,
            stderr: r.stderr,
          }),
        ),
        extractTokenUsage(r.stdout),
      );
    }

    let parsed: { session_id?: string; result?: string };
    try {
      parsed = JSON.parse(r.stdout) as { session_id?: string; result?: string };
    } catch (e) {
      opts.debug?.(
        `[agent:claude] unparseable output — first 500 chars: ${headlessPreview(r.stdout)}`,
      );
      throw new Error(`claude output was not valid JSON: ${(e as Error).message}`);
    }

    // Read from the SAME stdout the answer came out of — the `usage` block is
    // part of the `--output-format json` envelope, so this costs no extra call.
    const usage = extractTokenUsage(r.stdout);

    return {
      sessionId: parsed.session_id ?? '',
      verdict: null,
      raw: parsed.result ?? '',
      ...(usage ? { usage } : {}),
    };
  }
}
