import { homedir } from 'node:os';
import { join } from 'node:path';

/** Relative project-dir root under the config dir (default `~/.claude`). */
export const CLAUDE_PROJECTS_RELATIVE = join('projects');

/**
 * The Claude Code config root's `projects/` dir. Honors `CLAUDE_CONFIG_DIR`
 * (the official override), else `<home>/.claude/projects`.
 */
export function resolveClaudeProjectsDir(
  env?: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env?.CLAUDE_CONFIG_DIR;
  const configDir =
    typeof override === 'string' && override.length > 0 ? override : join(home, '.claude');
  return join(configDir, CLAUDE_PROJECTS_RELATIVE);
}

/**
 * The transcript project-dir name: every char outside `[a-zA-Z0-9-]` becomes `-`.
 * Verified against Claude Code 2.1.231:
 *   `/Users/nd/Work/projects/karst` -> `-Users-nd-Work-projects-karst`
 *   `.../karst/.karst/worktrees/<slug>` -> `-Users-nd-Work-projects-karst--karst-worktrees-<slug>`
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/** The session's transcript file path. `sessionId` is the file basename. */
export function transcriptPathFor(projectsDir: string, cwd: string, sessionId: string): string {
  return join(projectsDir, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Transcript parsing — cumulative usage from assistant messages.
// ---------------------------------------------------------------------------

/** One parsed, cumulative session sample from a transcript. */
export interface ClaudeTranscriptUsage {
  /** uuid of the LAST usage-bearing assistant message — the idempotency key. */
  eventId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What one sweep observed for one transcript. */
export interface ClaudeTranscriptSnapshot {
  transcriptPath: string;
  usage: ClaudeTranscriptUsage | null;
}

/** Per-ticket memory of the last observed transcript. */
export interface ClaudeWatchState {
  transcriptPath: string | null;
  eventId: string | null;
  /** mtime+size of the last read transcript. SWEEP-maintained — this module
   * is fs-free, so it only ever reads/writes this field's value via the state
   * object the sweep passes; the module never sets it. */
  fingerprint: { mtimeMs: number; size: number } | null;
}

export type ClaudeWatchEvent = {
  kind: 'UsageUpdate';
  usage: {
    event_id: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
};

/**
 * A count is a finite, non-negative number; anything else is not a count.
 */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Parse a Claude session transcript (JSONL) into a cumulative usage sample.
 *
 * Only lines with `type === 'assistant'` carrying `message.usage` contribute.
 * Each message's `input_tokens`/`output_tokens` are required; cache keys are
 * optional (absent → 0, present-but-invalid → skip the whole message). The
 * `uuid` field is required as the idempotency key.
 *
 * Returns null when no message contributed.
 */
export function parseClaudeTranscript(text: string): ClaudeTranscriptUsage | null {
  if (text.length === 0) return null;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let lastUuid: string | null = null;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // truncated mid-write line — skip
    }

    if (record['type'] !== 'assistant') continue;

    const message = record['message'] as Record<string, unknown> | null | undefined;
    if (typeof message !== 'object' || message === null) continue;
    const usage = message['usage'] as Record<string, unknown> | null | undefined;
    if (typeof usage !== 'object' || usage === null) continue;

    const inputCount = count(usage['input_tokens']);
    const outputCount = count(usage['output_tokens']);
    if (inputCount === null || outputCount === null) continue;

    const cacheReadRaw = usage['cache_read_input_tokens'];
    const cacheReadCount = count(cacheReadRaw);
    if ('cache_read_input_tokens' in usage && cacheReadCount === null) continue;

    const cacheWriteRaw = usage['cache_creation_input_tokens'];
    const cacheWriteCount = count(cacheWriteRaw);
    if ('cache_creation_input_tokens' in usage && cacheWriteCount === null) continue;

    const uuid = record['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;

    input += inputCount;
    output += outputCount;
    cacheRead += cacheReadCount ?? 0;
    cacheWrite += cacheWriteCount ?? 0;
    lastUuid = uuid;
  }

  if (lastUuid === null) return null;
  return { eventId: lastUuid, input, output, cacheRead, cacheWrite };
}

/**
 * Diff one sweep tick against the last for ONE ticket. Emits a UsageUpdate
 * event when the transcript's cumulative usage has advanced. A `null` snapshot
 * (no transcript yet) is silent. The sweep owns `state.fingerprint`; this
 * module only touches `transcriptPath` and `eventId`.
 */
export function claudeTranscriptTick(
  state: ClaudeWatchState,
  snapshot: ClaudeTranscriptSnapshot | null,
): ClaudeWatchEvent[] {
  if (snapshot === null) return [];

  if (snapshot.transcriptPath !== state.transcriptPath) {
    state.transcriptPath = snapshot.transcriptPath;
    state.eventId = null;
  }

  if (snapshot.usage === null) return [];
  if (snapshot.usage.eventId === state.eventId) return [];

  state.eventId = snapshot.usage.eventId;
  const u = snapshot.usage;
  return [
    {
      kind: 'UsageUpdate',
      usage: {
        event_id: u.eventId,
        input: u.input,
        output: u.output,
        cache_read: u.cacheRead,
        cache_write: u.cacheWrite,
      },
    },
  ];
}
