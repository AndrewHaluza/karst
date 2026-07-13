import { describe, it, expect } from 'vitest';
import { providerTicketUrl } from './ticketUrl.js';

describe('providerTicketUrl', () => {
  it('builds a ClickUp task URL from the source ref', () => {
    expect(providerTicketUrl('clickup', 'abc123')).toBe('https://app.clickup.com/t/abc123');
  });

  it('encodes the source ref', () => {
    expect(providerTicketUrl('clickup', 'a b/c')).toBe('https://app.clickup.com/t/a%20b%2Fc');
  });

  it('returns null for the manual provider (no external board)', () => {
    expect(providerTicketUrl('manual', 'abc123')).toBeNull();
  });

  it('returns null when the source ref is empty, blank, or missing', () => {
    expect(providerTicketUrl('clickup', '')).toBeNull();
    expect(providerTicketUrl('clickup', '   ')).toBeNull();
    expect(providerTicketUrl('clickup', null)).toBeNull();
    expect(providerTicketUrl('clickup', undefined)).toBeNull();
  });

  it('returns null when the provider is missing', () => {
    expect(providerTicketUrl(null, 'abc123')).toBeNull();
    expect(providerTicketUrl(undefined, 'abc123')).toBeNull();
  });
});
