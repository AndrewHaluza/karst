import {
  type AgentAdapter,
  type AgentCapabilities,
  type HeadlessResult,
  type InstructionDelivery,
  type InteractiveCommand,
  type InteractiveCommandOpts,
  type MaterializeOpts,
  type Materialized,
  type RunHeadlessOpts,
} from './adapter.js';
import { describeHeadlessFailure } from './cliFailure.js';
import { renderConsoleStream } from './consoleFormat.js';
import {
  spawnHeadlessCli,
  headlessPreview,
  type HeadlessSpawnOptions,
} from './headlessSpawn.js';
import { attachUsage } from './tokenUsage.js';
import type { TokenUsage } from './tokenUsage.js';
import { SUPPORTED, unsupported, type AdapterSurfaces } from './surfaces.js';
import { renderInstructionsPointer, withInstructionsPointer } from './instructions.js';
import { OpencodeAdapter, opencodeLaunchPermission } from './opencode.js';
import {
  opencode2Command,
  opencode2Config,
  opencode2IsolationEnv,
} from './opencode2Binary.js';
import { KARST_OPENCODE_HEADLESS_ENV, writeOpencode2Bridge } from './opencode2Bridge.js';
import { opencodeMcpSection, readMcpServersConfig } from './mcpConfig.js';

/**
 * The opencode v2 (`@opencode/cli` 2.x) core — a SEPARATE adapter from v1
 * `opencode`, which shares the command name but not the CLI contract.
 *
 * The v2 facts this adapter encodes were live-verified in
 * `docs/plans/2026-10-06-opencode2-verification.md`:
 *
 * - `--standalone` on every spawn: a bare invocation collides with a shared
 *   background service and per-spawn env only reaches a server karst starts.
 * - The binary is a required SETTING, never a PATH lookup (v2 ships launcher
 *   aliases named `opencode` too) — see `opencode2Binary.ts`.
 * - Every spawn runs under karst-owned XDG dirs: v2 migrates/corrupts v1's
 *   `opencode.db`, so the user's real dirs are never touched.
 * - Headless prompt is STDIN only — positional, `--`, and `--file` all mangle
 *   the bytes.
 * - `OPENCODE_CONFIG_CONTENT` carries top-level `model` (TUI preselection),
 *   `snapshot:false` (headless only, drops the shadow-git snapshot cost), and —
 *   for a read-only/add-dirs launch — a singular `permission` object that wins
 *   over a project `opencode.json` by last-match-wins. The v1
 *   `OPENCODE_PERMISSION` env is ignored by v2, and the ordered `permissions`
 *   array is the resolved internal shape, not an input.
 * - The instruction layer rides a one-line POINTER in the TUI `--prompt`
 *   kickoff: v2 ignores the config `instructions` key (verified on 2.0.24), and
 *   an `AGENTS.md` file is rejected (repo pollution, collision, accidental
 *   commits), so the body stays on disk at `$KARST_INSTRUCTIONS`.
 * - The interactive hook channel is a generated v2 plugin
 *   (`opencode2Bridge.ts`) — `export default { id, setup(ctx) }` — that maps
 *   `session.*`/`permission.*` events to karst's closed hook vocabulary.
 */

const OPENCODE2_TOOL_LABEL = 'OpenCode v2';
const MAX_DIAGNOSTIC_CHARS = 8_000;

/** A fast pre-check probe (session export) must not inherit the 15-minute bound. */
const SESSION_PROBE_TIMEOUT_MS = 20_000;

/**
 * The opencode2 TUI's first token can exceed 8 s (live-verified: 5/10 at 8 s,
 * 10/10 at 20 s). Every readiness/first-output bound for this core must be at
 * least this generous or a healthy launch is killed at startup.
 */
