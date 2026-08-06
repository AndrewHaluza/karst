import { request } from 'node:http';

const endpointUrl = "http://127.0.0.1:52144/hooks?karstLaunch=dff753d0-d966-4125-b53f-efc3f581d67f";
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

function post(hookEventName, input, directory, worktree, message) {
  try {
    const sessionId = extractSessionId(input);
    const cwd = extractCwd(input, directory, worktree);
    if (!sessionId && !cwd) return;
    const payload = { hook_event_name: hookEventName, cwd, session_id: sessionId };
    if (message) payload.message = message;
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) return;
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
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch {}
}

export const KarstBridge = async ({ directory, worktree }) => {
  return {
    event: async ({ event }) => {
      const type = event && event.type;
      const input = event && event.properties;
      if (type === 'session.idle') {
        post('session.idle', input, directory, worktree);
      } else if (type === 'session.error') {
        post('session.error', input, directory, worktree, extractErrorMessage(input));
      } else if (type === 'permission.asked' || type === 'permission.v2.asked') {
        post('permission.asked', input, directory, worktree);
      }
    },
  };
};
