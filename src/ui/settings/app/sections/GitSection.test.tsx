/**
 * COMPONENT-mode tests for the Git tab (NDL-126 §9.5).
 *
 * The load-bearing assertions here are the SPREAD rule (D1/D3): the tab owns one
 * manifest block, `conventions`, and rebuilds it from five controls, so a write
 * that dropped an unrendered key would silently DELETE configuration once the
 * host's `mergeSection` sees the field missing. Every write path — a keystroke, a
 * preset apply, the reset link — is checked for keeping the whole block.
 *
 * Also covered: the vocabulary is imported rather than mirrored (R-X1), the
 * pre-filled default PR description, the "clearing the last child clears the
 * parent" rule, and the preview's "unknown variable stays literal" behaviour.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { DEFAULT_PR_DESCRIPTION_TEMPLATE } from '../../../../workflow/conventionPresets.js';
import { TRANSFORM_NAMES } from '../../../../template/transforms.js';
import { GitSection } from './GitSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { CONVENTION_FALLBACKS } from './conventionPreview.js';

afterEach(cleanup);

/** A block with an inert key the tab does NOT render, plus the four templates. */
const INERT_BLOCK = {
  branchName: 'karst/{type}/{slug}',
  commitMessage: '{title}',
  pullRequestTitle: '{title}',
  pullRequestDescription: DEFAULT_PR_DESCRIPTION_TEMPLATE,
  inertKeyKarstNeverRenders: 'keep me',
};

function mountGit(state = FIXTURE_STATE_PUSH): {
  bridge: TestBridge;
  probe(): AppProbeShape;
} {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="git">
        <GitSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state }));
  return { bridge, probe: () => readProbe(view.baseElement) };
}

function conventions(probe: () => AppProbeShape): Record<string, unknown> {
  const draft = probe().draft as { conventions?: Record<string, unknown> };
  return draft.conventions ?? {};
}

describe('GitSection — the four template controls', () => {
  it('gives the page a header naming what the tab does not touch', () => {
    mountGit();
    expect(document.querySelector('#section-git')).not.toBeNull();
    expect(document.querySelector('.page-title')?.textContent).toBe('Git');
    expect(document.querySelector('.page-desc')?.textContent).toContain('Existing human-authored');
  });

  it('labels every control and wires a real help target (UI-R25)', () => {
    mountGit();
    for (const control of Array.from(
      document.querySelectorAll('#section-git input, #section-git select, #section-git textarea'),
    )) {
      const id = control.getAttribute('id');
      expect(id).toBeTruthy();
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
  });

  it('renders the PR description as a multiline control with the default pre-filled', () => {
    mountGit();
    const field = screen.getByLabelText('Pull request description template') as HTMLTextAreaElement;
    expect(field.tagName.toLowerCase()).toBe('textarea');
    expect(field.getAttribute('rows')).toBe('6');
    // The pre-fill is the point: the field must never claim an empty body when
    // ship will open a PR with the default one.
    expect(field.value).toBe(DEFAULT_PR_DESCRIPTION_TEMPLATE);
  });

  it('renders the other three templates empty when the manifest declares none', () => {
    mountGit();
    expect((screen.getByLabelText('Branch name template') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Commit message template') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Pull request title template') as HTMLInputElement).value).toBe('');
  });

  it('offers the imported ticket-type vocabulary, led by the default', () => {
    mountGit();
    const options = Array.from(
      (screen.getByLabelText('Default ticket type') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options[0]).toBe('');
    expect(options.slice(1)).toEqual([
      'feat',
      'fix',
      'refactor',
      'docs',
      'test',
      'chore',
      'perf',
      'ci',
      'build',
      'style',
      'revert',
    ]);
  });
});

describe('GitSection — the block is spread, never rebuilt (D1/D3)', () => {
  it('keeps an unrendered key when one template is edited', () => {
    const state = { ...FIXTURE_STATE_PUSH, manifest: { ...FIXTURE_STATE_PUSH.manifest, conventions: INERT_BLOCK } };
    const { probe } = mountGit(state);
    fireEvent.change(screen.getByLabelText('Branch name template'), {
      target: { value: 'karst/{key}-x' },
    });
    expect(conventions(probe)).toMatchObject({
      branchName: 'karst/{key}-x',
      commitMessage: '{title}',
      pullRequestTitle: '{title}',
      inertKeyKarstNeverRenders: 'keep me',
    });
  });

  it('keeps an unrendered key when the default type is edited', () => {
    const state = { ...FIXTURE_STATE_PUSH, manifest: { ...FIXTURE_STATE_PUSH.manifest, conventions: INERT_BLOCK } };
    const { probe } = mountGit(state);
    fireEvent.change(screen.getByLabelText('Default ticket type'), { target: { value: 'fix' } });
    expect(conventions(probe)).toMatchObject({
      defaultType: 'fix',
      branchName: 'karst/{type}/{slug}',
      inertKeyKarstNeverRenders: 'keep me',
    });
  });

  it('keeps an unrendered key when a preset is applied', () => {
    const state = { ...FIXTURE_STATE_PUSH, manifest: { ...FIXTURE_STATE_PUSH.manifest, conventions: INERT_BLOCK } };
    const { probe } = mountGit(state);
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    expect(conventions(probe)).toMatchObject({
      branchName: 'karst/{slug}',
      commitMessage: '{title}',
      pullRequestTitle: '{title}',
      inertKeyKarstNeverRenders: 'keep me',
    });
  });

  it('keeps an unrendered key when the reset link restores the default body', () => {
    const state = {
      ...FIXTURE_STATE_PUSH,
      manifest: {
        ...FIXTURE_STATE_PUSH.manifest,
        conventions: { ...INERT_BLOCK, pullRequestDescription: '{description}' },
      },
    };
    const { probe } = mountGit(state);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(conventions(probe)).toMatchObject({
      pullRequestDescription: DEFAULT_PR_DESCRIPTION_TEMPLATE,
      inertKeyKarstNeverRenders: 'keep me',
    });
  });

  it('does not write to disk when a preset is applied', () => {
    const { bridge, probe } = mountGit();
    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'ticket-prefixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply preset' }));
    expect(bridge.all('save')).toHaveLength(0);
    expect(probe().dirtySections).toEqual(['git']);
  });
});

