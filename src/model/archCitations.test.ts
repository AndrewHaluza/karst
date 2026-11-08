import { describe, expect, it } from 'vitest';
import {
  CITE_REASON_MAX,
  DESIGN_RULES_HEADING,
  appendDesignRulesSection,
  escapeCitationReason,
  normalizeArchKey,
  normalizeCitationReason,
  renderCitationText,
  renderDesignRulesSection,
  upsertDesignRulesSection,
} from './archCitations.js';

const A = { key: '@arch:UATHOST-00', reason: 'resolveAdapter keeps the host fallback order' };
const B = { key: '@arch:CLI-02', reason: 'verb stays a separate parse path' };

describe('normalizeArchKey', () => {
  it('accepts a key with or without the leading @', () => {
    expect(normalizeArchKey('arch:UATHOST-00')).toBe('@arch:UATHOST-00');
    expect(normalizeArchKey('  @arch:UATHOST-00 ')).toBe('@arch:UATHOST-00');
  });
  it.each(['', 'UATHOST', '@arch:', '@arch:a b', `@arch:${'X'.repeat(90)}`])('rejects %j', (raw) => {
    expect(() => normalizeArchKey(raw)).toThrow(/not an arch key/);
  });
});

describe('normalizeCitationReason', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeCitationReason('  a \n  b\t c ')).toBe('a b c');
  });
  it('rejects an empty reason', () => {
    expect(() => normalizeCitationReason('   ')).toThrow(/needs a reason/);
  });
  it('rejects a reason over the bound and accepts one at the bound', () => {
    expect(normalizeCitationReason('x'.repeat(CITE_REASON_MAX))).toHaveLength(CITE_REASON_MAX);
    expect(() => normalizeCitationReason('x'.repeat(CITE_REASON_MAX + 1))).toThrow(/too long/);
  });
  it('rejects a control character', () => {
    expect(() => normalizeCitationReason('bad\u0007bell')).toThrow(/control character/);
  });
});

describe('escapeCitationReason', () => {
  it('turns @ into an entity so a reason cannot forge a citation or mention a user', () => {
    const out = escapeCitationReason('see @arch:CLI-02 and @someone');
    expect(out).not.toContain('@');
    expect(out).toContain('&#64;arch:CLI-02');
  });
  it('escapes markdown and html structure', () => {
    expect(escapeCitationReason('<b>*x*</b> [l](u) `c` | # h')).toBe('&lt;b&gt;\\*x\\*&lt;/b&gt; \\[l\\](u) \\`c\\` \\| &#35; h');
  });
});

describe('renderCitationText', () => {
  it('is empty with no citations', () => {
    expect(renderCitationText([])).toBe('');
  });
  it('renders key-sorted lines', () => {
    expect(renderCitationText([A, B])).toBe(
      '@arch:CLI-02 — verb stays a separate parse path\n@arch:UATHOST-00 — resolveAdapter keeps the host fallback order',
    );
  });
  it('cannot cite a second key through the reason', () => {
    const text = renderCitationText([{ key: '@arch:CLI-02', reason: 'also @arch:UATHOST-00' }]);
    expect(text).not.toMatch(/@arch:UATHOST-00/);
  });
});

describe('design rules section', () => {
  it('renders nothing for no citations', () => {
    expect(renderDesignRulesSection([])).toBe('');
    expect(appendDesignRulesSection('body', [])).toBe('body');
  });
  it('appends the section after the body', () => {
    const out = appendDesignRulesSection('Ticket: X\n\nprose\n', [B, A]);
    expect(out).toBe(
      `Ticket: X\n\nprose\n\n${DESIGN_RULES_HEADING}\n\n- @arch:CLI-02 — verb stays a separate parse path\n- @arch:UATHOST-00 — resolveAdapter keeps the host fallback order\n`,
    );
  });
  it('writes only the section for an empty body', () => {
    expect(appendDesignRulesSection('', [A])).toBe(`${renderDesignRulesSection([A])}\n`);
  });
  it('replaces an existing section in place and keeps the prose around it', () => {
    const first = upsertDesignRulesSection('intro\n', [A]);
    const withTail = `${first}\n## Notes\n\nhuman text\n`;
    const out = upsertDesignRulesSection(withTail, [A, B]);
    expect(out.match(/## Design rules checked/g)).toHaveLength(1);
    expect(out).toContain('- @arch:CLI-02');
    expect(out).toContain('## Notes\n\nhuman text');
    expect(out.startsWith('intro\n')).toBe(true);
  });
  it('is idempotent', () => {
    const once = upsertDesignRulesSection('intro', [A, B]);
    expect(upsertDesignRulesSection(once, [A, B])).toBe(once);
  });
});
