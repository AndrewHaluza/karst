import { describe, it, expect } from 'vitest';
import { claudeTrailingQuota, claudeTrailingQuotaText, quotaTextFromHook, quotaTextFromClaudeEntry, isInteractiveQuota } from './interactiveQuota.js';

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

  describe('claudeTrailingQuotaText', () => {
    const err = JSON.stringify({ isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Claude usage limit reached' }] } });
    const ok = JSON.stringify({ message: { content: [{ type: 'text', text: 'done' }] } });
    it('returns the text only when the LAST line is the API error', () => {
      expect(claudeTrailingQuotaText(`${ok}\n${err}\n`)).toBe('Claude usage limit reached');
      expect(claudeTrailingQuotaText(`${err}\n${ok}\n`)).toBeNull();
    });
    it('keys the trailing error by its raw line', () => {
      expect(claudeTrailingQuota(`${ok}\n${err}\n`)).toEqual({ text: 'Claude usage limit reached', key: err });
      expect(claudeTrailingQuota(ok)).toBeNull();
    });
    it('tolerates empty and malformed tails', () => {
      expect(claudeTrailingQuotaText('')).toBeNull();
      expect(claudeTrailingQuotaText(`${err}\n{broken`)).toBeNull();
    });
  });
});
