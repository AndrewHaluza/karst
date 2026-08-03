import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { CONVENTION_PRESETS } from '../../workflow/conventionPresets.js';
import { TICKET_TYPES } from '../../store/ticketTypes.js';
import { TRANSFORM_NAMES, applyTransforms } from '../../template/transforms.js';
import { parseTokenBody } from '../../template/token.js';
import {
  SETTINGS_SECTIONS,
  SECTION_FIELDS,
  SECTION_LABELS,
  mergeSection,
} from './sections.js';
import { validateManifest } from '../../manifest/schema.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';

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
    // Validates the tab-scoped candidate — what Save would actually write — but
    // still round-trips it to the host: nothing here decides validity locally.
    expect(HTML).toContain("post({ type: 'validate', manifest: saveCandidate(currentSection) })");
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
    const parse = runInNewContext(`
      ${functionSource('manifestFaultDetail')}
      ${functionSource('parseRepoFieldError')}
      parseRepoFieldError
    `, {}) as (msg: string | null) => { key: string } | null;

    expect(parse('repository "api".repoPath must be a string')).toEqual({ key: 'api.repoPath' });
    expect(parse('repository "api" service.start must be a non-empty string'))
      .toEqual({ key: 'api.start' });
    expect(parse('repository "api" service.ports[0].env must be a non-empty string'))
      .toEqual({ key: 'api.ports.0.env' });
    expect(parse('portRange must be a [min, max] number pair')).toBeNull();
  });

  it('maps an error that still carries its ManifestError prefix', () => {
    // The webview receives `error.message`, not `error.detail`, so the prefix is
    // always there. While it was not stripped, every anchored pattern below
    // missed and no inline field message ever rendered.
    const parse = runInNewContext(`
      ${functionSource('manifestFaultDetail')}
      ${functionSource('parseRepoFieldError')}
      parseRepoFieldError
    `, {}) as (msg: string | null) => { key: string } | null;

    expect(parse('Invalid karst.yml: repository "api".repoPath must be a string'))
      .toEqual({ key: 'api.repoPath' });
    expect(parse('Invalid karst.yml (/w/.karst/karst.yml): repository "api".repoPath must be a string'))
      .toEqual({ key: 'api.repoPath' });
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

  it('renders a real k-switch per repository card, with a matching aria-label and title', () => {
    // UI-R24/R26: role="switch" + aria-checked, not a hidden checkbox behind a
    // decorative dot — and the accessible name (aria-label) matches the
    // tooltip (title) exactly, since the control carries no visible text.
    expect(HTML).toContain('data-repo-enabled="${esc(name)}"');
    expect(HTML).toMatch(/class="k-switch" role="switch" aria-checked="\$\{isEnabled \? 'true' : 'false'\}"/);
    expect(HTML).toMatch(/aria-label="\$\{isEnabled \? 'Disable this repository' : 'Enable this repository'\}"/);
    expect(HTML).toMatch(/title="\$\{isEnabled \? 'Disable this repository' : 'Enable this repository'\}"/);
  });

  it('shows a Draft label when a repository is disabled', () => {
    expect(HTML).toContain('repo.enabled === false');
    expect(HTML).toContain('Draft');
  });

  it('does not expand the card when the toggle itself is clicked', () => {
    // The disclosure is its own <button class="card-toggle" data-toggle>, and
    // the switch is a SIBLING, never a descendant of it — so a click on the
    // switch cannot bubble through `closest('[data-toggle]')` at all. No
    // ancestor exemption is needed (or present) any more.
    expect(HTML).toMatch(/class="card-toggle" data-toggle="\$\{esc\(name\)\}"/);
    expect(HTML).toContain("t.closest && t.closest('[data-toggle]')");
  });

  it('flips draft.repositories[name].enabled on toggle click, reading aria-checked', () => {
    expect(HTML).toContain('t.dataset.repoEnabled');
    expect(HTML).toMatch(/next = t\.getAttribute\('aria-checked'\) !== 'true'/);
    expect(HTML).toMatch(/enabled:\s*next/);
    expect(HTML).toMatch(/t\.setAttribute\('aria-checked', String\(next\)\)/);
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
    // The disclosure is now a real <button class="card-toggle"> rather than the
    // whole `.card-head` row, and its size comes from the type scale rather
    // than a literal — the design system owns the value (UI-R04, UI-R09).
    const m = HTML.match(/\.card \.card-toggle \.chevron\{([^}]*)\}/);
    expect(m, '.card .card-toggle .chevron rule not found').toBeTruthy();
    expect(m![1]).toMatch(/font-size:var\(--k-text-(lg|xl|2xl)\)/); // >= 14px, up from 10px
  });

  it('applies the error border to any invalid field, not just convention fields', () => {
    expect(HTML).toMatch(/input\[aria-invalid="true"\][^{]*\{[^}]*border-color/);
  });
});

