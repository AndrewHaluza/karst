import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

/**
 * Text-level guards on the onboarding webview (§ manual ticket creation, §
 * fetch-on-Enter). Standalone HTML with no test harness — same rationale as
 * dashboard/webview.test.ts: every DECISION here is host-agnostic script logic
 * that these regex checks can pin, even though nothing actually renders a DOM.
 */
describe('onboarding webview.html', () => {
  it('gates Phase 2 on title alone for a manual ticket — key is optional', () => {
    // The literal bug: phase1Valid() used to require el('ref').value
    // unconditionally, hard-blocking a keyless manual ticket from ever seeing
    // its own submit button. Manual must now short-circuit on title alone.
    const fnMatch = HTML.match(/function phase1Valid\(\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'phase1Valid() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("currentProvider === 'manual'");
    expect(body).toMatch(/return hasTitle/);
  });

  it('tracks the current provider so phase1Valid and the submit/save guards can read it', () => {
    expect(HTML).toContain('let currentProvider');
    expect(HTML).toContain('currentProvider = p;'); // set from renderProvider(state.provider)
  });

  it('does not require a key on submit/save when the provider is manual', () => {
    // Both handlers must branch on currentProvider !== 'manual' rather than a
    // bare `!key` check, or a manual ticket is blocked again at the last step.
    const submitBlock = HTML.slice(HTML.indexOf("el('submitBtn').addEventListener"));
    const saveBlock = HTML.slice(HTML.indexOf("el('saveBtn').addEventListener"));
    for (const block of [submitBlock, saveBlock]) {
      expect(block.slice(0, 600)).toContain("currentProvider !== 'manual' && !key");
    }
  });

  it('fires the same fetch action on Enter in the key field as on the Fetch button click', () => {
    expect(HTML).toContain("el('fetchBtn').addEventListener('click', doFetch)");
    const refKeydown = HTML.match(/el\('ref'\)\.addEventListener\('keydown', \(e\) => {([\s\S]*?)}\);/);
    expect(refKeydown, "ref keydown listener not found").toBeTruthy();
    expect(refKeydown![1]).toContain("e.key !== 'Enter'");
    expect(refKeydown![1]).toContain('doFetch()');
  });

  it('the analyzer result badges the approach but never moves the pick', () => {
    // The AI approach is a suggestion: it sets aiSuggestion (the row badge) but
    // must NOT assign draft.approach, or an AI pick silently replaces the user's
    // explicit selection — which then gets persisted on the next save. The user's
    // selection is authoritative. See ticket 869e889uh.
    const caseMatch = HTML.match(/case 'analysis': {([\s\S]*?)\n {6}}/);
    expect(caseMatch, "analysis message handler not found").toBeTruthy();
    const body = caseMatch![1]!;
    expect(body).toContain('aiSuggestion =');
    expect(body).not.toMatch(/draft\.approach\s*=/);
  });

  it('doFetch is a no-op when the fetch button is hidden or already busy/done', () => {
    const fnMatch = HTML.match(/function doFetch\(\)\s*{([\s\S]*?)\n {2}}/);
    expect(fnMatch, 'doFetch() not found').toBeTruthy();
    const body = fnMatch![1]!;
    expect(body).toContain("classList.contains('hidden')");
    expect(body).toContain('disabled');
  });
});
