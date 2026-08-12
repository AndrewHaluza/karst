import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
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
import { describeHeadlessFailure } from './cliFailure.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { attachUsage } from './tokenUsage.js';
import type { TokenUsage } from './tokenUsage.js';
import { KARST_PLUGIN_NAME, renderWorkflowCommand } from './workflowCommand.js';

const OPENCODE_BIN = 'opencode';
const MAX_DIAGNOSTIC_CHARS = 8_000;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * opencode's skill-name rules — lowercase `kebab-case`, 1–64 chars, and NOT the
 * reserved `karst` name. A name is the folder (or file) basename opencode
 * discovers under `.opencode/`, so a violation would be a silently-unloadable
 * artifact.
 */
const OPENCODE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const MAX_OPENCODE_NAME = 64;

/**
 * Guard a RAW value that is ALSO used as a path segment (the approach id names
 * the package directory under `baseDir`). Kept separate from the naming rule
 * below: sluggification would happily erase a `..` instead of refusing it, and
 * the traversal refusal is the security property.
 */
function assertSafeSegment(kind: string, raw: string): void {
  if (
    raw.length === 0 ||
    raw === '..' ||
    raw.includes('/') ||
    raw.includes('\\') ||
    isAbsolute(raw)
  ) {
    throw new Error(`materializeApproach: unsafe ${kind} "${raw}"`);
  }
}

/**
 * The opencode-legal basename DERIVED from a value karst did not choose — an
 * approach id, an artifact basename, a solo agent name.
 *
 * These are NOT the user typing a skill name: an id like
 * `superpowers:writing-plans` is legal in the manifest, is the package's
 * directory on disk, and is what every other adapter carries verbatim. Only the
 * basename opencode discovers under `.opencode/` has to be kebab, so a
 * non-kebab source is SLUGGED here rather than rejected — the rejection parked
 * every ticket on such an approach with no skills, agents or commands
 * materialized at all (869eg343z). The source value keeps naming the package
 * directory; only the destination name is slugged.
 *
 * Still a hard rejection when nothing legal survives (an id of pure
 * punctuation), when the slug is the reserved `karst` plugin name, or when the
 * source could escape its directory — a truncation would collide two approaches
 * onto one name.
 */
function opencodeName(kind: string, raw: string): string {
  assertSafeSegment(kind, raw);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug === KARST_PLUGIN_NAME) {
    throw new Error(`materializeApproach: reserved name "${raw}" for ${kind}`);
  }
  if (slug.length === 0 || slug.length > MAX_OPENCODE_NAME || !OPENCODE_NAME.test(slug)) {
    throw new Error(`materializeApproach: invalid name "${raw}" for ${kind}`);
  }
  return slug;
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

/**
 * opencode's `step_finish` event reports `part.tokens` as
 * `{total, input, output, reasoning, cache:{write, read}}` — keys the shared
 * `extractTokenUsage` deliberately does not match (it looks for
 * `input_tokens`/`prompt_tokens`/etc.), so the adapter owns the mapping, the
 * same way `parseCodexJsonl` owns Codex's dialect. `cache.read`/`cache.write`
 * are disjoint from `input` in opencode's report, so they map straight across.
 */