export const OPENCODE2_MIN_READINESS_MS = 20_000;

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
  return text.length <= MAX_DIAGNOSTIC_CHARS ? text : `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Map v2's `tokens` object (`{input, output, reasoning, cache:{read,write}}`,
 * no `total`) into the shared ledger shape. Deliberately mirrors v1's adapter
 * mapping: `cache.read`/`cache.write` are disjoint from `input`, and
 * `reasoning` is its own counter, so they map straight across. A missing
 * `total` is derived from the parts.
 */
function mapTokens(tokens: unknown): TokenUsage | undefined {
  const record = asRecord(tokens);
  if (record === null) return undefined;
  const cache = asRecord(record['cache']);
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = count(record['input']);
  const output = count(record['output']);
  const reasoning = count(record['reasoning']);
  const cacheRead = cache === null ? undefined : count(cache['read']);
  const cacheWrite = cache === null ? undefined : count(cache['write']);
  const total = count(record['total']);
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: reasoning ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    totalTokens:
      total ??
      (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    model: null,
    estimated: false,
  };
}

function stepFinishTokens(part: unknown): TokenUsage | undefined {
  const record = asRecord(part);
  if (record === null || record['type'] !== 'step-finish') return undefined;
  return mapTokens(record['tokens']);
}

/**
 * The launch error for a v2 `error` event. `provider.no-route`'s "Variant
 * unavailable" (fixture `run-error-variant-unavailable.ndjson`) is the one the
 * ticket calls out: the model/effort pair the operator asked for is not
 * offered, and that must surface as a clear launch error, not a raw JSON blob.
 */
export function describeOpencode2ErrorEvent(error: unknown): Error {
  const record = asRecord(error);
  const type = typeof record?.['type'] === 'string' ? (record['type'] as string) : '';
  const message = typeof record?.['message'] === 'string' ? (record['message'] as string) : '';
  if (type === 'provider.no-route' && /variant unavailable/i.test(message)) {
    return new Error(
      `opencode2 refused the requested model variant — ${message}. ` +
        'Check the model id and its advertised effort variants.',
    );
  }
  if (type.startsWith('provider.auth') || record?.['status'] === 401 || record?.['status'] === 403) {
    return new Error(
      `opencode2 is not authenticated (${message || type}). ` +
        "Run 'Karst: Log in to OpenCode v2' and retry.",
    );
  }
  return new Error(
    `opencode2 reported an error: ${diagnostic(JSON.stringify(error ?? null))}`,
  );
}

/**
 * Parse `opencode2 run --format json` NDJSON. One object per stdout line; a
 * truncated final line is SKIPPED (v2 streams, so a cut mid-write is expected).
 *
 * Shapes the live fixtures pin: a text-only turn emits NO `step_finish`
 * (`run-text.ndjson`), a tool turn emits `tool_use` with `tool:"shell"` and a
 * `step_finish` whose tokens carry no `total` (`run-tool-auto.ndjson`), and a
 * failure can be a single `error` event with no step at all (`run-error-*`).
 */
export function parseOpencode2Jsonl(stdout: string): {
  sessionId: string;
  raw: string;
  usage?: TokenUsage;
} {
  let sessionId = '';
  let raw = '';
  let usage: TokenUsage | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof event['sessionID'] === 'string') sessionId = event['sessionID'];
    if (event['type'] === 'error') throw describeOpencode2ErrorEvent(event['error']);
    if (event['type'] === 'text') {
      const part = asRecord(event['part']);
      if (part !== null && part['type'] === 'text' && typeof part['text'] === 'string') {
        raw += part['text'];
      }
    }
    if (event['type'] === 'step_finish') {
      const mapped = stepFinishTokens(event['part']);
      if (mapped) usage = mapped;
    }
  }

  if (!sessionId) throw new Error('opencode2 JSONL did not contain a session id');
  // No text is an EMPTY ANSWER, never a parse failure — a turn can end on a
  // tool call (869ekt). A missing session id stays a hard failure.
  return { sessionId, raw, ...(usage ? { usage } : {}) };
}

/**
 * The first `error` event in a v2 NDJSON stream, described for a human, or
 * `null` when the stream carries none. Used on the NONZERO-exit path so a
 * structured failure (auth, an unavailable variant) keeps its clear message
 * instead of being flattened into raw JSON by the generic describer.
 */
export function findOpencode2ErrorEvent(stdout: string): Error | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['type'] === 'error') return describeOpencode2ErrorEvent(event['error']);
  }
  return null;
}

/** The usage read for a FAILED run — whatever `step_finish` events streamed. */
export function parseOpencode2JsonlUsage(stdout: string): TokenUsage | null {
  let usage: TokenUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['type'] !== 'step_finish') continue;
    const mapped = stepFinishTokens(event['part']);
    if (mapped) usage = mapped;
  }
  return usage ?? null;
}

/**
 * Read the CUMULATIVE session usage from `session export <id>` output. v2 puts
 * the running tally at `info.tokens` (no `total`; derived), which is why this
 * — not the per-step `step_finish` counts — is the headless usage source.
 * Returns null when the document is not a session export.
 */
export function parseOpencode2Export(stdout: string): TokenUsage | null {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const info = asRecord(document['info']);
  if (info === null) return null;
  return mapTokens(info['tokens']) ?? null;
}

/**
 * The one per-spawn `OPENCODE_CONFIG_CONTENT` builder. This ticket adds
 * top-level `model` (TUI preselection; effort rides as the `#<effort>` suffix),
 * `snapshot:false` for HEADLESS spawns (removes the shadow-git snapshot cost;
 * interactive keeps snapshots for undo), and the read-only/add-dirs
 * `permission` object (singular — v2 rejects the v1 `OPENCODE_PERMISSION` env
 * and the ordered `permissions` array shape). The ruleset wins over a project
 * `opencode.json`: v2 appends CONFIG_CONTENT rules after the file's, and the
 * last matching rule decides (verified against 2.0.24).
 */
