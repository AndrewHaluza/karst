import { spawn } from 'node:child_process';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
import { describeHeadlessFailure } from './cliFailure.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { hookFailureLogPath } from './hookFailureLog.js';
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

export function resolveNodeExecutable(
  pathValue = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string {
  const separator = platform === 'win32' ? ';' : ':';
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (!existsSync(candidate)) continue;
    if (platform !== 'win32') {
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
    }
    return candidate;
  }
  throw new Error(
    'karst: Codex hooks require a standalone Node.js executable on PATH',
  );
}

const CODEX_HOOK_BRIDGE = String.raw`const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let eventName = 'unknown';
const diagnosticsPath = process.argv[3];

// The launch-time URL is this session's own window while that window lives.
// A VS Code reload rebinds an ephemeral hook port, so the extension also
// writes its current URL to a stable file on every activation; when the
// launch-time URL is gone (connection refused, or a foreign process answering
// on the stale port) the bridge falls back to that file. The karstLaunch
// generation rides on the launch-time URL and is carried onto every candidate,
// so the endpoint's generation barrier still admits the session after a rebind.
let argvEndpoint = process.argv[2];
let fileEndpoint = null;
try {
  if (diagnosticsPath) {
    const configDir = path.dirname(path.dirname(diagnosticsPath));
    const endpointFile = path.join(configDir, 'codex', 'current-endpoint');
    const content = fs.readFileSync(endpointFile, 'utf8').trim();
    if (content.length > 0) fileEndpoint = content;
  }
} catch {}

let launchSearch = '';
try { launchSearch = new URL(argvEndpoint).search; } catch {}
function candidateEndpoint(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (launchSearch) url.search = launchSearch;
    return url.toString();
  } catch {
    return null;
  }
}
const endpoints = [];
for (const raw of [argvEndpoint, fileEndpoint]) {
  const candidate = candidateEndpoint(raw);
  if (candidate !== null && !endpoints.includes(candidate)) endpoints.push(candidate);
}

function logFailure(outcome) {
  try {
    if (!diagnosticsPath || fs.existsSync(diagnosticsPath) && fs.statSync(diagnosticsPath).size >= 64 * 1024) return;
    fs.appendFileSync(diagnosticsPath, JSON.stringify({
      at: new Date().toISOString(),
      event: eventName,
      outcome,
    }) + '\n', { mode: 0o600 });
  } catch {}
}

let finished = false;
function finish(exitCode, outcome) {
  if (finished) return;
  finished = true;
  if (outcome) logFailure(outcome);
  process.exit(exitCode);
}

// A stale endpoint is an expected IDE/session lifecycle race and fails open.
// Malformed invocations and bridge defects remain visible as genuine failures.
process.on('uncaughtException', () => finish(1, 'uncaught-exception'));
process.on('unhandledRejection', () => finish(1, 'unhandled-rejection'));

// Task 5: a count is a finite, non-negative number; anything else is dropped,
// never coerced to 0 (a 0 would read as a measured free call).
function usageCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Build the UsageUpdate payload from a provider-supplied usage object. The
// stable event id is the dedupe key: usage.event_id wins, the event's
// turn_id is the fallback, and neither → the usage is dropped.
function usagePayload(raw) {
  const usage = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.usage : null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const eventId =
    typeof usage.event_id === 'string' && usage.event_id.length > 0
      ? usage.event_id
      : typeof raw.turn_id === 'string' && raw.turn_id.length > 0
        ? raw.turn_id
        : null;
  if (!eventId) return null;
  const input = usageCount(usage.input);
  const output = usageCount(usage.output);
  if (input === null || output === null) return null;
  const payload = { event_id: eventId, input, output };
  const cacheRead = usageCount(usage.cache_read);
  const cacheWrite = usageCount(usage.cache_write);
  const total = usageCount(usage.total);
  if (cacheRead !== null) payload.cache_read = cacheRead;
  if (cacheWrite !== null) payload.cache_write = cacheWrite;
  if (total !== null) payload.total = total;
  return payload;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  // A tool output rides the hook input and can legitimately be large; the
  // bridge only needs the small fields, so an oversized input is DECLINED,
  // never a failure — exit 0 keeps the agent from rendering a hook error,
  // and the decline is logged for the diagnostic report. Mirrors the hook
  // endpoint's oversized-body contract (MAX_HOOK_BODY_BYTES = 1 MiB).
  if (input.length > 1024 * 1024) finish(0, 'input-too-large');
});
process.stdin.on('end', () => {
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    finish(1, 'invalid-json');
    return;
  }
  const event = raw.hook_event_name;
  if (typeof event === 'string') eventName = event.slice(0, 64);
  if (
    typeof event !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.session_id !== 'string'
  ) {
    finish(1, 'invalid-input');
    return;
  }
  const mapped =
    event === 'PermissionRequest'
      ? { hook_event_name: 'Notification', message: 'permission_prompt' }
      : event === 'Stop' &&
          typeof raw.last_assistant_message === 'string' &&
          /\?\s*$/.test(raw.last_assistant_message)
        ? { hook_event_name: 'Notification', message: 'idle_prompt' }
      : ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'].includes(event)
        ? { hook_event_name: event }
        : null;

  const posts = [];
  if (mapped) {
    posts.push({ ...mapped, cwd: raw.cwd, session_id: raw.session_id });
  }
  const usage = usagePayload(raw);
  if (usage) {
    posts.push({ hook_event_name: 'UsageUpdate', cwd: raw.cwd, session_id: raw.session_id, usage });
  }
  if (posts.length === 0) {
    finish(0);
    return;
  }

  let index = 0;
  let endpointIndex = 0;
  function nextPost() {
    if (index >= posts.length) {
      finish(0);
      return;
    }
    const payload = posts[index];
    const body = JSON.stringify(payload);
    let target;
    try {
      target = new URL(endpoints[endpointIndex]);
    } catch {
      finish(1, 'invalid-endpoint');
      return;
    }
    // A failed attempt against a candidate that is not the last one is the
    // reload race: the launch-time port is gone or held by something else, so
    // switch to the extension's current endpoint and retry THIS post. The
    // switch is silent -- request-error on the old port is expected, not a
    // failure worth diagnosing. Only the final candidate's failure is logged.
    // One socket failure can surface as several events on the same request
    // ('aborted' AND 'error'), so an attempt settles exactly once: after it
    // hands off, finishes or advances, its later events are inert — a stale
    // event must never double-advance the post index and skip a delivery.
    let attemptDone = false;
    const settle = () => {
      attemptDone = true;
    };
    function switchEndpoint() {
      if (attemptDone) return true;
      if (endpointIndex + 1 < endpoints.length) {
        settle();
        endpointIndex += 1;
        nextPost();
        return true;
      }
      return false;
    }
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 2000,
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => {
        if (attemptDone) return;
        const status = res.statusCode ?? 0;
        const successful = status >= 200 && status < 300;
        if (!successful) {
          if (switchEndpoint()) return;
          settle();
          finish(1, 'http-error:' + status);
          return;
        }
        settle();
        index += 1;
        nextPost();
      });
      res.on('aborted', () => {
        if (attemptDone) return;
        if (switchEndpoint()) return;
        settle();
        logFailure('request-error');
        index += 1;
        nextPost();
      });
      res.on('error', () => {
        if (attemptDone) return;
        if (switchEndpoint()) return;
        settle();
        logFailure('request-error');
        index += 1;
        nextPost();
      });
    });
    req.on('error', (err) => {
      if (attemptDone) return;
      if (switchEndpoint()) return;
      settle();
      const code = err && typeof err.code === 'string' ? err.code : '';
      logFailure(code ? 'request-error:' + code : 'request-error');
      index += 1;
      nextPost();
    });
    req.on('timeout', () => req.destroy());
    req.end(body);
  }
  nextPost();
});
`;

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
      await post({ ...mapped, cwd, session_id: sessionId });
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
  if (current !== CODEX_HOOK_BRIDGE) {
    const temporaryPath = `${bridgePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, CODEX_HOOK_BRIDGE);
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

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  // `opts.sessionName` is deliberately dropped: codex names sessions only after
  // the fact (`codex archive <name>`), with no launch-time flag to set one.
  buildInteractiveCommand(
    opts: InteractiveCommandOpts,
  ): InteractiveCommand {
    const args: string[] = [];
    if (opts.resume) args.push('resume');
    if (opts.model) args.push('--model', opts.model);
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
      });
      const destination = writeSkill(
        opts.sessionDir,
        prefix,
        `Run the ${opts.pkg.label} workflow for a Karst ticket.`,
        body,
      );
      if (destination) owned.add(destination);
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
    // Karst creates and owns the selected worktree. Headless Codex still
    // requires this opt-out before it will consume the supplied prompt.
    args.push('--skip-git-repo-check');
    if (opts.model) args.push('--model', opts.model);
    appendPolicyArgs(args, opts.permissionMode);
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
    const result = await this.spawnHeadless(CODEX_BIN, args, opts.cwd, {
      signal: opts.signal,
      onDebug: opts.debug,
    });
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
    const usage = extractTokenUsage(result.stdout);
    return { ...parsed, verdict: null, ...(usage ? { usage } : {}) };
  }
}
