import { describe, it, expect } from 'vitest';
import { claudeTrailingQuota, claudeTrailingQuotaText, codexTrailingQuota, quotaTextFromHook, quotaTextFromClaudeEntry, isInteractiveQuota } from './interactiveQuota.js';

describe('interactive quota detector', () => {
  it('session.error message is candidate text; other events are not', () => {
    expect(quotaTextFromHook({ hook_event_name: 'session.error', message: 'insufficient_quota' })).toBe('insufficient_quota');
    expect(quotaTextFromHook({ hook_event_name: 'Stop', message: 'usage limit' })).toBeNull();
    expect(quotaTextFromHook({ hook_event_name: 'session.error', message: 5 })).toBeNull();
    expect(quotaTextFromHook({ hook_event_name: 'session.error', message: '' })).toBeNull();
    expect(quotaTextFromHook({ hook_event_name: 'session.error' })).toBeNull();
    expect(quotaTextFromHook({ message: 'insufficient_quota' })).toBeNull();
  });

  it('claude entry counts only when isApiErrorMessage is true', () => {
    const entry = (flag: boolean) => ({
      isApiErrorMessage: flag,
      message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] },
    });
    expect(quotaTextFromClaudeEntry(entry(true))).toBe('Claude usage limit reached');
    expect(quotaTextFromClaudeEntry(entry(false))).toBeNull();
    expect(quotaTextFromClaudeEntry('x')).toBeNull();
    expect(quotaTextFromClaudeEntry(null)).toBeNull();
    expect(quotaTextFromClaudeEntry({ isApiErrorMessage: true })).toBeNull();
    expect(quotaTextFromClaudeEntry({ isApiErrorMessage: true, message: { content: [{ type: 'text', text: '  ' }, 7] } })).toBeNull();
    expect(
      quotaTextFromClaudeEntry({ isApiErrorMessage: true, message: { content: [{ text: 'a' }, { text: 'b' }] } }),
    ).toBe('a\nb');
    expect(quotaTextFromClaudeEntry({ isApiErrorMessage: true, message: { content: 'str' } })).toBeNull();
  });

  it('quota phrases hit; prose about a rate limit does not', () => {
    expect(isInteractiveQuota('claude', 'Claude usage limit reached')).toBe(true);
    expect(isInteractiveQuota('opencode', 'You exceeded your current quota (insufficient_quota)')).toBe(true);
    expect(isInteractiveQuota('claude', 'I should add a rate limit to this endpoint')).toBe(false);
  });

  describe('claudeTrailingQuota', () => {
    const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
    const errLine = (text: string, uuid = 'err-1'): string =>
      line({ type: 'assistant', uuid, isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } });
    const assistantLine = (text: string, uuid = 'ok-1'): string =>
      line({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } });
    const humanLine = (): string =>
      line({ type: 'user', uuid: 'u-human', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'continue' }] } });
    const notificationLine = (): string =>
      line({ type: 'user', uuid: 'u-task', origin: { kind: 'task-notification' }, message: { content: [{ type: 'text', text: 'task done' }] } });
    const systemLine = (): string => line({ type: 'system', subtype: 'turn_duration', uuid: 'sys-1' });
    const lastPromptLine = (): string => line({ type: 'last-prompt', uuid: 'lp-1' });
    const fileHistoryLine = (): string => line({ type: 'file-history-snapshot', uuid: 'fh-1' });

    const err = errLine('Claude usage limit reached');
    const ok = assistantLine('done');

    it('reads the last assistant entry, past the trailing metadata Claude appends', () => {
      // T1319 shape: the API error is never the last line.
      const tail = [err, systemLine(), notificationLine(), lastPromptLine(), fileHistoryLine()].join('\n');
      expect(claudeTrailingQuota(`${tail}\n`)).toEqual({ text: 'Claude usage limit reached', key: err });
      expect(claudeTrailingQuotaText(`${tail}\n`)).toBe('Claude usage limit reached');
    });

    it('clears the error once a human prompt follows it', () => {
      const tail = [err, systemLine(), notificationLine(), lastPromptLine(), humanLine()].join('\n');
      expect(claudeTrailingQuota(tail)).toBeNull();
    });

    it('clears the error once a later assistant turn answers', () => {
      const tail = [err, systemLine(), notificationLine(), assistantLine('all good')].join('\n');
      expect(claudeTrailingQuota(tail)).toBeNull();
    });

    it('ignores an older error when the last assistant entry is a normal reply', () => {
      expect(claudeTrailingQuota([err, assistantLine('back on track'), systemLine()].join('\n'))).toBeNull();
    });

    it('keys the error by its own raw line', () => {
      expect(claudeTrailingQuota(`${ok}\n${err}\n`)).toEqual({ text: 'Claude usage limit reached', key: err });
      expect(claudeTrailingQuota(ok)).toBeNull();
    });

    it('tolerates empty and malformed tails', () => {
      expect(claudeTrailingQuotaText('')).toBeNull();
      expect(claudeTrailingQuotaText(`${err}\n{broken`)).toBeNull();
    });
  });

  describe('codexTrailingQuota', () => {
    const event = (payload: Record<string, unknown>): string =>
      JSON.stringify({ timestamp: '2026-08-08T09:00:00.000Z', type: 'event_msg', payload });
    const usageError = (info = 'usage_limit_exceeded', message: unknown = "You've hit your usage limit. Upgrade to Plus or try again at Aug 8th, 2026 11:06 AM."): string =>
      event({ type: 'task_complete', turn_id: 't1', last_agent_message: null, error: { message, codex_error_info: info } });
    const taskStarted = (): string => event({ type: 'task_started', turn_id: 't2' });
    const turnAborted = (): string => event({ type: 'turn_aborted', reason: 'interrupted' });
    const settingsApplied = (): string => event({ type: 'thread_settings_applied', thread_id: 'th-1' });
    const tokenCount = (): string => event({ type: 'token_count', info: null });
    const plainComplete = (): string => event({ type: 'task_complete', turn_id: 't1', error: null });
    const agentMessage = (): string =>
      JSON.stringify({
        timestamp: '2026-08-08T09:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: "You've hit your usage limit" }] },
      });

    it('reads the usage-limit error as the last line, keyed by that line', () => {
      const err = usageError();
      expect(codexTrailingQuota(`${err}\n`)).toEqual({ text: "You've hit your usage limit. Upgrade to Plus or try again at Aug 8th, 2026 11:06 AM.", key: err });
    });

    it('reads past the thread settings and token count Codex appends', () => {
      const err = usageError();
      expect(codexTrailingQuota([err, settingsApplied(), tokenCount()].join('\n'))).toEqual({
        text: "You've hit your usage limit. Upgrade to Plus or try again at Aug 8th, 2026 11:06 AM.",
        key: err,
      });
    });

    it('clears the error once a newer turn starts or is aborted', () => {
      expect(codexTrailingQuota([usageError(), settingsApplied(), taskStarted()].join('\n'))).toBeNull();
      expect(codexTrailingQuota([usageError(), turnAborted()].join('\n'))).toBeNull();
    });

    it('ignores an older error when the last turn completed without one', () => {
      expect(codexTrailingQuota([usageError(), plainComplete()].join('\n'))).toBeNull();
    });

    it('accepts only the usage_limit_exceeded code and a non-empty message', () => {
      expect(codexTrailingQuota(usageError('other'))).toBeNull();
      expect(codexTrailingQuota(usageError('model_not_found'))).toBeNull();
      expect(codexTrailingQuota(event({ type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } }))).toBeNull();
      expect(codexTrailingQuota(usageError('usage_limit_exceeded', ''))).toBeNull();
      expect(codexTrailingQuota(usageError('usage_limit_exceeded', { text: 'x' }))).toBeNull();
      expect(codexTrailingQuota(event({ type: 'task_complete', error: 'usage_limit_exceeded' }))).toBeNull();
    });

    it('never reads agent prose about a usage limit', () => {
      expect(codexTrailingQuota(agentMessage())).toBeNull();
      expect(codexTrailingQuota([agentMessage(), tokenCount()].join('\n'))).toBeNull();
    });

    it('yields nothing for a truncated tail or empty text', () => {
      expect(codexTrailingQuota(`${usageError()}\n{"type":"event_msg","payload":{"type":"task_com`)).toBeNull();
      expect(codexTrailingQuota('')).toBeNull();
    });
  });
});
