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

describe('ticket form — regions + title-gated primary', () => {
  it('lays out header, content, settings, actions in DOM order', () => {
    const v = open(baseState());
    const regions = v.queryAll('[data-region]').map((e) => e.getAttribute('data-region'));
    expect(regions).toEqual(['header', 'content', 'settings', 'actions']);
    expect(v.query('#actionBar')!.getAttribute('data-region')).toBe('actions');
  });

  it('keeps every section enabled and disables only the primary, with a reason, while the title is blank', () => {
    const v = open(baseState());
    expect(v.query('#phase2')).toBeNull();
    expect(v.query('#phase2Hint')).toBeNull();
    expect(v.query('[inert]')).toBeNull();
    expect(v.query('[aria-disabled="true"]')).toBeNull();
    const submit = v.query<HTMLButtonElement>('#submitBtn')!;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toMatch(/title/i);
    expect(v.query('#actionReason')!.textContent).toBe('Add a title to continue');
    expect(v.query<HTMLButtonElement>('#saveBtn')!.disabled).toBe(false);
  });

  it('enables the primary once a title is present', () => {
    const v = open(baseState({ title: 'Fix it' }));
    expect(v.query<HTMLButtonElement>('#submitBtn')!.disabled).toBe(false);
  });

  it('saving without a title shows #titleErr under the field, describes and focuses it', () => {
    const v = open(baseState());
    v.click('#saveBtn');
    const err = v.query<HTMLElement>('#titleErr')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('Title is required');
    const title = v.query<HTMLTextAreaElement>('#title')!;
    expect(title.nextElementSibling).toBe(err);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe('titleErr');
    expect(v.document.activeElement).toBe(title);
    expect(v.query('#err')!.classList.contains('hidden')).toBe(true);
    expect(v.posted.some((m) => (m as { type: string }).type === 'save')).toBe(false);
  });
});

describe('ticket form — actions footer', () => {
  it('lives inside the single frame and shows the disabled reason while the title is blank', () => {
    const v = open(baseState());
    expect(v.query('.frame')!.contains(v.query('#actionBar'))).toBe(true);
    expect(v.query('#actionReason')!.textContent).toBe('Add a title to continue');
    expect(v.query('#submitBtn')!.classList.contains('p')).toBe(true);
    expect(v.query('#cancelBtn')!.classList.contains('g')).toBe(true);
  });
});

describe('ticket form — action labels', () => {
  it('create mode: Save draft / Create & start, Cancel first, primary last, no sentence', () => {
    const v = open(baseState());
    expect(v.query('#saveBtn')!.textContent).toBe('Save draft');
    expect(v.query('#submitBtn')!.textContent).toBe('Create & start');
    // The hidden carry control (T1313) sits beside the reason; the visible order is unchanged.
    const ids = v.queryAll('#actionBar button').filter((b) => !b.classList.contains('hidden')).map((b) => b.id);
    expect(ids).toEqual(['cancelBtn', 'saveBtn', 'submitBtn']);
    expect(v.query('#actionHint')).toBeNull();
  });

  // T1313 / @arch:AC-65: an active carried pick shows "Stop using pick" in the
  // action row; a click posts the park id; no carry keeps it hidden.
  it('shows Stop using pick for an active carry and posts its park id', () => {
    const none = open(baseState());
    expect(none.query('#carryStopBtn')!.classList.contains('hidden')).toBe(true);
    none.close();
    const v = open({ ...baseState(), activeCarries: [{ parkId: 14, label: 'Stop using pick: claude/claude-opus-5-5 until 15:05 (parked on antigravity)' }] });
    const btn = v.query('#carryStopBtn') as HTMLButtonElement;
    expect(btn.classList.contains('hidden')).toBe(false);
    expect(btn.title).toBe('Stop using pick: claude/claude-opus-5-5 until 15:05 (parked on antigravity)');
    expect(btn.textContent).toBe('Stop using pick: claude/claude-opus-5-5 until 15:05 (parked on antigravity)');
    btn.click();
    expect(v.posted).toContainEqual({ type: 'usage-limit-carry-stop', parkId: 14 });
    const ids = v.queryAll('#actionBar button').filter((b) => !b.classList.contains('hidden')).map((b) => b.id);
    expect(ids.at(-1)).toBe('submitBtn');
  });

  it('static markup labels match the create-mode runtime labels', () => {
    const v = renderWebview('ticketForm');
    h = v;
    expect(v.query('#saveBtn')!.textContent).toBe('Save draft');
    expect(v.query('#submitBtn')!.textContent).toBe('Create & start');
  });

  it('edit mode: Save / Save & start', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'PROJ-1', title: 'T' }));
    expect(v.query('#saveBtn')!.textContent).toBe('Save');
    expect(v.query('#submitBtn')!.textContent).toBe('Save & start');
  });
});

