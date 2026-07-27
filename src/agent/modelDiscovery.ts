import { spawn } from 'node:child_process';
import type { ModelOption } from './modelCatalog.js';
import { validateModelList } from './modelCatalog.js';

const COMMAND_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export type DiscoveryResult =
  | { status: 'available'; models: ModelOption[] }
  | { status: 'unavailable'; reason: string };

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failure?: 'command unavailable' | 'command failed' | 'timed out' | 'output exceeded';
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<CommandResult>;

export type SpawnImpl = typeof spawn;

export interface CommandLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Run one provider command without blocking the extension host. Output is
 * bounded across both streams because either stream may be controlled by a
 * provider CLI or its environment.
 */
export function makeCommandRunner(
  spawnImpl: SpawnImpl = spawn,
  limits: CommandLimits = {},
): CommandRunner {
  const timeoutMs = limits.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return (command, args, input) => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const fail = (failure: NonNullable<CommandResult['failure']>, message: string): void => {
      child?.kill('SIGKILL');
      settle({ stdout, stderr: stderr || message, exitCode: 1, failure });
    };

    const timer = setTimeout(() => {
      fail('timed out', `${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const append = (stream: 'stdout' | 'stderr', value: unknown): void => {
      if (settled) return;
      const text = String(value);
      const bytes = Buffer.byteLength(text);
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const captured = bytes <= remaining
          ? text
          : Buffer.from(text).subarray(0, remaining).toString();
        if (stream === 'stdout') stdout += captured;
        else stderr += captured;
      }
      outputBytes += bytes;
      if (outputBytes > maxOutputBytes) {
        fail('output exceeded', `${command} output exceeded ${maxOutputBytes} bytes`);
      }
    };

    try {
      child = spawnImpl(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: unknown) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: unknown) => append('stderr', chunk));
      child.once('error', (error: Error & { code?: string }) => {
        const failure = error.code === 'ENOENT' ? 'command unavailable' : 'command failed';
        settle({ stdout, stderr: `${stderr}${error.message}`, exitCode: 1, failure });
      });
      child.once('close', (code) => {
        const exitCode = code ?? 1;
        settle({
          stdout,
          stderr,
          exitCode,
          ...(exitCode === 0 ? {} : { failure: 'command failed' as const }),
        });
      });
      if (input !== undefined) child.stdin?.write(input);
      child.stdin?.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle({ stdout, stderr: `${stderr}${message}`, exitCode: 1, failure: 'command failed' });
    }
  });
}

const defaultCommandRunner = makeCommandRunner();

function unavailable(reason: string): DiscoveryResult {
  return { status: 'unavailable', reason };
}

function commandFailure(result: CommandResult): DiscoveryResult | undefined {
  if (result.exitCode === 0) return undefined;
  return unavailable(result.failure ?? (result.stderr.trim() || `command exited ${result.exitCode}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function availableCodexModel(entry: Record<string, unknown>): boolean {
  const availability = entry.availability;
  if (availability === 'unavailable' || availability === false) return false;
  if (entry.available === false || entry.isAvailable === false) return false;
  return true;
}

/** Parse the response to the Codex app-server `model/list` request only. */
export function parseCodexModels(stdout: string): ModelOption[] | undefined {
  let response: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (isRecord(message) && message.id === 2 && isRecord(message.result)) {
      response = message.result;
    }
  }
  if (!response) return undefined;

  const candidates = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.models)
      ? response.models
      : undefined;
  if (!candidates) return undefined;

  const models: { id: unknown; label: unknown }[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) return undefined;
    if (!availableCodexModel(candidate)) continue;
    models.push({ id: candidate.model, label: candidate.displayName });
  }
  return validateModelList('codex', models);
}

/** Parse the documented `agy models` text output into normalized catalog rows. */
export function parseAntigravityModels(stdout: string): ModelOption[] | undefined {
  const lines = stdout.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === 'available models:');
  if (heading < 0) return undefined;

  const models = lines.slice(heading + 1)
    .map((line) => line.trim().replace(/^(?:[-*]\s+)/, ''))
    .filter((label) => label.length > 0)
    .map((label) => ({
      id: label
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, ''),
      label,
    }));
  return validateModelList('antigravity', models);
}

const CODEX_PROTOCOL_INPUT = [
  { id: 1, method: 'initialize', params: { clientInfo: { name: 'karst', version: '1.0.0' }, capabilities: {} } },
  { method: 'initialized', params: {} },
  { id: 2, method: 'model/list', params: {} },
].map((request) => JSON.stringify(request)).join('\n') + '\n';

export async function discoverCodexModels(run: CommandRunner = defaultCommandRunner): Promise<DiscoveryResult> {
  const result = await run('codex', ['app-server', '--stdio'], CODEX_PROTOCOL_INPUT);
  const failure = commandFailure(result);
  if (failure) return failure;

  const models = parseCodexModels(result.stdout);
  return models
    ? { status: 'available', models }
    : unavailable('Codex returned an invalid or empty model list');
}

export async function discoverAntigravityModels(
  run: CommandRunner = defaultCommandRunner,
): Promise<DiscoveryResult> {
  const result = await run('agy', ['models']);
  const failure = commandFailure(result);
  if (failure) return failure;

  const models = parseAntigravityModels(result.stdout);
  return models
    ? { status: 'available', models }
    : unavailable('Antigravity returned an invalid or empty model list');
}

export async function discoverClaudeModels(): Promise<DiscoveryResult> {
  return unavailable('Claude CLI model discovery is unsupported');
}
