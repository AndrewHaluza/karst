import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'webview.html'),
  'utf8',
);

describe('settings artifact conventions', () => {
  it('provides the three project-level controls with a multiline PR description', () => {
    expect(HTML).toContain('Commit &amp; pull request conventions');
    expect(HTML).toContain('id="f-commitMessageTemplate"');
    expect(HTML).toContain('id="f-prTitleTemplate"');
    expect(HTML).toMatch(/<textarea[^>]*id="f-prDescriptionTemplate"[^>]*rows="6"/);
  });

  it('hydrates only configured values and preserves raw multiline content', () => {
    expect(HTML).toContain("const conventions = draft.conventions || {};");
    expect(HTML).toContain(
      "el('f-prDescriptionTemplate').value = conventions.pullRequestDescription || '';",
    );
  });

  it('deletes blank children and removes the empty conventions parent', () => {
    const fn = HTML.match(
      /function updateConvention\(field, value\)\s*{([\s\S]*?)\n {2}}/,
    );
    expect(fn, 'updateConvention() not found').toBeTruthy();
    expect(fn![1]).toContain("value.trim() === ''");
    expect(fn![1]).toContain('delete draft.conventions[field]');
    expect(fn![1]).toContain('Object.keys(draft.conventions).length === 0');
    expect(fn![1]).toContain('delete draft.conventions');
  });

  it('shows the exact artifact-specific token vocabulary', () => {
    expect(HTML).toContain(
      "const COMMON_CONVENTION_VARS = ['title', 'key', 'id', 'repo'];",
    );
    expect(HTML).toContain(
      "const DESCRIPTION_CONVENTION_VARS = [...COMMON_CONVENTION_VARS, 'description'];",
    );
    expect(HTML).toContain(
      "renderConventionVars('commitMessageVars', COMMON_CONVENTION_VARS)",
    );
    expect(HTML).toContain(
      "renderConventionVars('prTitleVars', COMMON_CONVENTION_VARS)",
    );
    expect(HTML).toContain(
      "renderConventionVars('prDescriptionVars', DESCRIPTION_CONVENTION_VARS)",
    );
  });

  it('keeps host manifest validation authoritative', () => {
    expect(HTML).toContain("post({ type: 'validate', manifest: draft })");
    expect(HTML).not.toContain('function validateArtifactTemplate');
    expect(HTML).toContain('function showConventionValidation(error)');
    const validationCase = HTML.match(
      /case 'validation': {([\s\S]*?)\n {8}break;/,
    );
    expect(validationCase, 'validation message case not found').toBeTruthy();
    expect(validationCase![1]).toContain(
      'showConventionValidation(msg.ok ? null : msg.error)',
    );
  });
});