/** Classes on the accordion card that hosts the custom provider dropdown. */
function providerCardClasses(): string[] {
  const wrap = HTML.indexOf('id="provSelectWrap"');
  expect(wrap, '#provSelectWrap not found').toBeGreaterThan(-1);
  // The nearest preceding opening tag whose class list contains `card` itself
  // (not `card-body`, which sits between the wrapper and its card).
  const tags = [...HTML.slice(0, wrap).matchAll(/<div class="([^"]*)"/g)]
    .map((m) => m[1]!.split(/\s+/).filter(Boolean))
    .filter((classes) => classes.includes('card'));
  const last = tags[tags.length - 1];
  expect(last, 'no enclosing .card for #provSelectWrap').toBeTruthy();
  return last!;
}

describe('ticketing provider dropdown', () => {
  // The menu is absolutely positioned below the trigger and is taller than the
  // (short) card that hosts it, so the accordion's `.card{overflow:hidden}`
  // clipped it to a sliver: the dropdown opened but was invisible.
  it('is not clipped by its accordion card', () => {
    const classes = providerCardClasses();
    const optedOut = classes.some(
      (c) => c !== 'card' && new RegExp(`\\.card\\.${c}\\{[^}]*overflow:visible`).test(HTML),
    );
    expect(optedOut, `provider card classes "${classes.join(' ')}" are still clipped`).toBe(true);
  });

  it('paints the menu above the cards that follow it', () => {
    const m = HTML.match(/\.provselect-menu\{([^}]*)\}/);
    expect(m, '.provselect-menu rule not found').toBeTruthy();
    expect(m![1]).toMatch(/z-index:(?:\d+|var\(--k-z-[\w-]+\))/);
  });
});

