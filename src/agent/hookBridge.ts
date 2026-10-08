/**
 * Leaf module — no imports from any adapter, so codex, opencode, and claude can
 * all import the one bridge source without depending on each other.  Mirrors
 * the rationale `nodeExecutable.ts` records.
 */

/**
 * The shared hook bridge script source. A standalone `.cjs` that:
 *  - Reads argv[2] (launch-time URL) and argv[3] (diagnostics/failure-log path)
 *  - Falls back to `<configDir>/<argv[4] || 'codex'>/current-endpoint` when
 *    the launch URL dies (VS Code reload rebinds the ephemeral hook port)
 *  - Re-validates every fallback candidate against loopback (hook payloads
 *    carry session ids and worktree paths)
 *  - Carries the launch generation onto every candidate so the endpoint's
 *    generation barrier still admits the session after a rebind
 *  - Logs bounded failures to the diagnostics path (64 KB cap)
 *  - Normalizes provider-native events to karst's closed vocabulary
 *
 * Written once per activation (atomic temp+rename); the provider segment in
 * the `current-endpoint` path is parameterized via argv[4] so one script
 * serves codex, opencode, and claude.
 */
export const HOOK_BRIDGE = String.raw`const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let eventName = 'unknown';
const diagnosticsPath = process.argv[3];
const provider = process.argv[4] || 'codex';
// The reply channel's hard ceiling, deliberately BELOW the smallest Stop hook
// timeout agents register (codex 3 s, claude 5 s): a hung endpoint must not
// hold the agent's turn open. The endpoint answers synchronously, so this is a
// backstop, not the normal path.
const REPLY_TIMEOUT_MS = 1500;
const MAX_REPLY_BYTES = 64 * 1024;

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
    const endpointFile = path.join(configDir, provider, 'current-endpoint');
    const content = fs.readFileSync(endpointFile, 'utf8').trim();
    if (content.length > 0) fileEndpoint = content;
  }
} catch {}

let launchSearch = '';
try { launchSearch = new URL(argvEndpoint).search; } catch {}
// The fallback URL comes off disk, so it is re-validated here: hook payloads
// carry session ids and worktree paths, and a non-loopback candidate would send
// them off-box. Mirrors the opencode bridge's check (869ej1zpv).
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
const endpoints = [];
for (const raw of [argvEndpoint, fileEndpoint]) {
  const candidate = candidateEndpoint(raw);
  if (candidate !== null && !endpoints.includes(candidate)) endpoints.push(candidate);
}
// Which candidate last answered — the ACK goes back to the same endpoint.
let endpointIndex = 0;

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

// The mail reply captured from a Stop response, written to stdout at exit. Only
// a Stop the endpoint answered with a block carries one; a timeout, a dead
// endpoint or any failure leaves it null, so the bridge fails open (exit 0, no
// output) exactly as it always has.
let replyBlock = null;
let finished = false;
// A Stop hook can carry more than one post (the Stop reply plus a sibling
// UsageUpdate), and each post's own timeout would let the TOTAL run past the
// agent's Stop timeout (codex kills the hook at 3 s). This one deadline bounds
// the WHOLE invocation whenever a reply is possible, so the block is flushed
// before the agent gives up on the hook.
let deadlineTimer = null;
// The positive delivery confirmation posted to the endpoint AFTER the block was
// written to stdout. A response that reached the bridge is not proof the agent
// saw it — a hung endpoint can flush into a socket this bridge already gave up
// on — so only this ACK confirms delivery and suppresses the sweep's typed
// fallback. Best-effort: the payload is set from the validated input, and a
// failure to post it just leaves the fallback in place.
let ackPayload = null;
const ACK_TIMEOUT_MS = 400;
function finish(exitCode, outcome) {
  if (finished) return;
  finished = true;
  if (deadlineTimer) {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }
  if (outcome) logFailure(outcome);
  if (!replyBlock) {
    process.exit(exitCode);
    return;
  }
  try {
    process.stdout.write(JSON.stringify(replyBlock));
  } catch {}
  // The block is out; confirm it so the host can trust the delivery, then exit.
  ackReply(() => process.exit(exitCode));
}

// POST the positive delivery confirmation to the endpoint that answered. Bounded
// by ACK_TIMEOUT_MS so a hung endpoint cannot hold the process; the block has
// already been written to stdout, so the exit code never depends on this.
function ackReply(done) {
  if (!ackPayload) { done(); return; }
  let target;
  try {
    target = new URL(endpoints[endpointIndex]);
  } catch {
    done();
    return;
  }
  let settled = false;
  const settleAck = () => { if (settled) return; settled = true; done(); };
  try {
    const body = JSON.stringify(ackPayload);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: ACK_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      res.on('end', settleAck);
      res.on('error', settleAck);
      res.on('aborted', settleAck);
    });
    req.on('error', settleAck);
    req.on('timeout', () => { req.destroy(); settleAck(); });
    req.end(body);
  } catch {
    settleAck();
  }
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
  // The ACK the endpoint reads to confirm delivery of a captured block: the
  // endpoint maps it back to the ticket via the URL's launch generation.
  ackPayload = { hook_event_name: 'MailReplyAck', cwd: raw.cwd, session_id: raw.session_id };
  const mapped =
    event === 'PermissionRequest'
      ? { hook_event_name: 'Notification', message: 'permission_prompt' }
      : event === 'Stop' &&
          typeof raw.last_assistant_message === 'string' &&
          /\?\s*$/.test(raw.last_assistant_message)
        ? { hook_event_name: 'Notification', message: 'idle_prompt' }
      : ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd', 'Notification'].includes(event)
        ? {
            hook_event_name: event,
            ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
            // Forward Claude's Stop re-entry flag so the host declines a
            // continuation Stop WITHOUT spending the batch's one-block budget
            // (the endpoint answers 204, not a block the bridge would discard).
            ...(event === 'Stop' && raw.stop_hook_active === true ? { stop_hook_active: true } : {}),
          }
        : null;

  // The Stop-block reply is eligible only for an ORIGINAL Stop that was NOT
  // remapped to a question turn (idle_prompt) and that the agent has not
  // already re-entered (stop_hook_active). The endpoint returns a body at most
  // once per change in the unread count, so a core that does not send
  // stop_hook_active still cannot loop.
  const stopBlockEligible =
    event === 'Stop' &&
    raw.stop_hook_active !== true &&
    mapped !== null &&
    mapped.hook_event_name === 'Stop';

  const posts = [];
  if (mapped) {
    // PROMPT-15: forward tool_name on PostToolUse so the marker-miss split
    // can count tool activity per turn. tool_name is a fixed-vocabulary
    // string (never the response body), safe to pass through the bridge.
    const toolName =
      event === 'PostToolUse' && typeof raw.tool_name === 'string'
        ? { tool_name: raw.tool_name }
        : {};
    posts.push({ ...mapped, ...toolName, cwd: raw.cwd, session_id: raw.session_id });
  }
  const usage = usagePayload(raw);
  if (usage) {
    posts.push({ hook_event_name: 'UsageUpdate', cwd: raw.cwd, session_id: raw.session_id, usage });
  }
  if (posts.length === 0) {
    finish(0);
    return;
  }

  // Bound the WHOLE invocation when a reply is possible: the Stop post plus a
  // sibling usage post must not stack past the agent's Stop timeout.
  if (stopBlockEligible) {
    deadlineTimer = setTimeout(() => finish(0), REPLY_TIMEOUT_MS);
  }

  let index = 0;
  function nextPost() {
    if (index >= posts.length) {
      finish(0);
      return;
    }
    const payload = posts[index];
    // Only the Stop post can carry a reply; a usage post that rides the same
    // Stop hook must not read the body.
    const isReplyPost = stopBlockEligible && payload.hook_event_name === 'Stop';
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
      // A reply post waits for the endpoint's body, but never past the hard
      // ceiling: a hung endpoint fails open (no output) rather than holding the
      // turn. Non-reply posts keep the historical 2 s bound.
      timeout: isReplyPost ? REPLY_TIMEOUT_MS : 2000,
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const successful = status >= 200 && status < 300;
      let responseBody = '';
      if (isReplyPost && successful) {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (responseBody.length <= MAX_REPLY_BYTES) responseBody += chunk;
        });
      } else {
        res.resume();
      }
      res.on('end', () => {
        if (attemptDone) return;
        if (!successful) {
          if (switchEndpoint()) return;
          settle();
          // The mail reply is fail-open: a non-2xx from a foreign or stale
          // process on the port must not surface as a hook failure to the
          // agent. A non-reply post keeps the historical exit-1 signal — unless
          // a block was already captured, because an agent that ignores stdout
          // on a non-zero exit would lose it.
          if (isReplyPost) finish(0);
          else finish(replyBlock ? 0 : 1, 'http-error:' + status);
          return;
        }
        if (isReplyPost && responseBody) {
          try {
            const parsed = JSON.parse(responseBody);
            if (parsed && parsed.decision === 'block' && typeof parsed.reason === 'string') {
              replyBlock = { decision: 'block', reason: parsed.reason };
            }
          } catch {}
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
