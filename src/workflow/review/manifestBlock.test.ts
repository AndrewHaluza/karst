import { describe, expect, it } from 'vitest';
import { buildManifestBlock, MANIFEST_BLOCK_MAX_CHARS } from './manifestBlock.js';
import { buildFindingsPrompt } from './findingsLane.js';

const A = { intent: null, spec: null, plan: null };

describe('buildManifestBlock', () => {
  it('is empty when the manifest did not change', () => {
    expect(buildManifestBlock({ path: '/p/.karst/karst.yml', content: 'a: 1', changed: false })).toEqual([]);
  });
  it('names the path, says it is outside the diff, and gives the content', () => {
    const text = buildManifestBlock({ path: '/p/.karst/karst.yml', content: 'onSkip: reask', changed: true }).join('\n');
    expect(text).toContain('/p/.karst/karst.yml');
    expect(text).toMatch(/outside the git diff/);
    expect(text).toMatch(/changed since/);
    expect(text).toContain('onSkip: reask');
  });
  it('truncates a large file with a marker', () => {
    const text = buildManifestBlock({ path: 'm', content: 'x'.repeat(MANIFEST_BLOCK_MAX_CHARS + 50), changed: true }).join('\n');
    expect(text).toContain('truncated');
    expect(text).not.toContain('x'.repeat(MANIFEST_BLOCK_MAX_CHARS + 1));
  });
});

describe('buildManifestBlock fence', () => {
  it('uses a fence the content cannot close', () => {
    const lines = buildManifestBlock({ path: 'm', content: 'a: |\n  ```\n  ````\nb: 1', changed: true });
    expect(lines).toContain('`````yaml');
    expect(lines[lines.length - 1]).toBe('`````');
  });
  it('uses three backticks for plain content', () => {
    const lines = buildManifestBlock({ path: 'm', content: 'a: 1', changed: true });
    expect(lines).toContain('```yaml');
  });
});

describe('findings prompt manifest section', () => {
  it('carries the manifest for a ticket with a changed manifest, also with custom instructions', () => {
    const a = { ...A, operatorManifest: { path: '/p/.karst/karst.yml', content: 'requireEvidence: true', changed: true } };
    for (const instr of [undefined, 'Be strict.']) {
      const p = buildFindingsPrompt('api', 'main', 'b', instr, false, null, '/w', 'high', a);
      expect(p).toContain('/p/.karst/karst.yml');
      expect(p).toMatch(/outside the git diff/);
      expect(p).toContain('requireEvidence: true');
    }
  });
  it('adds no manifest section when the manifest did not change', () => {
    const a = { ...A, operatorManifest: { path: '/p/m.yml', content: 'c: 1', changed: false } };
    expect(buildFindingsPrompt('api', 'main', 'b', undefined, false, null, '/w', 'high', a)).toBe(
      buildFindingsPrompt('api', 'main', 'b', undefined, false, null, '/w', 'high', A),
    );
  });
});