describe('ticketing token state', () => {
  // Regression: the token buttons used to trigger a full `state` push, which
  // replaces `draft` with the manifest on disk. Setting a token is the first
  // step of first-time ticketing setup, so that silently reverted the provider
  // (and team id) the user had just entered but not yet saved.
  it('applies the host token flag without touching the manifest draft', () => {
    const source = functionSource('applyTokenState');
    expect(source).not.toContain('draft');
    expect(source).not.toContain('lastSaved');

    let rendered = 0;
    let saved: Record<string, unknown> | null = null;
    const sandbox = {
      tokenConfigured: false,
      renderTicketing: () => { rendered += 1; },
      vscode: {
        getState: () => ({ manifest: { ticketing: { provider: 'clickup' } }, tokenConfigured: false }),
        setState: (s: Record<string, unknown>) => { saved = s; },
      },
    };
    runInNewContext(`(${source})(true)`, sandbox);

    expect(sandbox.tokenConfigured).toBe(true);
    expect(rendered).toBe(1);
    // The persisted copy keeps the rest of the state and only flips the flag.
    expect(saved).toEqual({
      manifest: { ticketing: { provider: 'clickup' } },
      tokenConfigured: true,
    });
  });

  it('routes the host token-state message to applyTokenState', () => {
    expect(HTML).toContain("case 'token-state'");
    expect(HTML).toMatch(/applyTokenState\(msg\.configured\)/);
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

// ---- tab-scoped Save ----------------------------------------------------

/** The mirrored section vocabulary, lifted verbatim from the page's script. */
function sectionMirrorSource(): string {
  const start = HTML.indexOf('const SETTINGS_SECTIONS =');
  const end = HTML.indexOf('function clone(v)');
  if (start < 0 || end < 0) throw new Error('section mirror not found');
  return HTML.slice(start, end);
}

function sectionHelpers(): {
  SETTINGS_SECTIONS: string[];
  SECTION_LABELS: Record<string, string>;
  SECTION_FIELDS: Record<string, string[]>;
  overlaySections: (base: unknown, source: unknown, sections: string[]) => Record<string, unknown>;
  dirtySectionsOf: (draft: unknown, base: unknown) => string[];
  sectionForError: (msg: string | null) => string | null;
} {
  return runInNewContext(`
    ${sectionMirrorSource()}
    ${functionSource('overlaySections')}
    ${functionSource('sectionFieldsEqual')}
    ${functionSource('dirtySectionsOf')}
    ${functionSource('manifestFaultDetail')}
    ${functionSource('sectionForError')}
    ({ SETTINGS_SECTIONS, SECTION_LABELS, SECTION_FIELDS,
       overlaySections, dirtySectionsOf, sectionForError })
  `, {}) as ReturnType<typeof sectionHelpers>;
}

describe('settings tab-scoped save', () => {
  it('mirrors the host section vocabulary exactly', () => {
    const mirror = sectionHelpers();
    expect(mirror.SETTINGS_SECTIONS).toEqual([...SETTINGS_SECTIONS]);
    expect(mirror.SECTION_LABELS).toEqual(SECTION_LABELS);
    for (const section of SETTINGS_SECTIONS) {
      expect(mirror.SECTION_FIELDS[section], section).toEqual([...SECTION_FIELDS[section]]);
    }
  });

  it('labels every nav tab with the label the mirror uses', () => {
    const { SECTION_LABELS: labels } = sectionHelpers();
    for (const [section, label] of Object.entries(labels)) {
      expect(HTML).toContain(`data-section="${section}">${label}<`);
    }
  });

  it('overlays a section exactly as the host merges it', () => {
    const { overlaySections } = sectionHelpers();
    const base = {
      host: 'localhost',
      portRange: [4000, 4999],
      baselineBranch: 'main',
      ticketLabelTemplate: '{key}',
      repositories: { api: { repoPath: '../api', hasMigrations: false } },
      conventions: { branchName: 'karst/{slug}' },
    } as unknown as Manifest;
    const drafts: Manifest[] = [
      { ...base, host: '0.0.0.0', repositories: {} } as unknown as Manifest,
      { ...base, conventions: { branchName: 'x/{slug}' } } as unknown as Manifest,
      // A CLEARED optional field: absent, not undefined — both renderers must
      // remove it rather than carry the baseline's value forward.
      (() => {
        const { ticketLabelTemplate: _drop, ...rest } = base;
        return rest as Manifest;
      })(),
    ];
    for (const section of SETTINGS_SECTIONS) {
      for (const draft of drafts) {
        expect(overlaySections(base, draft, [section]), section).toEqual(
          mergeSection(base, draft, section),
        );
      }
    }
  });

  it('reports only the tabs whose own fields changed', () => {
    const { dirtySectionsOf } = sectionHelpers();
    const base = {
      host: 'localhost',
      repositories: { api: { repoPath: '../api' } },
      conventions: { branchName: 'karst/{slug}' },
    };
    expect(dirtySectionsOf(base, base)).toEqual([]);
    expect(dirtySectionsOf({ ...base, host: '0.0.0.0' }, base)).toEqual(['general']);
    expect(dirtySectionsOf({ ...base, host: '0.0.0.0', repositories: {} }, base)).toEqual([
      'general',
      'services',
    ]);
    // A key the UI does not own must never make a tab look dirty.
    expect(dirtySectionsOf({ ...base, uat: { maxFixAttempts: 3 } }, base)).toEqual([]);
  });

  it('treats a cleared optional field as a change', () => {
    const { dirtySectionsOf } = sectionHelpers();
    const base = { host: 'localhost', ticketLabelTemplate: '{key}' };
    expect(dirtySectionsOf({ host: 'localhost' }, base)).toEqual(['general']);
  });

  it('attributes real validation errors to the tab that owns them', () => {
    const { sectionForError } = sectionHelpers();
    const valid = buildManifest(
      { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
      { portRange: [4000, 4999], approaches: [], agents: {}, ticketing: { provider: 'manual' } },
    );
    const broken: [string, Partial<Manifest>][] = [
      ['general', { portRange: [9000, 1000] as [number, number] }],
      ['general', { worktreePathDisplay: 'sideways' as never }],
      ['general', { agentProvider: 'nope' as never }],
      ['services', { repositories: {} }],
      ['services', { repositories: { api: { repoPath: 42 as never, hasMigrations: false } } }],
      ['git', { conventions: { branchName: '{nope}' } }],
      ['git', { conventions: { commitMessage: '{nope}' } }],
      ['ticketing', { ticketing: { provider: 'clickup', advanceOnShip: true } }],
      ['approaches', { approaches: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
      ['agents', { agents: 'nope' as never }],
    ];
    for (const [expected, patch] of broken) {
      let message = '';
      try {
        validateManifest({ ...valid, ...patch });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(patch)).not.toBe('');
      expect(sectionForError(message), message).toBe(expected);
    }
  });

  it('leaves an unattributable error unblamed', () => {
    const { sectionForError } = sectionHelpers();
    expect(sectionForError('top level must be a mapping')).toBeNull();
    expect(sectionForError(null)).toBeNull();
  });
});

describe('settings unsaved-changes gate', () => {
  it('renders a modal offering save, discard and cancel', () => {
    expect(HTML).toContain('id="leaveModal"');
    expect(HTML).toContain('id="leaveSaveBtn"');
    expect(HTML).toContain('id="leaveDiscardBtn"');
    expect(HTML).toContain('id="leaveCancelBtn"');
    expect(HTML).toContain('aria-modal="true"');
  });

  it('routes every nav click through the gate, never straight to showSection', () => {
    expect(HTML).toContain("btn.addEventListener('click', () => requestSection(btn.dataset.section))");
  });

  it('posts a section with both drawer saves and the Save button', () => {
    // All three go through `postAction`, not a bare `post()` — a save in
    // flight must be pending/non-re-triggerable (UI-R11–R12), so a raw
    // `post({type:'save',...})` call site here would be a regression.
    const saves = HTML.match(/postAction\([^,]+, 'save', \{[^}]*\}\)/g) ?? [];
    expect(saves.length).toBe(3); // topbar Save, approach drawer Save, approach drawer Delete
    for (const call of saves) expect(call, call).toContain('section');
  });
});

/**
 * Runs the real tab-switch gate — the extracted functions plus the modal's own
 * click handlers — against fake DOM elements. There is no DOM library in this
 * project, so `el`/`document` are stubbed just richly enough for these paths.
 */
function gateHarness(init: {
  draft: Record<string, unknown>;
  lastSaved: Record<string, unknown>;
  currentSection?: string;
  valid?: boolean;
}) {
  const posted: Record<string, unknown>[] = [];
  const handlers = new Map<string, Map<string, () => void>>();

  function fakeEl(id: string) {
    const classes = new Set<string>(id === 'leaveModal' ? ['hidden'] : []);
    return {
      id,
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
        toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)),
      },
      classes,
      dataset: {} as Record<string, string>,
      textContent: '',
      title: '',
      disabled: false,
      focus: () => {},
      addEventListener: (type: string, fn: () => void) => {
        if (!handlers.has(id)) handlers.set(id, new Map());
        handlers.get(id)!.set(type, fn);
      },
    };
  }

  const elements = new Map<string, ReturnType<typeof fakeEl>>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, fakeEl(id));
    return elements.get(id)!;
  };

  const navButtons = SETTINGS_SECTIONS.map((section) => {
    const btn = fakeEl('nav-' + section);
    btn.dataset.section = section;
    return btn;
  });
  const sections = SETTINGS_SECTIONS.map((section) => {
    const node = fakeEl('section-' + section);
    if (section !== 'general') node.classList.add('hidden');
    return node;
  });

  // Minimal fakes for the shared async-action runtime (designRuntime.ts):
  // real behaviour is covered by designRuntime.test.ts against the emitted
  // JS itself — this only needs enough surface for `postAction`/
  // `updateSaveEnabled` to run without throwing, and for pending to actually
  // gate a second click (UI-R12).
  const karstPending = new Set<unknown>();
  const karstIsPending = (control: unknown) => karstPending.has(control);
  const karstBeginPending = (control: { disabled: boolean }) => {
    karstPending.add(control);
    control.disabled = true;
  };

  const context: Record<string, unknown> = {
    ...init,
    currentSection: init.currentSection ?? 'general',
    valid: init.valid ?? true,
    dirtySections: [],
    pendingSection: null,
    navigateAfterSave: null,
    lastValidationError: null,
    validateTimer: null,
    openCards: new Set<string>(),
    el,
    post: (m: Record<string, unknown>) => posted.push(m),
    renderAll: () => {},
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      querySelectorAll: (sel: string) =>
        (sel === '.nav-btn' ? navButtons : sel === '.section' ? sections : []),
    },
    karstIsPending,
    karstBeginPending,
    karstRequestId: () => 'r-test',
    topbarSaveRequestId: null,
  };

  const modalHandlersStart = HTML.indexOf("el('leaveCancelBtn').addEventListener");
  const modalHandlersEnd = HTML.indexOf("document.addEventListener('keydown'");
  const source = `
    ${sectionMirrorSource()}
    ${functionSource('overlaySections')}
    ${functionSource('sectionFieldsEqual')}
    ${functionSource('dirtySectionsOf')}
    ${functionSource('manifestFaultDetail')}
    ${functionSource('sectionForError')}
    ${functionSource('saveCandidate')}
    ${functionSource('markDirty')}
    ${functionSource('scheduleValidate')}
    ${functionSource('currentSectionDirty')}
    ${functionSource('updateSaveEnabled')}
    ${functionSource('renderNavMarkers')}
    ${functionSource('renderUnsavedHint')}
    ${functionSource('showSection')}
    ${functionSource('goToSection')}
    ${functionSource('requestSection')}
    ${functionSource('openLeaveModal')}
    ${functionSource('closeLeaveModal')}
    ${functionSource('discardSection')}
    ${functionSource('postAction')}
    ${functionSource('saveCurrentSection')}
    ${HTML.slice(modalHandlersStart, modalHandlersEnd)}
    markDirty();
  `;
  runInNewContext(source, context);

  return {
    posted,
    el,
    context,
    state: () => context as { currentSection: string; draft: Record<string, unknown> },
    modalOpen: () => !el('leaveModal').classList.contains('hidden'),
    click: (id: string) => handlers.get(id)?.get('click')?.(),
    navTo: (section: string) =>
      runInNewContext(`requestSection(${JSON.stringify(section)})`, context),
  };
}