export function buildOpencode2ConfigContent(opts: {
  model?: string | undefined;
  effort?: string | undefined;
  headless: boolean;
  readOnly?: boolean | undefined;
  addDirs?: string[] | undefined;
  /** The `mcp` section when a launch-time karst MCP config was supplied. */
  mcp?: Record<string, unknown> | undefined;
}): string {
  const config: Record<string, unknown> = {};
  if (opts.model) {
    config['model'] = opts.effort ? `${opts.model}#${opts.effort}` : opts.model;
  }
  if (opts.headless) config['snapshot'] = false;
  const permission = opencodeLaunchPermission(opts);
  if (permission) config['permission'] = permission;
  if (opts.mcp && Object.keys(opts.mcp).length > 0) config['mcp'] = opts.mcp;
  return JSON.stringify(config);
}

/** The `--model` argv value: `<id>#<effort>` when an effort is set. */
function modelArg(model: string, effort: string | undefined): string {
  return effort ? `${model}#${effort}` : model;
}

export interface Opencode2SessionProbe {
  /** False only when v2 explicitly reported the session missing (exit 1). */
  found: boolean;
  /** Cumulative usage, when the export parsed. */
  usage?: TokenUsage;
}

export class Opencode2Adapter implements AgentAdapter {
  /**
   * opencode2's binary is a required SETTING, not a PATH command — v2 ships its
   * launcher also named `opencode`, so a lookup would run v1. `resolveAdapter`
   * constructs with no args, so this reads the process-wide config the host
   * sets (`opencode2Binary.ts`).
   */
  get requiredBinary(): string {
    return opencode2Command();
  }

  readonly capabilities: AgentCapabilities = {
    // The generated v2 plugin posts SessionStart / session.status / session.idle
    // / permission.* and cumulative UsageUpdate events.
    lifecycleEvents: true,
    resume: true,
    interactiveUsage: true,
    // Measured on the local opencode2 TUI: same submit window as v1.
    submitDelayMs: 60,
  };

  readonly surfaces: AdapterSurfaces = {
    exactModel: SUPPORTED,
    model: SUPPORTED,
    effortHeadless: SUPPORTED,
    effortInteractive: SUPPORTED,
    allowedTools: unsupported(
      'opencode2 narrows tools through its `permission` config object, not a per-run CLI flag',
    ),
    permissionMode: SUPPORTED,
    resume: SUPPORTED,
    sessionName: unsupported('the opencode2 TUI has no launch-time session-name flag'),
    consoleStream: SUPPORTED,
    structuredOutput: unsupported(
      '`opencode2 run --format json` emits raw JSON session events, never a '
        + 'schema-constrained final document',
    ),
    hookChannel: SUPPORTED,
    endpointRebind: SUPPORTED,
    mcpIsolationHeadless: unsupported(
      'opencode2 has no per-run MCP-isolation flag; the isolated XDG_CONFIG_HOME keeps '
        + 'the operator\'s config out but is not a per-server drop',
    ),
    toolActivity: unsupported(
      'opencode2\'s event stream has no per-tool PostToolUse event; the bridge can post '
        + 'execution/permission/usage signals but tool activity per turn is unobservable',
    ),
    skillDiscovery: SUPPORTED,
    entryOrchestrators: SUPPORTED,
    readOnlyInteractive: SUPPORTED,
    addDirsInteractive: SUPPORTED,
    mcpConfigInteractive: SUPPORTED,
  };

  readonly instructions: InstructionDelivery = {
    interactive: 'pointer',
    headless: 'n/a',
    acp: 'n/a',
    // The persona is materialized as an agent prompt on a solo launch, so the
    // pointer cannot ride beside it and the composer inlines the rules.
    soloFallback: true,
  };

