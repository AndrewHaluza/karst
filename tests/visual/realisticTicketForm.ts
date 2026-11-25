/**
 * The realistic ticket form state (Layout B′, ui:UI-R57). `corpora.ts` seeds the populated ticketForm page from it
 * (T1357), and `variants.ts` builds the named states from it. It lives here so that neither file imports the other.
 */
/**
 * The routed-model catalog the `routed-model` variant seeds: a gateway with a
 * vendor segment (OpenRouter), a vendor-less subscription route (OpenCode Go),
 * a `:free` suffix and a `-free` suffix — the id shapes the picker must read.
 */
export const ROUTED_MODEL_CATALOG = {
  claude: [{ id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'], efforts: ['low', 'medium', 'high'] }],
  codex: [],
  antigravity: [],
  opencode: [],
  opencode2: [
    {
      id: 'opencode-go/deepseek-v4.1-flash',
      label: 'OpenCode Go \u00b7 DeepSeek v4.1 Flash',
      providers: ['opencode2'],
      efforts: ['low', 'high', 'max'],
    },
    { id: 'openrouter/mancer/weaver', label: 'weaver', providers: ['opencode2'] },
    { id: 'openrouter/liquid/lfm-2.5-2.6b:free', label: 'LFM 2.5 2.6B', providers: ['opencode2'] },
    { id: 'opencode/big-pickle-free', label: 'big-pickle-free', providers: ['opencode2'] },
  ],
};

/** Layout B′ realistic state (ui:UI-R57): clickup, 3 repos (one non-runnable), 3 described approaches, 2 presets, 1 attachment. */
export const REALISTIC_TICKET_FORM = {
  provider: 'clickup',
  ticketSearchEnabled: true,
  canCreateProviderTicket: true,
  sourceRef: '869e889uh',
  title: 'Add per-repo base branch override to the ticket form',
  description: 'Let a ticket pick its base branch per repository, defaulting to the manifest baseline.',
  intent: 'Pick a base branch per repo, save, and confirm the worktree starts from it.',
  repos: [
    { service: 'karst', signals: [], score: 0, runnable: true, docker: false, selected: true },
    { service: 'docs-site', signals: [], score: 0, runnable: true, docker: false, selected: false },
    { service: 'infra', signals: [], score: 0, runnable: false, docker: false, selected: false },
  ],
  repoBases: [
    { repo: 'karst', value: '', default: 'develop', source: 'manifest', candidates: ['develop', 'main'] },
  ],
  approaches: [
    { id: 'tdd', label: 'TDD', description: 'Write failing tests first, then the smallest change.', recommended: true, installed: true },
    { id: 'research', label: 'Research first', description: 'Investigate and write findings before any code.', installed: true },
    { id: 'quick', label: 'Quick fix', description: 'Small, low-risk edit without a plan.', installed: true },
  ],
  selectedApproach: 'tdd',
  agentProviders: ['claude', 'codex'],
  agentPresetNames: ['fast', 'deep'],
  selectedAgentPreset: 'fast',
  modelCatalog: ROUTED_MODEL_CATALOG,
  recentModels: {},
  sessionOpen: false,
  attachments: [{ id: 1, kind: 'image', name: 'layout-at-480px.png', byteSize: 48213, src: '' }],
};