describe('settings unsaved-changes gate — behavior', () => {
  const SAVED = {
    host: 'localhost',
    repositories: { api: { repoPath: '../api' } },
    conventions: { branchName: 'karst/{slug}' },
  };

  it('switches straight away when the tab on screen is clean', () => {
    const h = gateHarness({ draft: { ...SAVED }, lastSaved: { ...SAVED } });
    h.navTo('git');

    expect(h.modalOpen()).toBe(false);
    expect(h.state().currentSection).toBe('git');
  });

  it('blocks the switch and asks when the tab on screen is dirty', () => {
    const h = gateHarness({ draft: { ...SAVED, host: '0.0.0.0' }, lastSaved: { ...SAVED } });
    h.navTo('git');

    expect(h.modalOpen()).toBe(true);
    expect(h.state().currentSection).toBe('general'); // still here
    expect(h.el('leaveModalBody').textContent).toContain('General');
    expect(h.el('leaveModalBody').textContent).toContain('Git');
  });

  it('does not ask about a dirty tab the user is leaving alone', () => {
    // Dirty on Repositories, standing on General: switching to Git touches
    // neither, so there is nothing to decide.
    const h = gateHarness({ draft: { ...SAVED, repositories: {} }, lastSaved: { ...SAVED } });
    h.navTo('git');

    expect(h.modalOpen()).toBe(false);
    expect(h.state().currentSection).toBe('git');
  });

  it('discards only the tab being left, then navigates', () => {
    const h = gateHarness({
      draft: { ...SAVED, host: '0.0.0.0', repositories: {} },
      lastSaved: { ...SAVED },
    });
    h.navTo('git');
    h.click('leaveDiscardBtn');

    expect(h.state().draft.host).toBe('localhost'); // General rolled back
    expect(h.state().draft.repositories).toEqual({}); // Repositories edit survives
    expect(h.state().currentSection).toBe('git');
    expect(h.modalOpen()).toBe(false);
  });

  it('saves the tab being left and waits for the ack before navigating', () => {
    const h = gateHarness({ draft: { ...SAVED, host: '0.0.0.0' }, lastSaved: { ...SAVED } });
    h.navTo('git');
    h.click('leaveSaveBtn');

    // Carries a requestId too (§ postAction, UI-R13) — the single dispatch
    // seam correlates the host's terminal result back to this exact request.
    expect(h.posted).toContainEqual({
      type: 'save',
      manifest: { ...SAVED, host: '0.0.0.0' },
      section: 'general',
      requestId: expect.any(String),
    });
    // Still on General: the nav is released by the `saved` ack, so a save the
    // host refuses leaves the user on the tab that needs fixing.
    expect(h.state().currentSection).toBe('general');
    expect(h.context.navigateAfterSave).toBe('git');
  });

  it('offers only discard or cancel while the draft cannot be saved', () => {
    const h = gateHarness({
      draft: { ...SAVED, host: '0.0.0.0' },
      lastSaved: { ...SAVED },
      valid: false,
    });
    h.navTo('git');

    expect(h.el('leaveSaveBtn').disabled).toBe(true);
    expect(h.el('leaveModalError').classList.contains('hidden')).toBe(false);
    h.click('leaveSaveBtn');
    expect(h.posted).toEqual([]);
  });

  it('cancel keeps both the tab and the edits', () => {
    const h = gateHarness({ draft: { ...SAVED, host: '0.0.0.0' }, lastSaved: { ...SAVED } });
    h.navTo('git');
    h.click('leaveCancelBtn');

    expect(h.modalOpen()).toBe(false);
    expect(h.state().currentSection).toBe('general');
    expect(h.state().draft.host).toBe('0.0.0.0');
  });

  it('scopes the Save button to the tab on screen and names it', () => {
    const h = gateHarness({
      draft: { ...SAVED, repositories: {} },
      lastSaved: { ...SAVED },
      currentSection: 'services',
    });

    expect(h.el('saveBtn').textContent).toBe('Save Repositories');
    expect(h.el('saveBtn').disabled).toBe(false);
    expect(h.el('discardBtn').disabled).toBe(false);
  });

  it('marks the tabs that hold unsaved edits and names the ones off screen', () => {
    const h = gateHarness({
      draft: { ...SAVED, host: '0.0.0.0', repositories: {} },
      lastSaved: { ...SAVED },
    });

    expect(h.context.dirtySections).toEqual(['general', 'services']);
    expect(h.el('unsavedHint').textContent).toBe('Unsaved on Repositories');
    expect(h.el('unsavedHint').classList.contains('hidden')).toBe(false);
  });
});

