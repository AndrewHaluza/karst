import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
} from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AgentAdapter,
  AgentCapabilities,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  MaterializeOpts,
  Materialized,
  RunHeadlessOpts,
} from './adapter.js';
import {
  RESERVED_BASENAMES,
  START_TASK_DESCRIPTION,
  RESUME_DESCRIPTION,
  FIX_DESCRIPTION,
  RESOLVE_CONFLICT_DESCRIPTION,
  renderStartTaskCommand,
  renderResumeCommand,
  renderFixCommand,
  renderResolveConflictCommand,
  renderWorkflowCommand,
  slugCommandName,
} from './workflowCommand.js';
import { withStamp, writeGeneratedArtifact } from './generatedArtifact.js';
import { renderTestSkill } from './testSkill.js';
import { describeHeadlessFailure } from './cliFailure.js';
import { renderConsoleStream } from './consoleFormat.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { hookFailureLogPath } from './hookFailureLog.js';
import { resolveNodeExecutable } from './nodeExecutable.js';
import { HOOK_BRIDGE } from './hookBridge.js';
import { SUPPORTED, unsupported, type AdapterSurfaces } from './surfaces.js';
import { attachUsage, extractTokenUsage } from './tokenUsage.js';

const CODEX_BIN = 'codex';
const MAX_DIAGNOSTIC_CHARS = 8_000;
const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;

type CodexHookInput = Record<string, unknown>;
export type NormalizedHook = {
  hook_event_name: string;
  cwd: string;
  session_id: string;
  message?: string;
  /** Task 5: provider-supplied cumulative counts, when the payload carried them. */
  usage?: {
    event_id: string;
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    total?: number;
  };
};
type PostHook = (payload: NormalizedHook) => Promise<void>;

/** The TS mirror of the bridge's `usagePayload` — same drop rules. */
function usageFromInput(raw: CodexHookInput): NormalizedHook['usage'] | null {
  const usage =
    raw['usage'] !== null && typeof raw['usage'] === 'object' && !Array.isArray(raw['usage'])
      ? (raw['usage'] as Record<string, unknown>)
      : null;
  if (usage === null) return null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const eventId =
    typeof usage['event_id'] === 'string' && usage['event_id'].length > 0
      ? usage['event_id']
      : typeof raw['turn_id'] === 'string' && raw['turn_id'].length > 0
        ? raw['turn_id']
        : null;
  if (eventId === null) return null;
  const input = count(usage['input']);
  const output = count(usage['output']);
  if (input === null || output === null) return null;
  const cacheRead = count(usage['cache_read']);
  const cacheWrite = count(usage['cache_write']);
  const total = count(usage['total']);
  return {
    event_id: eventId,
    input,
    output,
    ...(cacheRead !== null ? { cache_read: cacheRead } : {}),
    ...(cacheWrite !== null ? { cache_write: cacheWrite } : {}),
    ...(total !== null ? { total } : {}),
  };
}

export function codexHookNormalizer(post: PostHook) {
  return async (input: CodexHookInput): Promise<void> => {
    const event = input.hook_event_name;
    const cwd = input.cwd;
    const sessionId = input.session_id;
    if (
      typeof event !== 'string' ||
      typeof cwd !== 'string' ||
      typeof sessionId !== 'string'
    ) {
      return;
    }
    const mapped =
      event === 'PermissionRequest'
        ? {
            hook_event_name: 'Notification',
            message: 'permission_prompt',
          }
        : event === 'Stop' &&
            typeof input.last_assistant_message === 'string' &&
            /\?\s*$/.test(input.last_assistant_message)
          ? {
              hook_event_name: 'Notification',
              message: 'idle_prompt',
            }
        : CODEX_HOOK_EVENTS.includes(
              event as (typeof CODEX_HOOK_EVENTS)[number],
            ) && event !== 'PermissionRequest'
          ? { hook_event_name: event }
          : null;
    if (mapped) {
      // PROMPT-15: forward tool_name on PostToolUse (same as the JS bridge).
      const toolName =
        event === 'PostToolUse' && typeof input.tool_name === 'string'
          ? { tool_name: input.tool_name }
          : {};
      await post({ ...mapped, ...toolName, cwd, session_id: sessionId });
    }
    const usage = usageFromInput(input);
    if (usage !== null) {
      await post({
        hook_event_name: 'UsageUpdate',
        cwd,
        session_id: sessionId,
        usage,
      });
    }
  };
}

