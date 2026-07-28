import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

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