// ── Task 3.7 remediation guards (docs/ui/UI-RULES.md) ───────────────────────

describe('UI-R04 — no style literals remain', () => {
  it('the <style> block contains no raw hex, rgb()/rgba(), or px/rem literal', () => {
    const style = HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style.length).toBeGreaterThan(0);
    const hits = style.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[0-9]+(?:\.[0-9]+)?(?:px|rem)/g) ?? [];
    expect(hits).toEqual([]);
  });
});

describe('UI-R10b — destructive controls use the danger variant', () => {
  // Every data-act/handler matching delete|remove|uninstall carries a danger
  // variant class, never a plain secondary look-alike (the motivating defect:
  // this screen had NO danger variant anywhere in its stylesheet).
  const destructive = [
    { attr: 'data-remove-service', variant: 'k-btn--danger' },
    { attr: 'data-remove-port', variant: 'k-iconbtn--danger' },
    { attr: 'data-remove-bind', variant: 'k-iconbtn--danger' },
    { attr: 'data-remove-dep', variant: 'k-btn--danger' },
    { attr: 'data-remove-signal', variant: 'k-iconbtn--danger' },
    { attr: 'data-uninstall', variant: 'k-btn--danger' },
    { attr: 'data-delete-agent', variant: 'k-btn--danger' },
    { attr: 'id="approachDrawerDelete"', variant: 'k-btn--danger' },
  ];
  it.each(destructive)('$attr carries $variant', ({ attr, variant }) => {
    const idx = HTML.indexOf(attr);
    expect(idx, `${attr} not found`).toBeGreaterThanOrEqual(0);
    const tagStart = HTML.lastIndexOf('<button', idx);
    const tagEnd = HTML.indexOf('>', idx);
    const tag = HTML.slice(tagStart, tagEnd);
    expect(tag, tag).toContain(variant);
  });
});

