import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AgentProvider } from '../manifest/types.js';
import type { ModelOption } from './modelCatalog.js';
import { validateModelList } from './modelCatalog.js';
import { opencode2BinaryPath, opencode2Command } from './opencode2Binary.js';

const COMMAND_TIMEOUT_MS = 3_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * opencode2's `models` run starts a private server (`--standalone`) and reads
 * the account's provider catalog, which routinely takes longer than the 3 s the
 * other probes allow. Still bounded — a timeout leaves the bundled rows in
 * place — but long enough that a normal cold run completes.
 */
const OPENCODE2_COMMAND_TIMEOUT_MS = 15_000;

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.byteLength <= maxBytes) return text;
  return new StringDecoder('utf8').write(encoded.subarray(0, Math.max(0, maxBytes)));
}

/**
 * Why a provider produced no models, as a closed discriminant.
 *
 * The distinction the catalog loader needs is "normal state of this machine"
 * (`command-unavailable` — an optional CLI is simply not installed;
 * `unsupported` — karst has no probe for this provider at all) versus "a real
 * fault" (everything else). That distinction must travel as a code: it used to
 * be recovered downstream by substring-matching the human-readable `reason`,
 * which is how the permanently unsupported Claude probe came to be reported as
 * a missing `claude` binary on machines that had one.
 */
export type DiscoveryUnavailableCode =
  | 'command-unavailable'
  | 'unsupported'
  | 'timeout'
  | 'nonzero-exit'
  | 'invalid-output';

export type DiscoveryResult =
  | { status: 'available'; models: ModelOption[] }
  /** `reason` is diagnostic prose that may contain CLI output — never rendered. */
  | { status: 'unavailable'; code: DiscoveryUnavailableCode; reason: string };

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failure?: 'command unavailable' | 'command failed' | 'timed out' | 'output exceeded';
}

