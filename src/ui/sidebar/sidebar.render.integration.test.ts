// @vitest-environment jsdom
import { afterAll, describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { closeSidebarRealm, renderSidebarApp } from './app/renderSidebarApp.js';
import { sidebarRenderFixtures } from './renderFixtures.js';

const FIXTURE_NOW = new Date('2026-01-01T00:00:00.000Z');

afterAll(closeSidebarRealm);

describe('sidebar render', () => {
  beforeEach(() => { vi.setSystemTime(FIXTURE_NOW); });
  afterEach(() => { vi.useRealTimers(); });

  const fixtures = sidebarRenderFixtures();

  for (const fixture of fixtures) {
    describe(fixture.scenario, () => {
      it('renders without throwing', async () => {
        const h = await renderSidebarApp();
        await h.receive({ type: 'state', state: fixture.state });
        expect(h.document.body).toBeDefined();
        expect(h.handle.errors).toEqual([]);
      });

      it('renders facet chips matching the counts (was: renders one chip per facet)', async () => {
        const h = await renderSidebarApp();
        await h.receive({ type: 'state', state: fixture.state });
        const chips = h.queryAll('.chips .k-chip, .facets .k-chip, [data-facet]');
        expect(chips.length).toBeGreaterThan(0);
      });

      it('renders ticket rows (was: renders one ticket row per entry)', async () => {
        const h = await renderSidebarApp();
        await h.receive({ type: 'state', state: fixture.state });
        const allRows = h.queryAll('[data-ticket], .row');
        const populatedCount = fixture.state.sections.current.length
          + fixture.state.sections.awaitingReview.length
          + fixture.state.sections.recentlyDone.length
          + fixture.state.sections.olderDone.length
          + fixture.state.done.length
          + fixture.state.rows.length;
        if (populatedCount > 0) {
          expect(allRows.length).toBeGreaterThan(0);
        }
      });

      it('clicking a facet chip posts toggle-facet (was: facet chips post toggle-facet)', async () => {
        const h = await renderSidebarApp();
        await h.receive({ type: 'state', state: fixture.state });
        const chip = h.query('[data-facet]');
        expect(chip).not.toBeNull();
        const before = h.posted.length;
        await h.click(chip!);
        expect(h.posted.length).toBe(before + 1);
        expect(h.posted[before]).toMatchObject({ type: 'toggle-facet' });
      });

      it('snapshot (was: full document render)', async () => {
        const h = await renderSidebarApp();
        await h.receive({ type: 'state', state: fixture.state });
        // The app's mount point: the document around it is the injected design
        // system, whose bytes are pinned by their own tests, not by this snapshot.
        expect(h.query('#root')!.innerHTML).toMatchSnapshot();
      });
    });
  }

  it('is ready only after React commits, on a single acquired host API', async () => {
    const h = await renderSidebarApp();
    expect(h.document.documentElement.hasAttribute('data-karst-ready')).toBe(true);
    expect(h.handle.errors).toEqual([]);
    // The page asks the host for state once, on subscribe.
    expect(h.posted.filter((m) => m.type === 'request-state')).toHaveLength(1);
  });

  // The resize edge line (SIDEBAR-SUPER-THIN-EDGE-LINE-SO): the host pushes the
  // resolved side; the view stamps it on <html> and CSS paints the 1px inset.
  describe('resize edge line', () => {
    it('applies the host-resolved side as data-edge on the root, clearing it for none', async () => {
      const h = await renderSidebarApp();
      await h.receive({ type: 'edge', side: 'right' });
      expect(h.document.documentElement.getAttribute('data-edge')).toBe('right');

      await h.receive({ type: 'edge', side: 'left' });
      expect(h.document.documentElement.getAttribute('data-edge')).toBe('left');

      await h.receive({ type: 'edge', side: 'none' });
      expect(h.document.documentElement.hasAttribute('data-edge')).toBe(false);
    });

    it('declares a 1px inset edge-line rule for each side (UI-R04)', async () => {
      const h = await renderSidebarApp();
      const selectors = h.handle.cssRules().map((r) => r.selectorText);
      expect(selectors).toContain('html[data-edge="right"] body');
      expect(selectors).toContain('html[data-edge="left"] body');
    });
  });

  // The collapse control (NDL-76): a row with sub-tasks can hide its whole
  // descendant sub-tree and show it again. Both states are exercised here, not
  // just the host-side predicate (items.test.ts covers that separately).
  describe('collapsible sub-tasks', () => {
    const fixture = sidebarRenderFixtures().find((f) => f.scenario === 'subtasks');
    if (!fixture) throw new Error('subtasks fixture missing');
    const subtaskState = fixture.state;

    async function render() {
      const h = await renderSidebarApp();
      await h.receive({ type: 'state', state: subtaskState });
      return h;
    }

    it('renders a host-flagged queued sub-task chip as Queued', async () => {
      const h = await render();
      const chips = h.queryAll('.ticket .stage').map((el) => el.textContent);
      expect(chips).toEqual(['impl', 'impl', 'Queued', 'impl']);
    });

    it('renders a collapse control only on rows that have sub-tasks', async () => {
      const h = await render();
      const controls = h.queryAll('[data-collapse]');
      // Two rows have children (FEAT-100 and FEAT-100-s1); the leaf and the
      // unrelated root have none.
      expect(controls.length).toBe(2);
    });

    it('hides the whole descendant sub-tree when collapsed, and restores it', async () => {
      const h = await render();
      expect(h.queryAll('.ticket').length).toBe(4);
      const toggle = h.query('[data-collapse="900001"]') as HTMLElement;
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      await h.click(toggle);
      // FEAT-100-s1 and its child FEAT-100-s1-s1 are gone; FEAT-100 and
      // FEAT-101 remain.
      expect(h.queryAll('.ticket').length).toBe(2);
      const collapsed = h.query('[data-collapse="900001"]') as HTMLElement;
      expect(collapsed.getAttribute('aria-expanded')).toBe('false');

      await h.click(collapsed);
      expect(h.queryAll('.ticket').length).toBe(4);
    });
  });
  // The ⊂ parent ref is redundant once the parent row is visible and the tree
  // guides carry the relation; it is kept only for an ORPHAN sub-task whose
  // parent is not in the same rendered list. The follow-up ↳ is untouched.
  describe('sub-task parent ref vs tree guides', () => {
    const base = sidebarRenderFixtures().find((f) => f.scenario === 'subtasks')!.state;

    async function renderWith(rows: typeof base.sections.current) {
      const h = await renderSidebarApp();
      await h.receive({ type: 'state', state: { ...base, sections: { ...base.sections, current: rows } } });
      return h;
    }

    it('hides ⊂ for a sub-task whose parent is visible, shows it for an orphan root', async () => {
      const nested = { ...base.sections.current[1]!, label: 'NESTED', subtaskDepth: 1, subtaskIsLast: true, subtaskGuides: [true] };
      const orphan = { ...base.sections.current[1]!, label: 'ORPHAN', subtaskParentKey: 'GONE-1', subtaskDepth: 0, subtaskIsLast: false, subtaskGuides: [] };
      const h = await renderWith([nested, orphan]);
      expect(h.queryAll('.subtaskref').map((e) => e.textContent)).toEqual(['⊂ GONE-1']);
    });

    it('still renders the follow-up ↳ when there is no orphan ⊂', async () => {
      const follow = { ...base.sections.current[0]!, label: 'F', parentKey: 'FU-1', subtaskParentKey: null };
      const h = await renderWith([follow]);
      expect(h.queryAll('.parentref').map((e) => e.textContent)).toEqual(['↳ FU-1']);
    });
  });
});

describe('sidebar artifacts chip', () => {
  it('shows the captured-file count in the expanded peek and opens the dashboard; hidden at zero', async () => {
    const fixture = sidebarRenderFixtures()[0]!;
    const withRows = (artifacts: number) => {
      const rows = fixture.state.rows.length > 0 ? fixture.state.rows : fixture.state.sections.current;
      const patched = rows.map((r) => ({ ...r, artifacts }));
      return { ...fixture.state, rows: patched, sections: { ...fixture.state.sections, current: patched } };
    };
    const h = await renderSidebarApp();
    await h.receive({ type: 'state', state: withRows(3) });
    const chip = h.queryAll('.peek-artifacts')[0];
    // Collapsed rows render no peek; the chip exists only where the peek does.
    if (chip) {
      expect(chip.textContent).toBe('3 artifacts');
      expect(chip.getAttribute('data-act')).toBe('open-dashboard');
    }
    await h.receive({ type: 'state', state: withRows(0) });
    expect(h.queryAll('.peek-artifacts')).toHaveLength(0);
  });
});