describe('GitSection — clearing', () => {
  it('deletes just the cleared child', () => {
    const state = { ...FIXTURE_STATE_PUSH, manifest: { ...FIXTURE_STATE_PUSH.manifest, conventions: INERT_BLOCK } };
    const { probe } = mountGit(state);
    fireEvent.change(screen.getByLabelText('Branch name template'), { target: { value: '' } });
    expect(conventions(probe)).not.toHaveProperty('branchName');
    expect(conventions(probe)).toHaveProperty('commitMessage');
  });

  it('deletes the parent when its LAST child is cleared', () => {
    const { probe } = mountGit();
    for (const label of ['Commit message template', 'Pull request title template']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
    }
    fireEvent.change(screen.getByLabelText('Pull request description template'), {
      target: { value: '' },
    });
    expect(probe().draft).not.toHaveProperty('conventions');
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('GitSection — the vocabulary is imported, not mirrored (R-X1)', () => {
  it('offers exactly the branch vocabulary the host validates', () => {
    mountGit();
    const vars = document.querySelector('.template-meta')?.textContent ?? '';
    expect(vars).toContain('{type}');
    expect(vars).toContain('{slug}');
    // `{repo}` and `{scope}` are deliberately absent from a BRANCH template: two
    // repositories sharing a `repoPath` resolve to one worktree.
    expect(vars).not.toContain('{repo}');
  });

  it('offers the description vocabulary on the PR body only', () => {
    mountGit();
    const metas = Array.from(document.querySelectorAll('.template-meta')).map((n) => n.textContent ?? '');
    const description = metas.find((text) => text.includes('{description}'));
    expect(description).toBeTruthy();
    expect(description).toContain('{sessionId}');
    const commit = metas.find((text) => text.includes('{scope}') && !text.includes('{description}'));
    expect(commit).toBeTruthy();
    expect(commit).not.toContain('{sessionId}');
  });

  it('offers the imported transform names', () => {
    mountGit();
    const meta = document.querySelector('.template-meta')?.textContent ?? '';
    expect(meta).toContain('slice');
    expect(meta).toContain('truncate');
    expect(meta).toContain('{key|slice:-4}');
  });
});

describe('GitSection — the preview', () => {
  it('shows the fallback copy while a field is empty', () => {
    mountGit();
    const previews = Array.from(document.querySelectorAll('.lp-val')).map((n) => n.textContent);
    expect(previews).toContain(CONVENTION_FALLBACKS.commitMessage);
  });

  it('renders a template against the sample', () => {
    mountGit();
    fireEvent.change(screen.getByLabelText('Branch name template'), {
      target: { value: 'karst/{type}/{slug}' },
    });
    const preview = Array.from(document.querySelectorAll('.lp-val')).map((n) => n.textContent);
    expect(preview).toContain('karst/feat/proj-142-add-login');
  });

  it('applies transforms, and leaves an unknown variable LITERAL', () => {
    mountGit();
    fireEvent.change(screen.getByLabelText('Branch name template'), {
      target: { value: '{key|slice:-4}/{nope}' },
    });
    const preview = Array.from(document.querySelectorAll('.lp-val')).map((n) => n.textContent);
    // The known half renders; the unknown one stays visible so the user can see
    // WHICH variable is wrong, instead of a blank that hides it.
    expect(preview).toContain('-142/{nope}');
  });
});

describe('GitSection — the transform helper operates on the caret (R-X1)', () => {
  /** The Transforms help of one template row — the row's own transform list. */
  function transformButtons(meta: Element): string[] {
    const help = Array.from(meta.querySelectorAll('.k-field-help')).find((node) =>
      node.textContent?.startsWith('Transforms:'),
    );
    expect(help, 'a template row without a Transforms help block').toBeTruthy();
    return Array.from(help!.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');
  }

  it('lists exactly the host transform names', () => {
    mountGit();
    const metas = Array.from(document.querySelectorAll('.template-meta'));
    // Non-vacuity: four template rows, each with its own transform list.
    expect(metas).toHaveLength(4);
    for (const meta of metas) {
      // The list is the IMPORTED host vocabulary (R-X1), not a copy: rendering
      // drifts the moment `TRANSFORM_NAMES` changes.
      expect(transformButtons(meta)).toEqual([...TRANSFORM_NAMES]);
    }
  });

  it('clicking a transform with the caret inside a variable writes it through the field\'s onChange', async () => {
    const { probe } = mountGit();
    const field = screen.getByLabelText('Branch name template') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'karst/{slug}' } });
    // Caret at 9 sits INSIDE {slug} (6..12) — not at the end of the template.
    field.setSelectionRange(9, 9);
    const meta = field.closest('.k-field')!.querySelector('.template-meta') as Element;
    const upper = transformButtons(meta).find((name) => name === 'upper');
    expect(upper).toBe('upper');
    const button = Array.from(meta.querySelectorAll('button')).find(
      (b) => b.textContent === 'upper',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    expect(conventions(probe)).toMatchObject({ branchName: 'karst/{slug|upper}' });
    // The caret is re-applied after the write, just after the inserted chain
    // (index 17 — before the closing brace of `{slug|upper}`).
    await Promise.resolve();
    expect(field.selectionStart).toBe(17);
  });

  it('leaves the draft untouched when the caret is outside every variable', () => {
    const { probe } = mountGit();
    const field = screen.getByLabelText('Branch name template') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'karst/slug' } });
    field.setSelectionRange(9, 9);
    const meta = field.closest('.k-field')!.querySelector('.template-meta') as Element;
    const button = Array.from(meta.querySelectorAll('button')).find(
      (b) => b.textContent === 'upper',
    ) as HTMLButtonElement;
    fireEvent.click(button);
    // Vanilla refused the append: the value the user typed stays exactly as
    // it was — no `{slug|upper}`, no second write.
    expect(conventions(probe).branchName).toBe('karst/slug');
    expect(field.value).toBe('karst/slug');
  });
});