export interface CommandInteraction {
  initialInput: string;
  onStdoutLine: (line: string) => { write?: string; end?: boolean } | undefined;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string | CommandInteraction,
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
    let stdoutLines = '';
    let stdinEnded = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const interaction = typeof input === 'string' ? undefined : input;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const boundedStdout = truncateUtf8(result.stdout, maxOutputBytes);
      const stderrBytes = maxOutputBytes - Buffer.byteLength(boundedStdout);
      resolve({
        ...result,
        stdout: boundedStdout,
        stderr: truncateUtf8(result.stderr, stderrBytes),
      });
    };

    const fail = (failure: NonNullable<CommandResult['failure']>, message: string): void => {
      child?.kill('SIGKILL');
      settle({ stdout, stderr: stderr || message, exitCode: 1, failure });
    };

    const timer = setTimeout(() => {
      fail('timed out', `${command} timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const endInput = (): void => {
      if (stdinEnded) return;
      stdinEnded = true;
      child?.stdin?.end();
    };

    const writeInput = (value: string): void => {
      child?.stdin?.write(value);
    };

    const processStdoutLines = (text: string): void => {
      if (!interaction) return;
      stdoutLines += text;
      let newline = stdoutLines.indexOf('\n');
      while (newline >= 0) {
        const rawLine = stdoutLines.slice(0, newline);
        stdoutLines = stdoutLines.slice(newline + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const action = interaction.onStdoutLine(line);
        if (action?.write !== undefined) writeInput(action.write);
        if (action?.end) endInput();
        newline = stdoutLines.indexOf('\n');
      }
    };

    const append = (stream: 'stdout' | 'stderr', value: unknown): void => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      const bytes = chunk.byteLength;
      const remaining = maxOutputBytes - outputBytes;
      const captured = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
      outputBytes += bytes;
      if (outputBytes > maxOutputBytes) {
        if (stream === 'stdout') stdout += stdoutDecoder.write(captured);
        else stderr += stderrDecoder.write(captured);
        fail('output exceeded', `${command} output exceeded ${maxOutputBytes} bytes`);
        return;
      }

      const text = stream === 'stdout'
        ? stdoutDecoder.write(captured)
        : stderrDecoder.write(captured);
      if (stream === 'stdout') {
        stdout += text;
        processStdoutLines(text);
      } else {
        stderr += text;
      }
    };

    try {
      child = spawnImpl(command, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: unknown) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: unknown) => append('stderr', chunk));
      child.stdin?.once('error', (error: Error) => {
        fail('command failed', error.message);
      });
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
      if (interaction) writeInput(interaction.initialInput);
      else {
        if (typeof input === 'string') writeInput(input);
        endInput();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle({ stdout, stderr: `${stderr}${message}`, exitCode: 1, failure: 'command failed' });
    }
  });
}

const defaultCommandRunner = makeCommandRunner();

/** The opencode2 probe's own default: same runner, a longer bound (see above). */
const defaultOpencode2CommandRunner = makeCommandRunner(spawn, {
  timeoutMs: OPENCODE2_COMMAND_TIMEOUT_MS,
});

function unavailable(code: DiscoveryUnavailableCode, reason: string): DiscoveryResult {
  return { status: 'unavailable', code, reason };
}

/** Spawn-level outcome → discovery code. Exhaustive over `CommandResult.failure`. */
const FAILURE_CODES: Record<NonNullable<CommandResult['failure']>, DiscoveryUnavailableCode> = {
  'command unavailable': 'command-unavailable',
  'command failed': 'nonzero-exit',
  'timed out': 'timeout',
  'output exceeded': 'invalid-output',
};

function commandFailure(result: CommandResult): DiscoveryResult | undefined {
  if (result.exitCode === 0) return undefined;
  // An unclassified non-zero exit is a CLI that ran and refused, never an absent
  // one — only a spawn ENOENT may claim `command-unavailable`.
  const code = result.failure ? FAILURE_CODES[result.failure] : 'nonzero-exit';
  return unavailable(code, result.failure ?? (result.stderr.trim() || `command exited ${result.exitCode}`));
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

/** A bare model id as `agy models` prints it \u2014 no spaces, no punctuation prose. */
const BARE_MODEL_LINE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function antigravityModelId(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse `agy models` into normalized catalog rows.
 *
 * Two shapes are accepted because the CLI ships both: the documented
 * `Available models:` heading followed by human labels, and \u2014 what the current
 * `agy` actually prints \u2014 a bare newline-separated list of ids with no heading.
 * Requiring the heading made a working, installed `agy` report `invalid-output`.
 *
 * The headingless form is only accepted when EVERY line is a bare model id, so
 * usage text, an auth error, or any other prose is still refused rather than
 * silently turned into models.
 */
export function parseAntigravityModels(stdout: string): ModelOption[] | undefined {
  const lines = stdout.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === 'available models:');

  const labels = (heading < 0 ? lines : lines.slice(heading + 1))
    .map((line) => line.trim().replace(/^(?:[-*]\s+)/, ''))
    .filter((label) => label.length > 0);
  if (heading < 0 && !labels.every((label) => BARE_MODEL_LINE.test(label))) return undefined;

  return validateModelList(
    'antigravity',
    labels.map((label) => ({ id: antigravityModelId(label), label })),
  );
}

const CODEX_INITIALIZE_INPUT = `${JSON.stringify({
  id: 1,
  method: 'initialize',
  params: { clientInfo: { name: 'karst', version: '1.0.0' }, capabilities: {} },
})}\n`;

const CODEX_MODEL_LIST_INPUT = [
  { method: 'initialized', params: {} },
  { id: 2, method: 'model/list', params: {} },
].map((request) => JSON.stringify(request)).join('\n') + '\n';

function codexInteraction(): CommandInteraction {
  let initialized = false;
  return {
    initialInput: CODEX_INITIALIZE_INPUT,
    onStdoutLine: (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (!isRecord(message)) return undefined;
      if (!initialized && message.id === 1) {
        initialized = true;
        return { write: CODEX_MODEL_LIST_INPUT };
      }
      if (initialized && message.id === 2) return { end: true };
      return undefined;
    },
  };
}

export async function discoverCodexModels(run: CommandRunner = defaultCommandRunner): Promise<DiscoveryResult> {
  const result = await run('codex', ['app-server', '--stdio'], codexInteraction());
  const failure = commandFailure(result);
  if (failure) return failure;

  const models = parseCodexModels(result.stdout);
  return models
    ? { status: 'available', models }
    : unavailable('invalid-output', 'Codex returned an invalid or empty model list');
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
    : unavailable('invalid-output', 'Antigravity returned an invalid or empty model list');
}

/**
 * The Claude Code CLI exposes no model-listing command, so karst has no probe to
 * run. This is a property of karst, not of the user's machine: it is `unsupported`
 * and never `command-unavailable`, which would accuse an installed `claude` of
 * being missing on every activation.
 */
export async function discoverClaudeModels(): Promise<DiscoveryResult> {
  return unavailable('unsupported', 'Claude CLI model discovery is unsupported');
}

/** A bare opencode model id as `opencode models` prints it — `provider/model` with slashes and tildes. */
const OPENCODE_MODEL_LINE = /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/;

/**
 * Parse an `opencode models`-shaped plain output into catalog rows for one
 * provider.
 *
 * The plain format is one model ID per line (e.g. `opencode/big-pickle`,
 * `openrouter/anthropic/claude-opus-5`). No display names are available
 * without `--verbose`, so the ID is used as both id and label. The v1 and v2
 * CLIs print the identical shape, so the parser takes the provider instead of
 * being copied per core.
 */
export function parseOpencodeModelList(
  provider: AgentProvider,
  stdout: string,
): ModelOption[] | undefined {
  const lines = stdout.split(/\r?\n/);
  const ids = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (ids.length === 0) return undefined;
  if (!ids.every((id) => OPENCODE_MODEL_LINE.test(id))) return undefined;

  return validateModelList(
    provider,
    ids.map((id) => ({ id, label: id })),
  );
}

/** Parse v1 `opencode models` output into catalog rows. */
export function parseOpencodeModels(stdout: string): ModelOption[] | undefined {
  return parseOpencodeModelList('opencode', stdout);
}

/**
 * Discover available opencode models by running `opencode models`.
 *
 * opencode model ids are `provider/model` and depend on the user's account
 * and provider subscriptions. The CLI returns a full list; karst passes
 * it through without curation. Same posture as the Claude probe for the
 * failure case: `unsupported` (not `command-unavailable`) when the command
 * is not probed at all, so an installed `opencode` is not accused of being
 * missing.
 */
export async function discoverOpencodeModels(
  run: CommandRunner = defaultCommandRunner,
): Promise<DiscoveryResult> {
  const result = await run('opencode', ['models']);
  const failure = commandFailure(result);
  if (failure) return failure;

  const models = parseOpencodeModels(result.stdout);
  return models
    ? { status: 'available', models }
    : unavailable('invalid-output', 'opencode returned an invalid or empty model list');
}

/**
 * Discover available opencode2 (v2) models by running the CONFIGURED v2
 * binary with `models --standalone`.
 *
 * The v2 launcher is also named `opencode` but its contract differs from v1,
 * so the command comes from `opencode2Command()` — the absolute path in
 * `karst.opencode2.binaryPath` — never a PATH lookup. An unset setting is the
 * normal "core not configured" state and returns `command-unavailable`
 * without spawning: the sentinel `opencode2` must never be resolved on PATH.
 *
 * `--standalone` is NOT optional: a bare `models` reaches the shared managed
 * service and fails when the user's own OpenCode already owns its port
 * (`Managed service port 49374 … already in use`, live 2.0.27) — the same rule
 * every opencode2 spawn follows (AC-27). Unlike a session spawn, this probe is
 * deliberately NOT run under the karst-owned XDG dirs: the model list comes
 * from the user's own config, and an isolated run reports only the handful of
 * built-in `opencode/*` ids instead of the account's providers.
 *
 * v2 prints `provider/model` ids (the same shape v1 does), so the ids are
 * passed through the shared parser. The CLI gives no effort vocabulary, so a
 * discovered id that matches a bundled/feed `opencode2` row inherits that
 * row's curated `efforts` and `label` in `loadModelCatalog`, keeping
 * `#<effort>` working for the curated ids.
 */
export async function discoverOpencode2Models(
  run: CommandRunner = defaultOpencode2CommandRunner,
): Promise<DiscoveryResult> {
  if (opencode2BinaryPath() === '') {
    return unavailable('command-unavailable', 'opencode2 binary is not configured');
  }

  const result = await run(opencode2Command(), ['models', '--standalone']);
  const failure = commandFailure(result);
  if (failure) return failure;

  const models = parseOpencodeModelList('opencode2', result.stdout);
  return models
    ? { status: 'available', models }
    : unavailable('invalid-output', 'opencode2 returned an invalid or empty model list');
}