describe('UI-R09/R26 — card-head accordion is a real button with aria-expanded', () => {
  it('renders a <button class="card-toggle" data-toggle aria-expanded>, not a clickable div', () => {
    expect(HTML).toMatch(/<button type="button" class="card-toggle" data-toggle="\$\{esc\(name\)\}"/);
    expect(HTML).toMatch(/aria-expanded="\$\{isOpen \? 'true' : 'false'\}"/);
    // The old defect: a bare `<div class="card-head" data-toggle>` with no
    // role/tabindex/keydown handler anywhere.
    expect(HTML).not.toMatch(/<div class="card-head" data-toggle/);
  });

  it('the enable switch and Remove button are siblings of the toggle, never descendants', () => {
    const openTag = HTML.indexOf('<button type="button" class="card-toggle"');
    const closeTag = HTML.indexOf('</button>`', openTag);
    const toggleMarkup = HTML.slice(openTag, closeTag);
    expect(toggleMarkup).not.toContain('data-repo-enabled');
    expect(toggleMarkup).not.toContain('data-remove-service');
  });
});

describe('UI-R14b — the approach drawer does not close before its result', () => {
  it('submitApproachDrawer / deleteApproachDrawer never call closeApproachDrawer directly', () => {
    const submit = functionSource('submitApproachDrawer');
    const del = functionSource('deleteApproachDrawer');
    expect(submit).not.toContain('closeApproachDrawer()');
    expect(del).not.toContain('closeApproachDrawer()');
    // Both post through postAction and record the in-flight request instead.
    expect(submit).toContain('approachDrawerRequestId = postAction(');
    expect(del).toContain('approachDrawerRequestId = postAction(');
  });

  it('the drawer only closes from the saved ack, and shows the failure inline on error', () => {
    const savedCase = HTML.slice(HTML.indexOf("case 'saved':"), HTML.indexOf("case 'approach-command-body':"));
    expect(savedCase).toContain('closeApproachDrawer()');
    const errorCase = HTML.slice(HTML.indexOf("case 'error':"), HTML.indexOf("case 'saved':"));
    expect(errorCase).toContain('showApproachDrawerError(msg.message)');
    expect(errorCase).not.toContain('closeApproachDrawer()');
  });
});