function appendHookArgs(
  args: string[],
  configDir: string,
  endpointUrl: string,
): void {
  const target = new URL(endpointUrl);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.port === '' ||
    target.port === '0'
  ) {
    throw new Error(`karst: refusing non-loopback hook endpoint ${endpointUrl}`);
  }
  const diagnosticsPath = hookFailureLogPath(configDir);
  const bridgeDir = dirname(diagnosticsPath);
  const bridgePath = join(bridgeDir, 'bridge.cjs');
  mkdirSync(bridgeDir, { recursive: true });
  const current = existsSync(bridgePath)
    ? readFileSync(bridgePath, 'utf8')
    : null;
  if (current !== HOOK_BRIDGE) {
    const temporaryPath = `${bridgePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, HOOK_BRIDGE);
    renameSync(temporaryPath, bridgePath);
  }
  const command = [
    JSON.stringify(resolveNodeExecutable()),
    JSON.stringify(bridgePath),
    JSON.stringify(endpointUrl),
    JSON.stringify(diagnosticsPath),
  ].join(' ');
  // Remove every inherited hook before installing the complete event set
  // below. This makes the trust bypass authorize only Karst-authored commands,
  // never repository- or user-configured hooks.
  args.push('-c', 'hooks={}');
  for (const event of CODEX_HOOK_EVENTS) {
    const value =
      `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, ` +
      'timeout = 3 }] }]';
    args.push('-c', `hooks.${event}=${value}`);
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

const defaultSpawn: SpawnHeadless = (command, args, cwd, opts) =>
  spawnHeadlessCli(command, args, cwd, opts);

function diagnostic(text: string): string {
  return text.length <= MAX_DIAGNOSTIC_CHARS
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

export function parseCodexJsonl(
  stdout: string,
): { sessionId: string; raw: string } {
  let sessionId = '';
  let raw = '';
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `codex JSONL line ${index + 1} was invalid: ${
          (error as Error).message
        }`,
      );
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      if (sessionId && sessionId !== event.thread_id) {
        throw new Error('codex JSONL contained multiple thread ids');
      }
      sessionId = event.thread_id;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error(
        `codex reported ${String(event.type)}: ${diagnostic(line)}`,
      );
    }
    if (event.type === 'item.completed') {
      const item = event.item;
      if (
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === 'agent_message' &&
        typeof (item as Record<string, unknown>).text === 'string'
      ) {
        raw = (item as Record<string, unknown>).text as string;
      }
    }
  }
  if (!sessionId) throw new Error('codex JSONL did not contain thread.started');
  // A turn that completed without an `agent_message` is an EMPTY ANSWER, not a
  // failure — the same seam rule opencode carries (869ekt): claude and agy
  // already answer '' for a silent run, and the caller decides what silence
  // means. A stream with no `thread.started` is still a broken stream.
  return { sessionId, raw };
}

function appendPolicyArgs(args: string[], permissionMode?: string): void {
  if (permissionMode === 'bypassPermissions') {
    args.push(
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
    );
  }
}

function assertSafeName(kind: string, name: string): void {
  if (
    name.length === 0 ||
    name === 'karst' ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '..' ||
    isAbsolute(name)
  ) {
    throw new Error(
      `materializeApproach: unsafe or reserved ${kind} "${name}"`,
    );
  }
}

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n');
}

function writeSkill(
  worktree: string,
  name: string,
  description: string,
  body: string,
): string | undefined {
  assertSafeName('skill name', name);
  const dir = join(worktree, '.agents', 'skills', name);
  // A repository may intentionally check in a skill with the same stable name
  // as an approach artifact. That directory belongs to the repository, not this
  // terminal: overwriting it and later treating it as adapter-owned would make
  // session cleanup delete tracked project files.
  if (existsSync(dir)) return undefined;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillDocument(name, description, body));
  return dir;
}

export class CodexAdapter implements AgentAdapter {
  readonly requiredBinary = CODEX_BIN;
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
    interactiveUsage: true,
  };

  /** Declared seam positions (869ej1zpv R1) — pinned against argv by the conformance suite. */
  readonly surfaces: AdapterSurfaces = {
    exactModel: SUPPORTED,
    model: SUPPORTED,
    effortHeadless: SUPPORTED,
    effortInteractive: SUPPORTED,
    allowedTools: unsupported(
      'codex has no per-run tool allowlist flag; its execution policy is the sandbox ' +
        'mode (`--dangerously-bypass-approvals-and-sandbox`), carried by permissionMode',
    ),
    permissionMode: SUPPORTED,
    resume: SUPPORTED,
    sessionName: unsupported(
      'codex names sessions only after the fact (`codex archive <name>`) — no launch-time flag',
    ),
    consoleStream: SUPPORTED,
    structuredOutput: SUPPORTED,
    hookChannel: SUPPORTED,
    endpointRebind: SUPPORTED,
    mcpIsolationHeadless: SUPPORTED,
    toolActivity: SUPPORTED,
    skillDiscovery: SUPPORTED,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  // `opts.sessionName` is deliberately dropped: codex names sessions only after
  // the fact (`codex archive <name>`), with no launch-time flag to set one.
  buildInteractiveCommand(
    opts: InteractiveCommandOpts,
  ): InteractiveCommand {
    const args: string[] = [];
    if (opts.resume) args.push('resume');
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--config', `model_reasoning_effort=${opts.effort}`);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    if (opts.hookChannel) args.push('--dangerously-bypass-hook-trust');
    if (opts.hookChannel) {
      appendHookArgs(
        args,
        opts.hookChannel.configDir,
        opts.hookChannel.endpointUrl,
      );
    }
    if (opts.resume) {
      args.push(opts.resume);
      if (opts.initialPrompt) args.push(opts.initialPrompt);
    } else if (opts.initialPrompt) {
      args.push('--', opts.initialPrompt);
    }
    return {
      command: CODEX_BIN,
      args,
      env: {},
    };
  }

  materializeApproach(opts: MaterializeOpts): Materialized {
    assertSafeName('approach id', opts.pkg.id);
    const owned = new Set<string>();
    // The approach id is legal as a manifest/package id, but a `:` (or other
    // non-word punctuation) would break the generated skill name and its
    // `$`-invocation on codex — slug it into kebab (UNKNOWN-COMMAND-ISSUE).
    const idSlug = slugCommandName(opts.pkg.id);
    const prefix = `karst-${idSlug}`;

    for (const base of RESERVED_BASENAMES) {
      if (idSlug === base || prefix === `karst-${base}`) {
        throw new Error(
          `materializeApproach: approach id "${opts.pkg.id}" slugs to reserved ` +
            `"${base}" — it collides with the generated ${base} orchestrator`,
        );
      }
    }

    for (const artifact of opts.pkg.artifacts ?? []) {
      const source = join(opts.baseDir, opts.pkg.id, artifact.relPath);
      const base =
        artifact.kind === 'skill'
          ? basename(dirname(artifact.relPath))
          : basename(artifact.relPath, extname(artifact.relPath));
      assertSafeName('artifact name', base);
      const skillName = `${prefix}-${base}`;
      const destination = join(
        opts.sessionDir,
        '.agents',
        'skills',
        skillName,
      );
      if (existsSync(destination)) continue;

      if (artifact.kind === 'skill') {
        cpSync(dirname(source), destination, { recursive: true });
        const skillPath = join(destination, 'SKILL.md');
        const original = readFileSync(skillPath, 'utf8');
        writeFileSync(
          skillPath,
          skillDocument(
            skillName,
            `Use the ${base} workflow from ${opts.pkg.label}.`,
            original.replace(/^---[\s\S]*?---\s*/u, ''),
          ),
        );
      } else {
        const body = readFileSync(source, 'utf8');
        writeSkill(
          opts.sessionDir,
          skillName,
          artifact.kind === 'agent'
            ? `Delegate work using the ${base} role from ${opts.pkg.label}.`
            : `Run the ${base} command from ${opts.pkg.label}.`,
          artifact.kind === 'agent'
            ? `Delegate the requested work to a subagent following these instructions:\n\n${body}`
            : body,
        );
      }
      owned.add(destination);
    }

    if (opts.soloAgent) {
      assertSafeName('solo agent name', opts.soloAgent.name);
      const name = `karst-agent-${opts.soloAgent.name}`;
      const destination = writeSkill(
        opts.sessionDir,
        name,
        `Delegate the ticket to the ${opts.soloAgent.name} role.`,
        `Delegate this ticket to a subagent following these instructions:\n\n${opts.soloAgent.body}`,
      );
      if (destination) owned.add(destination);
    }

    const hasWorkflow = (opts.pkg.workflow?.length ?? 0) > 0;
    if (hasWorkflow) {
      const body = renderWorkflowCommand({
        id: opts.pkg.id,
        label: opts.pkg.label,
        phases: opts.pkg.workflow!,
        ...(opts.cliContextPrefix
          ? { contextCommand: opts.cliContextPrefix }
          : {}),
        ...(opts.cliStagePrefix
          ? { stageCommand: opts.cliStagePrefix }
          : {}),
        ...(opts.cliPhasePrefix
          ? { phaseCommand: opts.cliPhasePrefix }
          : {}),
        ...(opts.cliGuidePrefix
          ? { guideCommand: opts.cliGuidePrefix }
          : {}),
      });
      // NOT `writeSkill`: its "path exists → leave it" rule is right for a
      // copied artifact (the repository may have checked one in) but wrong for
      // the skill karst GENERATES — its inputs (stage marker, phases, label)
      // change between launches, so a stale body outliving them names a stage
      // the CLI now refuses. The per-file stamp separates "karst wrote this
      // earlier" (replace) from "the repository owns this" (leave alone).
      assertSafeName('skill name', prefix);
      const destination = join(opts.sessionDir, '.agents', 'skills', prefix);
      // Ownership stays "created by THIS call" (the conformance rule): a dir a
      // previous launch left behind is re-rendered, not re-claimed.
      const isNew = !existsSync(destination);
      const wrote = writeGeneratedArtifact(
        join(destination, 'SKILL.md'),
        skillDocument(
          prefix,
          `Run the ${opts.pkg.label} workflow for a Karst ticket.`,
          withStamp(body),
        ),
      );
      if (wrote && isNew) owned.add(destination);
    }

    // The test-family skill carries the resolved CLI prefix so the agent
    // never composes the --db/--manifest boilerplate itself.
    if (opts.cliTestPrefix) {
      const testSkillDir = join(opts.sessionDir, '.agents', 'skills', 'karst-test');
      const isNew = !existsSync(testSkillDir);
      const wrote = writeGeneratedArtifact(
        join(testSkillDir, 'SKILL.md'),
        renderTestSkill(opts.cliTestPrefix),
      );
      if (wrote && isNew) owned.add(testSkillDir);
    }

    let startTaskInvocation: string | undefined;
    let resumeInvocation: string | undefined;
    let fixInvocation: string | undefined;
    let resolveConflictInvocation: string | undefined;
    if (opts.cliContextPrefix) {
      const commandEntries: {
        basename: string;
        body: string;
        description: string;
      }[] = [
        {
          basename: 'karst-start-task',
          body: renderStartTaskCommand({
            contextCommand: opts.cliContextPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: START_TASK_DESCRIPTION,
        },
        {
          basename: 'karst-resume',
          body: renderResumeCommand({
            contextCommand: opts.cliContextPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: RESUME_DESCRIPTION,
        },
      ];

      if (opts.cliFixBriefPrefix) {
        commandEntries.push({
          basename: 'karst-fix',
          body: renderFixCommand({
            contextCommand: opts.cliContextPrefix,
            fixBriefCommand: opts.cliFixBriefPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: FIX_DESCRIPTION,
        });
      }

      if (opts.cliConflictBriefPrefix) {
        commandEntries.push({
          basename: 'karst-resolve-conflict',
          body: renderResolveConflictCommand({
            contextCommand: opts.cliContextPrefix,
            conflictBriefCommand: opts.cliConflictBriefPrefix,
            ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
          }),
          description: RESOLVE_CONFLICT_DESCRIPTION,
        });
      }

      for (const entry of commandEntries) {
        assertSafeName('skill name', entry.basename);
        const skillDir = join(opts.sessionDir, '.agents', 'skills', entry.basename);
        const isNew = !existsSync(skillDir);
        const wrote = writeGeneratedArtifact(
          join(skillDir, 'SKILL.md'),
          skillDocument(
            entry.basename,
            entry.description,
            withStamp(entry.body),
          ),
        );
        if (wrote && isNew) owned.add(skillDir);
      }

      // Per-ticket alias skills for the manual-recovery commands. Each alias
      // gets a `<basename>-<KEY>` name so the command picker fuzzy-matches on it.
      if (opts.aliasTickets && opts.aliasTickets.length > 0) {
        const renderers: Record<string, (ticketKey: string) => string> = {
          'karst-resume': (tk) =>
            renderResumeCommand({
              contextCommand: opts.cliContextPrefix!,
              ...(opts.cliGuidePrefix ? { guideCommand: opts.cliGuidePrefix } : {}),
              ticketKey: tk,
            }),
          ...(opts.cliFixBriefPrefix
            ? {
                'karst-fix': (tk: string) =>
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
                'karst-resolve-conflict': (tk: string) =>
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
          'karst-resume': RESUME_DESCRIPTION,
          'karst-fix': FIX_DESCRIPTION,
          'karst-resolve-conflict': RESOLVE_CONFLICT_DESCRIPTION,
        };
        for (const ticket of opts.aliasTickets) {
          const slug = slugCommandName(ticket.key);
          if (!slug) continue;
          for (const [basename, render] of Object.entries(renderers)) {
            const aliasName = `${basename}-${slug}`;
            assertSafeName('skill name', aliasName);
            const skillDir = join(opts.sessionDir, '.agents', 'skills', aliasName);
            const isNew = !existsSync(skillDir);
            const wrote = writeGeneratedArtifact(
              join(skillDir, 'SKILL.md'),
              skillDocument(
                aliasName,
                descriptions[basename] ?? '',
                withStamp(render(ticket.key)),
              ),
            );
            if (wrote && isNew) owned.add(skillDir);
          }
        }
      }

      startTaskInvocation = '/karst-start-task';
      resumeInvocation = '/karst-resume';
      if (opts.cliFixBriefPrefix) {
        fixInvocation = '/karst-fix';
      }
      if (opts.cliConflictBriefPrefix) {
        resolveConflictInvocation = '/karst-resolve-conflict';
      }
    }

    return {
      extraArgs: [],
      ownedPaths: [...owned],
      ...(hasWorkflow ? { invocation: `$${prefix}` } : {}),
      ...(startTaskInvocation ? { startTaskInvocation } : {}),
      ...(resumeInvocation ? { resumeInvocation } : {}),
      ...(fixInvocation ? { fixInvocation } : {}),
      ...(resolveConflictInvocation ? { resolveConflictInvocation } : {}),
    };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = opts.resume
      ? ['exec', 'resume', '--json']
      : ['exec', '--json'];
    // Karst creates and owns the selected worktree. Headless Codex still
    // requires this opt-out before it will consume the supplied prompt.
    args.push('--skip-git-repo-check');
    // Every headless call is ticket-driven automation, never an interactive
    // developer session: it must not depend on whatever MCP servers happen to
    // be configured in ~/.codex/config.toml on the machine that launched it
    // (869ekt1 — the claude-adapter twin of this fix; the concrete incident was
    // a claude-side plugin, but the property this closes is per-core).
    // `-c`/`--config` is documented repeatable (already used below for
    // `--model` and, on an effort, `model_reasoning_effort`); this override
    // replaces the WHOLE `mcp_servers` table with an empty TOML inline table
    // for this invocation only — never writes the config file.
    args.push('--config', 'mcp_servers={}');
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--config', `model_reasoning_effort=${opts.effort}`);
    appendPolicyArgs(args, opts.permissionMode);
    // Native structured output (Prompt 09): codex reads its JSON Schema from a
    // FILE (`--output-schema <FILE>`), so when a caller supplies one, materialize
    // it to a temp dir this adapter created and clean it up the moment the run
    // settles. The schema constrains the CLI's FINAL response to that shape, so
    // the salvage parser reads a clean whole-document array from the last
    // assistant message instead of coaxing one out of prose.
    let schemaFile: string | undefined;
    if (opts.outputSchema) {
      const dir = mkdtempSync(join(tmpdir(), 'karst-schema-'));
      schemaFile = join(dir, 'output-schema.json');
      writeFileSync(schemaFile, JSON.stringify(opts.outputSchema));
      args.push('--output-schema', schemaFile);
      opts.debug?.(
        `[agent:codex] structured output: enforcing --output-schema ${schemaFile} on the final response`,
      );
    }
    if (opts.resume) {
      args.push(opts.resume, opts.prompt);
    } else {
      args.push('--', opts.prompt);
    }

    // The prompt is ticket prose — never logged in full. The debug line names
    // the invocation and redacts the prompt to its length (§ debug logging).
    opts.debug?.(
      `[agent:codex] spawn: ${args
        .map((a) => (a === opts.prompt ? `<prompt:${opts.prompt.length} chars>` : a))
        .join(' ')} (cwd ${opts.cwd})`,
    );
    // The console tail streams RAW JSONL (`exec --json`): render each event as
    // a readable line before it reaches the console. The stream is only for the
    // console — the settle-time `stdout` still carries the raw bytes the parser
    // reads, so rendering here never touches what `parseCodexJsonl` sees.
    const consoleStream = opts.onOutput ? renderConsoleStream('codex', opts.onOutput) : undefined;
    opts.debug?.(
      consoleStream
        ? `[agent:codex] console stream: rendering JSONL events as readable lines`
        : `[agent:codex] console stream: none — no onOutput hook`,
    );
    let result: HeadlessSpawnResult;
    try {
      result = await this.spawnHeadless(CODEX_BIN, args, opts.cwd, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onDebug: opts.debug,
        onSpawned: opts.onSpawned,
        onOutput: consoleStream ? consoleStream.append : opts.onOutput,
      });
    } finally {
      consoleStream?.flush();
      // The schema file was only needed for the duration of the CLI run; remove
      // it on every exit path (clean, abort, timeout) so no temp file outlives
      // its call.
      if (schemaFile) rmSync(dirname(schemaFile), { recursive: true, force: true });
    }
    if (result.exitCode !== 0) {
      opts.debug?.(
        `[agent:codex] exit ${result.exitCode} — stdout: ${headlessPreview(result.stdout)}; stderr: ${headlessPreview(result.stderr)}`,
      );
      // The counts ride out on the rejection — a run that died mid-stream still
      // burned everything up to the cut (§ token consumption stats).
      throw attachUsage(
        new Error(
          describeHeadlessFailure({
            tool: 'Codex',
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        ),
        extractTokenUsage(result.stdout),
      );
    }
    let parsed: { sessionId: string; raw: string };
    try {
      parsed = parseCodexJsonl(result.stdout);
    } catch (error) {
      opts.debug?.(
        `[agent:codex] unparseable output — first 500 chars: ${headlessPreview(result.stdout)}`,
      );
      throw error;
    }
    if (parsed.raw === '') {
      opts.debug?.(
        `[agent:codex] clean exit with no agent message — empty answer (${result.stdout.length} byte(s) of events)`,
      );
    }
    const usage = extractTokenUsage(result.stdout);
    return { ...parsed, verdict: null, ...(usage ? { usage } : {}) };
  }
}