describe('ticket form — field order and headings', () => {
  it('Title (required) is in content; Key (optional) and Type are in settings', () => {
    const v = open(baseState());
    const title = v.query('#title')!;
    const ref = v.query('#ref')!;
    expect(title.compareDocumentPosition(ref) & 4).toBe(4); // ref follows title
    expect(title.getAttribute('placeholder')).toBe('Title (required)');
    // SET-58: a real visible label carries the requirement; the `*` is decorative.
    const label = v.query('label[for="title"]')!;
    expect(label.textContent).toContain('Title');
    expect(label.querySelector('.req')!.getAttribute('aria-hidden')).toBe('true');
    expect(title.getAttribute('aria-required')).toBe('true');
    expect(v.query('label[for="ref"]')!.textContent).toContain('(optional)');
    expect(ref.getAttribute('placeholder')).toBe('e.g. PROJ-142');
    expect(v.query('[data-region="content"] #title')).toBeTruthy();
    expect(v.query('[data-region="settings"] #ref')).toBeTruthy();
    expect(v.query('[data-region="settings"] #typeSelect')).toBeTruthy();
  });

  it('replaces the dot stepper with plain section headings', () => {
    const v = open(baseState({ title: 'x' }));
    expect(v.query('.step .dot')).toBeNull();
    const heads = v.queryAll('h2').map((e) => e.textContent!.trim());
    for (const want of ['Repositories', 'Approach', 'Agent']) {
      expect(heads.some((t) => t.startsWith(want))).toBe(true);
    }
    expect(v.query('#approachHeading')!.textContent).toBe('Approach');
  });

  it('Create in ClickUp lives in the source block in both modes', () => {
    const v = open(baseState({ canCreateProviderTicket: true }));
    const card = v.query('#sourceBlock')!;
    expect(card.contains(v.query('#createInRow'))).toBe(true);
    expect(card.contains(v.query('#createInBtn'))).toBe(true);
  });
});

describe('ticket form — edit header, callout, empty states', () => {
  it('edit mode: header strip reads "Edit <ref>", no chip', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, refLabel: 'T7 · PROJ-142', key: 'PROJ-142', title: 'Add retry' }));
    expect(v.query('#heading')!.textContent).toBe('Edit T7 · PROJ-142');
    expect(v.query<HTMLElement>('#keyChip')!.classList.contains('hidden')).toBe(true);
  });

  it('draft review page shows the draft id in the chip, and a sub-task names its parent as T<n>', () => {
    const v = open(baseState({ refLabel: 'D88', subtaskOf: 'Sub-task of T12' }));
    expect(v.query('#keyChip')!.textContent).toBe('D88');
    expect(v.query('#keyChip')!.classList.contains('hidden')).toBe(false);
    // SET-62: a separator, not "New ticket Sub-task of T12".
    expect(v.query('#subhead')!.textContent).toBe(' · Sub-task of T12');
  });

  it('create mode hides the key chip and shows no subtitle', () => {
    const v = open(baseState());
    expect(v.query('#heading')!.textContent).toBe('New ticket');
    expect(v.query('#keyChip')!.classList.contains('hidden')).toBe(true);
    expect(v.query('#subhead')!.textContent).toBe('');
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

  it('empty states are one muted line with a Settings link, no dashed box (C6)', () => {
    const v = open(baseState({ title: 'x' }));
    expect(v.query('#repoList .setempty a[data-act="open-settings"]')).not.toBeNull();
    expect(v.query('#approachList .setempty a[data-act="open-settings"]')).not.toBeNull();
    expect(v.query('#repoList .k-empty')).toBeNull();
  });

  it('empty states carry actionable copy', () => {
    const v = open(baseState({ title: 'x' }));
    expect(v.query('#repoList')!.textContent).toContain('Settings → Repositories');
    expect(v.query('#approachList')!.textContent).toContain('Settings');
  });
});

