import { describe, expect, it } from 'vitest';
import { assertScratchName, scratchName } from './common.mjs';

describe('sbx-scratch name guard', () => {
  it('builds karst-uat-t<ticket id>', () => {
    expect(scratchName({ KARST_TICKET_ID: '1202' })).toBe('karst-uat-t1202');
  });
  it('lower-cases and replaces characters sbx does not accept', () => {
    expect(scratchName({ KARST_TICKET_ID: 'AB_9' })).toBe('karst-uat-tab-9');
  });
  it('refuses a missing ticket id', () => {
    expect(() => scratchName({})).toThrow('KARST_TICKET_ID');
  });
  it.each(['karst-ab12cd34-7-claude', 'karst-uat-', '', 'x-karst-uat-t1'])('refuses the name %j', (name) => {
    expect(() => assertScratchName(name)).toThrow('karst-uat-');
  });
});