describe('approach drawer save preserves undrawn keys', () => {
  function rebuildApproachFromDrawer(
    existing: Record<string, unknown> | null,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return runInNewContext(`(${functionSource('rebuildApproachFromDrawer')})`, {})(
      existing,
      fields,
    ) as Record<string, unknown>;
  }

  it('preserves approach keys the drawer does not render when editing', () => {
    // An approach carrying a workflow — exactly the shipped `rpi` shape.
    const before = {
      id: 'rpi',
      label: 'Research → Plan → Implement',
      entrypoint: 'research',
      enabled: true,
      workflow: [
        { name: 'describe' },
        { name: 'research', command: '/rpi:research' },
      ],
    };

    const after = rebuildApproachFromDrawer(before, {
      id: 'rpi',
      label: 'Research → Plan → Implement (edited)',
      description: '',
      entrypoint: 'research',
      sourceType: 'none',
      recommended: false,
    });

    expect(after.label).toBe('Research → Plan → Implement (edited)');
    expect(after.workflow).toEqual(before.workflow);
  });

  it('clears a drawer-owned optional field that the user blanked', () => {
    const before = { id: 'x', label: 'X', description: 'old', entrypoint: 'e', enabled: true };
    const after = rebuildApproachFromDrawer(before, {
      id: 'x', label: 'X', description: '', entrypoint: 'e',
      sourceType: 'none', recommended: false,
    });
    expect(after.description).toBeUndefined();
    expect(after.entrypoint).toBe('e');
  });
});

describe('UI-R12 — Save is disabled while a save is in flight', () => {
  it('updateSaveEnabled folds karstIsPending(saveBtn) into the disabled computation', () => {
    const fn = functionSource('updateSaveEnabled');
    expect(fn).toMatch(/saveBtn\.disabled\s*=\s*!valid \|\| !scopedDirty \|\| karstIsPending\(saveBtn\)/);
  });

  it('a double click on Save posts only one save message', () => {
    const h = gateHarness({
      draft: { host: 'x', repositories: {} },
      lastSaved: { host: 'y', repositories: {} },
    });
    h.click('leaveSaveBtn'); // exercises saveCurrentSection() via postAction
    h.click('leaveSaveBtn'); // a second immediate click must be dropped
    const saves = h.posted.filter((m) => m.type === 'save');
    expect(saves.length).toBe(1);
  });
});