describe('ticket form — agent section layout (group 3)', () => {
  it('mounts the Preset | Core + model switch in the identity picker, no standalone preset select', () => {
    const v = open(baseState());
    const picker = v.query<HTMLElement>('#agentIdentityPicker')!;
    expect(v.query('#agentPresetPicker')).toBeNull();
    expect(v.query('#agentPresetSelect')).toBeNull();
    const radios = [...picker.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    expect(radios.map((r) => r.textContent?.trim())).toEqual(['Preset', 'Core + model']);
    expect(picker.querySelector('[data-ap-preset]')).toBeTruthy();
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
    expect(api.textContent!.replace(/\s/g, '')).toBe('apimain');
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
    expect(api.textContent!.replace(/\s/g, '')).toBe('apikarst/feat/par-1(parent)');
    expect(api.querySelector('.repo-branch.is-overridden')).toBeNull();

    v.click('[data-base-caret="api"]');
    const pop = v.query<HTMLElement>('[data-base-pop="api"]')!;
    const resetBtn = pop.querySelector<HTMLElement>('[data-base-pick=""]')!;
    expect(resetBtn.textContent!.trim()).toBe('Reset to parent branch: karst/feat/par-1 (default)');

    v.click('[data-base-pick="main"]');
    expect(v.query('[data-repo="api"] .repo-branch.is-overridden')!.textContent).toContain('main (override)');
  });
});

describe('ticket form — reopen shows stored intent and code pointers', () => {
  const editState = (over: Record<string, unknown> = {}) =>
    baseState({ mode: 'edit', ticketId: 7, key: 'K-7', title: 'T', intent: '## Goal\ng', codePointers: '- a.ts — x', ...over });
  const lastSave = (v: RenderHandle) =>
    [...v.posted].reverse().find((m) => (m as { type: string }).type === 'save') as Record<string, unknown>;

  it('fills #intent and #codePointers and shows the pointers row', () => {
    const v = open(editState());
    expect(v.query<HTMLTextAreaElement>('#intent')!.value).toBe('## Goal\ng');
    expect(v.query<HTMLTextAreaElement>('#codePointers')!.value).toBe('- a.ts — x');
    expect(v.query<HTMLElement>('#codePointersRow')!.hidden).toBe(false);
  });
  it('keeps the pointers row hidden when the ticket has none', () => {
    const v = open(editState({ codePointers: null }));
    expect(v.query<HTMLElement>('#codePointersRow')!.hidden).toBe(true);
  });
  it('an untouched reopen saves without intent/codePointers, so stored values are not rewritten', () => {
    const v = open(editState());
    v.click('#saveBtn');
    const save = lastSave(v);
    expect(save).toBeTruthy();
    expect('intent' in save).toBe(false);
    expect('codePointers' in save).toBe(false);
  });
  it('editing #intent sends only that field on save', () => {
    const v = open(editState());
    v.query<HTMLTextAreaElement>('#intent')!.value = '## Goal\nedited';
    v.click('#saveBtn');
    const save = lastSave(v);
    expect(save.intent).toBe('## Goal\nedited');
    expect('codePointers' in save).toBe(false);
  });
});

describe('ticket form — sandbox backend opt-out', () => {
  const picker = (v: RenderHandle) => v.query<HTMLElement>('#backendPicker')!;
  const select = (v: RenderHandle) => v.query<HTMLSelectElement>('#backendSelect')!;
  const inherit = (v: RenderHandle) => select(v).options[0]!.textContent;
  const MAP = { codex: 'sbx', opencode: 'docker' };
  const st = (over: Record<string, unknown> = {}) =>
    baseState({ agentBackends: MAP, presetCores: {}, defaultAgentProvider: 'claude', agentProviders: ['claude', 'codex', 'opencode'], ...over });
  const pickCore = (v: RenderHandle, core: string) => {
    v.click('[data-ap-trigger="core"]');
    v.click(`[data-ap-core="${core}"]`);
  };

  it('shows a Claude default on host while other cores use a sandbox', () => {
    const v = open(st({ mode: 'edit' }));
    expect(picker(v).classList.contains('hidden')).toBe(false);
    expect(inherit(v)).toBe('Inherit (project: host)');
    expect([...select(v).options].map((o) => o.value)).toEqual(['', 'host']);
    expect(select(v).value).toBe('');
  });

  it('shows sbx for a Codex default', () => {
    expect(inherit(open(st({ defaultAgentProvider: 'codex' })))).toBe('Inherit (project: sbx)');
  });

  it('shows docker for an explicit opencode pick', () => {
    expect(inherit(open(st({ selectedAgentProvider: 'opencode' })))).toBe('Inherit (project: docker)');
  });

  it('follows the core of the selected preset', () => {
    const v = open(st({ agentPresetNames: ['cx'], presetCores: { cx: 'codex' }, selectedAgentPreset: 'cx' }));
    expect(inherit(v)).toBe('Inherit (project: sbx)');
  });

  it('maps antigravity to the agy key', () => {
    const v = open(st({ agentBackends: { agy: 'docker' }, defaultAgentProvider: 'antigravity' }));
    expect(inherit(v)).toBe('Inherit (project: docker)');
  });

  it('updates the label on a live core pick in create mode with no state push', () => {
    const v = open(st({ mode: 'create' }));
    expect(inherit(v)).toBe('Inherit (project: host)');
    pickCore(v, 'codex');
    expect(inherit(v)).toBe('Inherit (project: sbx)');
    pickCore(v, 'claude');
    expect(inherit(v)).toBe('Inherit (project: host)');
  });

  it('keeps the draft backend pick in the payload path (no set-backend post in create mode)', () => {
    const v = open(st({ mode: 'create' }));
    select(v).value = 'host';
    select(v).dispatchEvent(new Event('change', { bubbles: true }));
    expect(v.posted.some((m) => (m as { type: string }).type === 'set-backend')).toBe(false);
  });

  it('is hidden when no core selects a sandbox', () => {
    expect(picker(open(baseState({ mode: 'create', agentBackends: {} }))).classList.contains('hidden')).toBe(true);
    h?.close();
    expect(picker(open(baseState({ mode: 'edit', agentBackends: {} }))).classList.contains('hidden')).toBe(true);
  });

  it('stays visible with host selected for an opt-out on an empty map', () => {
    const v = open(baseState({ mode: 'edit', agentBackends: {}, selectedBackend: 'host' }));
    expect(picker(v).classList.contains('hidden')).toBe(false);
    expect(select(v).value).toBe('host');
  });

  it('disables the select while a session is open', () => {
    expect(select(open(st({ mode: 'edit', sessionOpen: true }))).disabled).toBe(true);
  });

  it('posts set-backend on change', () => {
    const v = open(st({ mode: 'edit', selectedBackend: null }));
    select(v).value = 'host';
    select(v).dispatchEvent(new Event('change', { bubbles: true }));
    expect(v.posted).toContainEqual(expect.objectContaining({ type: 'set-backend', id: 'host' }));
  });
});

describe('ticket form — graph role preview (T1266)', () => {
  const lines = (preset: string) => [
    { role: 'expert', text: `claude · expert-${preset}`, source: 'preset' },
    { role: 'worker', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
    { role: 'fast', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
  ];
  const approach = (id: string) => ({ id, label: id, description: '', recommended: false, installed: true, enabled: true });
  const st = (over: Record<string, unknown> = {}) =>
    baseState({
      approaches: [approach('dyn'), approach('classic')],
      selectedApproach: 'dyn',
      agentPresetNames: ['deep'],
      defaultAgentPreset: 'deep',
      selectedAgentPreset: null,
      defaultAgentProvider: 'claude',
      agentProviders: ['claude'],
      agentBackends: {},
      presetCores: {},
      graphRoles: { dyn: { '': lines('inherit'), deep: lines('deep') } },
      ...over,
    });
  const preview = (v: RenderHandle) => v.query<HTMLElement>('#graphRolesPreview')!;
  const hintOf = (v: RenderHandle) => preview(v).querySelector('.graph-roles-hint')!.textContent;

  it('shows the approach-profile lines for a ticket preset the manifest lacks, not the active preset (T1266 fix)', () => {
    const dangling = [{ role: 'expert', text: 'claude · dangling-profile', source: 'approach' }];
    const v = open(st({
      selectedAgentPreset: 'gone',
      graphRoles: { dyn: { '': lines('inherit'), deep: lines('deep'), '\u0000dangling': dangling } },
    }));
    expect(preview(v).textContent).toContain('dangling-profile');
    expect(preview(v).textContent).not.toContain('expert-inherit');
  });

  it('shows expert, worker and fast with their source when the approach has a graph', () => {
    const v = open(st());
    expect(preview(v).classList.contains('hidden')).toBe(false);
    const rows = v.queryAll('#graphRolesPreview [data-graph-role]');
    expect(rows.map((r) => r.getAttribute('data-graph-role'))).toEqual(['expert', 'worker', 'fast']);
    expect(rows[0]!.textContent).toContain('claude · expert-inherit');
    expect(rows[0]!.textContent).toContain('preset');
    expect(rows[1]!.textContent).toContain('approach');
  });

  it('follows the selected preset', () => {
    const v = open(st({ selectedAgentPreset: 'deep' }));
    expect(v.query('#graphRolesPreview [data-graph-role="expert"]')!.textContent).toContain('expert-deep');
  });

  it('tells to choose a Preset to change the models for this ticket (arch:AC-63)', () => {
    expect(hintOf(open(st()))).toBe('The preset sets these models. To change them for this ticket, choose a Preset above.');
  });

  it('a stale ticket core shows no single-agent text: the chips and hint stay preset/approach', () => {
    const v = open(st({ mode: 'edit', selectedAgentProvider: 'opencode2', selectedModel: 'kimi-k2', selectedEffort: 'max' }));
    expect(hintOf(v)).toBe('The preset sets these models. To change them for this ticket, choose a Preset above.');
    const chips = [...preview(v).querySelectorAll('.k-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['preset', 'approach', 'approach']);
    expect(preview(v).textContent).not.toContain('sets its own core');
  });

  const pickerOf = (v: RenderHandle) => v.query<HTMLElement>('#agentIdentityPicker')!;
  const segOf = (v: RenderHandle) => pickerOf(v).querySelector<HTMLElement>('[role="radiogroup"]')!;
  const fieldHidden = (v: RenderHandle, sel: string) =>
    (pickerOf(v).querySelector(sel)!.closest('.ap-field') as HTMLElement).hidden;

  it('a graph approach shows the preset only: no Core + model switch, core and model hidden', () => {
    const v = open(st({ mode: 'edit', selectedAgentProvider: 'opencode2' }));
    expect(segOf(v).hidden).toBe(true);
    expect(fieldHidden(v, '[data-ap-preset]')).toBe(false);
    expect(fieldHidden(v, '[data-ap-shell="core"]')).toBe(true);
    expect(fieldHidden(v, '[data-ap-shell="model"]')).toBe(true);
  });

  it('a non-graph approach keeps the Preset | Core + model switch', () => {
    const v = open(st({ selectedApproach: 'classic' }));
    expect(segOf(v).hidden).toBe(false);
    const radios = [...segOf(v).querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent?.trim())).toEqual(['Preset', 'Core + model']);
  });

  it('an approach pick re-mounts the picker: graph hides the switch, classic shows it again', () => {
    const v = open(st({ selectedApproach: 'classic' }));
    v.click('[data-approach="dyn"]');
    expect(segOf(v).hidden).toBe(true);
    v.click('[data-approach="classic"]');
    expect(segOf(v).hidden).toBe(false);
  });

  type AgentPayload = { agentProvider: unknown; model: unknown; effort: unknown; agentPreset: unknown };
  it('submit and save send a null core/model/effort for a graph approach and keep the preset', () => {
    const over = { title: 'fix: graph', selectedAgentProvider: 'opencode2', selectedModel: 'kimi-k2', selectedEffort: 'max', selectedAgentPreset: 'deep' };
    for (const btn of ['#submitBtn', '#saveBtn']) {
      const v = open(st(over));
      v.click(btn);
      const sent = v.posted.find((m) => ['submit', 'save'].includes((m as { type: string }).type)) as AgentPayload;
      expect(sent, btn).toMatchObject({ agentProvider: null, model: null, effort: null, agentPreset: 'deep' });
    }
  });

  it('submit keeps the core/model/effort for a non-graph approach', () => {
    const v = open(st({ title: 'fix: classic', selectedApproach: 'classic', selectedAgentProvider: 'claude', selectedModel: 'claude-sonnet-5', selectedEffort: 'high' }));
    v.click('#submitBtn');
    const sent = v.posted.find((m) => (m as { type: string }).type === 'submit') as AgentPayload;
    expect(sent).toMatchObject({ agentProvider: 'claude', model: 'claude-sonnet-5', effort: 'high' });
  });

  it('says the approach sets the models when every role comes from the approach (SET-51)', () => {
    const fromApproach = (preset: string) => [
      { role: 'expert', text: `claude · expert-${preset}`, source: 'approach' },
      { role: 'worker', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
      { role: 'fast', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
    ];
    const v = open(st({ graphRoles: { dyn: { '': fromApproach('inherit'), deep: fromApproach('deep') } } }));
    expect(hintOf(v)).toBe('The approach sets these models. To change them for this ticket, choose a Preset above.');
  });

  it('is hidden for an approach with no graph', () => {
    const v = open(st({ selectedApproach: 'classic' }));
    expect(preview(v).classList.contains('hidden')).toBe(true);
  });
});

describe('ticket form — a title-derived key is not a user-owned key', () => {
  it('two state pushes in create mode keep the key auto-derived on submit', () => {
    const v = open(baseState({ title: 'fix: the toasts built in sandbox' }));
    v.receive({ type: 'state', state: baseState({ title: 'fix: the toasts built in sandbox' }) });
    expect(v.query<HTMLInputElement>('#ref')!.value).not.toBe('');
    v.click('#submitBtn');
    const sub = v.posted.find((m) => (m as { type: string }).type === 'submit') as { keyAutoDerived: boolean };
    expect(sub.keyAutoDerived).toBe(true);
  });

  it('two state pushes in create mode keep the key auto-derived on save', () => {
    const v = open(baseState({ title: 'fix: the toasts built in sandbox' }));
    v.receive({ type: 'state', state: baseState({ title: 'fix: the toasts built in sandbox' }) });
    v.click('#saveBtn');
    const save = v.posted.find((m) => (m as { type: string }).type === 'save') as { keyAutoDerived: boolean };
    expect(save.keyAutoDerived).toBe(true);
  });

  it('a key that came from the state stays user-owned', () => {
    const v = open(baseState({ title: 'T', key: 'P-1', mode: 'edit', ticketId: 1 }));
    v.click('#submitBtn');
    const sub = v.posted.find((m) => (m as { type: string }).type === 'submit') as { keyAutoDerived: boolean };
    expect(sub.keyAutoDerived).toBe(false);
  });
});

describe('ticket form — honest states (SET-52, SET-53, SET-54)', () => {
  it('shows only the loading blocks and no active control before the first state (SET-53)', () => {
    h = renderWebview('ticketForm');
    const v = h;
    expect(v.query('#loadingContent')!.getAttribute('role')).toBe('status');
    expect(v.query('#loadingContent')!.textContent).toBe('Loading the ticket…');
    expect(v.query('#loadingSettings')!.getAttribute('role')).toBe('status');
    expect(v.query('#loadingSettings')!.textContent).toBe('Loading the ticket…');
    // Each block is the FIRST child of its region — the layout gate reads the regions in DOM order.
    expect(v.query('[data-region="content"]')!.firstElementChild).toBe(v.query('#loadingContent'));
    expect(v.query('[data-region="settings"]')!.firstElementChild).toBe(v.query('#loadingSettings'));
    // Nothing invites typing before anything loaded.
    expect(v.query<HTMLButtonElement>('#analyzeBtn')!.disabled).toBe(true);
    expect(v.document.body.classList.contains('is-ready')).toBe(false);
    // The hiding is declared CSS (jsdom cannot cascade it): every other child of
    // both regions is hidden until `is-ready`.
    const selectors = v.cssRules().map((rule) => rule.selectorText).join('\n');
    expect(selectors).toContain('body:not(.is-ready) [data-region="content"] > :not(#loadingContent)');
    expect(selectors).toContain('body:not(.is-ready) [data-region="settings"] > :not(#loadingSettings)');
  });

  it('replaces the loading state with the real regions on the first state (SET-53)', () => {
    const v = open(baseState());
    expect(v.document.body.classList.contains('is-ready')).toBe(true);
    const hideRule = v
      .cssRules()
      .find(
        (rule) =>
          rule.selectorText.includes('body.is-ready #loadingContent') &&
          rule.selectorText.includes('body.is-ready #loadingSettings'),
      );
    expect(hideRule?.style.display).toBe('none');
  });

  it('shows a host error that lands before the first state instead of the loading blocks (SET-53)', () => {
    h = renderWebview('ticketForm');
    const v = h;
    v.receive({ type: 'error', message: 'Could not build the ticket form: boom' });
    const err = v.query('#err')!;
    expect(err.classList.contains('hidden')).toBe(false);
    expect(v.query('#errMsg')!.textContent).toBe('Could not build the ticket form: boom');
    expect(v.document.body.classList.contains('is-ready')).toBe(false);
    expect(v.document.body.classList.contains('load-failed')).toBe(true);
    // jsdom cannot cascade: the pre-ready hide rule must spare #err, and a
    // failed load must stop the loading blocks from claiming "Loading…".
    const rules = v.cssRules();
    const selectors = rules.map((rule) => rule.selectorText).join('\n');
    expect(selectors).toContain('body:not(.is-ready) [data-region="content"] > :not(#loadingContent):not(#err)');
    const failRule = rules.find(
      (rule) =>
        rule.selectorText.includes('body.load-failed #loadingContent') &&
        rule.selectorText.includes('body.load-failed #loadingSettings'),
    );
    expect(failRule?.style.display).toBe('none');
  });

  it('drops the load-failed state when a state finally lands (SET-53)', () => {
    h = renderWebview('ticketForm');
    const v = h;
    v.receive({ type: 'error', message: 'boom' });
    v.receive({ type: 'state', state: baseState() });
    expect(v.document.body.classList.contains('load-failed')).toBe(false);
    expect(v.document.body.classList.contains('is-ready')).toBe(true);
  });

  it('an error after the form is ready does not mark the load as failed (SET-53)', () => {
    const v = open(baseState());
    v.receive({ type: 'error', message: 'Save failed' });
    expect(v.document.body.classList.contains('load-failed')).toBe(false);
  });

  it('renders a fetch failure under the Key row and clears it on the next state (SET-52)', () => {
    const v = open(baseState({ provider: 'clickup' }));
    v.receive({
      type: 'fetch-error',
      message: 'Could not fetch FEAT-9999: the provider returned 404 (check the list id).',
    });
    const err = v.query('#fetchErr')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.classList.contains('hidden')).toBe(false);
    expect(err.textContent).toContain('404');
    // In the Source block, directly after the key row (the #createInErr pattern).
    expect(v.query('#sourceBlock')!.contains(err)).toBe(true);
    expect(err.previousElementSibling!.id).toBe('keyRow');
    // The page bucket stays empty: a fetch failure is not a host error.
    expect(v.query('#err')!.classList.contains('hidden')).toBe(true);

    v.receive({ type: 'state', state: baseState({ provider: 'clickup' }) });
    expect(v.query('#fetchErr')!.classList.contains('hidden')).toBe(true);
  });

  it('shows a Re-fetch failure on a bound ticket, where the key row is hidden (SET-52)', () => {
    const v = open(baseState({ provider: 'clickup', mode: 'edit', ticketId: 7, sourceRef: 'abc123' }));
    expect(v.query('#keyRow')!.classList.contains('hidden')).toBe(true);
    v.click('#refetchBtn');
    v.receive({ type: 'fetch-error', message: 'Could not fetch abc123: the provider returned 404.' });
    const err = v.query('#fetchErr')!;
    expect(err.classList.contains('hidden')).toBe(false);
    // No ancestor hides it: the error is visible beside the Re-fetch control it came from.
    expect(err.closest('.hidden, [hidden]')).toBeNull();
    expect(err.textContent).toContain('404');
  });

  it('keeps host errors in a danger callout with the alert-triangle icon (SET-52)', () => {
    const v = open(baseState());
    v.receive({ type: 'error', message: 'Could not save the draft.' });
    const box = v.query('#err')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.classList.contains('callout')).toBe(true);
    expect(box.classList.contains('callout--danger')).toBe(true);
    expect(box.classList.contains('hidden')).toBe(false);
    expect(v.query('#errMsg')!.textContent).toBe('Could not save the draft.');
    expect(v.query('#err .callout-icon svg')).not.toBeNull();
  });

  it('keeps the three usage-limit park actions inside the callout (SET-52, D159)', () => {
    const v = open(baseState());
    v.receive({
      type: 'error',
      message: 'Claude Code usage limit reached — monthly quota exceeded. Pick another agent/model, retry, or dismiss.',
      usageLimitParkId: 7,
    });
    const acts = v.queryAll('#errMsg [data-act]').map((b) => b.getAttribute('data-act'));
    expect(acts).toEqual([
      'usage-limit-park-pick',
      'usage-limit-park-retry',
      'usage-limit-park-dismiss',
    ]);
    expect(v.query('#errMsg')!.textContent).toContain('Claude Code usage limit reached');
    v.click('#errMsg [data-act="usage-limit-park-retry"]');
    expect(v.posted).toContainEqual({ type: 'usage-limit-park-retry', parkId: 7 });
  });
});

describe('ticket form — Cancel asks only when the form was edited (SET-54, Q13)', () => {
  it('a clean form posts a plain close-form', () => {
    const v = open(baseState());
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form' });
  });

  it('a typed field posts dirty: true', () => {
    const v = open(baseState());
    const title = v.query<HTMLTextAreaElement>('#title')!;
    title.value = 'Typed but not saved';
    title.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
  });

  it('a settings change posts dirty: true', () => {
    const v = open(baseState());
    v.query('#typeSelect')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
  });

  describe('a create-mode pick that is not a native change event still makes Cancel ask', () => {
    const repos = [
      { service: 'api', selected: true, score: 3 },
      { service: 'web', selected: false, score: 0 },
    ];
    const repoBases = [{ repo: 'api', default: 'main', value: '', candidates: ['main', 'epic/x'] }];
    const approaches = [
      { id: 'direct', label: 'Direct', description: 'd' },
      { id: 'rpi', label: 'RPI', description: 'r' },
    ];
    const st = () => baseState({ repos, repoBases, approaches, selectedApproach: 'direct' });
    const cancelPosts = (v: RenderHandle) => {
      v.click('#cancelBtn');
      return v.posted.at(-1);
    };

    it('a core pick from the agent menu', () => {
      const v = open(st());
      v.click('[data-ap-trigger="core"]');
      const option = v.query<HTMLElement>('#agentIdentityPicker [data-ap-core]')!;
      expect(option).toBeTruthy();
      option.click();
      expect(v.posted.some((m) => (m as { type: string }).type === 'set-provider')).toBe(true);
      expect(cancelPosts(v)).toEqual({ type: 'close-form', dirty: true });
    });

    it('a repository chip toggle', () => {
      const v = open(st());
      v.click('[data-repo="web"]');
      expect(cancelPosts(v)).toEqual({ type: 'close-form', dirty: true });
    });

    it('a base-branch pick', () => {
      const v = open(st());
      v.click('[data-base-caret="api"]');
      v.click('[data-base-pick="epic/x"]');
      expect(cancelPosts(v)).toEqual({ type: 'close-form', dirty: true });
    });

    it('an approach pick', () => {
      const v = open(st());
      v.click('#approachBtn');
      v.click('[data-approach="rpi"]');
      expect(v.posted).toContainEqual(expect.objectContaining({ type: 'set-approach', id: 'rpi' }));
      expect(cancelPosts(v)).toEqual({ type: 'close-form', dirty: true });
    });
  });

  describe('a form switch the host never stores makes Cancel ask, in both modes', () => {
    const modes = [
      ['create', baseState()],
      ['edit', baseState({ mode: 'edit', ticketId: 7, key: 'K-7', title: 'T' })],
    ] as const;
    for (const [mode, state] of modes) {
      for (const id of ['pullBase', 'autoImprove']) {
        it(`${mode}: #${id}`, () => {
          const v = open(state);
          v.click(`#${id}`);
          v.click('#cancelBtn');
          expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
        });
      }
    }

    it('create: #createIn', () => {
      const v = open(baseState({ provider: 'clickup', canCreateProviderTicket: true }));
      v.click('#createIn');
      v.click('#cancelBtn');
      expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
    });
  });

  it('in edit mode a settings pick posts a plain close-form: the host already stored it', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'K-7', title: 'T' }));
    v.query('#typeSelect')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form' });
  });

  it('in edit mode a typed field still posts dirty: true', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'K-7', title: 'T' }));
    const title = v.query<HTMLTextAreaElement>('#title')!;
    title.value = 'T edited';
    title.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
  });

  it('the search status filter is not an edit', () => {
    const v = open(baseState({ provider: 'clickup' }));
    v.query('#searchStatus')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form' });
  });

  it('a settings change that Save draft stored posts a plain close-form', () => {
    const v = open(baseState({ title: 'Saved title' }));
    v.query('#typeSelect')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.click('#saveBtn');
    v.receive({ type: 'draft-saved' });
    v.receive({ type: 'busy', what: 'save', on: false });
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form' });
  });

  it('a settings change while the save runs stays dirty', () => {
    const v = open(baseState({ title: 'Saved title' }));
    v.click('#saveBtn');
    v.query('#typeSelect')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.receive({ type: 'draft-saved' });
    v.receive({ type: 'busy', what: 'save', on: false });
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
  });

  it('a settings change stays dirty when the save fails', () => {
    const v = open(baseState({ title: 'Saved title' }));
    v.query('#typeSelect')!.dispatchEvent(new v.window.Event('change', { bubbles: true }));
    v.click('#saveBtn');
    v.receive({ type: 'error', message: 'Save failed' });
    v.receive({ type: 'busy', what: 'save', on: false });
    v.click('#cancelBtn');
    expect(v.posted.at(-1)).toEqual({ type: 'close-form', dirty: true });
  });
});

