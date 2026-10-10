// @vitest-environment jsdom
/**
 * Rendered behaviour of the ticket-form layout revamp (group 1): the
 * always-present action bar, the gated (dimmed, not hidden) Phase 2, the
 * dedicated title error, section headings, the edit-mode header and the
 * classify callout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';

function baseState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'create', provider: 'manual', title: '', key: '', description: '',
    repos: [], approaches: [], agents: [], unclassified: [], attachments: [],
    ...over,
  };
}

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

function open(state: Record<string, unknown>): RenderHandle {
  h = renderWebview('ticketForm');
  h.receive({ type: 'state', state });
  return h;
}

describe('ticket form — gated Phase 2 + always-on action bar', () => {
  it('keeps the action bar visible and dims Phase 2 (inert) with a hint when the title is empty', () => {
    const v = open(baseState());
    const bar = v.query<HTMLElement>('#actionBar')!;
    expect(bar).toBeTruthy();
    expect(bar.classList.contains('hidden')).toBe(false);
    expect(v.query('#phase2')!.contains(bar)).toBe(false);
    const p2 = v.query<HTMLElement>('#phase2')!;
    expect(p2.classList.contains('hidden')).toBe(false);
    expect(p2.getAttribute('aria-disabled')).toBe('true');
    expect(p2.hasAttribute('inert')).toBe(true);
    const hint = v.query<HTMLElement>('#phase2Hint')!;
    expect(hint.textContent).toContain('Add a title to continue');
    expect(hint.classList.contains('hidden')).toBe(false);
  });

  it('ungates Phase 2 once a title is present', () => {
    const v = open(baseState({ title: 'Fix it' }));
    const p2 = v.query<HTMLElement>('#phase2')!;
    expect(p2.hasAttribute('aria-disabled')).toBe(false);
    expect(p2.hasAttribute('inert')).toBe(false);
    expect(v.query('#phase2Hint')!.classList.contains('hidden')).toBe(true);
  });

  it('submitting without a title shows #titleErr under the field, describes and focuses it', () => {
    const v = open(baseState());
    v.click('#submitBtn');
    const err = v.query<HTMLElement>('#titleErr')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('Title is required');
    const title = v.query<HTMLInputElement>('#title')!;
    expect(title.nextElementSibling).toBe(err);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe('titleErr');
    expect(v.document.activeElement).toBe(title);
    expect(v.query('#err')!.classList.contains('hidden')).toBe(true);
    expect(v.posted.some((m) => (m as { type: string }).type === 'submit')).toBe(false);
  });
});

describe('ticket form — action labels', () => {
  it('create mode: Save draft / Create & start session, Cancel first', () => {
    const v = open(baseState());
    expect(v.query('#saveBtn')!.textContent).toBe('Save draft');
    expect(v.query('#submitBtn')!.textContent).toBe('Create & start session');
    const ids = v.queryAll('#actionBar button').map((b) => b.id);
    expect(ids).toEqual(['cancelBtn', 'saveBtn', 'submitBtn']);
    expect(v.query('#actionHint')!.textContent).toMatch(/start/i);
  });

  it('static markup labels match the create-mode runtime labels', () => {
    const v = renderWebview('ticketForm');
    h = v;
    expect(v.query('#saveBtn')!.textContent).toBe('Save draft');
    expect(v.query('#submitBtn')!.textContent).toBe('Create & start session');
  });

  it('edit mode: Save changes / Save & start session', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'PROJ-1', title: 'T' }));
    expect(v.query('#saveBtn')!.textContent).toBe('Save changes');
    expect(v.query('#submitBtn')!.textContent).toBe('Save & start session');
  });
});

describe('ticket form — field order and headings', () => {
  it('Title (required) comes before Key (optional) and Type sits next to Key', () => {
    const v = open(baseState());
    const title = v.query('#title')!;
    const ref = v.query('#ref')!;
    expect(title.compareDocumentPosition(ref) & 4).toBe(4); // ref follows title
    expect(v.query('label[for="title"]')!.textContent).toContain('(required)');
    expect(v.query('label[for="ref"]')!.textContent).toContain('(optional)');
    expect(ref.getAttribute('placeholder')).toBe('e.g. PROJ-142');
    expect(v.query('#keyTypeRow #typeSelect')).toBeTruthy();
  });

  it('replaces the dot stepper with plain section headings', () => {
    const v = open(baseState({ title: 'x' }));
    expect(v.query('.step .dot')).toBeNull();
    const heads = v.queryAll('h2').map((e) => e.textContent!.trim());
    for (const want of ['Ticket', 'Repositories', 'Approach', 'Agent']) {
      expect(heads.some((t) => t.startsWith(want))).toBe(true);
    }
    const labelledBy = v.query('#approachList')!.getAttribute('aria-labelledby')!;
    expect(v.query('#' + labelledBy)!.textContent).toBe('Approach');
  });

  it('Create in ClickUp lives in the Ticket card in both modes', () => {
    const v = open(baseState({ canCreateProviderTicket: true }));
    const card = v.query('#ticketCard')!;
    expect(card.contains(v.query('#createInRow'))).toBe(true);
    expect(card.contains(v.query('#createInBtn'))).toBe(true);
  });
});

describe('ticket form — edit header, callout, empty states', () => {
  it('edit mode: h1 is the title, key is a chip, "Editing" eyebrow', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'PROJ-142', title: 'Add retry' }));
    expect(v.query('#heading')!.textContent).toBe('Add retry');
    const chip = v.query<HTMLElement>('#keyChip')!;
    expect(chip.classList.contains('hidden')).toBe(false);
    expect(chip.textContent).toBe('PROJ-142');
    expect(v.query<HTMLElement>('#eyebrow')!.classList.contains('hidden')).toBe(false);
    expect(v.query('#eyebrow')!.textContent).toBe('Editing');
  });

  it('create mode hides the eyebrow and key chip', () => {
    const v = open(baseState());
    expect(v.query('#heading')!.textContent).toBe('New ticket');
    expect(v.query('#keyChip')!.classList.contains('hidden')).toBe(true);
    expect(v.query('#eyebrow')!.classList.contains('hidden')).toBe(true);
  });

  it('shows the design constraints card with chips, doc names and escaped warnings', () => {
    const v = open(baseState({ designConstraints: {
      entries: [{ text: '@arch:RESIDENT', doc: 'prompt-metrics.md' }, { text: '<b>x</b>' }],
      warnings: ['unknown commit <i>abc</i>'],
    } }));
    expect(v.query<HTMLElement>('#designConstraintsCard')!.hidden).toBe(false);
    const chips = [...v.document.querySelectorAll('#designConstraintsList .chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['@arch:RESIDENT prompt-metrics.md', '<b>x</b>']);
    expect(v.query('#designConstraintsList b')).toBeNull();
    expect(v.query('#designConstraintsWarnings .callout')!.textContent).toBe('unknown commit <i>abc</i>');
    expect(v.query('#designConstraintsWarnings i')).toBeNull();
  });

  it('hides the design constraints card when the state has none', () => {
    const v = open(baseState());
    expect(v.query<HTMLElement>('#designConstraintsCard')!.hidden).toBe(true);
  });

  it('classify gate renders as a compact callout', () => {
    const v = open(baseState({ unclassified: ['api', 'web'], repos: [] }));
    const gate = v.query<HTMLElement>('#gateCard')!;
    expect(gate.classList.contains('callout')).toBe(true);
    expect(gate.classList.contains('card')).toBe(false);
    expect(v.query('#gateMsg')!.textContent).toContain('2 repositories need signal words');
  });

  it('empty states carry actionable copy', () => {
    const v = open(baseState({ title: 'x' }));
    expect(v.query('#repoList')!.textContent).toContain('karst.yml');
    expect(v.query('#approachList')!.textContent).toContain('Settings');
  });
});

describe('ticket form — agent section layout (group 3)', () => {
  it('places the preset select directly after the identity picker, labelled as an alternative', () => {
    const v = open(baseState());
    const picker = v.query<HTMLElement>('#agentIdentityPicker')!;
    const preset = v.query<HTMLElement>('#agentPresetPicker')!;
    expect(preset.previousElementSibling === picker || preset.previousElementSibling?.id === 'providerLockHint').toBe(true);
    expect(picker.parentElement).toBe(preset.parentElement);
    expect(v.query('label[for="agentPresetSelect"]')!.textContent).toContain('or use a preset');
    expect(preset.querySelector('#agentPresetSelect')).toBeTruthy();
    expect(preset.querySelector('.sub')!.textContent).toContain('Overrides');
  });
});

describe('ticket form — F3 split repo chips (group 4)', () => {
  const repos = [
    { service: 'api', selected: true, score: 3, runnable: false, docker: true },
    { service: 'web', selected: false, score: 0 },
  ];
  const repoBases = [
    { repo: 'api', default: 'main', value: '', candidates: ['main', 'epic/x', 'release'] },
    { repo: 'web', default: 'develop', value: '', candidates: ['develop'] },
  ];
  const st = (over: Record<string, unknown> = {}) => baseState({ title: 'T', repos, repoBases, ...over });
  const key = (v: RenderHandle, el: Element, k: string) =>
    el.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('renders an unselected repo as a ghost chip with its name only, and no badge tags', () => {
    const v = open(st());
    const web = v.query<HTMLElement>('[data-repo="web"]')!;
    expect(web.getAttribute('aria-pressed')).toBe('false');
    expect(web.textContent!.trim()).toBe('web');
    expect(v.query('[data-base-caret="web"]')).toBeNull();
    expect(v.query('#repoList .chip-badge')).toBeNull();
    expect(v.query('#repoList')!.textContent).not.toMatch(/docker|no service/);
  });

  it('a selected repo shows repo:branch (default dim) plus a caret with aria-label/haspopup', () => {
    const v = open(st());
    const api = v.query<HTMLElement>('[data-repo="api"]')!;
    expect(api.textContent!.replace(/\s/g, '')).toBe('api:main');
    expect(api.querySelector('.repo-branch.is-overridden')).toBeNull();
    const caret = v.query<HTMLElement>('[data-base-caret="api"]')!;
    expect(caret.getAttribute('aria-label')).toBe('Change base branch for api');
    expect(caret.getAttribute('aria-haspopup')).toBeTruthy();
    expect(caret.getAttribute('aria-expanded')).toBe('false');
  });

  it('clicking the left half toggles off; clicking a ghost selects', () => {
    const v = open(st());
    v.click('[data-repo="api"]');
    expect(v.query('[data-repo="api"]')!.getAttribute('aria-pressed')).toBe('false');
    v.click('[data-repo="web"]');
    expect(v.query('[data-repo="web"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(v.posted.filter((m) => (m as { type: string }).type === 'set-repos').length).toBe(2);
  });

  it('caret opens a popover: filter, branch options, reset to default; picking posts set-base-ref and marks override', () => {
    const v = open(st());
    v.click('[data-base-caret="api"]');
    const pop = v.query<HTMLElement>('[data-base-pop="api"]')!;
    expect(pop).toBeTruthy();
    expect(v.query('[data-base-caret="api"]')!.getAttribute('aria-expanded')).toBe('true');
    expect(pop.querySelector('[data-base-filter]')!.getAttribute('aria-label')).toBe('Filter branches for api');
    expect([...pop.querySelectorAll('[data-base-pick]')].map((b) => b.textContent!.trim()))
      .toEqual(['main', 'epic/x', 'release', 'Reset to default (main)']);
    v.click('[data-base-pick="epic/x"]');
    expect(v.posted).toContainEqual({ type: 'set-base-ref', repo: 'api', baseRef: 'epic/x' });
    expect(v.query('[data-base-pop="api"]')).toBeNull();
    expect(v.query('[data-repo="api"] .repo-branch.is-overridden')!.textContent).toContain('epic/x');
    expect(v.document.activeElement).toBe(v.query('[data-base-caret="api"]'));
    v.click('[data-base-caret="api"]');
    v.click('[data-base-pick=""]');
    expect(v.posted).toContainEqual({ type: 'set-base-ref', repo: 'api', baseRef: '' });
    expect(v.query('[data-repo="api"] .is-overridden')).toBeNull();
  });

  it('filter narrows the list; Enter applies a free-text branch not in the list', () => {
    const v = open(st());
    v.click('[data-base-caret="api"]');
    const f = v.query<HTMLInputElement>('[data-base-filter]')!;
    f.value = 'rel';
    f.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    const visible = v.queryAll<HTMLElement>('[data-base-pop="api"] [data-base-opt]').filter((b) => !b.hidden);
    expect(visible.map((b) => b.dataset.basePick)).toEqual(['release']);
    f.value = 'feature/remote-only';
    key(v, f, 'Enter');
    expect(v.posted).toContainEqual({ type: 'set-base-ref', repo: 'api', baseRef: 'feature/remote-only' });
  });

  it('Esc closes and returns focus to the caret; ArrowDown on caret opens', () => {
    const v = open(st());
    const caret = v.query<HTMLElement>('[data-base-caret="api"]')!;
    key(v, caret, 'ArrowDown');
    const f = v.query<HTMLElement>('[data-base-filter]')!;
    expect(f).toBeTruthy();
    expect(v.document.activeElement).toBe(f);
    key(v, f, 'Escape');
    expect(v.query('[data-base-pop="api"]')).toBeNull();
    expect(v.document.activeElement).toBe(v.query('[data-base-caret="api"]'));
  });

  it('edit-mode prefill shows the stored override and submit carries it in baseRefs', () => {
    const v = open(st({ repoBases: [{ ...repoBases[0], value: 'epic/x' }, repoBases[1]] }));
    expect(v.query('[data-repo="api"] .repo-branch.is-overridden')!.textContent).toContain('epic/x');
    v.click('#submitBtn');
    const sub = v.posted.find((m) => (m as { type: string }).type === 'submit') as { baseRefs: Record<string, string> };
    expect(sub.baseRefs).toEqual({ api: 'epic/x' });
  });

  it('sub-task: renders parent branch as default with (parent) source and custom defaultLabel in popover', () => {
    const v = open(st({
      repoBases: [
        {
          repo: 'api',
          default: 'karst/feat/par-1',
          defaultLabel: 'parent branch: karst/feat/par-1 (default)',
          value: '',
          source: 'parent',
          candidates: ['karst/feat/par-1', 'main'],
        },
        repoBases[1],
      ],
    }));
    const api = v.query<HTMLElement>('[data-repo="api"]')!;
    expect(api.textContent!.replace(/\s/g, '')).toBe('api:karst/feat/par-1(parent)');
    expect(api.querySelector('.repo-branch.is-overridden')).toBeNull();

    v.click('[data-base-caret="api"]');
    const pop = v.query<HTMLElement>('[data-base-pop="api"]')!;
    const resetBtn = pop.querySelector<HTMLElement>('[data-base-pick=""]')!;
    expect(resetBtn.textContent!.trim()).toBe('Reset to parent branch: karst/feat/par-1 (default)');

    v.click('[data-base-pick="main"]');
    expect(v.query('[data-repo="api"] .repo-branch.is-overridden')!.textContent).toContain('main (override)');
  });
});
