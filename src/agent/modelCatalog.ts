import type { AgentProvider } from '../manifest/types.js';

export interface ModelOption {
  /** The `--model` value passed to the agent CLI. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Agent CLIs that accept this exact model id. */
  providers: readonly AgentProvider[];
}

export type ModelCatalog = Readonly<Record<AgentProvider, readonly ModelOption[]>>;

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

const BUNDLED_CATALOG: ModelCatalog = {
  claude: [
    { id: 'claude-opus-4-8', label: 'Opus 4.8', providers: ['claude'] },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', providers: ['claude'] },
    { id: 'claude-fable-5', label: 'Fable 5', providers: ['claude'] },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'] },
  ],
  antigravity: [
    { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', providers: ['antigravity'] },
    { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', providers: ['antigravity'] },
    { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', providers: ['antigravity'] },
    { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)', providers: ['antigravity'] },
    { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', providers: ['antigravity'] },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)', providers: ['antigravity'] },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', providers: ['antigravity'] },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', providers: ['antigravity'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', providers: ['antigravity'] },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', providers: ['antigravity'] },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', providers: ['antigravity'] },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one independently sourced provider list. A list is usable only when
 * every entry is valid, unique, and non-empty.
 */
export function validateModelList(
  provider: AgentProvider,
  value: unknown,
): ModelOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const ids = new Set<string>();
  const models: ModelOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string') {
      return undefined;
    }

    const id = entry.id.trim();
    const label = entry.label.trim();
    if (
      !MODEL_ID.test(id)
      || label.length === 0
      || label.length > 160
      || CONTROL_CHARACTER.test(label)
      || ids.has(id)
    ) {
      return undefined;
    }

    ids.add(id);
    models.push({ id, label, providers: [provider] });
  }
  return models;
}

/** Parse a versioned feed, isolating malformed provider sections. */
export function parseModelFeed(value: unknown): Partial<ModelCatalog> {
  if (!isRecord(value) || value.version !== 1) return {};
  const providers = value.providers;
  if (!isRecord(providers)) return {};

  return Object.fromEntries(
    PROVIDERS.flatMap((provider) => {
      const models = validateModelList(provider, providers[provider]);
      return models === undefined ? [] : [[provider, models]];
    }),
  ) as Partial<ModelCatalog>;
}

/** The offline catalog included with the extension. */
export function bundledModelCatalog(): ModelCatalog {
  return BUNDLED_CATALOG;
}
