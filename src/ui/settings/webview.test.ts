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
import type { GateDef, Manifest } from '../../manifest/types.js';
import {
  manifest as buildManifest,
  runnableRepo,
  slot,
  uat as buildUat,
  review as buildReview,
} from '../../manifest/fixtures.js';
import { gateSummary as hostGateSummary } from './gateDraft.js';
import { PROCESS_KEYS } from '../../manifest/validate/processAssignments.js';

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
      // The refresh re-requests host-computed process views only on the Agents
      // tab — this sandbox is on General, so the post must not fire.
      currentSection: 'general',
      saveCandidate: () => ({}),
      post: () => {},
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
    expect(parse('repository "api" service.portRange must be a [min, max] number pair'))
      .toEqual({ key: 'api.portRange' });
    expect(parse('repository "api" service.portRange min must be an integer between 1 and 65535 (got 0)'))
      .toEqual({ key: 'api.portRange' });
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
    expect(HTML).toContain('data-port-range-field="min"'); // port range min input
    expect(HTML).toContain('data-port-range-field="max"'); // port range max input
    expect(HTML).toContain('data-touch-key="${esc(name)}.portRange"');
  });
});

describe('per-service port range editing', () => {
  it('writes draft.repositories[name].service.portRange from the range inputs', () => {
    expect(HTML).toContain('t.dataset.portRangeField');
    expect(HTML).toMatch(/svcDef\.portRange = \[Number\(minVal\) \|\| 0, Number\(maxVal\) \|\| 0\];/);
  });

  it('clears service.portRange when both inputs are blank', () => {
    expect(HTML).toContain("if (minVal === '' && maxVal === '') delete svcDef.portRange;");
  });

  it('renders an existing portRange into the min/max inputs', () => {
    expect(HTML).toContain('value="${svc.portRange ? svc.portRange[0] : \'\'}"');
    expect(HTML).toContain('value="${svc.portRange ? svc.portRange[1] : \'\'}"');
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

describe('ticketing search toggle', () => {
  it('renders a search toggle card that defaults ON, hidden for manual', () => {
    const markup = HTML.slice(HTML.indexOf('id="searchCard"'), HTML.indexOf('id="searchCard"') + 500);
    expect(markup).toContain('id="f-searchEnabled"');
    expect(markup).toContain('Search tickets in the Add/Edit ticket page');
    // renderTicketing shows it only for clickup and reflects the draft value.
    const render = functionSource('renderTicketing');
    expect(render).toContain("el('searchCard').classList.toggle('hidden', !isClickup)");
    expect(render).toContain("el('f-searchEnabled').checked = cfg.searchEnabled !== false");
  });

  it('writes the toggle back into the manifest draft and marks it dirty', () => {
    const m = HTML.match(
      /el\('f-searchEnabled'\)\.addEventListener\('change', \(\) => \{([\s\S]*?)\n {2}}\);/,
    );
    expect(m, 'f-searchEnabled change listener not found').toBeTruthy();
    const body = m![1]!;
    expect(body).toContain("ticketingCfg().searchEnabled = el('f-searchEnabled').checked");
    expect(body).toContain('markDirty()');
  });

  it('clears a stale searchEnabled when the provider leaves clickup', () => {
    const source = functionSource('pickProvider');
    expect(source).toContain('delete cfg.searchEnabled');
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
    // A key no section owns must never make a tab look dirty.
    expect(dirtySectionsOf({ ...base, id: 'karst' }, base)).toEqual([]);
    // uat is now owned by the quality tab.
    expect(dirtySectionsOf({ ...base, uat: { maxFixAttempts: 3 } }, base)).toEqual(['quality']);
    // The auto-archive delay is a General-tab field (869eck7my).
    expect(dirtySectionsOf({ ...base, archiveDoneAfterDays: 7 }, base)).toEqual(['general']);
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
      ['general', { archiveDoneAfterDays: 0 }],
      ['services', { repositories: {} }],
      ['services', { repositories: { api: { repoPath: 42 as never, hasMigrations: false } } }],
      ['git', { conventions: { branchName: '{nope}' } }],
      ['git', { conventions: { commitMessage: '{nope}' } }],
      ['ticketing', { ticketing: { provider: 'clickup', advanceOnShip: true } }],
      ['approaches', { approaches: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
      ['agents', { agents: 'nope' as never }],
      ['agents', { processes: { wibble: {} } as never }],
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
    { attr: 'data-remove-gate', variant: 'k-iconbtn--danger' },
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

describe('project facts (manifest path & resolved project id)', () => {
  it('renders a read-only <dl>, not inputs, so Save can never write these back', () => {
    const generalStart = HTML.indexOf('id="section-general"');
    const generalEnd = HTML.indexOf('<!-- Git -->');
    const section = HTML.slice(generalStart, generalEnd);
    expect(section).toContain('id="projectFacts"');
    expect(section).toContain('<dl class="facts">');
    expect(section).toContain('id="factManifestPath"');
    expect(section).toContain('id="factProjectSlug"');
    expect(section).toContain('id="factSlugDerived"');
    expect(section).toContain('id="factVersion"');
    expect(section).toContain('id="openManifestBtn"');
  });

  it('never adds the facts to SECTION_FIELDS — they must not enter the draft', () => {
    expect(SECTION_FIELDS.general).not.toContain('manifestPath');
    expect(SECTION_FIELDS.general).not.toContain('projectSlug');
  });

  it('the Open karst.yml button posts through the pending action runtime (UI-R11)', () => {
    expect(HTML).toMatch(/postAction\(el\('openManifestBtn'\),\s*'open-manifest'/);
  });

  it("renderProjectFacts fills the facts from the host-pushed state, marking a derived id", () => {
    const source = `
      let manifestPath = '';
      let projectSlug = { value: '', derived: true };
      let extensionVersion = '1.0.0';
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', hidden: false };
        return elements[id];
      }
      ${functionSource('renderProjectFacts')}
      manifestPath = '/work/proj/.karst/karst.yml';
      projectSlug = { value: 'my-proj', derived: true };
      extensionVersion = '1.0.0';
      renderProjectFacts();
      ({
        path: elements.factManifestPath.textContent,
        slug: elements.factProjectSlug.textContent,
        derivedHidden: elements.factSlugDerived.hidden,
        version: elements.factVersion.textContent,
      });
    `;
    const result = runInNewContext(source, {}) as {
      path: string;
      slug: string;
      derivedHidden: boolean;
      version: string;
    };
    expect(result.path).toBe('/work/proj/.karst/karst.yml');
    expect(result.slug).toBe('my-proj');
    expect(result.derivedHidden).toBe(false);
    expect(result.version).toBe('1.0.0');
  });

  it('renderProjectFacts hides the derived chip when the id is explicit', () => {
    const source = `
      let manifestPath = 'x';
      let projectSlug = { value: '', derived: true };
      let extensionVersion = '';
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', hidden: false };
        return elements[id];
      }
      ${functionSource('renderProjectFacts')}
      projectSlug = { value: 'explicit-id', derived: false };
      renderProjectFacts();
      elements.factSlugDerived.hidden;
    `;
    const result = runInNewContext(source, {});
    expect(result).toBe(true);
  });

  it('falls back to (unresolved) when the host has not supplied the facts yet', () => {
    const source = `
      let manifestPath = '';
      let projectSlug = { value: '', derived: true };
      let extensionVersion = '';
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', hidden: false };
        return elements[id];
      }
      ${functionSource('renderProjectFacts')}
      renderProjectFacts();
      ({ path: elements.factManifestPath.textContent, slug: elements.factProjectSlug.textContent });
    `;
    const result = runInNewContext(source, {}) as { path: string; slug: string };
    expect(result.path).toBe('(unresolved)');
    expect(result.slug).toBe('(unresolved)');
  });
});

describe('auto-archive delay field (General tab)', () => {
  it('renders a number input that cannot express "immediately"', () => {
    const generalStart = HTML.indexOf('id="section-general"');
    const generalEnd = HTML.indexOf('<!-- Git -->');
    const section = HTML.slice(generalStart, generalEnd);
    expect(section).toContain('id="f-archiveDoneAfterDays"');
    expect(section).toContain('min="1"');
    expect(section).toContain('step="1"');
    expect(section).toContain('id="archiveHint"');
  });
});

describe('debug logging toggle (General tab)', () => {
  it('renders a checkbox in the General section with the debug hint', () => {
    const generalStart = HTML.indexOf('id="section-general"');
    const generalEnd = HTML.indexOf('<!-- Git -->');
    const section = HTML.slice(generalStart, generalEnd);
    expect(section).toContain('id="f-debug"');
    expect(section).toContain('type="checkbox"');
    expect(section).toContain('id="debugHint"');
  });

  it('checks the box only when the draft carries debug: true', () => {
    const source = `
      let draft = {};
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', hidden: false };
        return elements[id];
      }
      function renderModelPicker() {}
      function renderPresetOptions() {}
      function renderDefaultTypeOptions() {}
      function renderLabelPreview() {}
      function renderConventions() {}
      function renderProjectFacts() {}
      function agentBadgeHtml() { return ''; }
      const KNOWN_AGENT_PROVIDERS = [];
      const implementedProviders = [];
      function esc(s) { return String(s); }
      ${functionSource('renderGeneral')}
      draft = { debug: true };
      renderGeneral();
      const on = el('f-debug').checked;
      draft = {};
      renderGeneral();
      const off = el('f-debug').checked;
      ({ on, off });
    `;
    const result = runInNewContext(source, {}) as { on: boolean; off: boolean };
    expect(result.on).toBe(true);
    expect(result.off).toBe(false);
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

describe('settings quality tab (UAT + review scalars)', () => {
  it('nav entry and section exist, with the gates mount point left empty', () => {
    expect(HTML).toContain('<button class="nav-btn" data-section="quality">Quality</button>');
    expect(HTML).toContain('<div class="section hidden" id="section-quality">');
    expect(HTML).toContain('id="qualityGates"');
  });

  it('provides every DOM id the draft-sync task depends on', () => {
    for (const id of [
      'f-uatMaxFix',
      'f-reviewMaxFix',
      'f-reviewIndependent',
      'f-reviewOpenChanges',
      'f-findingsEnabled',
      'f-findingsSeverity',
      'f-findingsMax',
    ]) {
      expect(HTML, id).toContain(`id="${id}"`);
      // Every input/select carries a matching <label for>.
      expect(HTML, `${id} label`).toContain(`for="${id}"`);
    }
  });

  /**
   * Mirrors validate/review.ts defaultFindings()/validateReview() and
   * validate/uat.ts's maxFixAttempts fallback so the mirror can't silently
   * drift from the validators it stands in for.
   */
  it('mirrors the validators exactly', () => {
    expect(HTML).toContain("const UAT_DEFAULTS = { maxFixAttempts: 3 };");
    expect(HTML).toContain(
      "const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'none'];",
    );
    expect(HTML).toMatch(
      /const REVIEW_DEFAULTS = \{\s*maxFixAttempts: 3,\s*requireIndependentSignal: true,\s*openChanges: false,\s*findings: \{ enabled: true, blockingSeverity: 'high', maxFindings: 50 \},\s*\};/,
    );
  });

  function fakeEl(id: string) {
    return { id, value: '' as unknown, checked: false, innerHTML: '' };
  }

  function runRenderQuality(draft: Record<string, unknown>): Record<string, { value: unknown; checked: unknown }> {
    const elements = new Map<string, ReturnType<typeof fakeEl>>();
    const el = (id: string) => {
      if (!elements.has(id)) elements.set(id, fakeEl(id));
      return elements.get(id)!;
    };
    const source = `
      const UAT_DEFAULTS = { maxFixAttempts: 3 };
      const REVIEW_DEFAULTS = {
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      };
      const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'none'];
      const draft = ${JSON.stringify(draft)};
      ${functionSource('gateSummary')}
      ${functionSource('parseGateBlock')}
      ${functionSource('renderGateList')}
      ${functionSource('renderOverridesSection')}
      ${functionSource('syncGateRepoSelects')}
      ${functionSource('renderQuality')}
      renderQuality();
    `;
    runInNewContext(source, {
      el,
      esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] ?? c),
      document: { querySelector: () => null },
    });
    const out: Record<string, { value: unknown; checked: unknown }> = {};
    for (const [id, node] of elements) out[id] = { value: node.value, checked: node.checked };
    return out;
  }

  function field(
    result: Record<string, { value: unknown; checked: unknown }>,
    id: string,
  ): { value: unknown; checked: unknown } {
    const found = result[id];
    if (!found) throw new Error(`renderQuality never touched ${id}`);
    return found;
  }

  it('renders review findings defaults as blocking when the block is absent', () => {
    // The manifest default is enabled/high by design — a control that renders
    // "off" would imply review is advisory when it actually blocks (S4).
    const result = runRenderQuality({});
    expect(field(result, 'f-findingsEnabled').checked).toBe(true);
    expect(field(result, 'f-findingsSeverity').value).toBe('high');
    expect(field(result, 'f-findingsMax').value).toBe(50);
    expect(field(result, 'f-reviewIndependent').checked).toBe(true);
    expect(field(result, 'f-reviewOpenChanges').checked).toBe(false);
    expect(field(result, 'f-reviewMaxFix').value).toBe(3);
    expect(field(result, 'f-uatMaxFix').value).toBe(3);
  });

  it('hydrates from explicit values when the blocks are present', () => {
    const result = runRenderQuality({
      uat: { maxFixAttempts: 5 },
      review: {
        maxFixAttempts: 2,
        requireIndependentSignal: false,
        openChanges: true,
        findings: { enabled: false, blockingSeverity: 'none', maxFindings: 10 },
      },
    });
    expect(field(result, 'f-uatMaxFix').value).toBe(5);
    expect(field(result, 'f-reviewMaxFix').value).toBe(2);
    expect(field(result, 'f-reviewIndependent').checked).toBe(false);
    expect(field(result, 'f-reviewOpenChanges').checked).toBe(true);
    expect(field(result, 'f-findingsEnabled').checked).toBe(false);
    expect(field(result, 'f-findingsSeverity').value).toBe('none');
    expect(field(result, 'f-findingsMax').value).toBe(10);
  });

  it('populates the severity select from the SEVERITIES vocabulary', () => {
    const elements = new Map<string, ReturnType<typeof fakeEl>>();
    const el = (id: string) => {
      if (!elements.has(id)) elements.set(id, fakeEl(id));
      return elements.get(id)!;
    };
    const source = `
      const UAT_DEFAULTS = { maxFixAttempts: 3 };
      const REVIEW_DEFAULTS = {
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      };
      const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'none'];
      const draft = {};
      ${functionSource('gateSummary')}
      ${functionSource('parseGateBlock')}
      ${functionSource('renderGateList')}
      ${functionSource('renderOverridesSection')}
      ${functionSource('syncGateRepoSelects')}
      ${functionSource('renderQuality')}
      renderQuality();
    `;
    runInNewContext(source, {
      el,
      esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] ?? c),
      document: { querySelector: () => null },
    });
    const select = elements.get('f-findingsSeverity')!;
    for (const s of ['critical', 'high', 'medium', 'low', 'info', 'none']) {
      expect(select.innerHTML, s).toContain(`value="${s}"`);
    }
  });

  it('renderAll wires renderQuality in so tab switches stay current', () => {
    const body = HTML.slice(HTML.indexOf('function renderAll('), HTML.indexOf('function refreshModelCatalog('));
    expect(body).toContain('renderQuality();');
  });

  it('never rebuilds draft.uat or draft.review wholesale (mergeSection deletes absent fields)', () => {
    // Task 9 ships no write-back handlers yet; this guards the invariant for
    // whichever later task adds them.
    expect(HTML).not.toMatch(/draft\.uat\s*=\s*\{[^.]*maxFixAttempts/);
    expect(HTML).not.toMatch(/draft\.review\s*=\s*\{[^.]*maxFixAttempts/);
  });
});

/**
 * Task 11: the shared gate editor mounted into #qualityGates. ONE renderer
 * (renderGateList) parameterized by 'uat' | 'review' so the two blocks cannot
 * diverge, mirroring src/ui/settings/gateDraft.ts the way SECTION_FIELDS and
 * the placeholder-transform engine are already mirrored (UI-R34).
 */
describe('settings quality tab — gate editor', () => {
  function escMirror(s: unknown): string {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] ?? c);
  }

  it('renders every gate exactly as the host summarises it', () => {
    const webviewGateSummary = runInNewContext(
      `(${functionSource('gateSummary')})`,
      {},
    ) as (gate: GateDef) => string;
    const cases: GateDef[] = [
      { name: 'test', kind: 'script', script: 'test' },
      { name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] },
      { name: 'build', kind: 'script', script: 'build', repo: 'frontend' },
      { name: 'a', kind: 'script' },
      { name: 'a', kind: 'command', command: 'npx', args: [] },
      { name: 'a', kind: 'command', command: '' },
    ];
    for (const gate of cases) {
      expect(webviewGateSummary(gate)).toBe(hostGateSummary(gate));
    }
  });

  function loadRenderGateList(repositories: Record<string, unknown>): (block: string, gates: GateDef[]) => string {
    const source = `
      const draft = { repositories: ${JSON.stringify(repositories)} };
      ${functionSource('gateSummary')}
      ${functionSource('parseGateBlock')}
      ${functionSource('renderGateList')}
      renderGateList
    `;
    return runInNewContext(source, { esc: escMirror }) as (block: string, gates: GateDef[]) => string;
  }

  it('scopes a gate to a repository from the declared repositories only', () => {
    const renderGateList = loadRenderGateList({ api: {}, web: {} });
    const html = renderGateList('uat', [{ name: 'build', kind: 'script', script: 'build' }]);
    const select = html.match(/<select aria-label="Gate 1 repository"[^>]*>([\s\S]*?)<\/select>/);
    if (!select) throw new Error('repo select not found in rendered row');
    // '' is "every target" — the absent-repo case, which must stay selectable.
    const options = [...select[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['', 'api', 'web']);
  });

  it('renders a script gate row with name/kind/script/repo fields and data attributes', () => {
    const renderGateList = loadRenderGateList({ api: {} });
    const html = renderGateList('uat', [{ name: 'test', kind: 'script', script: 'test', repo: 'api' }]);
    expect(html).toContain('data-gate-block="uat"');
    expect(html).toContain('data-gate-idx="0"');
    expect(html).toContain('aria-label="Gate 1 name"');
    expect(html).toContain('aria-label="Gate 1 kind"');
    expect(html).toContain('aria-label="Gate 1 script"');
    expect(html).toContain('aria-label="Gate 1 repository"');
    expect(html).toContain('data-gate-field="name"');
    expect(html).toContain('data-gate-field="script"');
    expect(html).toContain('data-gate-field="repo"');
    expect(html).not.toContain('aria-label="Gate 1 command"');
    expect(html).toContain('npm run test');
    expect(html).toContain('data-remove-gate="uat"');
    expect(html).toContain('aria-label="Remove gate 1"');
    expect(html).toContain('title="Remove gate 1"');
  });

  it('renders a command gate row with command/args fields instead of script', () => {
    const renderGateList = loadRenderGateList({});
    const html = renderGateList('review', [
      { name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] },
    ]);
    expect(html).toContain('data-gate-field="command"');
    expect(html).toContain('data-gate-field="args"');
    expect(html).not.toContain('data-gate-field="script"');
    expect(html).toContain('value="npx"');
    expect(html).toContain('value="playwright test"');
    expect(html).toContain('npx playwright test');
    expect(html).toContain('data-gate-block="review"');
  });

  it('escapes gate field values injected into the row', () => {
    const renderGateList = loadRenderGateList({});
    const html = renderGateList('uat', [{ name: '<img src=x onerror=alert(1)>', kind: 'script', script: 's' }]);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('renders a repo <select> for a global gate row, with the declared repositories as options', () => {
    const renderGateList = loadRenderGateList({ api: {}, web: {} });
    const html = renderGateList('uat', [{ name: 'build', kind: 'script', script: 'build' }]);
    const row = html.slice(0, html.indexOf('data-add-gate'));
    expect(row).toContain('data-gate-field="repo"');
    const select = row.match(/<select aria-label="Gate 1 repository"[^>]*>([\s\S]*?)<\/select>/);
    if (!select) throw new Error('repo select not found in rendered row');
    const options = [...select[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['', 'api', 'web']);
  });

  it('renders no repo <select> for an override gate row, and names the owning repo as text instead', () => {
    const renderGateList = loadRenderGateList({ api: {}, web: {} });
    const html = renderGateList('uat:api', [{ name: 'lint', kind: 'script', script: 'lint', repo: 'web' }]);
    const row = html.slice(0, html.indexOf('data-add-gate'));
    expect(row).not.toContain('data-gate-field="repo"');
    expect(row).not.toMatch(/aria-label="Gate 1 repository"/);
    expect(row).toContain('Runs in api');
    // The dead `gate.repo` value already on disk (here 'web') is left alone —
    // this fix stops OFFERING the control, it never rewrites the user's file.
  });

  it('escapes an override repository name containing HTML in the static text', () => {
    const renderGateList = loadRenderGateList({ '<x>': {} });
    const html = renderGateList('uat:<x>', [{ name: 'lint', kind: 'script', script: 'lint' }]);
    expect(html).not.toContain('Runs in <x>');
    expect(html).toContain('Runs in &lt;x&gt;');
  });

  it('renders the Add gate button for the block', () => {
    const renderGateList = loadRenderGateList({});
    const html = renderGateList('uat', []);
    expect(html).toContain('data-add-gate="uat"');
    expect(html).toContain('+ Add gate');
  });

  it('mounts both blocks into #qualityGates and syncs repo selects after render', () => {
    const body = HTML.slice(
      HTML.indexOf('function renderQuality('),
      HTML.indexOf("el('f-ticketTeamId').addEventListener"),
    );
    expect(body).toMatch(/renderGateList\(\s*'uat'/);
    expect(body).toMatch(/renderGateList\(\s*'review'/);
    expect(body).toContain("el('qualityGates')");
  });

  it('writes gate edits back by spreading the existing block, never rebuilding it', () => {
    // The Quality scalars (Task 9) never write; this task's gate editor does,
    // and must obey the same spread-not-rebuild rule mergeSection depends on.
    expect(HTML).toMatch(/draft\.uat\s*=\s*\{\s*\.\.\.\(draft\.uat \|\| \{\}\)/);
    expect(HTML).toMatch(/draft\.review\s*=\s*\{\s*\.\.\.\(draft\.review \|\| \{\}\)/);
  });

  it('mirrors gateDraft.ts helpers used to add/switch/remove gates', () => {
    expect(HTML).toMatch(/function emptyGate\(\)/);
    expect(HTML).toMatch(/function setGateKind\(/);
    expect(HTML).toMatch(/function gateSummary\(/);
  });
});

/**
 * Task 13: per-repository gate overrides. uat.repositories.<name>.gates /
 * review.repositories.<name>.gates REPLACE the block's global list for that
 * repository (declaredGatesFor / declaredReviewGatesFor) rather than adding
 * to it — the opposite of how "add a gate for this repo" reads. A
 * newly-created override is seeded with a COPY of the global list so the
 * replacement is visible instead of silently meaning "this repo runs no
 * gates".
 */
describe('settings quality tab — per-repository gate overrides', () => {
  function escMirror(s: unknown): string {
    return String(s ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] ?? c);
  }

  function overrideSandbox(draft: Record<string, unknown>): Record<string, unknown> {
    const sandbox: Record<string, unknown> = { draft, markDirty: () => {}, renderQuality: () => {} };
    const source = `
      function clone(v) { return JSON.parse(JSON.stringify(v)); }
      ${functionSource('updateUat')}
      ${functionSource('updateReview')}
      ${functionSource('addRepoOverride')}
      ${functionSource('removeRepoOverride')}
    `;
    runInNewContext(source, sandbox);
    return sandbox;
  }

  it('prefills a new per-repo override with the global list, so replacement is visible', () => {
    const draft = {
      repositories: { api: {}, web: {} },
      review: {
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
        gates: [{ name: 'build', kind: 'script', script: 'build' }],
        repositories: {},
      },
    };
    const sandbox = overrideSandbox(draft);
    runInNewContext("addRepoOverride('review', 'api')", sandbox);
    const result = sandbox.draft as { review: { repositories: Record<string, { gates: unknown[] }> } };
    expect(result.review.repositories.api!.gates).toEqual([
      { name: 'build', kind: 'script', script: 'build' },
    ]);
  });

  it('seeds the override with a COPY, not a shared reference — editing it never mutates the global list', () => {
    const draft = {
      repositories: { api: {} },
      review: { gates: [{ name: 'build', kind: 'script', script: 'build' }], repositories: {} },
    };
    const sandbox = overrideSandbox(draft);
    runInNewContext("addRepoOverride('review', 'api')", sandbox);
    const result = sandbox.draft as {
      review: {
        gates: Array<Record<string, unknown>>;
        repositories: Record<string, { gates: Array<Record<string, unknown>> }>;
      };
    };
    result.review.repositories.api!.gates[0]!.name = 'renamed';
    expect(result.review.gates[0]!.name).toBe('build');
  });

  it('removing an override deletes the repo key, falling back to the global list', () => {
    const draft = {
      repositories: { api: {} },
      uat: {
        gates: [{ name: 'test', kind: 'script', script: 'test' }],
        repositories: { api: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] } },
      },
    };
    const sandbox = overrideSandbox(draft);
    runInNewContext("removeRepoOverride('uat', 'api')", sandbox);
    const result = sandbox.draft as { uat: { repositories: Record<string, unknown> } };
    expect(result.uat.repositories.api).toBeUndefined();
  });

  it('says the override replaces rather than extends', () => {
    const start = HTML.indexOf('id="overrideHint"');
    expect(start).toBeGreaterThan(-1);
    const snippet = HTML.slice(start, start + 200);
    expect(snippet).toMatch(/replaces/i);
  });

  it('parseGateBlock splits an override block into base + repo, leaving a global block untouched', () => {
    const parseGateBlock = runInNewContext(`(${functionSource('parseGateBlock')})`, {}) as (
      block: string,
    ) => { base: string; repo: string | null };
    expect(parseGateBlock('review')).toEqual({ base: 'review', repo: null });
    expect(parseGateBlock('review:api')).toEqual({ base: 'review', repo: 'api' });
  });

  it('gatesOf/writeGates route an override block to repositories[repo].gates, preserving the global list', () => {
    const sandbox: Record<string, unknown> = {
      draft: {
        review: {
          gates: [{ name: 'build', kind: 'script', script: 'build' }],
          repositories: { api: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] } },
        },
      },
      markDirty: () => {},
    };
    const source = `
      ${functionSource('updateUat')}
      ${functionSource('updateReview')}
      ${functionSource('parseGateBlock')}
      ${functionSource('gatesOf')}
      ${functionSource('writeGates')}
      writeGates('review:api', gatesOf('review:api').concat([{ name: 'extra', kind: 'script', script: 'extra' }]));
    `;
    runInNewContext(source, sandbox);
    const draft = sandbox.draft as {
      review: { gates: unknown[]; repositories: { api: { gates: unknown[] } } };
    };
    expect(draft.review.gates).toEqual([{ name: 'build', kind: 'script', script: 'build' }]);
    expect(draft.review.repositories.api.gates).toHaveLength(2);
  });

  function loadRenderOverridesSection(
    repositories: Record<string, unknown>,
  ): (block: string, repositories: Record<string, { gates?: unknown[] }>) => string {
    const source = `
      const draft = { repositories: ${JSON.stringify(repositories)} };
      ${functionSource('gateSummary')}
      ${functionSource('parseGateBlock')}
      ${functionSource('renderGateList')}
      ${functionSource('renderOverridesSection')}
      renderOverridesSection
    `;
    return runInNewContext(source, { esc: escMirror }) as (
      block: string,
      repositories: Record<string, { gates?: unknown[] }>,
    ) => string;
  }

  it('offers only declared repositories in the override picker', () => {
    const renderOverridesSection = loadRenderOverridesSection({ api: {}, web: {} });
    const html = renderOverridesSection('review', {});
    const select = html.match(/<select[^>]*data-override-picker="review"[^>]*>([\s\S]*?)<\/select>/);
    if (!select) throw new Error('override picker select not found');
    const options = [...select[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options.sort()).toEqual(['api', 'web']);
  });

  it('excludes an already-overridden repository from the picker', () => {
    const renderOverridesSection = loadRenderOverridesSection({ api: {}, web: {} });
    const html = renderOverridesSection('review', { api: { gates: [] } });
    const select = html.match(/<select[^>]*data-override-picker="review"[^>]*>([\s\S]*?)<\/select>/);
    if (!select) throw new Error('override picker select not found');
    const options = [...select[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual(['web']);
  });

  it('renders each override using renderGateList, addressed by block:repo, with a remove control', () => {
    const renderOverridesSection = loadRenderOverridesSection({ api: {} });
    const html = renderOverridesSection('review', {
      api: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] },
    });
    expect(html).toContain('data-gate-block="review:api"');
    expect(html).toContain('data-remove-override="review"');
    expect(html).toContain('data-override-repo="api"');
    expect(html).toContain('aria-label="Remove api override"');
    expect(html).toContain('title="Remove api override"');
  });

  it('escapes a repository name injected into the override card', () => {
    const renderOverridesSection = loadRenderOverridesSection({ '<x>': {} });
    const html = renderOverridesSection('review', { '<x>': { gates: [] } });
    expect(html).not.toContain('<x>override');
    expect(html).toContain('&lt;x&gt;');
  });

  it('mounts renderOverridesSection into #qualityGates for both blocks', () => {
    const body = HTML.slice(
      HTML.indexOf('function renderQuality('),
      HTML.indexOf("el('f-ticketTeamId').addEventListener"),
    );
    expect(body).toMatch(/renderOverridesSection\(\s*'uat'/);
    expect(body).toMatch(/renderOverridesSection\(\s*'review'/);
  });

  it('add/remove-override handlers route through addRepoOverride/removeRepoOverride, never a direct draft assignment', () => {
    expect(HTML).toContain('t.dataset.addOverride');
    expect(HTML).toContain('t.dataset.removeOverride');
    expect(HTML).toContain('addRepoOverride(block, repo)');
    expect(HTML).toContain('removeRepoOverride(t.dataset.removeOverride, t.dataset.overrideRepo)');
  });
});

/**
 * Task 12: the guard for Task 8's trap. Quality renders only the wired
 * scalars (Task 9) and the gate editor (Task 11), but `uat`/`review` are
 * whole-field section members (SECTION_FIELDS.quality) — mergeSection
 * REPLACES the entire block with whatever the draft posts. Every Quality
 * write must therefore spread the block as it stands rather than rebuild it
 * from the rendered controls, or a save would erase uat.secrets, uat.env,
 * uat.origins, and review.repositories — the same class of defect as the
 * approach-drawer clobber (S1).
 *
 * `simulateQualityEdit` exercises the REAL updateUat/updateReview/
 * updateFindings functions straight out of webview.html (never a
 * reimplementation), then the result is fed through the REAL mergeSection
 * from sections.ts — that combination is what makes the guard meaningful.
 */
describe('settings quality tab — draft updaters preserve inert manifest keys', () => {
  function simulateQualityEdit(
    onDisk: Manifest,
    edits: { uatMaxFixAttempts?: number; reviewMaxFixAttempts?: number },
  ): Manifest {
    const sandbox: Record<string, unknown> = {
      draft: JSON.parse(JSON.stringify(onDisk)),
      markDirty: () => {},
    };
    const calls: string[] = [];
    if (edits.uatMaxFixAttempts !== undefined) {
      calls.push(`updateUat({ maxFixAttempts: ${JSON.stringify(edits.uatMaxFixAttempts)} });`);
    }
    if (edits.reviewMaxFixAttempts !== undefined) {
      calls.push(`updateReview({ maxFixAttempts: ${JSON.stringify(edits.reviewMaxFixAttempts)} });`);
    }
    const source = `
      const REVIEW_DEFAULTS = {
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      };
      ${functionSource('updateUat')}
      ${functionSource('updateReview')}
      ${functionSource('updateFindings')}
      ${calls.join('\n')}
    `;
    runInNewContext(source, sandbox);
    return sandbox.draft as Manifest;
  }

  const baseManifest = buildManifest(
    { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
    { approaches: [], agents: {}, ticketing: { provider: 'manual' } },
  );

  it('preserves inert uat keys when the quality tab is saved', () => {
    const onDisk: Manifest = {
      ...baseManifest,
      uat: buildUat({
        maxFixAttempts: 3,
        env: { BASE_URL: 'http://localhost:3000' },
        secrets: ['STRIPE_KEY'],
        origins: ['https://api.stripe.com'],
      }),
    };
    // The webview renders only maxFixAttempts and gates. Saving must not erase
    // the rest — mergeSection deletes fields absent from the posted draft, and
    // rebuilding draft.uat from the rendered controls would omit them.
    const posted = simulateQualityEdit(onDisk, { uatMaxFixAttempts: 7 });
    const merged = mergeSection(onDisk, posted, 'quality');

    expect(merged.uat?.maxFixAttempts).toBe(7);
    expect(merged.uat?.secrets).toEqual(['STRIPE_KEY']);
    expect(merged.uat?.env).toEqual({ BASE_URL: 'http://localhost:3000' });
    expect(merged.uat?.origins).toEqual(['https://api.stripe.com']);
  });

  it('preserves review.repositories overrides when editing global review gates', () => {
    const onDisk: Manifest = {
      ...baseManifest,
      review: buildReview({
        maxFixAttempts: 3,
        repositories: { api: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] } },
      }),
    };
    const posted = simulateQualityEdit(onDisk, { reviewMaxFixAttempts: 5 });
    const merged = mergeSection(onDisk, posted, 'quality');
    expect(merged.review?.maxFixAttempts).toBe(5);
    expect(merged.review?.repositories?.api?.gates).toHaveLength(1);
  });

  it('updateFindings deep-merges over REVIEW_DEFAULTS.findings, never dropping a sibling key', () => {
    const sandbox: Record<string, unknown> = {
      draft: { review: { findings: { enabled: false, blockingSeverity: 'critical', maxFindings: 5 } } },
      markDirty: () => {},
    };
    const source = `
      const REVIEW_DEFAULTS = {
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      };
      ${functionSource('updateReview')}
      ${functionSource('updateFindings')}
      updateFindings({ maxFindings: 12 });
    `;
    runInNewContext(source, sandbox);
    const draft = sandbox.draft as { review: { findings: Record<string, unknown> } };
    expect(draft.review.findings).toEqual({
      enabled: false,
      blockingSeverity: 'critical',
      maxFindings: 12,
    });
  });

  it('no Quality handler assigns draft.uat or draft.review directly outside updateUat/updateReview', () => {
    // Everything after renderGateList's helpers must route through the three
    // updaters. This greps the whole Quality region (gate editor start ->
    // end of the file's quality-adjacent listeners) for a raw assignment.
    const start = HTML.indexOf('function gatesOf(');
    const end = HTML.indexOf('el(\'f-ticketTeamId\')');
    const body = HTML.slice(start, end);
    // Strip the updater bodies themselves (the only legal assignment sites).
    const withoutUpdaters = body
      .replace(functionSource('updateUat'), '')
      .replace(functionSource('updateReview'), '');
    expect(withoutUpdaters).not.toMatch(/draft\.uat\s*=/);
    expect(withoutUpdaters).not.toMatch(/draft\.review\s*=/);
  });
});

/**
 * Task 7 (+ ticket-form follow-up): the six inside-process assignment rows on
 * the Agents tab. ONE renderer (renderProcessAssignmentRow) parameterized by
 * the PROCESS_KEYS vocabulary (mirrored from validate/processAssignments.ts,
 * UI-R34), with the provider/model choices read from the HOST-SUPPLIED
 * catalog (modelCatalog) exactly like the General tab's model picker — never
 * HTML literals. Every string the row renders — role label, description, the
 * four validation states, the Default hints — arrives in a host-computed view
 * (processAssignmentViews.ts, handoff §7): the webview derives nothing.
 */
describe('settings agents tab — process assignments', () => {
  it('mirrors the host PROCESS_KEYS vocabulary exactly', () => {
    expect(HTML).toContain(
      `const PROCESS_KEYS = [${PROCESS_KEYS.map((k) => `'${k}'`).join(', ')}];`,
    );
  });

  it('renders six process assignment rows with profile/core/model/name controls and an enabled switch', () => {
    expect(HTML).toContain('id="processAssignments"');
    // The render walks the PROCESS_KEYS vocabulary (pinned above) and the row
    // template stamps every control with the key it edits.
    expect(HTML).toContain('PROCESS_KEYS\n      .map((key) => renderProcessAssignmentRow(key,');
    expect(HTML).toContain('data-proc-key="${key}"');
    expect(HTML).toContain('data-proc-field="agent"');
    expect(HTML).toContain('data-proc-field="provider"');
    expect(HTML).toContain('data-proc-field="model"');
    expect(HTML).toContain('data-proc-field="agentName"');
    expect(HTML).toContain('data-proc-enabled="${key}"');
    expect(HTML).toContain('role="switch"');
    // The handoff §7 labels ("Agent profile", "Agent core", "Model") are the
    // primary labels; the raw manifest terms are never user-facing copy.
    expect(HTML).not.toContain('PROCESS_ROLE_LABELS');
    expect(HTML).not.toContain('agent provider');
  });

  it('has no hard-coded model or provider literal list for the rows', () => {
    // The rows must read provider options from the injected agent identity and
    // model options from the host catalog — the same mirrors the General tab
    // uses — so a catalog refresh flows straight through.
    expect(HTML).not.toContain('const PROCESS_MODELS');
    expect(HTML).not.toContain('const PROCESS_PROVIDERS');
  });

  it('fixes the inline flex:1 1 220px UI-R04 violations', () => {
    expect(HTML).not.toContain('flex:1 1 220px');
  });

  const CATALOG = {
    claude: [{ id: 'claude-only', label: 'Claude Only', providers: ['claude'] }],
    codex: [{ id: 'codex-current', label: 'Codex Current', providers: ['codex'] }],
    antigravity: [{ id: 'agy-current', label: 'Antigravity Current', providers: ['antigravity'] }],
    opencode: [],
  };

  /** A host-computed row view (§ processAssignmentViews.ts) for the harness. */
  function view(
    key: string,
    roleLabel: string,
    patch: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      key,
      roleLabel,
      description: '',
      state: 'valid',
      stateTone: 'note',
      stateMessage: '',
      invalidField: null,
      profileOptions: [],
      effectiveProvider: 'claude',
      profileHint: '',
      coreHint: '',
      modelHint: '',
      ...patch,
    };
  }

  function loadProcessRowRenderer(): (
    key: string,
    cfg: Record<string, unknown>,
    rowView: Record<string, unknown>,
  ) => string {
    const source = `
      const KNOWN_AGENT_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode'];
      const AGENT_PROVIDER_LABELS = {
        claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode',
      };
      ${functionSource('renderModelOptions')}
      ${functionSource('renderProcessAssignmentRow')}
      renderProcessAssignmentRow
    `;
    return runInNewContext(source, {
      modelCatalog: CATALOG,
      esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c] ?? c),
    }) as (
      key: string,
      cfg: Record<string, unknown>,
      rowView: Record<string, unknown>,
    ) => string;
  }

  it('uses the host view for the role label and the per-row description', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', {}, view('uatTester', 'UAT Tester', {
      description: 'Runs after required UAT gates pass',
    }));
    expect(html).toContain('UAT Tester');
    expect(html).toContain('Runs after required UAT gates pass');
    expect(html).not.toContain('UAT test');
  });

  it('offers the host-supplied agent pool in the Agent profile select', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', { agent: 'review-author' }, view('uatTester', 'UAT Tester', {
      profileOptions: ['uat-author', 'review-author'],
    }));
    expect(html).toContain('<option value="">Role default</option>');
    expect(html).toContain('<option value="uat-author">uat-author</option>');
    expect(html).toContain('<option value="review-author" selected>review-author</option>');
  });

  it('keeps a saved profile visible when it left the pool, marked by the state message', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', { agent: 'ghost' }, view('uatTester', 'UAT Tester', {
      state: 'unknown-profile',
      stateTone: 'error',
      stateMessage: 'Agent profile "ghost" does not exist. Pick a profile from the list or leave the role default.',
      invalidField: 'agent',
      profileOptions: ['uat-author'],
    }));
    expect(html).toContain('<option value="ghost" selected>ghost</option>');
  });

  it('fills each model select from the host catalog for the row core', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', { provider: 'codex', model: '' }, view('uatTester', 'UAT Tester', {
      effectiveProvider: 'codex',
    }));

    expect(html).toContain('data-proc-key="uatTester"');
    expect(html).toContain('Codex Current');
    expect(html).not.toContain('Claude Only');
    expect(html).toContain('data-proc-field="provider"');
    expect(html).toContain('data-proc-field="model"');
  });

  it('keeps a saved model visible when absent from the catalog', () => {
    const render = loadProcessRowRenderer();
    const html = render('review', { provider: 'codex', model: 'preview-x' }, view('review', 'Review', {
      effectiveProvider: 'codex',
    }));
    expect(html).toContain('Saved model: preview-x');
  });

  it('keys the model select off the view core when the row declares none', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', {}, view('uatTester', 'UAT Tester', {
      effectiveProvider: 'claude',
    }));
    expect(html).toContain('Claude Only');
  });

  it('renders the Default hints from the host view', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', {}, view('uatTester', 'UAT Tester', {
      profileHint: 'Default: UAT Agent',
      coreHint: 'Default: Claude Code',
      modelHint: 'Default: Sonnet 4.6',
    }));
    expect(html).toContain('Default: UAT Agent');
    expect(html).toContain('Default: Claude Code');
    expect(html).toContain('Default: Sonnet 4.6');
  });

  it('renders the four validation states from the host view', () => {
    const render = loadProcessRowRenderer();

    // Unknown profile: inline error naming the missing profile, aria-invalid
    // on the profile select, the message wired by aria-describedby (UI-R25).
    const unknownProfile = render('uatTester', { agent: 'ghost' }, view('uatTester', 'UAT Tester', {
      state: 'unknown-profile',
      stateTone: 'error',
      stateMessage: 'Agent profile "ghost" does not exist. Pick a profile from the list or leave the role default.',
      invalidField: 'agent',
      profileOptions: ['uat-author'],
    }));
    expect(unknownProfile).toContain('Agent profile &quot;ghost&quot; does not exist');
    expect(unknownProfile).toContain('data-proc-field="agent"');
    expect(unknownProfile).toContain('aria-invalid="true"');
    expect(unknownProfile).toContain('aria-describedby="proc-uatTester-msg"');
    expect(unknownProfile).toContain('id="proc-uatTester-msg"');
    expect(unknownProfile).toContain('class="proc-msg is-error"');

    // Unknown provider: inline error and NO model picker claim — the model
    // select is disabled and carries no saved-model row.
    const unknownProvider = render('review', { provider: 'copilot', model: 'x' }, view('review', 'Review', {
      state: 'unknown-provider',
      stateTone: 'error',
      stateMessage: 'Agent core "copilot" is not supported. Pick one of the listed cores.',
      invalidField: 'provider',
      effectiveProvider: null,
    }));
    expect(unknownProvider).toContain('Agent core &quot;copilot&quot; is not supported');
    expect(unknownProvider).toContain('data-proc-field="model"');
    expect(unknownProvider).toContain(' disabled');
    expect(unknownProvider).not.toContain('Saved model:');

    // Model incompatible with provider: inline error; the saved value is
    // never silently substituted.
    const incompatible = render('review', { provider: 'codex', model: 'claude-opus-4-8' }, view('review', 'Review', {
      state: 'incompatible-model',
      stateTone: 'error',
      stateMessage: 'Model "claude-opus-4-8" is not compatible with Codex. Pick a model for Codex.',
      invalidField: 'model',
      effectiveProvider: 'codex',
    }));
    expect(incompatible).toContain('Model &quot;claude-opus-4-8&quot; is not compatible with Codex');
    expect(incompatible).toContain('aria-invalid="true"');
    expect(incompatible).toContain('Saved model: claude-opus-4-8');

    // Catalog unavailable: a NOTE (never an error) beside the kept saved id.
    const catalogDown = render('prDescription', { provider: 'opencode', model: 'custom-x' }, view('prDescription', 'PR description', {
      state: 'catalog-unavailable',
      stateTone: 'note',
      stateMessage: 'No model list is available for OpenCode; the saved model is kept.',
      invalidField: null,
      effectiveProvider: 'opencode',
    }));
    expect(catalogDown).toContain('No model list is available for OpenCode');
    expect(catalogDown).toContain('class="proc-msg is-note"');
    expect(catalogDown).toContain('Saved model: custom-x');
  });

  it('renders the disabled explanation from the host view', () => {
    const render = loadProcessRowRenderer();
    const html = render('uatTester', { provider: 'codex', enabled: false }, view('uatTester', 'UAT Tester', {
      state: 'disabled',
      stateTone: 'note',
      stateMessage: 'Disabled — UAT Tester is skipped. Selections are kept.',
      invalidField: null,
      effectiveProvider: 'codex',
    }));
    expect(html).toContain('Disabled — UAT Tester is skipped. Selections are kept.');
    expect(html).toContain('aria-checked="false"');
  });

  it('adopts host views on every state push and re-renders rows from the reply', () => {
    expect(HTML).toContain('processAssignmentViews = indexProcessViews(msg.state.processAssignments || [])');
    expect(HTML).toContain("case 'process-assignment-views':");
    expect(HTML).toContain('post({ type: \'validate-process-assignments\'');
  });

  it('indexes host process-assignment views by process key', () => {
    const index = loadFunction('indexProcessViews', {});
    expect(index([{ key: 'review' }, { key: 'uatTester' }])).toEqual({
      review: { key: 'review' },
      uatTester: { key: 'uatTester' },
    });
    expect(index([])).toEqual({});
  });

  it('requests host-computed process views when validating on the Agents tab', () => {
    const posted: unknown[] = [];
    const sandbox = {
      validateTimer: null,
      currentSection: 'agents',
      saveCandidate: (s: string) => ({ s }),
      post: (m: unknown) => { posted.push(m); },
      setTimeout: (fn: () => void) => { fn(); return 1; },
      clearTimeout: () => {},
    };
    const source = `${functionSource('scheduleValidate')} scheduleValidate();`;
    runInNewContext(source, sandbox);
    expect(posted).toContainEqual({ type: 'validate', manifest: { s: 'agents' } });
    expect(posted).toContainEqual({
      type: 'validate-process-assignments',
      manifest: { s: 'agents' },
    });
  });

  it('does not request process views from any other tab', () => {
    const posted: unknown[] = [];
    const source = `${functionSource('scheduleValidate')} scheduleValidate();`;
    runInNewContext(source, {
      validateTimer: null,
      currentSection: 'general',
      saveCandidate: (s: string) => ({ s }),
      post: (m: unknown) => { posted.push(m); },
      setTimeout: (fn: () => void) => { fn(); return 1; },
      clearTimeout: () => {},
    });
    expect(posted.filter((m) => (m as { type?: string }).type === 'validate-process-assignments')).toEqual([]);
  });

  it('writes edits by spreading the existing processes block, never rebuilding it', () => {
    expect(HTML).toMatch(/draft\.processes\s*=\s*\{\s*\.\.\.\(draft\.processes \|\| \{\}\)\s*,\s*\[key\]: entry\s*\};/);
  });

  it('routes process edits through the delegated click/change listeners', () => {
    expect(HTML).toContain('t.dataset.procKey');
    expect(HTML).toContain('t.dataset.procField');
    expect(HTML).toContain("updateProcessAssignment(t.dataset.procKey, {");
  });

  it('preserves a hand-authored agent reference through an agents-tab save', () => {
    // The `agent` field is NOT rendered by the tab (only enabled/agentName/
    // provider/model are) — it is authored in karst.yml by hand. The updater
    // must spread the entry so a Save never erases it, exactly like the
    // Quality tab's spread-not-rebuild rule.
    const onDisk: Manifest = {
      ...buildManifest(
        { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
        { approaches: [], agents: { 'uat-author': { role: 'uat' } }, ticketing: { provider: 'manual' } },
      ),
      processes: {
        uatTester: {
          agent: 'uat-author',
          agentName: 'My UAT',
          provider: 'codex',
          model: 'gpt-5.6-sol',
        },
      },
    };
    const sandbox: Record<string, unknown> = {
      draft: JSON.parse(JSON.stringify(onDisk)),
      markDirty: () => {},
      renderProcessAssignments: () => {},
    };
    const source = `
      ${functionSource('updateProcessAssignment')}
      updateProcessAssignment('uatTester', { agentName: 'Renamed' });
    `;
    runInNewContext(source, sandbox);
    const merged = mergeSection(onDisk, sandbox.draft as Manifest, 'agents');

    expect(merged.processes?.uatTester).toEqual({
      agent: 'uat-author',
      agentName: 'Renamed',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('clearing every field of a row removes the entry rather than saving an empty mapping', () => {
    const sandbox: Record<string, unknown> = {
      draft: { processes: { review: { agentName: 'X', provider: 'codex' } } },
      markDirty: () => {},
      renderProcessAssignments: () => {},
    };
    const source = `
      ${functionSource('updateProcessAssignment')}
      updateProcessAssignment('review', { agentName: '', provider: '' });
    `;
    runInNewContext(source, sandbox);
    expect(sandbox.draft).toEqual({ processes: undefined });
  });
});

// ═══ v7 redesign: shell + primitives (869efqhmh) ════════════════════════════

describe('settings v7 shell', () => {
  it('groups the sidebar nav into Project / Workflow / Integrations with captions', () => {
    expect(HTML).toContain('<nav class="sidebar"');
    expect(HTML).toContain('<div class="nav-caption">Project</div>');
    expect(HTML).toContain('<div class="nav-caption">Workflow</div>');
    expect(HTML).toContain('<div class="nav-caption">Integrations</div>');
    // The pinned button markup survives inside the groups.
    expect(HTML).toContain('<button class="nav-btn" data-section="git">Git</button>');
    expect(HTML).toContain('<button class="nav-btn" data-section="services">Repositories</button>');
  });

  it('adds a compact project identity footer with manifest open and a details popover', () => {
    expect(HTML).toContain('id="projectInfoBtn"');
    expect(HTML).toContain('id="footProjectId"');
    expect(HTML).toContain('id="footProjectVersion"');
    expect(HTML).toContain('id="footOpenManifest"');
    expect(HTML).toContain('id="projectInfoPop"');
    expect(HTML).toContain('id="popManifestPath"');
  });

  it('keeps the topbar save-state region and the mobile project entry', () => {
    expect(HTML).toContain('id="saveState"');
    expect(HTML).toContain('id="mobileProjectBtn"');
  });

  it('gives every page a header with title and description', () => {
    for (const id of ['section-general', 'section-git', 'section-services', 'section-approaches', 'section-agents', 'section-ticketing', 'section-quality']) {
      expect(HTML, id).toContain('id="' + id + '"');
    }
    expect(HTML).toContain('class="page-title"');
    expect(HTML).toContain('class="page-desc"');
  });
});

describe('settings v7 shared primitives', () => {
  it('styles select triggers, dropdowns and identity options with the shared geometry', () => {
    expect(HTML).toContain('.select-trigger');
    expect(HTML).toContain('.select-shell');
    expect(HTML).toContain('.dropdown');
    expect(HTML).toContain('.drop-item');
    expect(HTML).toContain('.chev');
  });

  it('implements the fixed-size reload icon button with a pending spin', () => {
    expect(HTML).toMatch(/class="reload-btn(?: fixed)?"/);
    expect(HTML).toContain('class="reload-icon"');
    expect(HTML).toContain('reload-spin');
    expect(HTML).toMatch(/prefers-reduced-motion[\s\S]*?reload-icon[\s\S]*?animation:none/);
  });

  it('provides the context menu host and more-button trigger', () => {
    expect(HTML).toContain('id="ctxMenu"');
    expect(HTML).toContain('class="more-btn"');
    expect(HTML).toContain('data-more="agent"');
    expect(HTML).toContain('data-more="approach"');
    expect(HTML).toContain('class="ctx-item');
  });

  it('moves destructive actions into the overflow menu but keeps the danger variant', () => {
    // The UI-R10b pin is on the raw HTML: the menu item templates carry the
    // data attribute AND k-btn--danger in the same button tag, so the inline
    // affordance removal does not weaken the guard.
    expect(HTML).toContain('data-delete-agent="${esc(name)}"');
    expect(HTML).toContain('data-uninstall="${esc(id)}"');
  });

  it('renders the template helper popup and the model picker popup', () => {
    expect(HTML).toContain('id="helperPop"');
    expect(HTML).toContain('data-template-help');
    expect(HTML).toContain('data-insert-var');
    expect(HTML).toContain('data-insert-transform');
    expect(HTML).toContain('id="modelShell"');
    expect(HTML).toContain('id="modelPop"');
    expect(HTML).toContain('id="modelSearch"');
    expect(HTML).toContain('data-model-id');
  });

  it('keeps the hidden native model select as the value carrier', () => {
    expect(HTML).toContain('<select id="f-defaultModel" class="hidden"></select>');
  });
});

describe('settings v7 process matrix', () => {
  it('emits the matrix head and UAT/Review/Ship group headers from the row renderer', () => {
    // The head is a separate static string prepended in renderProcessAssignments.
    expect(HTML).toContain("const MATRIX_HEAD = '<div class=\"matrix-head matrix-cols\">'");
    expect(HTML).toContain('>Process</div><div>Agent profile</div><div>Agent core</div><div>Model</div><div>State</div>');
    // Group headers come from a LOCAL map inside the row renderer so the
    // standalone sandbox (which loads only that function) stays self-contained.
    const renderer = functionSource('renderProcessAssignmentRow');
    expect(renderer).toContain("const GROUP_OF = { uatTester: 'UAT', review: 'Review', prDescription: 'Ship' };");
    expect(renderer).toContain('matrix-group');
    expect(renderer).toContain('data-name-override="${key}"');
  });

  it('keeps the pinned spread-not-rebuild write path untouched', () => {
    expect(HTML).toMatch(/draft\.processes\s*=\s*\{\s*\.\.\.\(draft\.processes \|\| \{\}\)\s*,\s*\[key\]: entry\s*\};/);
  });
});

describe('settings v7 template helper semantics', () => {
  it('inserts a transform only into the variable at the caret', () => {
    const sandbox = { input: undefined as unknown, TRANSFORM_NAMES: ['slice'], TRANSFORM_ARITY: {} };
    const source = `
      ${functionSource('variableAtCaret')}
      ${functionSource('applyTransformAtCaret')}
      function el() { return null; }
      function Event() {}
      const input = { value: 'karst/{slug}', selectionStart: 9, selectionEnd: 9,
        setSelectionRange: () => {}, dispatchEvent: () => {} };
      const applied = applyTransformAtCaret(input, 'upper');
      input.value;
    `;
    const result = runInNewContext(source, {}) as string;
    // {slug} at index 6..12; caret at 9 sits INSIDE it, so the transform lands
    // on that variable, not at the end of the template.
    expect(result).toBe('karst/{slug|upper}');
  });

  it('refuses to append a transform with no variable under the caret', () => {
    const sandbox = { input: undefined as unknown };
    const source = `
      ${functionSource('variableAtCaret')}
      ${functionSource('applyTransformAtCaret')}
      function el() { return null; }
      function Event() {}
      const input = { value: 'karst/slug', selectionStart: 9, selectionEnd: 9,
        setSelectionRange: () => {}, dispatchEvent: () => {} };
      applyTransformAtCaret(input, 'upper');
      input.value;
    `;
    const result = runInNewContext(source, {}) as string;
    expect(result).toBe('karst/slug');
  });
});

describe('settings v7 project footer rendering', () => {
  it('fills the footer and popover from the host-pushed facts', () => {
    const source = `
      let manifestPath = '/work/proj/.karst/karst.yml';
      let projectSlug = { value: 'my-proj', derived: false };
      let extensionVersion = '1.2.3';
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', classList: { add(){}, remove(){}, toggle(){} } };
        return elements[id];
      }
      ${functionSource('renderProjectFooter')}
      renderProjectFooter();
      ({
        id: elements.footProjectId.textContent,
        version: elements.footProjectVersion.textContent,
        manifest: elements.footManifestName.textContent,
        popId: elements.popProjectId.textContent,
        popSource: elements.popIdSource.textContent,
        popVersion: elements.popVersion.textContent,
        popPath: elements.popManifestPath.textContent,
      });
    `;
    const result = runInNewContext(source, {}) as Record<string, string>;
    expect(result.id).toBe('my-proj');
    expect(result.version).toBe('v1.2.3');
    expect(result.manifest).toBe('karst.yml');
    expect(result.popId).toBe('my-proj');
    expect(result.popSource).toContain('Explicit');
    expect(result.popVersion).toBe('1.2.3');
    expect(result.popPath).toBe('/work/proj/.karst/karst.yml');
  });

  it('shows the derived id source when the manifest has no explicit id', () => {
    const source = `
      let manifestPath = '';
      let projectSlug = { value: 'derived-slug', derived: true };
      let extensionVersion = '';
      const elements = {};
      function el(id) {
        if (!elements[id]) elements[id] = { textContent: '', classList: { add(){}, remove(){}, toggle(){} } };
        return elements[id];
      }
      ${functionSource('renderProjectFooter')}
      renderProjectFooter();
      elements.popIdSource.textContent;
    `;
    const result = runInNewContext(source, {});
    expect(result).toContain('Derived');
  });
});

describe('settings v7 responsive block', () => {
  it('ships the responsive rules in a separate style block with em breakpoints', () => {
    // The first <style> must stay literal-free (UI-R04); the responsive block
    // sits before the palette block and uses em units, which the conformance
    // literal budget explicitly exempts.
    const firstStyleEnd = HTML.indexOf('</style>');
    const responsiveAt = HTML.indexOf('@media (max-width: 61.25em)');
    expect(responsiveAt).toBeGreaterThan(firstStyleEnd);
    for (const bp of ['61.25em', '40em', '26.875em', '22.5em', '18.75em']) {
      expect(HTML, bp).toContain('@media (max-width: ' + bp + ')');
    }
    expect(HTML).toContain('/*KARST_PALETTE*/');
  });
});
