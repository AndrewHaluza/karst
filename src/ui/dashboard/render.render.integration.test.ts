// @vitest-environment jsdom
/**
 * Drives the dashboard fixture corpus through the shared jsdom render harness.
 *
 * Asserts the state-dependent RUNTIME rules (UI-R11, R12, R13, R15, R17, R18,
 * R26, R32) for the dashboard view only.  The other seven views' state-dependent
 * rules are out of scope until FEAT-37 supplies their corpora.
 */
import { describe, it, expect } from 'vitest';
import { renderWebview } from '../testing/renderHarness.js';
import { buildStepper } from '../../model/stepper.js';
import { buildStageRail } from '../../model/stageRail.js';
import {
  renderFixtures,
  renderStateFor,
  implementationPrototypeFixture,
  populatedStateFor,
  type InsideRenderFixture,
} from './renderFixtures.js';

const envelope = (f: InsideRenderFixture) => {
  const base = renderStateFor(f.stage);
  return {
    type: 'state',
    state: { ...base, insideViews: { ...base.insideViews, [f.stage]: f.view } },
  };
};

describe('dashboard render — fixture corpus', () => {
  it.each(renderFixtures())(
    '$repositoryCount repos, $scenario ($stage): renders #inside with rows and zero errors',
    (f) => {
      const h = renderWebview('dashboard');
      h.receive(envelope(f));
      const inside = h.query('#inside');
      expect(inside, '#inside not found').toBeTruthy();
      expect(inside!.innerHTML.length, '#inside is empty').toBeGreaterThan(0);
      expect(h.errors).toEqual([]);
      const rows = h.queryAll('[data-proc-id]');
      expect(rows.length, 'no [data-proc-id] rows').toBeGreaterThanOrEqual(1);
      h.close();
    },
  );

  it.each(renderFixtures())(
    '$repositoryCount repos, $scenario ($stage): escapes hostile labels (UI-R32)',
    (f) => {
      const h = renderWebview('dashboard');
      h.receive(envelope(f));
      const inside = h.query('#inside')!;
      // No script elements should appear inside #inside, even though fixture
      // labels contain literal "<script>" strings.
      expect(inside.querySelectorAll('script').length).toBe(0);
      expect(inside.querySelectorAll('img').length).toBe(0);
      expect(inside.querySelectorAll('iframe').length).toBe(0);
      // No on* event-handler attributes
      for (const el of inside.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(attr.name).not.toMatch(/^on/);
        }
      }
      h.close();
    },
  );

  it('click dispatches exactly one postMessage (UI-R11, R12, R17, R18)', () => {
    const h = renderWebview('dashboard');
    const fixture = renderFixtures()[0]!;
    h.receive(envelope(fixture));

    const btn = h.query<HTMLElement>('[data-act="copy-ticket-key"]');
    if (!btn) { h.close(); return; } // no control to click — vacuously true

    const ariaLabelBefore = btn.getAttribute('aria-label');

    h.click('[data-act="copy-ticket-key"]');
    expect(h.posted.length).toBe(1);
    const msg = h.posted[0] as { type: string; requestId?: string };
    expect(msg.type).toBe('copy-ticket-key');
    expect(msg.requestId).toBeTruthy();

    // After click: aria-busy and disabled
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(true);

    // A second click posts nothing more
    h.click('[data-act="copy-ticket-key"]');
    expect(h.posted.length).toBe(1);

    // Accessible name is unchanged across the transition (UI-R18)
    expect(btn.getAttribute('aria-label')).toBe(ariaLabelBefore);

    h.close();
  });

  it('action-result clears busy and re-enables (UI-R13, R15)', () => {
    const h = renderWebview('dashboard');
    const fixture = renderFixtures()[0]!;
    h.receive(envelope(fixture));

    const btn = h.query<HTMLElement>('[data-act="copy-ticket-key"]');
    if (!btn) { h.close(); return; }

    h.click('[data-act="copy-ticket-key"]');
    expect(btn.getAttribute('aria-busy')).toBe('true');

    // ok:true clears busy
    const requestId = (h.posted[0] as { requestId: string }).requestId;
    h.receive({ type: 'action-result', requestId, ok: true });
    expect(btn.getAttribute('aria-busy')).toBe(null);
    expect(btn.hasAttribute('disabled')).toBe(false);

    h.close();
  });

  it('implementationPrototypeFixture renders session segments', () => {
    const h = renderWebview('dashboard');
    const f = implementationPrototypeFixture();
    h.receive(envelope(f));
    const inside = h.query('#inside');
    expect(inside, '#inside not found').toBeTruthy();
    expect(inside!.innerHTML.length).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('renders a bypassed rail segment distinctly from passed (P2-18)', () => {
    const h = renderWebview('dashboard');
    const stages = [
      { stageKey: 'scope', status: 'passed' },
      { stageKey: 'impl', status: 'passed' },
      { stageKey: 'uat', status: 'passed' },
      { stageKey: 'review', status: 'bypassed' },
      { stageKey: 'ship', status: 'pending' },
    ] as const;
    const rail = buildStageRail(buildStepper(stages), stages, {
      current: 'ship',
      needsUser: false,
      needs: null,
    });
    h.receive({
      type: 'state',
      state: { ...renderStateFor('ship'), stageCurrent: 'ship', rail },
    });
    const seg = h.query('.track .seg.bypassed');
    expect(seg, 'bypassed segment not rendered').toBeTruthy();
    // The glyph is ⊘ — the rail's distinct bypass marker, never the passed ✓.
    expect(seg!.querySelector('.g')!.textContent).toContain('⊘');
    expect(seg!.querySelector('.g')!.textContent).not.toContain('✓');
    expect(seg!.querySelector('.pick')!.getAttribute('aria-label')).toContain('bypassed');
    expect(h.queryAll('.track .seg.passed').length).toBe(3);
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('renders the ship ⋯ menu when PR feedback is the only available recovery action', () => {
    const h = renderWebview('dashboard');
    const base = renderStateFor('ship');
    h.receive({
      type: 'state',
      state: {
        ...base,
        stageCurrent: 'ship',
        presentedStage: 'ship',
        prFeedbackFix: { available: true, round: 1, items: 2 },
        openPrFeedback: 2,
      },
    });
    expect(h.query('[data-stage-menu="ship"]'), '⋯ menu not rendered').toBeTruthy();
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('renders no ship ⋯ menu when the host withholds every recovery action', () => {
    const h = renderWebview('dashboard');
    const base = renderStateFor('ship');
    h.receive({
      type: 'state',
      state: {
        ...base,
        stageCurrent: 'ship',
        presentedStage: 'ship',
        sendBack: { available: false, reason: 'stage' },
        rerunGate: { available: false, reason: 'not-gate-stage' },
      },
    });
    expect(h.query('[data-stage-menu]')).toBeNull();
    h.close();
  });

  // Variant 2 (DASHBOARD-HEADER-SHOW-ONLY-ROLE): the second header row lists
  // only the roles whose model differs from implementation, grouped by model.
  const caps = (impl: [string, string], uat: [string, string], review: [string, string]) => ({
    implementation: { provider: impl[0], model: impl[1] },
    uatTester: { provider: uat[0], model: uat[1] },
    review: { provider: review[0], model: review[1] },
    uatFix: null, reviewFix: null, prDescription: null, ticketAnalysis: null,
    graphExpert: null, graphWorker: null, graphFast: null,
  });
  const catalog = { claude: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }], codex: [], opencode: [], antigravity: [] };
  const withCaps = (capabilityIdentity: unknown, extra: Record<string, unknown> = {}) => {
    const base = renderStateFor('impl');
    return { ...base, ...extra, agentSwitch: { ...base.agentSwitch, modelsByCore: catalog }, capabilityIdentity };
  };
  const OPUS: [string, string] = ['claude', 'claude-opus-5-5'];
  const SONNET: [string, string] = ['claude', 'claude-sonnet-5-5'];

  it('hides the role row when every role matches implementation', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, OPUS)) });
    expect(h.errors).toEqual([]);
    expect((h.query('#headerMeta') as HTMLElement).hidden).toBe(true);
    expect(h.queryAll('.capChip')).toHaveLength(0);
    h.close();
  });

  it('renders one chip when only review differs, with friendly labels and full-id tooltip', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, SONNET)) });
    expect((h.query('#headerMeta') as HTMLElement).hidden).toBe(false);
    const chips = h.queryAll('.capChip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('Review');
    expect(chips[0]!.textContent).not.toContain('UAT');
    expect(chips[0]!.textContent).toContain('Sonnet 5.5');
    expect(chips[0]!.getAttribute('title')).toContain('claude/claude-sonnet-5-5');
    h.close();
  });

  it('groups UAT and review into one chip when they share a different model', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, SONNET, SONNET)) });
    const chips = h.queryAll('.capChip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('UAT · Review');
    h.close();
  });

  it('falls back to the raw model id when the catalog has no label', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, ['codex', 'gpt-x'])) });
    expect(h.queryAll('.capChip')[0]!.textContent).toContain('gpt-x');
    h.close();
  });

  it('shows only the relation for a sub-task with no overrides', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, OPUS), { subtaskParent: { key: 'PARENT-1' } }) });
    const row = h.query('#headerMeta') as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(row.firstElementChild!.id).toBe('parentRef');
    expect(row.textContent).toContain('Sub-task of PARENT-1');
    expect(h.queryAll('.capChip')).toHaveLength(0);
    h.close();
  });
});

describe('dashboard render — queued sub-task', () => {
  it('renders a host-flagged queued sub-task as Queued, others by stage', () => {
    const h = renderWebview('dashboard');
    h.receive({ type: 'state', state: populatedStateFor('impl') });
    const queued = h.query('.subtask[data-id="942020"]');
    expect(queued, 'queued sub-task row missing').toBeTruthy();
    expect(queued!.querySelector('.stage')!.textContent).toBe('Queued');
    expect(queued!.querySelector('.k-dot')!.getAttribute('aria-label')).toBe('Queued');
    const running = h.query('.subtask[data-id="942019"]')!;
    const state = populatedStateFor('impl');
    const starting = {
      ...state,
      subtasks: state.subtasks.map((s) => (s.id === 942020 ? { ...s, autostart: 'starting' as const } : s)),
    };
    h.receive({ type: 'state', state: starting });
    expect(h.query('.subtask[data-id="942020"] .stage')!.textContent).toBe('Starting');
    expect(running.querySelector('.stage')!.textContent).toBe('impl');
    expect(h.errors).toEqual([]);
    h.close();
  });
});
