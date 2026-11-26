/** The ticket-form variants (ui:VISUAL-VARIANTS). */
import { getCorpus, MINIMAL_TICKET_FORM } from '../corpora.js';
import { REALISTIC_TICKET_FORM, ROUTED_MODEL_CATALOG } from '../realisticTicketForm.js';
import {
  ALL_THEMES,
  BOTTOM_EDGE_HEIGHT,
  LOADING,
  LONG_TITLE,
  variant,
  stateMessage,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

const BRIEF_FULL = {
  title: 'Add per-repo base branch override',
  description: Array.from({ length: 2 }, (_, i) => `Requirement line ${i + 1}: keep the manifest baseline as the default.`).join('\n'),
  tags: ['frontend', 'picker'],
  status: 'in progress',
  priority: 'high',
  people: [
    { name: 'Jo Lee', role: 'assignee' },
    { name: 'Mika Kato', role: 'reporter' },
  ],
  attachments: [{ name: 'current-picker.png', url: 'https://app.clickup.com/a/1' }],
  comments: [
    { author: 'Mika Kato', text: 'Design attached. '.repeat(3), date: '2026-10-29T10:30:00Z' },
  ],
  url: 'https://app.clickup.com/t/869e889uh',
};
const BRIEF_MINIMAL = {
  title: 'Add per-repo base branch override',
  description: 'Let a ticket pick its base branch per repository.',
  tags: [],
  comments: [],
  attachments: [],
  url: 'https://app.clickup.com/t/869e889uh',
};

export const ticketFormVariants = (): Variant[] => {
  const base = MINIMAL_TICKET_FORM;
  const withState = (patch: Record<string, unknown>): ViewCorpus => stateMessage({ ...base, ...patch });
  const edit = {
    mode: 'edit',
    ticketId: 42,
    refLabel: 'T42 · FEAT-42',
    key: 'FEAT-42',
    title: 'Add per-repo override to the picker',
    description: 'Let a ticket pick its base branch per repository.',
    stepper: [],
    attachments: [],
  };
  const editCoreModel = () =>
    withState({
      ...edit,
      agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
      agentPresetNames: ['fast', 'deep'],
      selectedAgentPreset: null,
      selectedAgentProvider: 'claude',
      defaultAgentProvider: 'claude',
      selectedModel: 'claude-sonnet-5',
      selectedEffort: 'high',
      modelCatalog: ROUTED_MODEL_CATALOG,
      recentModels: {},
      sessionOpen: false,
    });
  // T1266: the Dynamic Graph approach is selected, so the settings region lists expert / worker / fast.
  const graphRoles = () =>
    withState({
      ...edit,
      approaches: [{ id: 'karst-graph-engineering', label: 'Dynamic Graph', description: '', recommended: true, installed: true, enabled: true }],
      selectedApproach: 'karst-graph-engineering',
      agentPresetNames: ['fast', 'deep'],
      selectedAgentPreset: 'deep',
      defaultAgentPreset: 'fast',
      // SET-35: `describeGraphRoles` prints the core and model labels, never the raw
      // ids. The fixture bypasses the host, so it carries the labelled shape.
      graphRoles: {
        'karst-graph-engineering': {
          deep: [
            { role: 'expert', text: 'Codex · GPT-5.6 Sol · high', source: 'preset' },
            { role: 'worker', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
            { role: 'fast', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
          ],
        },
      },
    });
  // T1308 (arch:AC-63): a legacy graph ticket whose row still holds a stale core, model and
  // effort. The picker shows the preset only, and the chips stay preset/approach.
  const graphRolesLegacyCore = () =>
    withState({
      ...edit,
      approaches: [{ id: 'karst-graph-engineering', label: 'Dynamic Graph', description: '', recommended: true, installed: true, enabled: true }],
      selectedApproach: 'karst-graph-engineering',
      agentProviders: ['claude', 'codex', 'opencode2'],
      agentPresetNames: ['fast', 'deep'],
      selectedAgentPreset: null,
      defaultAgentPreset: 'fast',
      selectedAgentProvider: 'opencode2',
      selectedModel: 'kimi-k2',
      selectedEffort: 'max',
      graphRoles: {
        'karst-graph-engineering': {
          '': [
            { role: 'expert', text: 'Antigravity · Gemini 4 Neon · high', source: 'preset' },
            { role: 'worker', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
            { role: 'fast', text: 'Claude Code · Sonnet 5.5 · low', source: 'approach' },
          ],
        },
      },
    });
  return [
    // SET-63: the role preview's shared labels at every theme, not dark only.
    variant('ticketForm', 'graph-roles', graphRoles, { themes: ALL_THEMES }),
    variant('ticketForm', 'graph-roles-legacy-core', graphRolesLegacyCore),
    variant('ticketForm', 'graph-roles-legacy-core-tight-320', graphRolesLegacyCore, { width: 320 }),
    // T1357: the realistic create page (`getCorpus`), so it differs from `empty`. SET-63: every theme, for the light
    // input edge and the HC switch/primary edge (SET-56/57).
    variant('ticketForm', 'populated', () => getCorpus('ticketForm'), { baseline: 'ticketForm', themes: ALL_THEMES }),
    variant('ticketForm', 'empty', () => withState({})),
    variant('ticketForm', 'loading', LOADING),
    // SET-52: a fetch failure has its own message and renders under the Key row,
    // not in the page-level bucket above the title.
    variant(
      'ticketForm',
      'error',
      () => ({
        messages: [
          ...withState({}).messages,
          { type: 'fetch-error', message: 'Could not fetch FEAT-9999: the provider returned 404 (check the list id).' },
        ],
      }),
      // SET-63: the fetch error is a contrast surface, so light and HC record it too.
      { themes: ALL_THEMES },
    ),
    // D159: an op that died on quota carries its park id, so the error notification
    // offers Pick agent/model, Retry same and Dismiss.
    variant('ticketForm', 'usage-limit-error', () => ({
      messages: [
        ...withState({}).messages,
        {
          type: 'error',
          // SET-52: the real shape of a quota failure — the product name, never a
          // raw provider id ("anthropic: …").
          message: 'Claude Code usage limit reached — monthly quota exceeded. Pick another agent/model, retry, or dismiss.',
          usageLimitParkId: 7,
        },
      ],
    })),
    variant('ticketForm', 'long-content', () =>
      withState({ ...edit, key: 'FEAT-'.concat('9'.repeat(40)), title: LONG_TITLE, description: `${LONG_TITLE}. `.repeat(40) }),
    ),
    variant('ticketForm', 'edit', () => withState(edit)),
    // T838 (ui:UI-R57): the provider-derived "Also create in <badge>" switch.
    variant('ticketForm', 'clickup-create-in', () =>
      withState({ provider: 'clickup', canCreateProviderTicket: true }),
    ),
    // T777: the shared picker's routed-model stack — the route mark, the model
    // name over its gateway vendor, and the `free` tag. Seeded in the TICKET
    // FORM because its full-page baseline is the only picker host whose picker
    // sits inside the captured area: the Agents Roles table lives in an
    // internal scroll region below the settings page's 720px crop, so an
    // agents-* baseline can never show it.
    variant(
      'ticketForm',
      'routed-model',
      () =>
        withState({
          ...edit,
          title: 'Route the picker through OpenRouter',
          description: 'A multi-provider model id, read at a glance.',
          agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
          selectedAgentProvider: 'opencode2',
          defaultAgentProvider: 'opencode2',
          selectedModel: 'openrouter/mancer/weaver',
          defaultModel: 'opencode-go/deepseek-v4.1-flash',
          selectedEffort: null,
          defaultEffort: null,
          modelCatalog: ROUTED_MODEL_CATALOG,
          recentModels: {},
          sessionOpen: false,
        }),
      { themes: ALL_THEMES },
    ),
    // T839: the picker's opt-in Preset | Core + model switch. `agent-preset` is
    // the preset tab (core/model/effort hidden); `agent-core-model` is the
    // core tab with all three controls, the effort showing because the
    // model advertises efforts.
    variant('ticketForm', 'agent-preset', () =>
      withState({
        ...edit,
        agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
        agentPresetNames: ['fast', 'deep'],
        selectedAgentPreset: 'fast',
        modelCatalog: ROUTED_MODEL_CATALOG,
        recentModels: {},
        sessionOpen: false,
      }),
    ),
    variant('ticketForm', 'agent-core-model', () =>
      withState({
        ...edit,
        agentProviders: ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'],
        agentPresetNames: ['fast', 'deep'],
        selectedAgentPreset: null,
        selectedAgentProvider: 'claude',
        defaultAgentProvider: 'claude',
        selectedModel: 'claude-sonnet-5',
        selectedEffort: 'high',
        modelCatalog: ROUTED_MODEL_CATALOG,
        recentModels: {},
        sessionOpen: false,
      }),
    ),
    // A1 (T885): edit + core+model at the widest and narrowest tiers — the actions
    // footer must never cover the settings column.
    variant('ticketForm', 'edit-core-model-tight', editCoreModel, { width: 1212 }),
    variant('ticketForm', 'edit-core-model-tight-320', editCoreModel, { width: 320 }),
    // Layout B′ (ui:UI-R57, prototype docs/design/ticket-form-b-prime.html). The realistic
    // create page at every theme is the `populated` variant (T1357, it was `realistic-create`).
    // SET-56 proof (T1301): the Auto-improve switch goes Off while Pull base stays On,
    // so one HC shot holds both switch states and the 3:1 track edge. The toggle changes
    // no geometry, so it shares the populated page's covered layout instead of a new page
    // (a variant with no dark fixture page cannot join the dark-only layout project).
    variant('ticketForm', 'realistic-create-switches', () => withState(REALISTIC_TICKET_FORM), {
      themes: ['hc'],
      clicks: ['#autoImprove'],
      skipLayout: true,
    }),
    variant('ticketForm', 'realistic-edit', () =>
      withState({ ...REALISTIC_TICKET_FORM, ...edit, title: REALISTIC_TICKET_FORM.title, refLabel: 'T42 · FEAT-42' }),
    ),
    variant('ticketForm', 'subtask', () =>
      withState({
        ...REALISTIC_TICKET_FORM,
        subtaskOf: 'Sub-task of T12',
        repoBases: [
          { repo: 'karst', value: '', default: 'karst/feat/parent', defaultLabel: 'parent branch: karst/feat/parent (default)', source: 'parent', candidates: [] },
        ],
      }),
    ),
    variant('ticketForm', 'session-open', () =>
      withState({ ...REALISTIC_TICKET_FORM, ...edit, title: REALISTIC_TICKET_FORM.title, sessionOpen: true }),
    ),
    variant('ticketForm', 'narrow-480', () => withState(REALISTIC_TICKET_FORM), { width: 480 }),
    variant('ticketForm', 'tight-320', () => withState(REALISTIC_TICKET_FORM), { width: 320 }),
    // D287: the inline brief card — expanded with meta, attachment and comments,
    // and the minimal tags-only brief; the approach picker with descriptions; a
    // manual ticket's header.
    variant('ticketForm', 'brief-expanded', () => ({
      messages: [
        ...withState({ ...REALISTIC_TICKET_FORM, attachments: [], description: '' }).messages,
        { type: 'brief', brief: BRIEF_FULL },
      ],
    })),
    variant('ticketForm', 'brief-minimal', () => ({
      messages: [
        ...withState(REALISTIC_TICKET_FORM).messages,
        { type: 'brief', brief: BRIEF_MINIMAL },
      ],
    })),
    // SET-65: the open approach list, not a second copy of the closed form.
    variant('ticketForm', 'approach-picker', () => withState(REALISTIC_TICKET_FORM), { click: '#approachBtn' }),
    // T1091: the approach, agent and base popovers near the bottom edge of a short window.
    variant('ticketForm', 'approach-picker-bottom-edge', () => withState(REALISTIC_TICKET_FORM), {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      capture: 'viewport',
      click: '#approachBtn',
    }),
    variant('ticketForm', 'agent-picker-bottom-edge', editCoreModel, {
      skipLayout: true,
      width: 800,
      viewportHeight: BOTTOM_EDGE_HEIGHT,
      capture: 'viewport',
      click: '[data-ap-trigger="core"]',
    }),
    // T1301 (RD-AGENT-MENU): the open agent-core menu at the wide 799-tall window must end above the sticky
    // action bar (or open above its trigger), leaving all three footer buttons visible.
    variant('ticketForm', 'agent-picker-open', editCoreModel, {
      viewportHeight: 799,
      capture: 'viewport',
      click: '[data-ap-trigger="core"]',
    }),
    variant('ticketForm', 'manual-provider', () => withState({ ...REALISTIC_TICKET_FORM, provider: 'manual', sourceRef: '' })),
    variant('ticketForm', 'attachments', () =>
      withState({
        ...edit,
        attachments: [
          { id: 1, kind: 'image', name: 'screenshot-of-the-failing-layout-at-480px-width.png', byteSize: 48213, src: '' },
          { id: 2, kind: 'file', name: 'trace.zip', byteSize: 2_345_678, src: '' },
        ],
      }),
    ),
  ];
};
