import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
} from 'node:path';
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
import { renderWorkflowCommand } from './workflowCommand.js';

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

const CODEX_HOOK_BRIDGE = String.raw`const http = require('node:http');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 64 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const event = raw.hook_event_name;
  if (
    typeof event !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.session_id !== 'string'
  ) {
    process.exit(0);
  }
  const mapped =
    event === 'PermissionRequest'
      ? { hook_event_name: 'Notification', message: 'permission_prompt' }
      : ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'].includes(event)
        ? { hook_event_name: event }
        : null;
  if (!mapped) process.exit(0);
  const payload = JSON.stringify({
    ...mapped,
    cwd: raw.cwd,
    session_id: raw.session_id,
  });
  const target = new URL(process.argv[2]);
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    timeout: 2000,
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => req.destroy());
  req.end(payload);
});
`;

type CodexHookInput = Record<string, unknown>;
export type NormalizedHook = {
  hook_event_name: string;
  cwd: string;
  session_id: string;
  message?: string;
};
type PostHook = (payload: NormalizedHook) => Promise<void>;

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
        : CODEX_HOOK_EVENTS.includes(
              event as (typeof CODEX_HOOK_EVENTS)[number],
            ) && event !== 'PermissionRequest'
          ? { hook_event_name: event }
          : null;
    if (!mapped) return;
    await post({ ...mapped, cwd, session_id: sessionId });
  };
}

function appendHookArgs(
  args: string[],
  cwd: string,
  endpointUrl: string,
): string {
  const target = new URL(endpointUrl);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.port === '' ||
    target.port === '0'
  ) {
    throw new Error(`karst: refusing non-loopback hook endpoint ${endpointUrl}`);
  }
  const ownedPath = join(cwd, '.codex', 'karst');
  const bridgePath = join(ownedPath, 'bridge.cjs');
  mkdirSync(ownedPath, { recursive: true });
  writeFileSync(bridgePath, CODEX_HOOK_BRIDGE);
  const command = [
    JSON.stringify(process.execPath),
    JSON.stringify(bridgePath),
    JSON.stringify(endpointUrl),
  ].join(' ');
  for (const event of CODEX_HOOK_EVENTS) {
    const value =
      `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, ` +
      'timeout = 3 }] }]';
    args.push('-c', `hooks.${event}=${value}`);
  }
  return ownedPath;
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
) => Promise<HeadlessSpawnResult>;

const defaultSpawn: SpawnHeadless = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: unknown) => {
      stdout += String(data);
    });
    child.stderr?.on('data', (data: unknown) => {
      stderr += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

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
  if (!raw) {
    throw new Error(
      'codex JSONL did not contain a completed agent message',
    );
  }
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
): string {
  assertSafeName('skill name', name);
  const dir = join(worktree, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillDocument(name, description, body));
  return dir;
}

export class CodexAdapter implements AgentAdapter {
  readonly requiredBinary = CODEX_BIN;
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  buildInteractiveCommand(
    opts: InteractiveCommandOpts,
  ): InteractiveCommand {
    const args: string[] = [];
    if (opts.resume) args.push('resume');
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    const ownedPaths = opts.hookChannel
      ? [
          appendHookArgs(
            args,
            opts.cwd,
            opts.hookChannel.endpointUrl,
          ),
        ]
      : [];
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
      ...(ownedPaths.length > 0 ? { ownedPaths } : {}),
    };
  }

  materializeApproach(opts: MaterializeOpts): Materialized {
    assertSafeName('approach id', opts.pkg.id);
    const owned = new Set<string>();
    const prefix = `karst-${opts.pkg.id}`;

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
      owned.add(
        writeSkill(
          opts.sessionDir,
          name,
          `Delegate the ticket to the ${opts.soloAgent.name} role.`,
          `Delegate this ticket to a subagent following these instructions:\n\n${opts.soloAgent.body}`,
        ),
      );
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
      });
      owned.add(
        writeSkill(
          opts.sessionDir,
          prefix,
          `Run the ${opts.pkg.label} workflow for a Karst ticket.`,
          body,
        ),
      );
    }

    return {
      extraArgs: [],
      ownedPaths: [...owned],
      ...(hasWorkflow ? { invocation: `$${prefix}` } : {}),
    };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = opts.resume
      ? ['exec', 'resume', '--json']
      : ['exec', '--json'];
    if (opts.model) args.push('--model', opts.model);
    appendPolicyArgs(args, opts.permissionMode);
    if (opts.resume) {
      args.push(opts.resume, opts.prompt);
    } else {
      args.push('--', opts.prompt);
    }
    const result = await this.spawnHeadless(CODEX_BIN, args, opts.cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `codex exited ${result.exitCode}: ${diagnostic(
          result.stderr || result.stdout,
        )}`,
      );
    }
    const parsed = parseCodexJsonl(result.stdout);
    return { ...parsed, verdict: null };
  }
}
