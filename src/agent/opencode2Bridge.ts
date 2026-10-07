import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { currentEndpointPath } from './hookFailureLog.js';

/**
 * The opencode v2 (`@opencode/cli` 2.x) hook bridge.
 *
 * v2 has NO CLI hook flag, so — exactly like v1 — the channel is a generated
 * plugin under `<cwd>/.opencode/plugins/`, auto-discovered for a session
 * launched in that worktree. The module SHAPE differs from v1's:
 * v1 exports a named `KarstBridge` function, v2 requires the
 * `export default { id, setup(ctx) }` contract. That named-export shape is why
 * a v1 plugin dropped into a v2 session fails to load (`setup` is never
 * called), so this is a SEPARATE renderer, not a parameterization of v1's
 * `renderHookBridge`.
 *
 * The event stream is an ASYNC ITERATOR: `for await (const e of
 * ctx.event.subscribe())`. `subscribe(cb)` is NOT a callback registrar — it
 * treats `cb` as a stream transform (live-verified, SPIKE-OPENCODE2-V2-0-24).
 * Events arrive as `{ id, created, type, data }`; the payload is under `data`
 * and the session id is the FLAT `data.sessionID`.
 *
 * Safety mirrors the v1 bridge exactly:
 *  - the endpoint is baked in at generation time from a loopback-validated URL;
 *  - after a VS Code reload the launch URL dies and the plugin falls back to the
 *    extension's stable `current-endpoint` file, re-validated against loopback
 *    and re-stamped with the launch generation (`karstLaunch` query);
 *  - the serialized payload is size-bounded (a local sender cannot grow host
 *    memory);
 *  - every failure is swallowed so a dead endpoint or a plugin defect never
 *    throws into the agent's event loop.
 *
 * The `form.*` elicitation subsystem (`form.created`/`replied`/`cancelled`) is
 * deliberately NOT mapped here: no live fixture verified its payloads. See the
 * `default:` branch comment — a follow-up ticket maps it once a fixture exists.
 */

/**
 * Set on EVERY headless opencode2 spawn and never on an interactive one. The
 * generated plugin returns from `setup()` immediately when it is `'1'`, so a
 * gate/review `run` — which may discover a `karst-bridge.js` left in the
 * worktree by an earlier interactive session — emits no hooks at all.
 * Live-verified: the spawn env reaches the plugin under `--standalone`.
 */
export const KARST_OPENCODE_HEADLESS_ENV = 'KARST_OPENCODE_HEADLESS';

/** The adapter-owned plugin basename under `.opencode/plugins/` (v1 shares it). */
export const OPENCODE2_BRIDGE_FILENAME = 'karst-bridge.js';

/** The plugin id the v2 module contract requires. */
const OPENCODE2_BRIDGE_ID = 'karst-bridge';

/** Payload size bound — local, but still not unbounded host memory. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Render the v2 plugin source. `endpointFile` is the stable file the extension
 * rewrites on every activation; `null` (an older caller) disables the fallback
 * and the plugin uses only its baked-in launch URL, exactly as before.
 */
