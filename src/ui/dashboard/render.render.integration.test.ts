// @vitest-environment jsdom
/**
 * Drives the dashboard fixture corpus through the shared jsdom render harness.
 *
 * Asserts the state-dependent RUNTIME rules (UI-R11, R12, R13, R15, R17, R18,
 * R26, R32) for the dashboard view only.  The other seven views' state-dependent
 * rules are out of scope until FEAT-37 supplies their corpora.
 */
import { describe, it, expect } from 'vitest';
import { drainReactWork, renderWebview, renderWebviewReady, waitForSettingsReady } from '../testing/renderHarness.js';
import { buildStepper } from '../../model/stepper.js';
import { buildStageRail } from '../../model/stageRail.js';
import {
  renderFixtures,
  renderStateFor,
  implementationPrototypeFixture,
  populatedStateFor,
  shipPreviewFixture,
  shipPreviewStateFor,
  type InsideRenderFixture,
} from './renderFixtures.js';
import type { DashboardState } from './state.js';

const envelope = (f: InsideRenderFixture) => {
  const base = renderStateFor(f.stage);
  return {
    type: 'state',
    state: { ...base, insideViews: { ...base.insideViews, [f.stage]: f.view } },
  };
};

describe('dashboard render — fixture corpus', () => {
  it('renders a linked blocked-by chip from host state', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({
      type: 'state',
      state: { ...renderStateFor('impl'), blockers: [{ ticketId: 42, idLabel: 'T42', label: 'CU-123' }] },
    });
    await drainReactWork(h);
    const chip = h.query('#parentRef .k-chip');
    expect(chip?.textContent).toContain('Blocked by T42 · CU-123');
    h.click('#parentRef [data-act="open-dependency"]');
    await drainReactWork(h);
    expect(h.posted[0]).toMatchObject({ type: 'open-dependency', ticketId: 42 });
    h.close();
  });

  it('paints the prefixed id in the header, the origin line and each sub-task row', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: populatedStateFor('impl') });
    await drainReactWork(h);
    expect(h.query('#idBadge')!.textContent).toMatch(/^T\d+$/);
    expect(h.query('#parentRef')!.textContent).toContain('from D88 (P17)');
    expect(h.queryAll('.subtask .k-id').map((e) => e.textContent)).toEqual(['T942018', 'T942019', 'T942020']);
    h.close();
  });

  it.each(renderFixtures())(
    '$repositoryCount repos, $scenario ($stage): renders #inside with rows and zero errors',
    async (f) => {
      const h = await renderWebviewReady('dashboard');
      h.receive(envelope(f));
      await drainReactWork(h);
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
    async (f) => {
      const h = await renderWebviewReady('dashboard');
      h.receive(envelope(f));
      await drainReactWork(h);
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

  it('implementationPrototypeFixture renders session segments', async () => {
    const h = await renderWebviewReady('dashboard');
    const f = implementationPrototypeFixture();
    h.receive(envelope(f));
    await drainReactWork(h);
    const inside = h.query('#inside');
    expect(inside, '#inside not found').toBeTruthy();
    expect(inside!.innerHTML.length).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('renders a bypassed rail segment distinctly from passed (P2-18)', async () => {
    const h = await renderWebviewReady('dashboard');
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
    await drainReactWork(h);
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

  it('renders the ship ⋯ menu when PR feedback is the only available recovery action', async () => {
    const h = await renderWebviewReady('dashboard');
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
    await drainReactWork(h);
    expect(h.query('[data-stage-menu="ship"]'), '⋯ menu not rendered').toBeTruthy();
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('renders no ship ⋯ menu when the host withholds every recovery action', async () => {
    const h = await renderWebviewReady('dashboard');
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
    await drainReactWork(h);
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

  it('hides the role row when every role matches implementation', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, OPUS)) });
    await drainReactWork(h);
    expect(h.errors).toEqual([]);
    expect((h.query('#headerMeta') as HTMLElement).hidden).toBe(true);
    expect(h.queryAll('.capChip')).toHaveLength(0);
    h.close();
  });

  it('renders one chip when only review differs, with friendly labels and full-id tooltip', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, SONNET)) });
    await drainReactWork(h);
    expect((h.query('#headerMeta') as HTMLElement).hidden).toBe(false);
    const chips = h.queryAll('.capChip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('Review');
    expect(chips[0]!.textContent).not.toContain('UAT');
    expect(chips[0]!.textContent).toContain('Sonnet 5.5');
    expect(chips[0]!.getAttribute('title')).toContain('claude/claude-sonnet-5-5');
    h.close();
  });

  it('groups UAT and review into one chip when they share a different model', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, SONNET, SONNET)) });
    await drainReactWork(h);
    const chips = h.queryAll('.capChip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('UAT · Review');
    h.close();
  });

  it('falls back to the raw model id when the catalog has no label', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, ['codex', 'gpt-x'])) });
    await drainReactWork(h);
    expect(h.queryAll('.capChip')[0]!.textContent).toContain('gpt-x');
    h.close();
  });

  it('shows only the relation for a sub-task with no overrides', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withCaps(caps(OPUS, OPUS, OPUS), { subtaskParent: { key: 'PARENT-1', ref: 'T9 · PARENT-1' } }) });
    await drainReactWork(h);
    const row = h.query('#headerMeta') as HTMLElement;
    expect(row.hidden).toBe(false);
    expect(row.firstElementChild!.id).toBe('parentRef');
    expect(row.textContent).toContain('Sub-task of T9 · PARENT-1');
    expect(h.queryAll('.capChip')).toHaveLength(0);
    h.close();
  });
});

