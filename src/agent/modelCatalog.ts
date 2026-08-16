import type { AgentProvider } from '../manifest/types.js';

/** Model capability tags (closed vocabulary). Display + future capability
 *  checks; an unknown tag invalidates the provider section at validation. */
export const MODEL_TAGS = ['multimodal', 'text-only', 'audio', 'vision'] as const;
export type ModelTag = (typeof MODEL_TAGS)[number];

export interface ModelOption {
  /** The `--model` value passed to the agent CLI. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Agent CLIs that accept this exact model id. */
  providers: readonly AgentProvider[];
  /**
   * Effort values this model advertises (design § Execution policy
   * resolution). Absent → the model accepts NO effort value — an explicitly
   * configured effort is then a configuration failure at Save, never silently
   * discarded. Mirrored into `model-catalog.json` (the equality test pins both
   * copies). A custom user-typed model id is not in the catalog, so it has no
   * efforts — intended conservative behavior.
   */
  efforts?: readonly string[];
  /**
   * Model capability tags (closed vocabulary, see `MODEL_TAGS`). Absent →
   * the model's capabilities are unknown, which is a claim of nothing. The
   * live CLI tiers report id/label only, so discovered models carry no tags;
   * only the curated bundled catalog and the published feed supply them.
   * Mirrored into `model-catalog.json` (the equality test pins both copies).
   */
  tags?: readonly ModelTag[];
}

export type ModelCatalog = Readonly<Record<AgentProvider, readonly ModelOption[]>>;

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
const EFFORT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const BUNDLED_CATALOG: ModelCatalog = {
  claude: [
    { id: 'claude-opus-5', label: 'Opus 5', providers: ['claude'], efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], tags: ['multimodal', 'vision'] },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', providers: ['claude'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision'] },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', providers: ['claude'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision'] },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', providers: ['claude'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision'] },
    { id: 'claude-fable-5', label: 'Fable 5', providers: ['claude'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision'] },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', providers: ['codex'], efforts: ['minimal', 'low', 'medium', 'high'], tags: ['multimodal', 'vision'] },
  ],
  antigravity: [
    { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)', providers: ['antigravity'], efforts: ['low', 'medium', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', providers: ['antigravity'], efforts: ['low', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', providers: ['antigravity'], efforts: ['low', 'high'], tags: ['multimodal', 'vision', 'audio'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', providers: ['antigravity'], tags: ['multimodal', 'vision'] },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', providers: ['antigravity'], tags: ['multimodal', 'vision'] },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', providers: ['antigravity'], tags: ['text-only'] },
  ],
  opencode: [],
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

    // `efforts` is optional; when present it must be a duplicate-free list of
    // bounded, safe values — a malformed list invalidates the whole section,
    // exactly like any other malformed field (a silently accepted effort value
    // would later surface as an opaque CLI rejection at launch).
    let efforts: readonly string[] | undefined;
    if (entry.efforts !== undefined) {
      if (!Array.isArray(entry.efforts) || entry.efforts.length === 0) return undefined;
      const seen = new Set<string>();
      for (const raw of entry.efforts) {
        if (typeof raw !== 'string') return undefined;
        const value = raw.trim();
        if (!EFFORT_VALUE.test(value) || seen.has(value)) return undefined;
        seen.add(value);
      }
      efforts = [...seen];
    }

    // `tags` is optional; when present it must be a duplicate-free list of
    // closed-vocabulary values — a malformed list invalidates the whole
    // section exactly like any other malformed field, and an unknown tag is
    // malformed: a future capability check must be able to trust every tag it
    // sees.
    let tags: readonly ModelTag[] | undefined;
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags) || entry.tags.length === 0) return undefined;
      const seen = new Set<ModelTag>();
      for (const raw of entry.tags) {
        if (typeof raw !== 'string') return undefined;
        const value = raw.trim() as ModelTag;
        if (!EFFORT_VALUE.test(value) || !MODEL_TAGS.includes(value) || seen.has(value)) {
          return undefined;
        }
        seen.add(value);
      }
      tags = [...seen];
    }

    ids.add(id);
    models.push({
      id, label, providers: [provider],
      ...(efforts ? { efforts } : {}),
      ...(tags ? { tags } : {}),
    });
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
      const raw = providers[provider];
      // An EXPLICITLY empty section is a deliberate curated-empty list (opencode
      // curates zero rows) and is preserved as such; an absent section stays
      // absent so the loader can fall through to the bundled/cache tiers.
      if (Array.isArray(raw) && raw.length === 0) return [[provider, []]];
      const models = validateModelList(provider, raw);
      return models === undefined ? [] : [[provider, models]];
    }),
  ) as Partial<ModelCatalog>;
}

/** The offline catalog included with the extension. */
export function bundledModelCatalog(): ModelCatalog {
  return BUNDLED_CATALOG;
}