export function renderOpencode2Bridge(
  endpointUrl: string,
  endpointFile: string | null,
): string {
  return String.raw`import { request } from 'node:http';
import { readFileSync } from 'node:fs';

// The launch-time URL is this session's window while that window lives. A VS
// Code reload rebinds the ephemeral hook port, so the extension also writes its
// current URL to a stable file on every activation; when the launch URL stops
// answering (connection refused, or a foreign process on the stale port) the
// plugin falls back to that file. The launch-time query string carries the
// karstLaunch generation, so it is re-applied to every candidate or the
// endpoint's generation barrier would reject the rebound session.
const launchEndpointUrl = ${JSON.stringify(endpointUrl)};
const endpointFile = ${JSON.stringify(endpointFile)};
const MAX_PAYLOAD_BYTES = ${MAX_PAYLOAD_BYTES};
const headlessEnvVar = ${JSON.stringify(KARST_OPENCODE_HEADLESS_ENV)};

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
// session that outlives no reload, so a synchronous read per event would be
// waste. Read only when the launch URL has actually stopped delivering.
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

// Payload extraction. v2 events carry the session id FLAT at data.sessionID
// (unlike v1, which nested a Session object under properties.info).
function extractSessionId(data) {
  return stringOf(data && data.sessionID);
}

// The launch cwd (the worktree) is the ONE field the hook endpoint keys tickets
// on. Only some v2 events carry a location, so the plugin init directory is the
// fallback for every event.
function extractCwd(data, directory) {
  const location = asRecord(data && data.location);
  const fromEvent = stringOf(location && location.directory);
  if (fromEvent) return fromEvent;
  return stringOf(directory);
}

function extractErrorMessage(data) {
  const error = asRecord(data && data.error);
  if (error) {
    const message = stringOf(error.message);
    if (message) return message;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized.length <= 2000) return serialized;
    } catch {}
  }
  return stringOf(data && data.message);
}

// A count is a finite, non-negative number; anything else is not a count.
function usageCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// v2 reports the running tally at data.tokens as
// {input, output, reasoning, cache:{read, write}}, with NO total. cache.read and
// cache.write are disjoint from input and from each other, and reasoning is its
// own output-billed counter, so they map straight across — never folded.
function extractUsage(data) {
  const tokens = asRecord(data && data.tokens);
  if (!tokens) return null;
  const cache = asRecord(tokens.cache);
  const input = usageCount(tokens.input);
  const output = usageCount(tokens.output);
  if (input === null || output === null) return null;
  const usage = { input, output };
  const reasoning = usageCount(tokens.reasoning);
  if (reasoning !== null) usage.reasoning = reasoning;
  const cacheRead = usageCount(cache && cache.read);
  if (cacheRead !== null) usage.cache_read = cacheRead;
  const cacheWrite = usageCount(cache && cache.write);
  if (cacheWrite !== null) usage.cache_write = cacheWrite;
  const total = usageCount(tokens.total);
  if (total !== null) usage.total = total;
  return usage;
}

// v2 re-emits session.usage.updated on every save, not only when the counters
// moved, so the tally signature dedupes an unchanged observation — the ledger
// would otherwise append a zero delta on every save.
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

// POST to one candidate. next() is called when THIS candidate did not deliver
// (connection error, timeout, or a non-2xx answer — a foreign process holding
// the stale port answers, so a status check is part of "delivered").
function sendTo(endpoint, body, next) {
  let settled = false;
  const succeed = () => {
    if (settled) return;
    settled = true;
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

function deliver(payload) {
  try {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) return;
    const launch = candidateEndpoint(launchEndpointUrl);
    let attempt = 0;
    const advance = () => {
      attempt += 1;
      // 1: the launch-time endpoint. 2: the extension's current one, read only
      // now, and only when it differs from the one that just failed.
      if (attempt === 1 && launch) {
        sendTo(launch, body, advance);
        return;
      }
      if (attempt <= 2) {
        const fallback = readFallbackEndpoint();
        if (fallback && fallback !== launch) {
          sendTo(fallback, body, advance);
          return;
        }
      }
    };
    advance();
  } catch {}
}

function post(hookEventName, sessionId, cwd, message) {
  if (!sessionId && !cwd) return;
  const payload = { hook_event_name: hookEventName, cwd, session_id: sessionId };
  if (message) payload.message = message;
  deliver(payload);
}

// The last posted cumulative tally per session — see tallySignature.
const lastPostedTally = new Map();

function postUsageAdvanced(eventId, data, directory) {
  const sessionId = extractSessionId(data);
  const cwd = extractCwd(data, directory);
  const usage = extractUsage(data);
  if (!sessionId || !cwd || !usage) return;
  const signature = tallySignature(usage);
  if (lastPostedTally.get(sessionId) === signature) return;
  lastPostedTally.set(sessionId, signature);
  // The ledger requires a stable, non-empty event id. Real v2 events carry one
  // on the envelope, but a recording without one still produces a unique id
  // from the session and the (advanced) tally.
  const stableId = eventId || sessionId + ':' + signature;
  deliver({
    hook_event_name: 'UsageUpdate',
    cwd,
    session_id: sessionId,
    usage: { event_id: stableId, ...usage },
  });
}

function handleEvent(event, directory) {
  if (!event || typeof event !== 'object') return;
  const type = typeof event.type === 'string' ? event.type : '';
  const data = asRecord(event.data) || {};
  const sessionId = extractSessionId(data);
  const cwd = extractCwd(data, directory);
  switch (type) {
    case 'session.created':
      // The only v2 event that delivers the session id; the launch-intent
      // handshake and resume-by-id both hang off SessionStart.
      if (sessionId) post('SessionStart', sessionId, cwd);
      break;
    case 'session.execution.started':
      post('session.status', sessionId, cwd, 'busy');
      break;
    case 'session.execution.succeeded':
      post('session.idle', sessionId, cwd);
      break;
    case 'session.execution.failed':
      // A failed turn is both a diagnostic (session.error carries the message)
      // and a turn end (session.idle flips the ticket off running).
      post('session.error', sessionId, cwd, extractErrorMessage(data));
      post('session.idle', sessionId, cwd);
      break;
    case 'session.execution.interrupted':
      post('session.idle', sessionId, cwd);
      break;
    case 'session.retry.scheduled':
      post('session.status', sessionId, cwd, 'retry');
      break;
    case 'session.usage.updated':
      postUsageAdvanced(typeof event.id === 'string' ? event.id : '', data, directory);
      break;
    case 'permission.asked':
      post('permission.asked', sessionId, cwd);
      break;
    case 'permission.replied':
      post('permission.replied', sessionId, cwd);
      break;
    default:
      // form.created / form.replied / form.cancelled (v2's question/elicitation
      // subsystem) are deliberately UNMAPPED: no live fixture verified their
      // payloads. Follow-up: map them to permission.asked/permission.replied
      // once a recorded fixture exists. session.idle/status/updated do NOT exist
      // on v2 and are intentionally absent as inputs.
      break;
  }
}

// The launch cwd, from the plugin init context. location.directory is the
// project/worktree the session was launched in; every fallback is defensive.
function initialDirectory(ctx) {
  const location = asRecord(ctx && ctx.location);
  const fromLocation = stringOf(location && location.directory);
  if (fromLocation) return fromLocation;
  return stringOf(ctx && ctx.directory);
}

export default {
  id: ${JSON.stringify(OPENCODE2_BRIDGE_ID)},
  async setup(ctx) {
    // Headless isolation: a gate/review run must never emit interactive hooks.
    // The adapter sets this on every headless spawn and never on an interactive
    // one, so returning here leaves headless runs completely silent without
    // deleting the plugin (which would race a live session).
    if (process.env[headlessEnvVar] === '1') return;
    const directory = initialDirectory(ctx);
    try {
      for await (const event of ctx.event.subscribe()) {
        try {
          handleEvent(event, directory);
        } catch {}
      }
    } catch {
      // The stream can fail on shutdown; the loop must never throw into the agent.
    }
  },
};
`;
}

/**
 * Refuse any endpoint that is not a bound `http://127.0.0.1:<port>` — the same
 * loopback rule the v1 bridge enforces. The plugin POSTs ticket state keyed by
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
 * Write the v2 bridge plugin beneath `cwd` (the worktree) and return its path.
 * Atomic (temp + rename) and skipped when the existing content is identical,
 * mirroring the v1 bridge write — re-launching a session must not churn the
 * file, and a plugin from another session's endpoint is replaced. The path is
 * `.opencode/plugins/karst-*`, so `materializedCleanup.ts` owns it.
 */
export function writeOpencode2Bridge(
  cwd: string,
  endpointUrl: string,
  configDir?: string,
): string {
  assertLoopbackEndpoint(endpointUrl);
  const pluginPath = join(cwd, '.opencode', 'plugins', OPENCODE2_BRIDGE_FILENAME);
  const body = renderOpencode2Bridge(
    endpointUrl,
    configDir ? currentEndpointPath(configDir, 'opencode2') : null,
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
