/**
 * COMPONENT-mode tests for the Quality tab (NDL-126 §9.5).
 *
 * The tab CLAIMS both blocks and renders a fraction of them, so the assertions
 * that matter are about what the tab does NOT touch: `uat.env`, `uat.secrets`,
 * `uat.origins`, `review.author`, and a `findings` sibling the user did not edit
 * all have to survive every write path. That is the D1/D3 guard, at component
 * level.
 *
 * Also covered: the defaults the tab SHOWS must be the ones the validator
 * applies (R-X1), the toggle that removes a block by presence rather than by a
 * `false`, the guarded severity listener, the override copy semantics, and the
 * destructive taxonomy on the two remove controls.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REVIEW_FINDINGS_DEFAULTS,
  REVIEW_MAX_FIX_ATTEMPTS,
  UAT_MAX_FIX_ATTEMPTS,
  UAT_TESTER_BLOCKING_SEVERITY,
} from '../../../../manifest/qualityDefaults.js';
import type { Manifest, ReviewConfig, UatConfig } from '../../../../manifest/types.js';
import type { SettingsState } from '../../state.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { runnableRepo } from '../../../../manifest/fixtures.js';
import { FIXTURE_MANIFEST, FIXTURE_STATE_PUSH } from '../testFixtures.js';

/** Two declared repositories, so the override editor has something to offer. */
const REPOS: NonNullable<Manifest['repositories']> = {
  backend: runnableRepo({}),
  frontend: { ...runnableRepo({}), repoPath: '../frontend' },
};
import { QualitySection } from './QualitySection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

afterEach(cleanup);

/** Inert keys on both blocks: config the tab never renders and must not lose. */
const INERT: Record<string, unknown> = {
  env: { BASE_URL: 'https://example.test' },
  secrets: ['STRIPE_KEY'],
  origins: ['https://api.stripe.com'],
  author: { name: 'team' },
};

/**
 * A `state` push carrying a manifest whose `uat` / `review` blocks are PARTIAL.
 *
 * That is what a hand-edited or validator-defaulted draft looks like, and it is
 * the case the tab's spread rule exists for — the blocks a manifest omits are
 * filled by the host validator at save time, so the tab must never assume they
 * are complete. `Manifest` types them as the validator's output, hence the one
 * documented cast.
 */
const partialUat = (blocks: Record<string, unknown>): UatConfig =>
  blocks as unknown as UatConfig;

const partialReview = (blocks: Record<string, unknown>): ReviewConfig =>
  blocks as unknown as ReviewConfig;

function stateWith(blocks: Partial<Manifest>): SettingsState {
  return {
    ...FIXTURE_STATE_PUSH,
    manifest: { ...FIXTURE_STATE_PUSH.manifest, ...blocks },
  };
}

function mountQuality(state: SettingsState = FIXTURE_STATE_PUSH): {
  bridge: TestBridge;
  probe(): AppProbeShape;
} {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="quality">
        <QualitySection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state }));
  return { bridge, probe: () => readProbe(view.baseElement) };
}

const uatOf = (probe: () => AppProbeShape): Record<string, unknown> =>
  (probe().draft as { uat?: Record<string, unknown> }).uat ?? {};
const reviewOf = (probe: () => AppProbeShape): Record<string, unknown> =>
  (probe().draft as { review?: Record<string, unknown> }).review ?? {};

const field = (name: string): HTMLInputElement =>
  document.querySelector(`[name="${name}"]`) as HTMLInputElement;

/** The control whose `<label for>` reads exactly `label` (UI-R25 pairing). */
function byLabel(label: string): HTMLInputElement {
  return byLabelIn(document, label) as HTMLInputElement;
}