describe('UI-R25 — every input is labelled', () => {
  it('every static <label for> id matches a real control id', () => {
    const forIds = [...HTML.matchAll(/<label[^>]*\bfor="([^"$]+)"/g)].map((m) => m[1]);
    expect(forIds.length).toBeGreaterThan(10);
    for (const id of forIds) {
      expect(HTML, `no control with id="${id}" for its <label for="${id}">`).toContain(`id="${id}"`);
    }
  });

  it('every dynamically rendered field carries a <label for> or an aria-label', () => {
    // Repository card fields: labelled via a per-repo <label for>.
    expect(HTML).toMatch(/<label for="\$\{nameFieldId\}">Name<\/label>/);
    expect(HTML).toMatch(/<label for="\$\{repoPathId\}">Repo path<\/label>/);
    expect(HTML).toMatch(/<label style="margin:0" for="\$\{migrationsId\}">Has migrations<\/label>/);
    expect(HTML).toMatch(/<label style="margin:0" for="\$\{runnableId\}">Runnable service<\/label>/);
    // Ports / depends-on / signals: no per-row <label> is practical (rows are
    // repeated and reordered), so each control carries its own aria-label.
    expect(HTML).toContain('aria-label="Port ${i + 1} name"');
    expect(HTML).toContain('aria-label="Port ${i + 1} environment variable"');
    expect(HTML).toContain('aria-label="Dependency ${i + 1} target repository"');
    expect(HTML).toContain('aria-label="Add signal word for ${esc(svcName)}"');
    expect(HTML).toContain("aria-label=\"${esc(a.name)} body\"");
    expect(HTML).toContain('aria-label="New agent name"');
    expect(HTML).toContain('aria-label="Port range minimum"');
    expect(HTML).toContain('aria-label="Port range maximum"');
  });
});

describe('UI-R13 — action-result is handled', () => {
  it('the host-message union includes action-result and the webview switch settles it', () => {
    expect(HTML).toContain("case 'action-result': {");
    const body = HTML.slice(
      HTML.indexOf("case 'action-result': {"),
      HTML.indexOf('break;', HTML.indexOf("case 'action-result': {")),
    );
    expect(body).toContain('karstSettle(msg.requestId, msg.ok, msg.message)');
  });

  it('messages.ts SettingsHostMessage includes ActionResultMessage', async () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'messages.ts'), 'utf8');
    expect(src).toContain('| ActionResultMessage');
    expect(src).toContain("from '../../model/actionResult.js'");
  });
});

describe('ClickUp reload buttons', () => {
  /**
   * These two fetches predate `action-result` and settle through their own
   * replies, so they are the one place a control could quietly keep the old
   * text-only "Loading…" treatment with no pending state at all. They drive the
   * runtime's pieces directly instead.
   */
  it('enters pending through the runtime, so the watchdog arms (UI-R11, R14)', () => {
    expect(HTML).toContain('karstBeginPending');
    expect(HTML).toMatch(/listsRequestId\s*=\s*beginFetch\('refreshListsBtn'/);
    expect(HTML).toMatch(/beginFetch\('refreshStatusesBtn'/);
  });

  it('drops a second activation while a fetch is in flight (UI-R12)', () => {
    expect(HTML).toContain('karstIsPending(btn)');
  });

  it('settles on both the success and the error reply (UI-R13)', () => {
    for (const reply of [
      'ticket-lists',
      'ticket-lists-error',
      'ticket-statuses',
      'ticket-statuses-error',
    ]) {
      const at = HTML.indexOf(`case '${reply}': {`);
      expect(at, `no handler for ${reply}`).toBeGreaterThan(0);
      expect(HTML.slice(at, at + 220), `${reply} does not settle`).toContain('endFetch(');
    }
  });

  it('carries the failure message into the settle rather than only the inline hint', () => {
    expect(HTML).toMatch(/endFetch\((?:lists|statuses)RequestId,\s*false,\s*msg\.message\)/);
  });
});
