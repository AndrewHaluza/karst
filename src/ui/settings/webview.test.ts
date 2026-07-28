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

describe('repository field validation UX', () => {
  it('tracks touched fields via a blur listener', () => {
    expect(HTML).toContain('touchedFields');
    // Blur does not bubble: the listener has to be registered in the CAPTURE
    // phase (the trailing `true`) or touch tracking silently never fires.
    expect(HTML).toMatch(/addEventListener\('blur',[\s\S]{0,600}?\}, true\)/);
  });

  it('parses a repoPath error to a repo/field key', () => {
    const fn = HTML.match(/function parseRepoFieldError\(msg\)\s*{([\s\S]*?)\n {2}}/);
    expect(fn, 'parseRepoFieldError not found').toBeTruthy();
    expect(fn![1]).toContain('repoPath');
    expect(fn![1]).toContain('service\\.(start|health)');
  });

  it('suppresses the banner for an untouched mapped field error', () => {
    expect(HTML).toContain('function shouldShowBanner(');
    expect(HTML).toContain('touchedFields.has(parsed.key)');
  });

  it('renders an inline field-error line and a browse button next to repoPath', () => {
    expect(HTML).toContain('data-field-error="${esc(name)}.repoPath"');
    expect(HTML).toContain('data-browse-repo-path="${esc(name)}"');
    expect(HTML).toContain('data-touch-key="${esc(name)}.repoPath"');
  });
});

describe('repository enabled toggle', () => {
  it('new repositories default to disabled (draft)', () => {
    const fn = HTML.match(/el\('addServiceBtn'\)\.addEventListener\('click', \(\) => {([\s\S]*?)\n {2}}\);/);
    expect(fn, 'addServiceBtn handler not found').toBeTruthy();
    expect(fn![1]).toContain('enabled: false');
  });

  it('renders an enabled pill toggle per repository card', () => {
    expect(HTML).toContain('data-repo-enabled="${esc(name)}"');
    expect(HTML).toContain('approach-toggle'); // reuses the existing pill style
  });

  it('shows a Draft label when a repository is disabled', () => {
    expect(HTML).toContain('repo.enabled === false');
    expect(HTML).toContain('Draft');
  });

  it('does not expand the card when the toggle itself is clicked', () => {
    // The visible part of the pill is a `.dot` span with no data attribute of
    // its own, so the accordion fallback must exempt it by ancestor.
    expect(HTML).toContain("t.closest('.approach-toggle')");
    expect(HTML).toMatch(/t\.dataset\.svcName === undefined && !inEnabledToggle/);
  });

  it('flips draft.repositories[name].enabled on toggle click', () => {
    expect(HTML).toContain('t.dataset.repoEnabled');
    expect(HTML).toMatch(/enabled:\s*t\.checked/);
  });
});

describe('repository field placeholders', () => {
  it('gives every free-text repo/service field an example placeholder', () => {
    expect(HTML).toContain('placeholder="/Users/you/code/${esc(name)}"'); // repoPath
    expect(HTML).toContain('placeholder="npm run dev"'); // start
    expect(HTML).toContain('placeholder="http://{host}:{port}/health"'); // health
    expect(HTML).toContain('placeholder="http"'); // port name
    expect(HTML).toContain('placeholder="PORT"'); // port env
    expect(HTML).toContain('placeholder="3000"'); // port default
    expect(HTML).toContain('placeholder="my-repo"'); // repo name field
  });
});

describe('chevron and invalid-field styling', () => {
  it('renders the chevron at a comfortably clickable size', () => {
    const m = HTML.match(/\.card \.card-head \.chevron\{([^}]*)\}/);
    expect(m, '.card .card-head .chevron rule not found').toBeTruthy();
    expect(m![1]).toMatch(/font-size:1[4-9]px/); // at least 14px, up from 10px
  });

  it('applies the error border to any invalid field, not just convention fields', () => {
    expect(HTML).toMatch(/input\[aria-invalid="true"\][^{]*\{[^}]*border-color/);
  });
});