  constructor(
    private readonly spawnHeadless: SpawnHeadless = defaultSpawn,
    private readonly materializer: OpencodeAdapter = new OpencodeAdapter(),
  ) {}

  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand {
    const args: string[] = ['--standalone'];
    let ownedPaths: string[] | undefined;
    if (opts.hookChannel) {
      // The generated v2 plugin is the ONLY hook authority karst introduces. It
      // is auto-discovered from `.opencode/plugins/` for a session launched in
      // this worktree, and it is adapter-owned so session close removes it. No
      // `--pure`-style isolation flag is passed on an interactive launch: it
      // would suppress the very plugin the hooks depend on.
      const pluginPath = writeOpencode2Bridge(
        opts.cwd,
        opts.hookChannel.endpointUrl,
        opts.hookChannel.configDir,
      );
      ownedPaths = [pluginPath];
    }
    if (opts.resume && opts.resume.length > 0) args.push('--session', opts.resume);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    const deliver = opts.instructions !== undefined && opts.soloAgent !== true;
    const kickoff = deliver
      ? withInstructionsPointer(opts.initialPrompt, renderInstructionsPointer())
      : opts.initialPrompt;
    // No `--model`: v2 preselects through the config blob (verified PASS,
    // including the `#<effort>` variant).
    if (kickoff) args.push('--prompt', kickoff);
    const mcp = opts.mcpConfigPath
      ? opencodeMcpSection(readMcpServersConfig(opts.mcpConfigPath))
      : undefined;
    const env: Record<string, string> = {
      ...opencode2IsolationEnv(opencode2Config().home),
      OPENCODE_CONFIG_CONTENT: buildOpencode2ConfigContent({
        model: opts.model,
        effort: opts.effort,
        headless: false,
        readOnly: opts.readOnly,
        addDirs: opts.addDirs,
        ...(mcp ? { mcp } : {}),
      }),
    };
    return {
      command: opencode2Command(),
      args,
      env,
      ...(ownedPaths ? { ownedPaths } : {}),
      ...(opts.instructions
        ? {
            instructionsChannel:
              opts.soloAgent === true ? ('fallback' as const) : ('pointer' as const),
          }
        : {}),
    };
  }

  materializeApproach(opts: MaterializeOpts): Materialized {
    // v2 discovers the same `.opencode/` layout as v1, so the materialization
    // is shared verbatim rather than duplicated (owned-path and exclude rules
    // are identical by construction).
    return this.materializer.materializeApproach!(opts);
  }