describe('ticket form — content and settings polish (SET-55/58/59/60/61/62)', () => {
  it('hides the base-branch hint when no repository can offer a ▾ (SET-58)', () => {
    const v = open(baseState());
    const hint = v.query<HTMLElement>('#repoHint')!;
    expect(hint.classList.contains('hidden')).toBe(true);
    expect(hint.textContent).toBe('Click ▾ on a repository to pick its base branch.');
  });

  it('shows the base-branch hint once repository chips render (SET-58)', () => {
    const v = open(baseState({ repos: [{ service: 'api', selected: false, score: 0 }] }));
    expect(v.query('#repoHint')!.classList.contains('hidden')).toBe(false);
  });

  it('makes the selected-chip branch text contrast-safe and the override underlined (SET-59)', () => {
    const v = open(baseState());
    const branch = v
      .cssRules()
      .find((r) => r.selectorText === '.repochip[aria-pressed="true"] .repo-branch');
    expect(branch?.style.color.toLowerCase()).toBe('currentcolor');
    const overridden = v
      .cssRules()
      .find((r) => r.selectorText === '.repo-branch.is-overridden');
    expect(overridden?.style.color).toBe('var(--k-warning)');
    expect(overridden?.style.textDecoration).toContain('underline');
  });

  it('shows one honest line and the show-session primary while a session runs (SET-60)', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'P-1', title: 'T', sessionOpen: true }));
    const hint = v.query<HTMLElement>('#sessionHint')!;
    expect(hint.classList.contains('hidden')).toBe(false);
    expect(hint.textContent).toBe('Changes apply on the next start.');
    expect(v.query('#submitBtn')!.textContent).toBe('Save & show session');
  });

  it('keeps the ordinary labels and hides the session line without a session (SET-60)', () => {
    const v = open(baseState({ mode: 'edit', ticketId: 7, key: 'P-1', title: 'T' }));
    expect(v.query('#sessionHint')!.classList.contains('hidden')).toBe(true);
    expect(v.query('#submitBtn')!.textContent).toBe('Save & start');
  });

  it('keeps the create labels even if a session flag leaked into a create state (SET-60)', () => {
    const v = open(baseState({ sessionOpen: true }));
    expect(v.query('#submitBtn')!.textContent).toBe('Create & start');
  });

  it('grows the title in a one-row textarea and blocks Enter (SET-61)', () => {
    const v = open(baseState({ title: 'A long title' }));
    const title = v.query<HTMLTextAreaElement>('#title')!;
    expect(title.tagName).toBe('TEXTAREA');
    expect(title.getAttribute('rows')).toBe('1');
    expect(title.value).toBe('A long title');
    const ev = new v.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    title.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('measures the title height again when the panel width changes (SET-61)', () => {
    const v = open(baseState({ title: 'A long title that wraps when the panel gets narrow' }));
    const title = v.query<HTMLTextAreaElement>('#title')!;
    // A narrower panel wraps the title onto more lines: jsdom has no layout, so stub the new content height.
    Object.defineProperty(title, 'scrollHeight', { configurable: true, get: () => 64 });
    v.window.dispatchEvent(new v.window.Event('resize'));
    expect(title.style.height).toBe('64px');
  });

  it('turns a pasted line break in the title into a space (SET-61)', () => {
    const v = open(baseState());
    const title = v.query<HTMLTextAreaElement>('#title')!;
    title.value = 'First line\nsecond line';
    title.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    expect(title.value).toBe('First line second line');
  });

  it('renders the host-built Key placeholder (SET-62)', () => {
    const v = open(baseState({ keyPlaceholder: 'e.g. 869e889uh' }));
    expect(v.query('#ref')!.getAttribute('placeholder')).toBe('e.g. 869e889uh');
  });

  it('names the effort field "Effort" in this page (SET-62)', () => {
    const v = open(baseState());
    expect(
      v.query('#agentIdentityPicker .ap-effort-field .ap-label')!.textContent,
    ).toBe('Effort');
  });

  it('keeps one "Acceptance check" label (SET-62)', () => {
    const v = open(baseState());
    const labels = v.queryAll('label[for="intent"]');
    expect(labels.map((l) => l.textContent)).toEqual(['Acceptance check']);
  });
});
