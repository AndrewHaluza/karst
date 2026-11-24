import { isQuotaExhausted } from './cliFailure.js';

/**
 * D160: interactive usage-limit signals. Only provider-authored error text is a
 * candidate; model prose never is, and the verdict is `isQuotaExhausted`
 * (QUOTA_PHRASES), not the broad LIMIT_PHRASES.
 */

/** The `session.error` hook's message (opencode / opencode2); other events carry none. */
export function quotaTextFromHook(payload: { hook_event_name?: string; message?: unknown }): string | null {
  if (payload.hook_event_name !== 'session.error') return null;
  return typeof payload.message === 'string' && payload.message !== '' ? payload.message : null;
}

/** A Claude transcript entry's text, only when Claude marked it an API error. */
export function quotaTextFromClaudeEntry(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as { isApiErrorMessage?: unknown; message?: { content?: unknown } };
  if (e.isApiErrorMessage !== true) return null;
  const content = e.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((c) => {
      const t = typeof c === 'object' && c !== null ? (c as { text?: unknown }).text : undefined;
      return typeof t === 'string' ? t : '';
    })
    .join('\n')
    .trim();
  return text === '' ? null : text;
}

export function isInteractiveQuota(provider: string, text: string): boolean {
  return isQuotaExhausted({ tool: provider, exitCode: 1, stdout: '', stderr: text, provider });
}

/**
 * The quota text of a Claude transcript, found by walking the non-empty lines
 * from the end. Claude appends metadata (`system` `turn_duration`, `last-prompt`,
 * `file-history-snapshot`, queued `user` task notifications) after an API error
 * in the same second, so the error is rarely the last line: the last
 * `assistant` entry decides — the error text when Claude marked the entry an API
 * error (`quotaTextFromClaudeEntry`), otherwise null. A `user` entry whose
 * `origin.kind` is `human` means the person acted after the error, so nothing
 * parks. Every other entry is skipped. A line that is not valid JSON is a write
 * in progress, so the read yields nothing.
 *
 * The key is that entry's raw line (unique per error: it carries uuid/timestamp),
 * so a resumed session that appends past an old error never re-parks, and the
 * same error reported on several ticks offers once.
 */
export function claudeTrailingQuota(transcript: string): { text: string; key: string } | null {
  const lines = transcript.split('\n').filter((line) => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const typed = entry as { type?: unknown; origin?: { kind?: unknown } };
    if (typed.type === 'assistant') {
      const text = quotaTextFromClaudeEntry(entry);
      return text === null ? null : { text, key: line };
    }
    if (typed.type === 'user' && typed.origin?.kind === 'human') return null;
  }
  return null;
}

export function claudeTrailingQuotaText(transcript: string): string | null {
  return claudeTrailingQuota(transcript)?.text ?? null;
}

/**
 * The quota text of a Codex session rollout, found by walking the non-empty
 * lines from the end. Codex records a failed turn as an `event_msg` entry whose
 * payload is `task_complete` and whose `error.codex_error_info` names the
 * failure; a usage limit is exactly `'usage_limit_exceeded'`. Only
 * `task_complete` decides: `task_started` / `turn_aborted` mean a newer turn
 * began, and every other event (`thread_settings_applied`, `token_count`,
 * `item_completed`) and every non-`event_msg` line is skipped. Agent prose is
 * never read — the error is provider-authored structure, not text. A line that
 * is not valid JSON is a write in progress, so the read yields nothing.
 *
 * The key is that entry's raw line, so the same error reported on several ticks
 * offers once, and a resumed session that appends past it never re-parks.
 */
export function codexTrailingQuota(rollout: string): { text: string; key: string } | null {
  const lines = rollout.split('\n').filter((line) => line.trim() !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const typed = entry as {
      type?: unknown;
      payload?: { type?: unknown; error?: { codex_error_info?: unknown; message?: unknown } | null };
    };
    if (typed.type !== 'event_msg') continue;
    const payload = typed.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    if (payload.type === 'task_started' || payload.type === 'turn_aborted') return null;
    if (payload.type !== 'task_complete') continue;
    const error = payload.error;
    if (typeof error !== 'object' || error === null) return null;
    if (error.codex_error_info !== 'usage_limit_exceeded') return null;
    const message = error.message;
    if (typeof message !== 'string' || message.trim() === '') return null;
    return { text: message, key: line };
  }
  return null;
}