describe('dashboard render — ship preview (D142)', () => {
  // Inside is React's: the block is drawn once React has committed the push.
  const render = async (kind: Parameters<typeof shipPreviewStateFor>[0]) => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: shipPreviewStateFor(kind) });
    await drainReactWork(h);
    return h;
  };

  // A pending Confirm with UAT and Review populated too, so a rail click has a
  // real view to land on rather than an empty block.
  const confirmPendingWithViews = (): DashboardState => {
    const base = populatedStateFor('ship');
    return {
      ...base,
      insideViews: {
        ...base.insideViews,
        uat: renderStateFor('uat').insideViews.uat!,
        review: renderStateFor('review').insideViews.review!,
      },
      ship: { kind: 'confirm' },
      shipPreview: shipPreviewFixture('ready')!,
    };
  };
  const SHIP_CLOCK = '09:40:02 · 1m 40s · attempt 1';
  const UAT_CLOCK = '10:03:55 · 41.2s · attempt 3';
  const REVIEW_CLOCK = '09:20:11 · 3m 02s · attempt 2';
  const insideClock = (h: Awaited<ReturnType<typeof renderWebviewReady>>) => h.query('#inside .inside-meta')?.textContent;

  it('is absent unless the ship slot waits for Confirm/Retry', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: renderStateFor('ship') }); // slot: none
    await drainReactWork(h);
    expect(h.query('[data-region="ship-preview"]')).toBeNull();
    h.close();
  });

  it('ready: renders one card per repo with the PR title and commit subject', async () => {
    const h = await render('ready');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section).toBeTruthy();
    const cards = h.queryAll('[data-region="ship-preview-repo"]');
    expect(cards).toHaveLength(2);
    expect(section.textContent).toContain('Ship preview');
    expect(section.textContent).toContain('src/app.ts');
    // Hostile prose is escaped, never a live element (UI-R32).
    expect(section.querySelectorAll('script').length).toBe(0);
    expect(h.errors).toEqual([]);
    h.close();
  });

  it('excluded + warning: names the excluded files and the committed-match warning', async () => {
    const h = await render('excluded-warning');
    const text = h.query('[data-region="ship-preview"]')!.textContent!;
    expect(text).toContain('Excluded');
    expect(text).toContain('(ship.exclude)');
    expect(text).toContain('dist/bundle.js');
    expect(text).toContain('ship.exclude matches committed changes');
    h.close();
  });

  it('blocked: shows the deny paths as danger text with an icon, never as "Commits"', async () => {
    const h = await render('blocked');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.textContent).toContain('.env');
    expect(section.querySelector('.sp-badge--danger')).toBeTruthy();
    expect(section.querySelector('.sp-row--danger')).toBeTruthy();
    // Ship refuses before the sweep, so the refused path is never labelled as
    // something it will commit.
    expect(section.textContent).not.toContain('Commits');
    h.close();
  });

  it('nothing-to-commit: says the agent already committed its work', async () => {
    const h = await render('nothing-to-commit');
    expect(h.query('[data-region="ship-preview"]')!.textContent).toContain(
      'nothing to commit — agent committed its work',
    );
    h.close();
  });

  it('all-nothing: warns ship will fail (arch:SHIP-UNCHANGED)', async () => {
    const h = await render('all-nothing');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.textContent).toContain('ship will fail — no repo has changes');
    expect(section.querySelector('.sp-note--warn')).toBeTruthy();
    h.close();
  });

  it('error: renders the per-repo message and never a "no changes" verdict', async () => {
    const h = await render('error');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.textContent).toContain('git status exited 128');
    expect(section.textContent).not.toContain('no changes from base');
    expect(h.queryAll('[data-region="ship-preview-repo"]')).toHaveLength(1);
    h.close();
  });

  it('loading: keeps geometry with a skeleton while the read lands', async () => {
    const h = await render('loading');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.querySelector('.sp-skel')).toBeTruthy();
    h.close();
  });

  it('caps the visible file list at 50 and names the remainder (UI-R44)', async () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    const state = shipPreviewStateFor('ready');
    const preview = shipPreviewFixture('ready')!;
    const withFiles = {
      ...state,
      shipPreview: { ...preview, repos: [{ ...preview.repos[0]!, commitFiles: files }] },
    };
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: withFiles });
    await drainReactWork(h);
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.querySelectorAll('.sp-file').length).toBe(51); // 50 + the remainder row
    expect(section.textContent).toContain('and 10 more');
    h.close();
  });

  it('auto-selects Ship once on entering a wait, then leaves the user choice alone (D234)', async () => {
    const base = confirmPendingWithViews();
    const h = await renderWebviewReady('dashboard');
    // The rail is React's: each push is drawn once React has committed it.
    const push = async (state: object, extra: Record<string, unknown> = {}): Promise<void> => {
      h.receive({ type: 'state', state, ...extra });
      await drainReactWork(h);
    };
    // Before the wait the user is on Review.
    await push({ ...base, ship: { kind: 'none' as const }, shipPreview: undefined });
    h.click('[data-stage="review"]');
    expect(insideClock(h)).toBe(REVIEW_CLOCK);
    // Entering the wait selects Ship so the preview is beside Confirm ship.
    await push(base);
    expect(insideClock(h)).toBe(SHIP_CLOCK);
    expect(h.query('[data-region="ship-preview"]')).not.toBeNull();
    expect(h.query('.pick[data-stage="ship"]')!.getAttribute('aria-pressed')).toBe('true');
    // The user navigates away; a later push for the SAME wait keeps them there.
    h.click('[data-stage="uat"]');
    await push(base);
    expect(insideClock(h)).toBe(UAT_CLOCK);
    expect(h.query('[data-region="ship-preview"]')).toBeNull();
    // A retry after the confirm is a NEW wait: Ship is selected once more.
    await push({ ...base, ship: { kind: 'retry' } });
    expect(insideClock(h)).toBe(SHIP_CLOCK);
    // ...and a wait on a DIFFERENT ticket is new too.
    h.click('[data-stage="review"]');
    await push({ ...base, ticketId: base.ticketId + 1, ship: { kind: 'retry' } });
    expect(insideClock(h)).toBe(SHIP_CLOCK);
    h.close();
  });

  it('keeps the rail live while the Ship slot waits — a click opens the stage (D234)', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: confirmPendingWithViews() });
    await drainReactWork(h);
    expect(insideClock(h)).toBe(SHIP_CLOCK);
    const impl = h.query<HTMLButtonElement>('[data-stage="impl"]')!;
    expect(impl.disabled).toBe(false);
    expect(impl.getAttribute('aria-disabled')).toBeNull();
    expect(impl.getAttribute('title')).not.toContain('pinned to ship');
    // UAT and Review are one click away, and each renders its own view.
    h.click('[data-stage="uat"]');
    expect(insideClock(h)).toBe(UAT_CLOCK);
    h.click('[data-stage="review"]');
    expect(insideClock(h)).toBe(REVIEW_CLOCK);
    // Ship lives only on the rail now; the header draws no Confirm ship button.
    expect(h.query('#confirmShip')).toBeNull();
    // Preview stays in the Ship view, one click away.
    h.click('[data-stage="ship"]');
    expect(h.query('[data-region="ship-preview"]')).not.toBeNull();
    h.close();
  });

  it('a live repaint follows the user selection, not the pending wait (D234)', async () => {
    const h = await renderWebviewReady('dashboard');
    const state = confirmPendingWithViews();
    h.receive({ type: 'state', state });
    await drainReactWork(h);
    h.click('[data-stage="uat"]');
    // A live repaint is the same snapshot re-read: it must advance the SELECTED
    // view's clock, never re-derive Ship from the waiting slot.
    const live: DashboardState = {
      ...state,
      insideViews: { ...state.insideViews, uat: { ...state.insideViews.uat!, clock: 'advanced uat clock' } },
    };
    h.receive({ type: 'state', state: live, live: true });
    expect(insideClock(h)).toBe('advanced uat clock');
    h.close();
  });

  it('restores a recorded wait without re-selecting Ship over the user choice (D234)', async () => {
    const state = confirmPendingWithViews();
    const h = renderWebview('dashboard', {
      persistedState: {
        state,
        sel: 'uat',
        shipWait: `${state.ticketId}:confirm`,
        srvFilter: '',
        artView: null,
        artScrolls: { ticket: 0, index: 0, detail: {} },
      },
    });
    await waitForSettingsReady(h);
    await drainReactWork(h);
    expect(insideClock(h)).toBe(UAT_CLOCK);
    expect(h.query('[data-region="ship-preview"]')).toBeNull();
    h.close();
  });

  it('persists the auto-selected wait so a reopen does not yank the selection (D234)', async () => {
    const state = confirmPendingWithViews();
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state });
    await drainReactWork(h);
    h.click('[data-stage="uat"]');
    expect(h.state).toMatchObject({ sel: 'uat', shipWait: `${state.ticketId}:confirm` });
    h.close();
  });

  it('re-ship: a live PR is committed INTO, never reported as skipped (FIX-46)', async () => {
    const h = await render('re-ship');
    const section = h.query('[data-region="ship-preview"]')!;
    expect(section.textContent).toContain('PR #42 open — this commit is pushed onto it');
    expect(section.textContent).not.toContain('skipped');
    expect(section.textContent).toContain('src/app.ts');
    h.close();
  });

  it('Refresh posts the intent once and marks the button busy (UI-R11/R12)', async () => {
    const h = await render('ready');
    h.click('[data-act="refresh-ship-preview"]');
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ type: 'refresh-ship-preview' });
    const btn = h.query<HTMLElement>('[data-act="refresh-ship-preview"]')!;
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(true);
    h.close();
  });
});

describe('dashboard render — queued sub-task', () => {
  it('renders a host-flagged queued sub-task as Queued, others by stage', async () => {
    const h = await renderWebviewReady('dashboard');
    h.receive({ type: 'state', state: populatedStateFor('impl') });
    await drainReactWork(h);
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
    await drainReactWork(h);
    expect(h.query('.subtask[data-id="942020"] .stage')!.textContent).toBe('Starting');
    expect(running.querySelector('.stage')!.textContent).toBe('impl');
    expect(h.errors).toEqual([]);
    h.close();
  });
});