  /**
   * `session export <id>` with the isolated env. exit 1 + "Session not found"
   * is the ONLY "missing" answer; any other failure is undetermined and the
   * caller keeps the resume (fail-open, never silently drop a live session).
   *
   * Public so `resolveResume` (the interactive seam) and `runHeadless` share
   * the same check; a synchronous `buildInteractiveCommand` cannot await it.
   */
  async probeResume(
    sessionId: string,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      debug?: (message: string) => void;
      timeoutMs?: number;
    },
  ): Promise<Opencode2SessionProbe> {
    const args = ['session', 'export', sessionId, '--standalone'];
    opts?.debug?.(
      `[agent:opencode2] pre-check: ${opencode2Command()} ${args.join(' ')} (cwd ${cwd})`,
    );
    let result: HeadlessSpawnResult;
    try {
      result = await this.spawnHeadless(opencode2Command(), args, cwd, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs ?? SESSION_PROBE_TIMEOUT_MS,
        onDebug: opts?.debug,
        // Every non-interactive spawn carries the headless marker so a plugin
        // left in the worktree stays silent (see opencode2Bridge.ts).
        isolationEnv: {
          ...opencode2IsolationEnv(opencode2Config().home),
          [KARST_OPENCODE_HEADLESS_ENV]: '1',
        },
      });
    } catch {
      // A probe failure is not proof the session is gone.
      opts?.debug?.('[agent:opencode2] pre-check: probe failed — keeping the resume id');
      return { found: true };
    }
    if (result.exitCode !== 0) {
      if (result.exitCode === 1 && /session not found/i.test(result.stderr)) {
        return { found: false };
      }
      opts?.debug?.(
        `[agent:opencode2] pre-check: exit ${result.exitCode} (not a missing session) — keeping the resume id`,
      );
      return { found: true };
    }
    const usage = parseOpencode2Export(result.stdout);
    return { found: true, ...(usage ? { usage } : {}) };
  }

  /**
   * The interactive seam's resume pre-check: drop a stale id (with a logged
   * reason) so a TUI launch never hands `--session` a session that is gone.
   */
  async resolveResume(
    sessionId: string,
    opts: { cwd: string; debug?: (message: string) => void },
  ): Promise<string | undefined> {
    const probe = await this.probeResume(sessionId, opts.cwd, { debug: opts.debug });
    if (probe.found) return sessionId;
    opts.debug?.(`[agent:opencode2] resume id ${sessionId} not found on opencode2 → fresh launch`);
    return undefined;
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    let resume = opts.resume;
    if (resume && resume.length > 0) {
      const probe = await this.probeResume(resume, opts.cwd, {
        signal: opts.signal,
        debug: opts.debug,
      });
      if (!probe.found) {
        opts.debug?.(`[agent:opencode2] resume id ${resume} not found on opencode2 → fresh launch`);
        resume = undefined;
      }
    }

    const args = ['run', '--format', 'json', '--standalone'];
    if (opts.permissionMode === 'bypassPermissions') args.push('--auto');
    if (opts.model) args.push('--model', modelArg(opts.model, opts.effort));
    if (resume) args.push('--session', resume);
    // The prompt rides STDIN only — positional/`--`/`--file` all mangle it.

    const debugArgs = args.map((a) => a);
    opts.debug?.(
      `[agent:opencode2] spawn: ${opencode2Command()} ${debugArgs.join(' ')} ` +
        `(cwd ${opts.cwd}; prompt <stdin:${opts.prompt.length} chars>)`,
    );
    const consoleStream = opts.onOutput
      ? renderConsoleStream('opencode2', opts.onOutput)
      : undefined;

    let result: HeadlessSpawnResult;
    try {
      result = await this.spawnHeadless(opencode2Command(), args, opts.cwd, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onDebug: opts.debug,
        onSpawned: opts.onSpawned,
        env: opts.env,
        // Headless only: the config blob carries `snapshot:false`, which removes
        // the shadow-git snapshot cost (~2x faster tool turns). It rides the
        // adapter-owned isolation env because `RunHeadlessOpts.env` is filtered
        // to KARST_* keys. The prompt still rides stdin.
        isolationEnv: {
          ...opencode2IsolationEnv(opencode2Config().home),
          OPENCODE_CONFIG_CONTENT: buildOpencode2ConfigContent({ headless: true }),
          // A headless `run` may discover a plugin an earlier interactive
          // session left in the worktree; the marker makes setup() return
          // immediately so the run emits no interactive hooks.
          [KARST_OPENCODE_HEADLESS_ENV]: '1',
        },
        stdin: opts.prompt,
        onOutput: consoleStream ? consoleStream.append : opts.onOutput,
      });
    } finally {
      consoleStream?.flush();
    }
    if (result.exitCode !== 0) {
      opts.debug?.(
        `[agent:opencode2] exit ${result.exitCode} — stdout: ${headlessPreview(result.stdout)}; stderr: ${headlessPreview(result.stderr)}`,
      );
      // A structured error event (auth, an unavailable variant) keeps its
      // actionable message; anything else falls back to the shared describer.
      const structured = findOpencode2ErrorEvent(result.stdout);
      throw attachUsage(
        structured ??
          new Error(
            describeHeadlessFailure({
              tool: OPENCODE2_TOOL_LABEL,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            }),
          ),
        parseOpencode2JsonlUsage(result.stdout),
      );
    }
    let parsed: ReturnType<typeof parseOpencode2Jsonl>;
    try {
      parsed = parseOpencode2Jsonl(result.stdout);
    } catch (error) {
      opts.debug?.(
        `[agent:opencode2] unparseable output — first 500 chars: ${headlessPreview(result.stdout)}`,
      );
      throw error;
    }
    if (parsed.raw === '') {
      opts.debug?.(
        `[agent:opencode2] clean exit with no agent text — empty answer (${result.stdout.length} byte(s) of events)`,
      );
    }
    // Prefer the CUMULATIVE tally from `session export`; the stream's
    // `step_finish` counts are per-step. A failed export keeps the stream value.
    let usage = parsed.usage;
    if (parsed.sessionId) {
      const exportProbe = await this.probeResume(parsed.sessionId, opts.cwd, {
        signal: opts.signal,
        debug: opts.debug,
      });
      if (exportProbe.usage) usage = exportProbe.usage;
    }
    return {
      sessionId: parsed.sessionId,
      verdict: null,
      raw: parsed.raw,
      ...(usage ? { usage } : {}),
    };
  }
}
