import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { CONVENTION_PRESETS } from '../../workflow/conventionPresets.js';
import { TICKET_TYPES } from '../../store/ticketTypes.js';
import { TRANSFORM_NAMES, applyTransforms } from '../../template/transforms.js';
import { parseTokenBody } from '../../template/token.js';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function functionSource(name: string): string {
  const start = HTML.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found`);
  const bodyStart = HTML.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < HTML.length; i += 1) {
    if (HTML[i] === '{') depth += 1;
    if (HTML[i] === '}') depth -= 1;
    if (depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`${name}() is incomplete`);
}

function loadFunction(
  name: string,
  modelCatalog: Record<string, unknown[]>,
  modelCompatibility: Record<string, unknown[]> = modelCatalog,
): (...args: unknown[]) => unknown {
  return runInNewContext(`(${functionSource(name)})`, {
    modelCatalog,
    modelCompatibility,
    esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c),
  }) as (...args: unknown[]) => unknown;
}

const MODELS = {
  claude: [{ id: 'claude-only', label: 'Claude Only', providers: ['claude'] }],
  codex: [{ id: 'codex-current', label: 'Codex Current', providers: ['codex'] }],
  antigravity: [{ id: 'agy-current', label: 'Antigravity Current', providers: ['antigravity'] }],
};

describe('settings model picker', () => {
  it('has no hard-coded model mirror', () => {
    expect(HTML).not.toContain('const KNOWN_MODELS');
  });

  it('filters the host catalog by provider and keeps an absent saved default visible', () => {
    const renderModelOptions = loadFunction('renderModelOptions', MODELS);
    const html = renderModelOptions('codex', 'preview-<next>') as string;
    expect(html).toContain('Codex Current');
    expect(html).not.toContain('Claude Only');
    expect(html).toContain('value="preview-&lt;next&gt;" selected');
    expect(html).toContain('Saved model: preview-&lt;next&gt;');
  });

  it('keeps a saved supported default selected without duplicating it', () => {
    const renderModelOptions = loadFunction('renderModelOptions', MODELS);
    const html = renderModelOptions('codex', 'codex-current') as string;

    expect(html).toContain('value="codex-current" selected');
    expect(html.match(/value="codex-current"/g)).toHaveLength(1);
    expect(html).not.toContain('Saved model: Codex Current');
  });

  it('does not clear a saved model merely because it is absent from the catalog', () => {
    const isCompatible = loadFunction('isModelCompatibleWithProvider', MODELS);
    expect(isCompatible('codex', 'preview-model')).toBe(true);
  });

  it('still rejects a model known only for another provider', () => {
    const isCompatible = loadFunction('isModelCompatibleWithProvider', MODELS);
    expect(isCompatible('codex', 'claude-only')).toBe(false);
  });

  it('uses bundled-plus-live compatibility knowledge when the picker list is narrower', () => {
    const current = {
      claude: [],
      codex: [{ id: 'codex-live', label: 'Codex Live', providers: ['codex'] }],
      antigravity: [],
    };
    const compatibility = {
      claude: [{ id: 'claude-bundled', label: 'Claude Bundled', providers: ['claude'] }],
      codex: [{ id: 'codex-live', label: 'Codex Live', providers: ['codex'] }],
      antigravity: [],
    };
    const isCompatible = loadFunction(
      'isModelCompatibleWithProvider',
      current,
      compatibility,
    );

    expect(isCompatible('codex', 'claude-bundled')).toBe(false);
    expect(isCompatible('claude', 'codex-live')).toBe(false);
  });

  it('merges a catalog refresh without replacing a dirty draft or its saved baseline', () => {
    let renderCount = 0;
    let persisted: unknown;
    const currentState = {
      manifest: { host: 'saved-host' },
      models: MODELS,
      modelCompatibility: MODELS,
    };
    const nextModels = {
      ...MODELS,
      codex: [{ id: 'codex-later', label: 'Codex Later', providers: ['codex'] }],
    };
    const context = {
      modelCatalog: MODELS,
      modelCompatibility: MODELS,
      draft: { host: 'dirty-host' },
      lastSaved: { host: 'saved-host' },
      dirty: true,
      nextModels,
      nextCompatibility: nextModels,
      renderModelPicker: () => { renderCount += 1; },
      vscode: {
        getState: () => currentState,
        setState: (value: unknown) => { persisted = value; },
      },
    };

    const result = runInNewContext(`
      (${functionSource('refreshModelCatalog')})(nextModels, nextCompatibility);
      ({ modelCatalog, modelCompatibility, draft, lastSaved, dirty });
    `, context) as {
      modelCatalog: typeof nextModels;
      modelCompatibility: typeof nextModels;
      draft: { host: string };
      lastSaved: { host: string };
      dirty: boolean;
    };

    expect(result.modelCatalog.codex[0]?.id).toBe('codex-later');
    expect(result.modelCompatibility.codex[0]?.id).toBe('codex-later');
    expect(result.draft.host).toBe('dirty-host');
    expect(result.lastSaved.host).toBe('saved-host');
    expect(result.dirty).toBe(true);
    expect(renderCount).toBe(1);
    expect(persisted).toEqual({
      ...currentState,
      models: nextModels,
      modelCompatibility: nextModels,
    });
  });
});

describe('settings artifact conventions', () => {
  it('lives in its own Git section, not in General', () => {
    expect(HTML).toContain('<button class="nav-btn" data-section="git">Git</button>');
    expect(HTML).toContain('<div class="section hidden" id="section-git">');
    // The card must sit INSIDE the Git section, after the General section closes.
    const git = HTML.indexOf('id="section-git"');
    const card = HTML.indexOf('Branch, commit &amp; pull request conventions');
    const repos = HTML.indexOf('id="section-services"');
    expect(git).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(git);
    expect(card).toBeLessThan(repos);
  });

  it('provides the four project-level controls with a multiline PR description', () => {
    expect(HTML).toContain('id="f-branchNameTemplate"');
    expect(HTML).toContain('id="f-commitMessageTemplate"');
    expect(HTML).toContain('id="f-prTitleTemplate"');
    expect(HTML).toMatch(/<textarea[^>]*id="f-prDescriptionTemplate"[^>]*rows="6"/);
    expect(HTML).toContain('id="f-defaultType"');
  });

  it('hydrates only configured values and preserves raw multiline content', () => {
    expect(HTML).toContain("const conventions = draft.conventions || {};");
    expect(HTML).toContain("el('f-branchNameTemplate').value = conventions.branchName || '';");
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
      "const COMMON_CONVENTION_VARS = ['title', 'key', 'id', 'repo', 'type', 'scope'];",
    );
    expect(HTML).toContain(
      "const DESCRIPTION_CONVENTION_VARS = [...COMMON_CONVENTION_VARS, 'description'];",
    );
    // The branch vocabulary is NOT the artifact one: {repo}/{scope} are absent
    // because entries sharing a repoPath resolve to a single worktree.
    expect(HTML).toContain(
      "const BRANCH_CONVENTION_VARS = ['type', 'slug', 'key', 'id', 'title'];",
    );
    expect(HTML).toContain("renderConventionVars('branchNameVars', BRANCH_CONVENTION_VARS)");
    expect(HTML).toContain("renderConventionVars('commitMessageVars', COMMON_CONVENTION_VARS)");
    expect(HTML).toContain("renderConventionVars('prTitleVars', COMMON_CONVENTION_VARS)");
    expect(HTML).toContain(
      "renderConventionVars('prDescriptionVars', DESCRIPTION_CONVENTION_VARS)",
    );
  });

  // The webview cannot import TypeScript, so it carries copies. Pin them against
  // the modules, or a preset that no longer validates ships to the user.
  it('mirrors the host preset and ticket-type vocabularies exactly', () => {
    expect(HTML).toContain(
      `const TICKET_TYPES = [${TICKET_TYPES.map((t) => `'${t}'`).join(', ')}];`,
    );
    for (const preset of CONVENTION_PRESETS) {
      expect(HTML, `preset id ${preset.id}`).toContain(`id: '${preset.id}'`);
      expect(HTML, `preset label ${preset.id}`).toContain(`label: '${preset.label}'`);
      for (const [field, value] of Object.entries(preset.conventions)) {
        // Newlines are escaped in the HTML's JS string literals.
        const literal = value.replace(/\n/g, '\\n');
        expect(HTML, `${preset.id}.${field}`).toContain(`${field}: '${literal}'`);
      }
    }
  });

  it('applies a preset into the draft only — never straight to disk', () => {
    const fn = HTML.match(
      /el\('applyPresetBtn'\)\.addEventListener\('click', \(\) => {([\s\S]*?)\n {2}}\);/,
    );
    expect(fn, 'applyPresetBtn handler not found').toBeTruthy();
    expect(fn![1]).toContain('updateConvention(field, value)');
    expect(fn![1]).toContain('markDirty()');
    expect(fn![1]).not.toContain("type: 'save'");
  });

  it('keeps host manifest validation authoritative', () => {
    expect(HTML).toContain("post({ type: 'validate', manifest: draft })");
    expect(HTML).not.toContain('function validateArtifactTemplate');
    expect(HTML).not.toContain('function validateBranchTemplate');
    expect(HTML).toContain('function showConventionValidation(error)');
    expect(HTML).toContain("['branchName', 'f-branchNameTemplate', 'branchNameError']");
    const validationCase = HTML.match(
      /case 'validation': {([\s\S]*?)\n {8}break;/,
    );
    expect(validationCase, 'validation message case not found').toBeTruthy();
    expect(validationCase![1]).toContain(
      'showConventionValidation(msg.ok ? null : msg.error)',
    );
  });
});

describe('settings section navigation', () => {
  type FakeSection = { id: string; hidden: boolean };

  function fakeSections(ids: readonly string[]): FakeSection[] {
    return ids.map((id) => ({ id, hidden: id !== ids[0] }));
  }

  function loadShowSection(sections: FakeSection[]): (target: unknown) => unknown {
    const nodes = sections.map((section) => ({
      id: section.id,
      classList: {
        toggle: (cls: string, on: boolean) => {
          if (cls === 'hidden') section.hidden = on;
        },
      },
    }));
    return runInNewContext(`(${functionSource('showSection')})`, {
      document: {
        querySelectorAll: (sel: string) => (sel === '.section' ? nodes : []),
      },
      console: { error: () => {} },
    }) as (target: unknown) => unknown;
  }

  function visible(sections: FakeSection[]): string[] {
    return sections.filter((s) => !s.hidden).map((s) => s.id);
  }

  it('has no hard-coded section id list — the omission that blanked Git', () => {
    expect(HTML).not.toMatch(/\['general',\s*'services'/);
  });

  it('every nav button targets a section that exists, and vice versa', () => {
    const navTargets = [...HTML.matchAll(/class="nav-btn[^"]*" data-section="([a-z]+)"/g)]
      .map((m) => m[1]);
    const sectionIds = [...HTML.matchAll(/<div class="section[^"]*" id="section-([a-z]+)"/g)]
      .map((m) => m[1]);
    expect(navTargets).toContain('git');
    expect([...navTargets].sort()).toEqual([...sectionIds].sort());
  });

  it('shows the Git section and hides the others', () => {
    const sections = fakeSections(['section-general', 'section-git', 'section-services']);
    const shown = loadShowSection(sections)('git');
    expect(shown).toBe('git');
    expect(visible(sections)).toEqual(['section-git']);
  });

  it('falls back to the first section instead of rendering nothing', () => {
    const sections = fakeSections(['section-general', 'section-git']);
    const shown = loadShowSection(sections)('does-not-exist');
    expect(shown).toBe('general');
    expect(visible(sections)).toEqual(['section-general']);
  });

  it('nav clicks route through showSection and mark the shown tab active', () => {
    const nav = HTML.match(
      /document\.querySelectorAll\('\.nav-btn'\)\.forEach\(\(btn\) => {([\s\S]*?)\n {2}}\);/,
    );
    expect(nav, 'nav-btn handler not found').toBeTruthy();
    expect(nav![1]).toContain('showSection(');
    expect(nav![1]).toContain("classList.toggle('active'");
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

/**
 * Extract the webview's mirrored transform engine and run it. Pinning the NAMES
 * alone would let the two implementations drift on semantics, and a preview that
 * disagrees with what Karst actually writes is worse than no preview.
 */
function loadMirrorTransforms(): (value: unknown, body: string) => string {
  const arity = HTML.match(/const TRANSFORM_ARITY = \{[\s\S]*?\};/);
  if (!arity) throw new Error('TRANSFORM_ARITY mirror not found');
  const source = [
    arity[0],
    functionSource('splitTransformArgs'),
    functionSource('separateWords'),
    functionSource('parseTokenBody'),
    functionSource('applyOneTransform'),
    functionSource('applyTransforms'),
    '((value, body) => applyTransforms(value, parseTokenBody(body).transforms))',
  ].join('\n');
  return runInNewContext(source, {}) as (value: unknown, body: string) => string;
}

describe('settings placeholder-transform mirror', () => {
  it('lists exactly the host transform names', () => {
    expect(HTML).toContain(
      `const TRANSFORM_NAMES = [${TRANSFORM_NAMES.map((n) => `'${n}'`).join(', ')}];`,
    );
  });

  it('renders every transform exactly as the host does', () => {
    const mirror = loadMirrorTransforms();
    const cases: Array<[unknown, string]> = [
      ['869e82530', 'key|slice:-4'],
      ['869e820e2', 'key|slice:-4'],
      ['abcdef', 'k|slice:1,3'],
      ['abcdef', 'k|slice:-4,-2'],
      ['abc', 'k|slice:10'],
      ['abc', 'k|slice:2,1'],
      ['abcdefgh', 'k|truncate:5'],
      ['abcdefgh', 'k|truncate:5,...'],
      ['abcdefgh', 'k|truncate:2,...'],
      ['🙂🙂🙂🙂', 'k|truncate:3'],
      ['abcde', 'k|truncate:5'],
      ['PROJ-142', 'k|lower'],
      ['proj-142', 'k|upper'],
      ['Add Login  Flow!', 'k|kebab'],
      ['Add Login  Flow!', 'k|snake'],
      ['Привет мир', 'k|kebab'],
      ['  add login  ', 'k|trim'],
      ['', 'k|default:idle'],
      ['working', 'k|default:idle'],
      [null, 'k|default:idle'],
      ['869e82530', 'k|slice:-4|upper'],
      ['  Add Login  ', 'k|trim|kebab|truncate:6'],
      ['', 'k|default:Not Started|kebab'],
      ['abc', 'k'],
      [null, 'k|slice:-4'],
      [undefined, 'k|truncate:5'],
      ['abc', 'k|nosuchtransform'],
    ];
    for (const [value, body] of cases) {
      const expected = applyTransforms(value, parseTokenBody(body).transforms);
      expect(mirror(value, body), `${String(value)} | ${body}`).toBe(expected);
    }
  });
});