function mapTokens(tokens: unknown): TokenUsage | undefined {
  const record = asRecord(tokens);
  if (record === null) return undefined;
  const cache = asRecord(record['cache']);
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  const input = count(record['input']);
  const output = count(record['output']);
  const cacheRead = cache === null ? undefined : count(cache['read']);
  const cacheWrite = cache === null ? undefined : count(cache['write']);
  const total = count(record['total']);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    totalTokens:
      total ?? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
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
 * Parse `opencode run --format json` NDJSON. One object per stdout line; a
 * truncated final line is SKIPPED (opencode streams, so a cut mid-write is
 * expected) rather than failing the whole read — unlike codex's strict throw.
 */
export function parseOpencodeJsonl(
  stdout: string,
): { sessionId: string; raw: string; usage?: TokenUsage } {
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
    if (event['type'] === 'error') {
      throw new Error(
        `opencode reported an error: ${diagnostic(JSON.stringify(event['error']))}`,
      );
    }
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

  if (!sessionId) throw new Error('opencode JSONL did not contain a session id');
  if (!raw) throw new Error('opencode JSONL did not contain agent text');
  return { sessionId, raw, ...(usage ? { usage } : {}) };
}

/**
 * The usage read for a FAILED run — a failure that died mid-stream still burned
 * everything up to the cut, so the counts ride out on the rejection. Uses the
 * SAME opencode token mapping as the success path.
 */
export function parseOpencodeJsonlUsage(stdout: string): TokenUsage | null {
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
 * opencode's only hook surface is a JS/TS plugin executed under Bun inside the
 * opencode server process (Task 7). The adapter generates a `.js` file beneath
 * `cwd/.opencode/plugins/` (auto-discovered for a session launched in that
 * worktree) exporting a plugin function whose `event` hook subscribes to
 * `session.idle`, `session.error`, and `permission.asked` and POSTs a normalized
 * payload `{ hook_event_name, cwd, session_id, message? }` to the loopback
 * endpoint — the opencode-native equivalent of Codex's `bridge.cjs`.
 *
 * Task 5: `session.idle` is the token-bearing completion event — its properties
 * carry the session snapshot whose `tokens` (`{ input, output, reasoning,
 * cache: { read, write } }`) are CUMULATIVE for the session, the same shape the
 * headless `step_finish` parser reads. When they are present and numeric, the
 * bridge posts a closed `UsageUpdate` beside the lifecycle event, keyed by the
 * plugin event's stable id. Cache reads and cache writes stay SEPARATE counters
 * — they are never folded into a single cached-input value. Token-less or
 * malformed events post no UsageUpdate at all.
 *
 * Safety mirrors `CODEX_HOOK_BRIDGE`: the endpoint is baked in at generation
 * time from a loopback-validated URL, the serialized payload is size-bounded
 * (a local sender can't grow host memory), and every failure is swallowed so a
 * dead endpoint or a plugin defect never throws into the agent's event loop.
 */
function renderHookBridge(endpointUrl: string): string {
  return String.raw`import { request } from 'node:http';

const endpointUrl = ${JSON.stringify(endpointUrl)};
const MAX_PAYLOAD_BYTES = 64 * 1024;

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

// opencode event payloads vary; extract defensively.
function extractSessionId(input) {
  if (!input) return '';
  const direct = stringOf(input.sessionID);
  if (direct) return direct;
  const session = asRecord(input.session);
  return session ? stringOf(session.id) : '';
}

function extractCwd(input, directory, worktree) {
  if (input) {
    const direct = stringOf(input.cwd);
    if (direct) return direct;
    const session = asRecord(input.session);
    const sessionDir = session ? stringOf(session.dir) : '';
    if (sessionDir) return sessionDir;
    const eventDir = stringOf(input.directory);
    if (eventDir) return eventDir;
  }
  // The plugin input's directory/worktree IS the session's launch cwd — the
  // same path the hook endpoint keys tickets on (events rarely carry it).
  const ctxDir = stringOf(directory);
  if (ctxDir) return ctxDir;
  return stringOf(worktree);
}

function extractErrorMessage(input) {
  if (!input) return '';
  const err = asRecord(input.error);
  if (err) {
    const message = stringOf(err.message);
    if (message) return message;
    const data = asRecord(err.data);
    const dataMessage = data ? stringOf(data.message) : '';
    if (dataMessage) return dataMessage;
  }
  const direct = stringOf(input.message);
  if (direct) return direct;
  try {
    const serialized = JSON.stringify(input.error);
    if (serialized && serialized.length <= 2000) return serialized;
  } catch {}
  return '';
}

// A count is a finite, non-negative number; anything else is not a count.
function usageCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// The session snapshot's cumulative tokens, read as opencode reports them:
// tokens.input/tokens.output plus nested tokens.cache.read/tokens.cache.write.
function extractUsage(input) {
  const session = asRecord(input && input.session);
  const tokens =
    asRecord(session && session.tokens) || asRecord(input && input.tokens);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const inputTokens = usageCount(tokens.input);
  const outputTokens = usageCount(tokens.output);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheRead = usageCount(cache && cache.read);
  const cacheWrite = usageCount(cache && cache.write);
  const total = usageCount(tokens.total);
  const usage = { input: inputTokens, output: outputTokens };
  if (cacheRead !== null) usage.cache_read = cacheRead;
  if (cacheWrite !== null) usage.cache_write = cacheWrite;
  if (total !== null) usage.total = total;
  return usage;
}

function send(payload, done) {
  try {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      if (done) done();
      return;
    }
    const target = new URL(endpointUrl);
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body, 'utf8'),
      },
      timeout: 2000,
    });
    // Fail open: a stale endpoint (IDE lifecycle race) must never block the agent.
    req.on('error', () => { if (done) done(); });
    req.on('timeout', () => req.destroy());
    req.end(body);
    if (done) {
      req.on('response', (res) => {
        res.resume();
        res.on('end', done);
      });
    }
  } catch {
    if (done) done();
  }
}

function post(hookEventName, input, directory, worktree, message, done) {
  const sessionId = extractSessionId(input);
  const cwd = extractCwd(input, directory, worktree);
  if (!sessionId && !cwd) {
    if (done) done();
    return;
  }
  const payload = { hook_event_name: hookEventName, cwd, session_id: sessionId };
  if (message) payload.message = message;
  send(payload, done);
}

function postUsage(eventId, input, directory, worktree, done) {
  const sessionId = extractSessionId(input);
  const cwd = extractCwd(input, directory, worktree);
  const usage = extractUsage(input);
  if (!sessionId || !cwd || !usage || !eventId) {
    if (done) done();
    return;
  }
  send({
    hook_event_name: 'UsageUpdate',
    cwd,
    session_id: sessionId,
    usage: { event_id: eventId, ...usage },
  }, done);
}

export const KarstBridge = async ({ directory, worktree }) => {
  return {
    event: async ({ event }) => {
      const type = event && event.type;
      const input = event && event.properties;
      if (type === 'session.idle') {
        // The usage update is sequenced AFTER the lifecycle post settles so the
        // endpoint sees one session event then its tokens — never reordered.
        post('session.idle', input, directory, worktree, undefined, () =>
          postUsage(event && event.id, input, directory, worktree));
      } else if (type === 'session.error') {
        post('session.error', input, directory, worktree, extractErrorMessage(input));
      } else if (
        type === 'permission.asked' ||
        type === 'permission.v2.asked' ||
        type === 'question.asked' ||
        type === 'question.v2.asked'
      ) {
        // A question is the same "blocked on the user" signal as a permission:
        // the agent stopped and only a human can continue it. Normalized to
        // karst's own closed wait vocabulary (permission.asked) so dispatch
        // needs no new event.
        post('permission.asked', input, directory, worktree);
      } else if (
        type === 'permission.replied' ||
        type === 'permission.v2.replied' ||
        type === 'question.replied' ||
        type === 'question.v2.replied'
      ) {
        // The ask was ANSWERED and the session resumes. opencode never emits a
        // PostToolUse/UserPromptSubmit, so this resolution is the ONLY signal
        // that the wait ended — without it, one answered prompt left the
        // ticket reading "Needs you" while the session kept processing
        // (FIX-WRONG-STATUS). Normalized to karst's own closed resolution
        // event (permission.replied) so dispatch needs no new event.
        post('permission.replied', input, directory, worktree);
      } else if (type === 'session.status') {
        // opencode's processing signal: 'status.type' is busy/idle/retry.
        // busy (and retry) mean the session is working — the running signal
        // the plugin can otherwise never send. idle is skipped: session.idle
        // already carries the idle flip.
        const status = asRecord(input && input.status);
        const state = status ? stringOf(status.type) : '';
        if (state === 'busy' || state === 'retry') {
          post('session.status', input, directory, worktree, state);
        }
      }
    },
  };
};
`;
}

/**
 * Refuse any endpoint that is not a bound `http://127.0.0.1:<port>` — the same
 * loopback rule Codex enforces (§ hooks). A plugin POSTs ticket state keyed by
 * worktree path; only the extension-host listener may receive it.
 */
function assertLoopbackEndpoint(endpointUrl: string): void {
  const target = new URL(endpointUrl);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.port === '' ||
    target.port === '0'
  ) {
    throw new Error(`karst: refusing non-loopback hook endpoint ${endpointUrl}`);
  }
}

/**
 * Write the karst-bridge plugin beneath `cwd` (the worktree) and return its
 * path. Atomic (temp + rename) and skipped when the existing content is
 * identical, mirroring Codex's bridge write — re-launching a session must not
 * churn the file, and a plugin from another session's endpoint is replaced.
 */
function writeKarstBridge(cwd: string, endpointUrl: string): string {
  assertLoopbackEndpoint(endpointUrl);
  const pluginPath = join(cwd, '.opencode', 'plugins', 'karst-bridge.js');
  const body = renderHookBridge(endpointUrl);
  const current = existsSync(pluginPath) ? readFileSync(pluginPath, 'utf8') : null;
  if (current !== body) {
    mkdirSync(dirname(pluginPath), { recursive: true });
    const temporaryPath = `${pluginPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, body);
    renameSync(temporaryPath, pluginPath);
  }
  return pluginPath;
}

export class OpencodeAdapter implements AgentAdapter {
  readonly requiredBinary = OPENCODE_BIN;
  // lifecycleEvents is gated on the generated `.opencode/plugins/karst-bridge.js`
  // (Task 7): opencode has no CLI hook flag, so the plugin IS the channel. It
  // ships ONCE the channel is proven; `resume` stays false — the TUI has no
  // launch-time resume flag, and headless resume runs via `--session`.
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: false,
    interactiveUsage: true,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  // `opts.sessionName` and `opts.resume` are deliberately dropped: the opencode
  // TUI has no launch-time session-name flag and no interactive resume flag, so
  // a resume id passed despite `resume:false` is ignored rather than emitted as
  // an unsupported `-s` against a TUI that would hang on a nonexistent session.
  buildInteractiveCommand(
    opts: InteractiveCommandOpts,
  ): InteractiveCommand {
    const args: string[] = [];
    let ownedPaths: string[] | undefined;
    if (opts.hookChannel) {
      // The generated plugin is the ONLY hook authority karst introduces — and
      // `--pure` disables ALL external plugin loading in opencode, including the
      // auto-discovered `.opencode/plugins/karst-bridge.js` this very call just
      // wrote. An interactive session launched with `--pure` can therefore never
      // deliver a single hook event (no SessionStart, no permission.asked, no
      // usage), which is how a permission ask in an opencode fix session failed
      // to surface "Needs you" (869eg458d). Never pass it here. Headless `run`
      // keeps `--pure` on purpose: gate processes need no hooks and stay
      // isolated from the user's own plugins.
      const pluginPath = writeKarstBridge(opts.cwd, opts.hookChannel.endpointUrl);
      ownedPaths = [pluginPath];
    }
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    if (opts.initialPrompt) args.push('--prompt', opts.initialPrompt);
    return {
      command: OPENCODE_BIN,
      args,
      env: {},
      ...(ownedPaths ? { ownedPaths } : {}),
    };
  }

  materializeApproach(opts: MaterializeOpts): Materialized {
    const idName = opencodeName('approach id', opts.pkg.id);
    const owned = new Set<string>();
    const prefix = `karst-${idName}`;

    for (const artifact of opts.pkg.artifacts ?? []) {
      const source = join(opts.baseDir, opts.pkg.id, artifact.relPath);
      const base =
        artifact.kind === 'skill'
          ? basename(dirname(artifact.relPath))
          : basename(artifact.relPath, extname(artifact.relPath));
      const skillName = `${prefix}-${opencodeName('artifact name', base)}`;

      if (artifact.kind === 'skill') {
        const destination = join(opts.sessionDir, '.opencode', 'skills', skillName);
        // A repository may check in its own skill under the same stable name.
        // That tree belongs to the repository, not this terminal: overwriting
        // it and later treating it as adapter-owned would make session cleanup
        // delete tracked project files.
        if (existsSync(destination)) continue;
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
        owned.add(destination);
      } else if (artifact.kind === 'agent') {
        const destination = join(opts.sessionDir, '.opencode', 'agents', `${skillName}.md`);
        if (existsSync(destination)) continue;
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          [
            '---',
            `description: Delegate work using the ${base} role from ${opts.pkg.label}.`,
            'mode: subagent',
            '---',
            '',
            `Delegate the requested work to a subagent following these instructions:\n\n${readFileSync(source, 'utf8')}`,
          ].join('\n'),
        );
        owned.add(destination);
      } else {
        // opencode HAS commands, but a neutral command maps more safely to an
        // on-demand skill (mirrors Antigravity): preserves the semantics
        // without colliding with the `/<name>` namespace.
        const destination = join(opts.sessionDir, '.opencode', 'skills', skillName);
        if (existsSync(destination)) continue;
        mkdirSync(destination, { recursive: true });
        writeFileSync(
          join(destination, 'SKILL.md'),
          skillDocument(
            skillName,
            `Run the ${base} command from ${opts.pkg.label}.`,
            readFileSync(source, 'utf8'),
          ),
        );
        owned.add(destination);
      }
    }

    if (opts.soloAgent) {
      const agentName = opencodeName('solo agent name', opts.soloAgent.name);
      const destination = join(
        opts.sessionDir,
        '.opencode',
        'agents',
        `karst-agent-${agentName}.md`,
      );
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          [
            '---',
            `description: Delegate the ticket to the ${opts.soloAgent.name} role.`,
            'mode: subagent',
            '---',
            '',
            `Delegate this ticket to a subagent following these instructions:\n\n${opts.soloAgent.body}`,
          ].join('\n'),
        );
        owned.add(destination);
      }
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
      // BARE `<id-slug>` (NOT `karst-<id>`): opencode registers the command file
      // as `/<basename>`, so this materializes as `/<id-slug>`. The slug is
      // already validated and reserved-safe. Deliberately NOT added to
      // `ownedPaths`: OWNED_PREFIXES only covers `.opencode/commands/karst-*`,
      // and claiming this bare-id path would make `cleanupOwnedPaths` throw.
      const destination = join(
        opts.sessionDir,
        '.opencode',
        'commands',
        `${idName}.md`,
      );
      if (!existsSync(destination)) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(
          destination,
          [
            '---',
            `description: Run the ${opts.pkg.label} workflow for a Karst ticket.`,
            'agent: build',
            '---',
            '',
            body,
          ].join('\n'),
        );
      }
    }

    return {
      extraArgs: [],
      ownedPaths: [...owned],
      ...(hasWorkflow ? { invocation: `/${idName}` } : {}),
    };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = ['run', '--format', 'json', '--pure'];
    // `--pure` suppresses config/global plugins, the same isolation
    // `buildInteractiveCommand` gives the interactive session: every headless
    // run (review findings lane, classify, fix-resume) must not inherit plugins
    // that add context, latency, or other projects' hook channels (869ef1e6x).
    if (opts.permissionMode === 'bypassPermissions') args.push('--auto');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resume) args.push('--session', opts.resume);
    // `--` terminates options so a dash-prefixed prompt (e.g. a YAML
    // frontmatter `---` in a seed) cannot be misread as an option.
    args.push('--', opts.prompt);

    // The prompt is ticket prose — never logged in full. The debug line names
    // the invocation and redacts the prompt to its length (§ debug logging).
    opts.debug?.(
      `[agent:opencode] spawn: ${args
        .map((a) => (a === opts.prompt ? `<prompt:${opts.prompt.length} chars>` : a))
        .join(' ')} (cwd ${opts.cwd})`,
    );
    const result = await this.spawnHeadless(OPENCODE_BIN, args, opts.cwd, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      onDebug: opts.debug,
      onSpawned: opts.onSpawned,
    });
    if (result.exitCode !== 0) {
      opts.debug?.(
        `[agent:opencode] exit ${result.exitCode} — stdout: ${headlessPreview(result.stdout)}; stderr: ${headlessPreview(result.stderr)}`,
      );
      throw attachUsage(
        new Error(
          describeHeadlessFailure({
            tool: 'OpenCode',
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
        ),
        parseOpencodeJsonlUsage(result.stdout),
      );
    }
    let parsed: ReturnType<typeof parseOpencodeJsonl>;
    try {
      parsed = parseOpencodeJsonl(result.stdout);
    } catch (error) {
      opts.debug?.(
        `[agent:opencode] unparseable output — first 500 chars: ${headlessPreview(result.stdout)}`,
      );
      throw error;
    }
    return {
      sessionId: parsed.sessionId,
      verdict: null,
      raw: parsed.raw,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  }
}
