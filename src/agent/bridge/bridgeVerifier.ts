import type { HookPayload } from '../../hooks/dispatch.js';
import type { StageKey } from '../../model/types.js';
import { SEQ_PATTERN } from './markerReply.js';
import { isMarkerStage, type MarkerStage } from '../markerStage.js';

export const MAX_BRIDGE_LINE_BYTES = 65536;

/** What the HOST knows about the session that owns one bridge file. Line content is never a source for these. */
export interface BridgeExpectation {
  readonly ticketId: number;
  readonly worktreePath: string;
  readonly launchId: string | undefined;
  /** The ticket's current stage, read live: a marker is valid only for it. */
  readonly stage: () => StageKey | null;
  /** The agent session id once the host captured one; undefined before the first SessionStart. */
  readonly sessionId: () => string | undefined;
}

export type BridgeAccepted =
  | { readonly kind: 'hook'; readonly payload: HookPayload }
  | { readonly kind: 'marker'; readonly stage: MarkerStage; readonly seq?: string };

export type BridgeVerdict =
  | { readonly ok: true; readonly event: BridgeAccepted }
  | { readonly ok: false; readonly reason: string };

const reject = (reason: string): BridgeVerdict => ({ ok: false, reason });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The only payload fields the host takes from a line; cwd and launchId are rebuilt from host facts. */
const STRING_FIELDS = ['hook_event_name', 'session_id', 'message', 'notification_type', 'tool_name', 'file_path'] as const;

function hookPayload(raw: Record<string, unknown>, expect: BridgeExpectation): HookPayload | string {
  if (typeof raw.hook_event_name !== 'string' || typeof raw.session_id !== 'string') {
    return 'payload needs string hook_event_name and session_id';
  }
  const bound = expect.sessionId();
  if (bound !== undefined && raw.session_id !== bound) return `session ${raw.session_id} != ${bound}`;
  const payload: Record<string, unknown> = { cwd: expect.worktreePath };
  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === 'string') payload[key] = value;
  }
  if (raw.stop_hook_active === true) payload.stop_hook_active = true;
  if (isRecord(raw.usage)) payload.usage = raw.usage;
  if (expect.launchId !== undefined) payload.launchId = expect.launchId;
  return payload as HookPayload;
}

/**
 * Verify ONE bridge line (port of `spikes/docker-sandbox/06-bridge/verify-events.mjs`).
 * Pure. The host binds identity by path; a line can only be accepted for the
 * session that owns the file, and never carries a verdict (arch:AC-31).
 */
export function verifyBridgeLine(line: string, expect: BridgeExpectation): BridgeVerdict {
  if (Buffer.byteLength(line, 'utf8') > MAX_BRIDGE_LINE_BYTES) return reject('line too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return reject('malformed');
  }
  if (!isRecord(parsed) || parsed.v !== 1) return reject('malformed');
  if (typeof parsed.ticket !== 'number') return reject('malformed');
  if (parsed.ticket !== expect.ticketId) return reject(`ticket ${parsed.ticket} != ${expect.ticketId}`);
  if (parsed.kind === 'hook') {
    if (!isRecord(parsed.payload)) return reject('malformed');
    const built = hookPayload(parsed.payload, expect);
    return typeof built === 'string' ? reject(built) : { ok: true, event: { kind: 'hook', payload: built } };
  }
  if (parsed.kind === 'marker') {
    const stage = parsed.stage;
    if (typeof stage !== 'string' || !isMarkerStage(stage)) return reject(`stage ${String(stage)} is not markable`);
    const current = expect.stage();
    if (stage !== current) return reject(`stage ${stage} != ${current}`);
    // `seq` names the reply file: a token or nothing (a malformed one never reaches a path).
    const seq = typeof parsed.seq === 'string' && SEQ_PATTERN.test(parsed.seq) ? parsed.seq : undefined;
    return { ok: true, event: { kind: 'marker', stage, ...(seq !== undefined ? { seq } : {}) } };
  }
  return reject('unknown kind');
}