describe('GitSection — inline faults', () => {
  it('shows the whole message on the field it names, and marks it invalid', () => {
    const { bridge } = mountGit();
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: conventions.branchName must include {slug}, {key} or {id}',
      }),
    );
    const field = screen.getByLabelText('Branch name template') as HTMLInputElement;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('#section-git .k-field-error')?.textContent).toBe(
      'conventions.branchName must include {slug}, {key} or {id}',
    );
    const other = screen.getByLabelText('Commit message template') as HTMLInputElement;
    expect(other.getAttribute('aria-invalid')).toBeNull();
  });

  it('clears the inline fault when the verdict turns positive', () => {
    const { bridge } = mountGit();
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: conventions.commitMessage template must not be blank',
      }),
    );
    expect((screen.getByLabelText('Commit message template') as HTMLInputElement).getAttribute('aria-invalid'))
      .toBe('true');
    act(() => bridge.push({ type: 'validation', ok: true, error: null }));
    expect((screen.getByLabelText('Commit message template') as HTMLInputElement).getAttribute('aria-invalid'))
      .toBeNull();
  });

  it('wires no inline error line for conventions.defaultType', () => {
    const { bridge } = mountGit();
    act(() =>
      bridge.push({
        type: 'validation',
        ok: false,
        error: 'Invalid karst.yml: conventions.defaultType must be a curated type',
      }),
    );
    expect(
      (screen.getByLabelText('Default ticket type') as HTMLSelectElement).getAttribute('aria-invalid'),
    ).toBeNull();
  });
});
