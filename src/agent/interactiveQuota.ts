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
 * The quota text of a Claude transcript whose LAST entry is an API error. A
 * resumed session appends past an old error, so an earlier error line never
 * re-parks a session that has since moved on.
 */
export function claudeTrailingQuotaText(transcript: string): string | null {
  const lines = transcript.split('\n').filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    return quotaTextFromClaudeEntry(JSON.parse(last));
  } catch {
    return null;
  }
}