function byLabelIn(scope: ParentNode, label: string): Element {
  const control = [...scope.querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no control labelled ${label}`);
  return control;
}

describe('QualitySection — the defaults it shows are the defaults ship applies', () => {
  it('shows the validator defaults for both blocks when the manifest declares none', () => {
    mountQuality();
    expect(field('uatMaxFixAttempts').value).toBe(String(UAT_MAX_FIX_ATTEMPTS));
    expect(field('reviewMaxFixAttempts').value).toBe(String(REVIEW_MAX_FIX_ATTEMPTS));
    expect(field('reviewRequireIndependentSignal').checked).toBe(true);
    expect(field('reviewOpenChanges').checked).toBe(false);
    // Findings default ON / 'high' / 50, the human-decided blocking default.
    expect(field('reviewFindingsEnabled').checked).toBe(REVIEW_FINDINGS_DEFAULTS.enabled);
    expect(field('reviewFindingsSeverity').value).toBe(
      REVIEW_FINDINGS_DEFAULTS.blockingSeverity,
    );
    expect(field('reviewFindingsMax').value).toBe(String(REVIEW_FINDINGS_DEFAULTS.maxFindings));
  });

  it('reads the tester toggle from the block PRESENCE, not from a default', () => {
    mountQuality();
    // Absent block → off, even though `blockingSeverity` defaults to 'none'.
    expect(field('uatTesterEnabled').checked).toBe(false);
    expect(document.getElementById('uatTesterOptions')).toBeNull();
  });

  it('hydrates explicit values when the blocks are present', () => {
    mountQuality(
      stateWith({
        uat: partialUat({ maxFixAttempts: 5, testerObservations: { blockingSeverity: 'critical' } }),
        review: partialReview({
          maxFixAttempts: 2,
          requireIndependentSignal: false,
          openChanges: true,
          findings: { enabled: false, blockingSeverity: 'low', maxFindings: 10 },
        }),
      }),
    );
    expect(field('uatMaxFixAttempts').value).toBe('5');
    expect(field('uatTesterEnabled').checked).toBe(true);
    expect(field('uatTesterSeverity').value).toBe('critical');
    expect(field('reviewMaxFixAttempts').value).toBe('2');
    expect(field('reviewRequireIndependentSignal').checked).toBe(false);
    expect(field('reviewOpenChanges').checked).toBe(true);
    expect(field('reviewFindingsEnabled').checked).toBe(false);
    expect(field('reviewFindingsSeverity').value).toBe('low');
    expect(field('reviewFindingsMax').value).toBe('10');
  });

  it('offers the imported severity vocabulary plus the advisory none', () => {
    mountQuality();
    const options = Array.from(
      (document.querySelector('[name="reviewFindingsSeverity"]') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(['critical', 'high', 'medium', 'low', 'info', 'none']);
  });
});

describe('QualitySection — every write spreads the block (D1/D3)', () => {
  it('keeps inert uat keys when the max fix attempts changes', () => {
    const { probe } = mountQuality(stateWith({ uat: partialUat({ ...INERT, maxFixAttempts: 3 }) }));
    fireEvent.change(field('uatMaxFixAttempts'), { target: { value: '7' } });
    expect(uatOf(probe)).toMatchObject({
      maxFixAttempts: 7,
      env: INERT.env,
      secrets: INERT.secrets,
      origins: INERT.origins,
    });
  });

  it('keeps review siblings when one review field changes', () => {
    const { probe } = mountQuality(stateWith({ review: partialReview({ author: INERT.author, maxFixAttempts: 5 }) }));
    fireEvent.change(field('reviewOpenChanges'), { target: { value: '' } });
    fireEvent.click(field('reviewOpenChanges'));
    expect(reviewOf(probe)).toMatchObject({ author: INERT.author, maxFixAttempts: 5 });
  });

  it('never drops a findings sibling when one findings field is edited', () => {
    const { probe } = mountQuality(
      stateWith({
        review: partialReview({
          findings: { enabled: false, blockingSeverity: 'critical', maxFindings: 5 },
        }),
      }),
    );
    fireEvent.change(field('reviewFindingsMax'), { target: { value: '12' } });
    expect((reviewOf(probe).findings as Record<string, unknown>)).toEqual({
      enabled: false,
      blockingSeverity: 'critical',
      maxFindings: 12,
    });
  });

  it('deep-merges findings over the defaults, never over the draft alone', () => {
    const { probe } = mountQuality();
    // The block is absent: patching one field must not write a findings block
    // with a single key, or the lane would stop blocking by default.
    fireEvent.change(field('reviewFindingsMax'), { target: { value: '12' } });
    expect(reviewOf(probe).findings).toEqual({
      enabled: REVIEW_FINDINGS_DEFAULTS.enabled,
      blockingSeverity: REVIEW_FINDINGS_DEFAULTS.blockingSeverity,
      maxFindings: 12,
    });
  });
});

describe('QualitySection — the tester toggle owns the block by presence', () => {
  it('removes the whole block when the toggle is switched off', () => {
    const { probe } = mountQuality(
      stateWith({ uat: partialUat({ ...INERT, testerObservations: { blockingSeverity: 'high' } }) }),
    );
    fireEvent.click(field('uatTesterEnabled'));
    expect(uatOf(probe)).not.toHaveProperty('testerObservations');
    // And the inert keys the toggle does not own are still there.
    expect(uatOf(probe)).toMatchObject({ env: INERT.env });
    expect(document.getElementById('uatTesterOptions')).toBeNull();
  });

  it('creates the block with the default severity when switched on', () => {
    const { probe } = mountQuality(stateWith({ uat: partialUat({ ...INERT }) }));
    fireEvent.click(field('uatTesterEnabled'));
    expect(uatOf(probe).testerObservations).toEqual({
      blockingSeverity: UAT_TESTER_BLOCKING_SEVERITY,
    });
    expect(field('uatTesterSeverity').value).toBe(UAT_TESTER_BLOCKING_SEVERITY);
  });

  it('writes the severity from the row it shows', () => {
    const { probe } = mountQuality(
      stateWith({ uat: partialUat({ ...INERT, testerObservations: { blockingSeverity: 'none' } }) }),
    );
    fireEvent.change(field('uatTesterSeverity'), { target: { value: 'high' } });
    expect(uatOf(probe).testerObservations).toEqual({ blockingSeverity: 'high' });
  });

  it('keeps the findings controls live when findings are off', () => {
    mountQuality();
    // Unlike the tester toggle, `f-findingsEnabled` hides nothing — the
    // severity and max rows stay usable so turning it back on is one click.
    expect(document.querySelector('[name="reviewFindingsSeverity"]')).not.toBeNull();
    expect(document.querySelector('[name="reviewFindingsMax"]')).not.toBeNull();
  });
});

describe('QualitySection — the gate editor', () => {
  const WITH_REPOS: SettingsState = {
    ...FIXTURE_STATE_PUSH,
    manifest: {
      ...FIXTURE_MANIFEST,
      repositories: REPOS,
    },
  };

  it('states the package.json fallback when a global list is empty', () => {
    mountQuality();
    const empties = Array.from(document.querySelectorAll('.gate-empty')).map((n) => n.textContent);
    expect(empties.some((text) => text?.includes('package.json'))).toBe(true);
    expect(empties.some((text) => text?.includes('Command'))).toBe(true);
  });

  it('states the global-list fallback when an override list is empty', () => {
    mountQuality({
      ...WITH_REPOS,
      manifest: {
        ...WITH_REPOS.manifest,
        uat: partialUat({ repositories: { backend: { gates: [] } } }),
      },
    });
    const empties = Array.from(document.querySelectorAll('.gate-empty')).map((n) => n.textContent);
    expect(empties.some((text) => text?.includes('runs the global list'))).toBe(true);
  });

  it('renders a script gate with only the script field, and a command gate with args', () => {
    mountQuality();
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add gate' })[0] as Element);
    expect(byLabel('Gate 1 name')).toBeTruthy();
    expect(byLabel('Gate 1 kind')).toBeTruthy();
    expect(byLabel('Gate 1 script')).toBeTruthy();
    // A script gate has no command/arguments row at all.
    expect(() => byLabel('Gate 1 command')).toThrow();
    fireEvent.change(byLabel('Gate 1 kind'), { target: { value: 'command' } });
    // Switching kind REPLACES the script row with the command + args pair.
    expect(() => byLabel('Gate 1 script')).toThrow();
    expect(byLabel('Gate 1 command')).toBeTruthy();
    expect(byLabel('Gate 1 arguments')).toBeTruthy();
  });

  it('splits a gate arguments field on whitespace, and clears it to none', () => {
    const { probe } = mountQuality({
      ...WITH_REPOS,
      manifest: {
        ...WITH_REPOS.manifest,
        uat: partialUat({
          gates: [{ name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] }],
        }),
      },
    });
    expect((uatOf(probe).gates as Record<string, unknown>[])[0]).toMatchObject({
      args: ['playwright', 'test'],
    });
    fireEvent.change(byLabel('Gate 1 arguments'), { target: { value: '' } });
    expect((uatOf(probe).gates as Record<string, unknown>[])[0]).toMatchObject({ args: [] });
  });

  it('routes a gate edit to the global list and keeps inert siblings', () => {
    const { probe } = mountQuality({
      ...WITH_REPOS,
      manifest: {
        ...WITH_REPOS.manifest,
        uat: partialUat({ ...INERT, gates: [{ name: 'build', kind: 'script', script: 'build' }] }),
      },
    });
    fireEvent.change(byLabel('Gate 1 name'), { target: { value: 'verify' } });
    expect(uatOf(probe)).toMatchObject({ env: INERT.env, secrets: INERT.secrets });
    expect((uatOf(probe).gates as Record<string, unknown>[])[0]).toMatchObject({
      name: 'verify',
      kind: 'script',
      script: 'build',
    });
    expect(probe().dirtySections).toEqual(['quality']);
  });

  it('keys a gate row by the gate identity, never by its position (R-X5)', () => {
    mountQuality({
      ...WITH_REPOS,
      manifest: {
        ...WITH_REPOS.manifest,
        uat: partialUat({
          gates: [
            { name: 'build', kind: 'script', script: 'build' },
            { name: 'lint', kind: 'script', script: 'lint' },
          ],
        }),
      },
    });
    const rows = Array.from(document.querySelectorAll('.gate-row'));
    expect(rows).toHaveLength(2);
    // Removing the FIRST row must leave the second one's identity intact.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove gate 1' })[0] as Element);
    expect(byLabel('Gate 1 name').value).toBe('lint');
  });

  it('scopes a gate row to a declared repository only', () => {
    mountQuality(WITH_REPOS);
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add gate' })[0] as Element);
    const repoSelect = [...document.querySelectorAll('select')].find((sel) =>
      Array.from(sel.options).some((o) => o.value === 'backend'),
    ) as HTMLSelectElement;
    expect(Array.from(repoSelect.options).map((o) => o.value)).toEqual(['', 'backend', 'frontend']);
    expect(Array.from(repoSelect.options).map((o) => o.label)).toContain('every target');
  });

  it('names the owning repository as text on an override row, with no repo select', () => {
    mountQuality({
      ...WITH_REPOS,
      manifest: {
        ...WITH_REPOS.manifest,
        uat: partialUat({
          repositories: { backend: { gates: [{ name: 'g', kind: 'script', script: 's' }] } },
        }),
      },
    });
    const summaries = Array.from(document.querySelectorAll('.gate-summary')).map((n) => n.textContent);
    expect(summaries).toContain('Runs in backend');
  });
});

describe('QualitySection — per-repository overrides REPLACE the global list', () => {
  const TWO_REPOS: SettingsState = {
    ...FIXTURE_STATE_PUSH,
    manifest: {
      ...FIXTURE_MANIFEST,
      repositories: REPOS,
      uat: partialUat({ ...INERT, gates: [{ name: 'build', kind: 'script', script: 'build' }] }),
    },
  };

  it('says so beside the cards it explains', () => {
    mountQuality({
      ...TWO_REPOS,
      manifest: {
        ...TWO_REPOS.manifest,
        uat: partialUat({
          ...INERT,
          gates: TWO_REPOS.manifest.uat?.gates as never,
          repositories: { backend: { gates: [] } },
        }),
      },
    });
    const note = document.querySelector('.override-editor-note')?.textContent ?? '';
    expect(note).toContain('replaces');
  });

  it('shows no override editor at all when the manifest declares no repositories', () => {
    mountQuality({
      ...FIXTURE_STATE_PUSH,
      manifest: { ...FIXTURE_STATE_PUSH.manifest, repositories: {} },
    });
    expect(document.querySelector('.override-editor')).toBeNull();
  });

  it('offers only declared repositories, excluding an already-overridden one', () => {
    mountQuality({
      ...TWO_REPOS,
      manifest: {
        ...TWO_REPOS.manifest,
        uat: partialUat({
          ...INERT,
          gates: TWO_REPOS.manifest.uat?.gates as never,
          repositories: { backend: { gates: [] } },
        }),
      },
    });
    const picker = byLabel('Repository to override') as unknown as HTMLSelectElement;
    // `backend` is already overridden, so it is not offered again.
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['frontend']);
  });

  it('seeds a new override with a COPY of the global list, not a shared reference', () => {
    const { probe } = mountQuality(TWO_REPOS);
    fireEvent.change(byLabel('Repository to override'), { target: { value: 'backend' } });
    const gates = (uatOf(probe).gates ?? []) as Record<string, unknown>[];
    const repositories = uatOf(probe).repositories as Record<
      string,
      { gates?: Record<string, unknown>[] } | undefined
    >;
    expect(repositories.backend?.gates).toEqual(gates);
    expect(repositories.backend?.gates).not.toBe(gates);
    // Editing the OVERRIDE's copy must not reach the global list.
    const card = document.querySelector('.override-card') as HTMLElement;
    const overrideName = byLabelIn(card, 'Gate 1 name');
    fireEvent.change(overrideName, { target: { value: 'override-only' } });
    expect(uatOf(probe).gates).toEqual([{ name: 'build', kind: 'script', script: 'build' }]);
  });

  it('removes the override itself when its LAST gate is removed', () => {
    const { probe } = mountQuality({
      ...TWO_REPOS,
      manifest: {
        ...TWO_REPOS.manifest,
        uat: partialUat({
          gates: TWO_REPOS.manifest.uat?.gates as never,
          repositories: { backend: { gates: [{ name: 'only', kind: 'script', script: 'only' }] } },
        }),
      },
    });
    const card = document.querySelector('.override-card') as HTMLElement;
    fireEvent.click(card.querySelector('[data-karst-action="remove-gate"]') as Element);
    // The override would fall back to the global list, which is not what the
    // user asked for by deleting its only entry — so the override is removed.
    expect(uatOf(probe).repositories).toEqual({});
    expect(uatOf(probe).gates).toEqual([{ name: 'build', kind: 'script', script: 'build' }]);
  });

  it('falls back to the global list when the override is removed', () => {
    const { probe } = mountQuality({
      ...TWO_REPOS,
      manifest: {
        ...TWO_REPOS.manifest,
        uat: partialUat({
          ...INERT,
          gates: TWO_REPOS.manifest.uat?.gates as never,
          repositories: { backend: { gates: [] } },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove backend override' }));
    expect(uatOf(probe).repositories).toEqual({});
    expect(uatOf(probe).gates).toEqual([{ name: 'build', kind: 'script', script: 'build' }]);
  });
});

describe('QualitySection — the remove controls carry the taxonomy (UI-R10b)', () => {
  it('emits data-karst-action on both destructive controls', () => {
    mountQuality({
      ...FIXTURE_STATE_PUSH,
      manifest: {
        ...FIXTURE_MANIFEST,
        repositories: REPOS,
        uat: partialUat({
          gates: [{ name: 'build', kind: 'script', script: 'build' }],
          repositories: { backend: { gates: [{ name: 'g', kind: 'script', script: 's' }] } },
        }),
      },
    });
    const actions = Array.from(document.querySelectorAll('[data-karst-action]')).map(
      (n) => n.getAttribute('data-karst-action'),
    );
    expect(actions).toContain('remove-gate');
    expect(actions).toContain('remove-override');
    for (const action of actions) {
      const node = document.querySelector(`[data-karst-action="${action}"]`) as HTMLElement;
      expect(node.className).toContain('k-btn--danger');
      expect(node.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe('QualitySection — no edit reaches the host', () => {
  it('posts nothing: a Quality edit is a draft edit', () => {
    const { bridge } = mountQuality();
    fireEvent.change(field('uatMaxFixAttempts'), { target: { value: '9' } });
    fireEvent.click(field('reviewOpenChanges'));
    fireEvent.change(field('reviewFindingsSeverity'), { target: { value: 'low' } });
    expect(bridge.posted).toHaveLength(0);
  });
});
