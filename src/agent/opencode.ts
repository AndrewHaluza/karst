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
import { renderConsoleStream } from './consoleFormat.js';
import { spawnHeadlessCli, headlessPreview, type HeadlessSpawnOptions } from './headlessSpawn.js';
import { attachUsage } from './tokenUsage.js';
import type { TokenUsage } from './tokenUsage.js';
import { KARST_PLUGIN_NAME, renderWorkflowCommand } from './workflowCommand.js';
import { withStamp, writeGeneratedArtifact } from './generatedArtifact.js';
import { renderTestSkill } from './testSkill.js';
import { SUPPORTED, unsupported, type AdapterSurfaces } from './surfaces.js';
import { currentEndpointPath } from './hookFailureLog.js';

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
  // NO text part is an EMPTY ANSWER, never a parse failure (869ekt). opencode
  // ends a turn on a tool call often enough that a clean 3-minute UAT run can
  // stream nothing but `tool_use`; throwing here reached the UAT Tester as an
  // adapter crash, which abandoned every remaining target and recorded zero
  // observations. Claude and agy already answer '' for the same shape, so the
  // seam agrees: an empty `raw` is what a silent core returns, and the CALLER
  // decides what an empty answer means (the Tester re-asks once, then records
  // `unreadable-output`). A stream with no session id stays a hard failure —
  // that one is a broken stream, not a quiet model.
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
 * Task 5: `session.updated` is the token-bearing event — its properties nest
 * the Session object under `info` whose `tokens` (`{ input, output, reasoning,
 * cache: { read, write } }`) are CUMULATIVE for the session (opencode 1.18.18
 * publishes `session.idle` with only a `sessionID`, so it can never carry the
 * tally; verified against the installed CLI's source and a live conversation
 * DB). When the counters are present and numeric, the bridge posts a closed
 * `UsageUpdate` keyed by the plugin event's stable id, only when the tally
 * advanced since the last posted observation. Cache reads and cache writes
 * stay SEPARATE counters — they are never folded into a single cached-input
 * value. Token-less or malformed events post no UsageUpdate at all.
 *
 * Safety mirrors `CODEX_HOOK_BRIDGE`: the endpoint is baked in at generation
 * time from a loopback-validated URL, the serialized payload is size-bounded
 * (a local sender can't grow host memory), and every failure is swallowed so a
 * dead endpoint or a plugin defect never throws into the agent's event loop.
 */
function renderHookBridge(endpointUrl: string, endpointFile: string | null): string {
  return String.raw`import { request } from 'node:http';
import { readFileSync } from 'node:fs';

// The launch-time URL is this window's endpoint while that window lives. A VS
// Code reload rebinds an ephemeral hook port, so the extension writes its
// current URL to a stable file on every activation; when the launch-time URL
// stops answering (connection refused, or a foreign process on the stale port)
// the plugin falls back to that file. Without this, an opencode session that
// survived a reload posted into a dead port for the rest of its life — the
// same defect the codex bridge already fixed for itself (869ej1zpv G3). The
// launch-time query string carries the karstLaunch generation, so it is
// re-applied to every candidate or the endpoint's generation barrier would
// reject the rebound session.
const launchEndpointUrl = ${JSON.stringify(endpointUrl)};
const endpointFile = ${JSON.stringify(endpointFile)};
const MAX_PAYLOAD_BYTES = 64 * 1024;

let launchSearch = '';
try { launchSearch = new URL(launchEndpointUrl).search; } catch {}

// The fallback URL comes off disk, so it is re-validated here exactly as the
// launch URL was validated at generation time: hook payloads carry session ids
// and worktree paths, and a non-loopback candidate would send them off-box.
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function candidateEndpoint(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return null;
    if (launchSearch) url.search = launchSearch;
    return url.toString();
  } catch {
    return null;
  }
}

// Resolved LAZILY and once: the launch endpoint answers for the whole life of a
// session that outlives no reload, and this runs inside the agent's own
// process, so a synchronous read per hook event would be pure waste. Read only
// when the launch URL has actually stopped delivering.
let fallbackResolved = false;
let fallbackEndpoint = null;
function readFallbackEndpoint() {
  if (fallbackResolved) return fallbackEndpoint;
  fallbackResolved = true;
  if (endpointFile) {
    try {
      const content = readFileSync(endpointFile, 'utf8').trim();
      if (content.length > 0) fallbackEndpoint = candidateEndpoint(content);
    } catch {}
  }
  return fallbackEndpoint;
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

// opencode event payloads vary; extract defensively. session.created carries
// the session under info (a Session object) rather than a flat sessionID —
// the launch-intent handshake needs its id, so both shapes resolve here.
function extractSessionId(input) {
  if (!input) return '';
  const direct = stringOf(input.sessionID);
  if (direct) return direct;
  const session = asRecord(input.session);
  const sessionId = session ? stringOf(session.id) : '';
  if (sessionId) return sessionId;
  // 'session.created' nests the Session under 'properties.info' (the SDK's
  // EventSessionCreated) — the ONLY opencode event that delivers the
  // interactive session id, and thus the capture step of resume-by-id (§5.3).
  const info = asRecord(input.info);
  return info ? stringOf(info.id) : '';
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
    // 'session.created' nests the Session under 'properties.info' too.
    const info = asRecord(input.info);
    const infoDir = info ? stringOf(info.directory) : '';
    if (infoDir) return infoDir;
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
// session.updated nests the Session object under info.tokens — CUMULATIVE for
// the session (verified against 1.18.18's schema and a live conversation DB).
// The legacy snapshot shape nested the tally at session.tokens. A
// message.part.updated step-finish part also carries tokens, but those are
// PER-STEP, so they are deliberately NOT read here: the ledger compares
// cumulative tallies, and a step-local count would read as a counter reset.
// cache.read and cache.write are disjoint from input in opencode's report, so
// they map straight across. So is reasoning: opencode counts thinking tokens
// in their own cumulative counter, NOT inside output (verified against a live
// conversation DB — a session reporting 8_220 output reported 40_485 reasoning
// beside it), and they are output-billed spend, so dropping them undercounted
// every reasoning model's session.
function extractUsage(input) {
  const info = asRecord(input && input.info);
  const session = asRecord(input && input.session);
  const tokens =
    (info && asRecord(info.tokens)) ||
    (session && asRecord(session.tokens)) ||
    asRecord(input && input.tokens);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const inputTokens = usageCount(tokens.input);
  const outputTokens = usageCount(tokens.output);
  if (inputTokens === null || outputTokens === null) return null;
  const reasoning = usageCount(tokens.reasoning);
  const cacheRead = usageCount(cache && cache.read);
  const cacheWrite = usageCount(cache && cache.write);
  const total = usageCount(tokens.total);
  const usage = { input: inputTokens, output: outputTokens };
  if (reasoning !== null) usage.reasoning = reasoning;
  if (cacheRead !== null) usage.cache_read = cacheRead;
  if (cacheWrite !== null) usage.cache_write = cacheWrite;
  if (total !== null) usage.total = total;
  return usage;
}

// POST to one candidate. next() is called when THIS candidate did not deliver
// (connection error, timeout, or a non-2xx answer — a foreign process holding
// the stale port answers, so a status check is part of "delivered"); done() is
// called exactly once, whichever way the walk ends.
function sendTo(endpoint, body, done, next) {
  // Exactly one outcome per attempt, like the codex bridge's attemptDone: a
  // destroyed request emits 'error' AFTER its response ended, so without this
  // a delivered payload would also be re-sent to the fallback endpoint and
  // done() would fire twice.
  let settled = false;
  const succeed = () => {
    if (settled) return;
    settled = true;
    if (done) done();
  };
  const advance = () => {
    if (settled) return;
    settled = true;
    next();
  };
  try {
    const target = new URL(endpoint);
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
    req.on('error', () => advance());
    req.on('timeout', () => req.destroy());
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      const ok = status >= 200 && status < 300;
      res.resume();
      res.on('aborted', () => advance());
      res.on('error', () => advance());
      res.on('end', () => (ok ? succeed() : advance()));
    });
    req.end(body);
  } catch {
    advance();
  }
}

function send(payload, done) {
  try {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      if (done) done();
      return;
    }
    const launch = candidateEndpoint(launchEndpointUrl);
    let attempt = 0;
    const advance = () => {
      attempt += 1;
      // 1: the launch-time endpoint. 2: the extension's current one, read only
      // now, and only when it differs from the one that just failed.
      if (attempt === 1 && launch) {
        sendTo(launch, body, done, advance);
        return;
      }
      if (attempt <= 2) {
        const fallback = readFallbackEndpoint();
        if (fallback && fallback !== launch) {
          sendTo(fallback, body, done, advance);
          return;
        }
      }
      if (done) done();
    };
    advance();
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

// The last posted cumulative tally per session. opencode re-emits
// session.updated on every session save, not only when the counters moved, so
// the bridge must not re-post an unchanged observation (the ledger would
// append a zero delta every save).
const lastPostedTally = new Map();

function tallySignature(usage) {
  return [
    usage.input,
    usage.output,
    usage.reasoning ?? 0,
    usage.cache_read ?? 0,
    usage.cache_write ?? 0,
    usage.total ?? 0,
  ].join(':');
}

function postUsageAdvanced(eventId, input, directory, worktree, done) {
  const sessionId = extractSessionId(input);
  const usage = extractUsage(input);
  if (!eventId || !sessionId || !usage) {
    if (done) done();
    return;
  }
  const signature = tallySignature(usage);
  if (lastPostedTally.get(sessionId) === signature) {
    if (done) done();
    return;
  }
  lastPostedTally.set(sessionId, signature);
  postUsage(eventId, input, directory, worktree, done);
}

export const KarstBridge = async ({ directory, worktree }) => {
  return {
    event: async ({ event }) => {
      const type = event && event.type;
      const input = event && event.properties;
      if (type === 'session.created') {
        // opencode's session-creation event — the SessionStart equivalent the
        // launch-intent handshake needs (dispatch.ts confirms a prepared fix
        // launch ONLY on SessionStart carrying the launch id). Without it a
        // closed-session fix resume records its intent and then waits forever:
        // the round stays pending, never fixing, and the stranded-fix sweep
        // parks the stage "no fix execution in flight" while the agent is
        // actually working. Normalized to karst's own closed vocabulary, the
        // same way the agy conversation watch synthesizes a SessionStart. It
        // is also the resume-by-id capture step (§5.3, investigation #217):
        // POSTing SessionStart persists 'tickets.session_id' so a later launch
        // can '--session' the same conversation. The id is the point of the
        // event, so a created event that carries none is dropped (post() would
        // otherwise still fire on the fallback cwd).
        if (extractSessionId(input)) {
          post('SessionStart', input, directory, worktree);
        }
      } else if (type === 'session.updated') {
        // The token-bearing event: its properties nest the Session under
        // info whose tokens are CUMULATIVE for the session (opencode 1.18.18
        // emits session.idle with only a sessionID, so it never carries a
        // tally). Posted only when the tally advanced since the last
        // observation for this session.
        postUsageAdvanced(event && event.id, input, directory, worktree);
      } else if (type === 'session.idle') {
        // Lifecycle only. opencode 1.18.18 emits session.idle with just a
        // sessionID — no tokens — so there is no usage to attach. (Kept as a
        // defensive fallback: if a future opencode adds tokens here,
        // extractUsage picks them up and the tally guard above still dedupes.)
        post('session.idle', input, directory, worktree, undefined, () =>
          postUsageAdvanced(event && event.id, input, directory, worktree));
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
function writeKarstBridge(
  cwd: string,
  endpointUrl: string,
  configDir?: string,
): string {
  assertLoopbackEndpoint(endpointUrl);
  const pluginPath = join(cwd, '.opencode', 'plugins', 'karst-bridge.js');
  // Absent configDir (older callers, tests) → no fallback file; the plugin then
  // uses its launch-time URL alone, exactly as it did before.
  const body = renderHookBridge(
    endpointUrl,
    configDir ? currentEndpointPath(configDir, 'opencode') : null,
  );
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
  // (Task 7): opencode has no CLI hook flag, so the plugin IS the channel. The
  // plugin captures the interactive session id from `session.created` and posts
  // SessionStart, and the TUI accepts `-s/--session <id>` to continue it — so
  // resume is real (verified against opencode 1.18.18, investigation #217).
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
    effortInteractive: unsupported(
      'the opencode TUI (1.18.18) has no `--variant` flag — only `opencode run` accepts ' +
        'it; passing it made the TUI print help and exit 1, killing the session at launch',
    ),
    allowedTools: unsupported(
      'opencode narrows tools through its own permissions config, not a per-run CLI flag',
    ),
    permissionMode: SUPPORTED,
    resume: SUPPORTED,
    sessionName: unsupported('the opencode TUI has no launch-time session-name flag'),
    consoleStream: SUPPORTED,
    structuredOutput: unsupported(
      '`opencode run --format json` emits raw JSON session EVENTS, never a '
        + 'schema-constrained final document; there is no `--json-schema`-style '
        + 'flag, so the prose output contract + salvage parse stay the only path',
    ),
    hookChannel: SUPPORTED,
    endpointRebind: SUPPORTED,
    // `--pure` in runHeadless already suppresses config/global plugins
    // unconditionally (869ef1e6x) — the same property this surface names for
    // every core. No separate flag needed; declaring it here just states the
    // fact that already holds.
    mcpIsolationHeadless: SUPPORTED,
    toolActivity: unsupported(
      'opencode\'s plugin emits session.created/session.idle/permission.asked/session.status ' +
        'but no PostToolUse events; the running signal is session.status:busy/retry, ' +
        'not a per-tool-use event, so tool activity per turn is unobservable',
    ),
    skillDiscovery: SUPPORTED,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  // `opts.sessionName` is deliberately dropped: the opencode TUI has no
  // launch-time session-name flag. `opts.resume` IS threaded as `--session`
  // (the TUI's continue flag, verified against the installed CLI) — without it
  // a captured id would never be applied to the launch.
  // `opts.effort` is deliberately dropped too: the opencode TUI (1.18.18) has
  // no `--variant` flag — only `opencode run` accepts it — so threading the
  // effort here made the TUI print help and exit 1, killing the session at
  // launch (the graph-planner crash this fix targets). The interactive TUI
  // cannot preselect a model variant; the variant is chosen in the model
  // picker. `runHeadless` keeps `--variant` because `opencode run` accepts it.
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
      const pluginPath = writeKarstBridge(
        opts.cwd,
        opts.hookChannel.endpointUrl,
        opts.hookChannel.configDir,
      );
      ownedPaths = [pluginPath];
    }
    if (opts.resume && opts.resume.length > 0) {
      // Continue a previously-captured session instead of a cold start (§5.3).
      args.push('--session', opts.resume);
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
      // Rewritten on every launch when karst generated it: the marker step and
      // phases are re-rendered from the CURRENT stage, so a stale body would
      // name a stage the CLI now refuses. A file the repository checked in at
      // this bare name is left alone by the stamp check.
      writeGeneratedArtifact(
        destination,
        [
          '---',
          `description: Run the ${opts.pkg.label} workflow for a Karst ticket.`,
          'agent: build',
          '---',
          '',
          withStamp(body),
        ].join('\n'),
      );
    }

    // The test-family skill carries the resolved CLI prefix so the agent
    // never composes the --db/--manifest boilerplate itself. Re-rendered on
    // every launch (same as the workflow skill) so the prefix stays current.
    if (opts.cliTestPrefix) {
      const testSkillDir = join(opts.sessionDir, '.opencode', 'skills', 'karst-test');
      const isNew = !existsSync(testSkillDir);
      const wrote = writeGeneratedArtifact(
        join(testSkillDir, 'SKILL.md'),
        renderTestSkill(opts.cliTestPrefix),
      );
      if (wrote && isNew) owned.add(testSkillDir);
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
    // `--dir` pins the run to the worktree cwd: opencode 1.18.18 mis-resolves a
    // nested linked-git-worktree cwd to the parent checkout, so the review
    // lane's git tools ran on the parent's `develop` and reported a blocking
    // "wrong checkout" finding for code never read. The flag is `run`-only —
    // NOT a top-level `opencode` flag — so the interactive path is unaffected.
    args.push('--dir', opts.cwd);
    if (opts.permissionMode === 'bypassPermissions') args.push('--auto');
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--variant', opts.effort);
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
    // The console tail streams RAW JSONL (`--format json`): render each event
    // as a readable line before it reaches the console. The stream is only for
    // the console — the settle-time `stdout` still carries the raw bytes the
    // parser reads, so rendering here never touches what `parseOpencodeJsonl`
    // sees.
    const consoleStream = opts.onOutput ? renderConsoleStream('opencode', opts.onOutput) : undefined;
    opts.debug?.(
      consoleStream
        ? `[agent:opencode] console stream: rendering JSONL events as readable lines`
        : `[agent:opencode] console stream: none — no onOutput hook`,
    );
    let result: HeadlessSpawnResult;
    try {
      result = await this.spawnHeadless(OPENCODE_BIN, args, opts.cwd, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onDebug: opts.debug,
        onSpawned: opts.onSpawned,
        onOutput: consoleStream ? consoleStream.append : opts.onOutput,
      });
    } finally {
      // A trailing partial JSON line that never got its newline (opencode does
      // not guarantee one after the last event) is still a complete event —
      // flush it to the console so the tail never loses the final rendered
      // line, whatever the run's outcome.
      consoleStream?.flush();
    }
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
    if (parsed.raw === '') {
      opts.debug?.(
        `[agent:opencode] clean exit with no agent text — empty answer (${result.stdout.length} byte(s) of events)`,
      );
    }
    return {
      sessionId: parsed.sessionId,
      verdict: null,
      raw: parsed.raw,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  }
}
