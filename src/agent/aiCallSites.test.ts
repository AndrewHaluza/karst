import { describe, it, expect } from 'vitest';
import {
  AI_CALL_SITES,
  aiCallSiteLabel,
  isAiCallSite,
  UNKNOWN_CALL_SITE,
} from './aiCallSites.js';

describe('aiCallSites', () => {
  it('names every AI integration point exactly once', () => {
    expect(new Set(AI_CALL_SITES).size).toBe(AI_CALL_SITES.length);
    expect(AI_CALL_SITES).toContain('ticket-analysis');
    expect(AI_CALL_SITES).toContain('signal-suggestion');
    expect(AI_CALL_SITES).toContain('pr-description');
    expect(AI_CALL_SITES).toContain('fix-resume');
    expect(AI_CALL_SITES).toContain('review-findings');
  });

  it('files an undeclared call under a site that is itself a known id', () => {
    expect(isAiCallSite(UNKNOWN_CALL_SITE)).toBe(true);
  });

  it('rejects a free-form string at the boundary', () => {
    expect(isAiCallSite('ticket-analysis')).toBe(true);
    expect(isAiCallSite('Ticket Analysis')).toBe(false);
    expect(isAiCallSite('')).toBe(false);
    expect(isAiCallSite(null)).toBe(false);
    expect(isAiCallSite(7)).toBe(false);
  });

  it('labels every known site, and passes an unknown id through unchanged', () => {
    for (const site of AI_CALL_SITES) {
      expect(aiCallSiteLabel(site)).not.toBe('');
    }
    expect(aiCallSiteLabel('ticket-analysis')).toBe('Ticket analysis');
    expect(aiCallSiteLabel('made-up')).toBe('made-up');
  });
});
