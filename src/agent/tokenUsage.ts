/**
 * Token counts for one headless agent-CLI run — read from what the provider
 * reported, never guessed when it reported anything (§ token consumption stats).
 *
 * The shape of that report differs per agent core and the module deliberately
 * does NOT branch on the core: `claude -p --output-format json` prints one
 * whole-document envelope carrying a single `usage`, `codex exec --json` prints
 * JSONL where the interesting event is never line 1, and a future core will do
 * a third thing. That is the same reading problem `cliFailure.ts` solves for the
 * human sentence, so it is solved the same way — scan both encodings, take the
 * keys wherever they sit — and one extractor keeps the numbers comparable
 * across cores instead of one dialect per adapter.
 *
 * Two rules make the stored numbers trustworthy:
 * - a provider total wins over a derived one, and a CUMULATIVE report (a running
 *   tally re-sent every event, as `total_token_usage`) is taken as-is rather
 *   than summed — summing a tally inflates the ticket's cost silently;
 * - anything non-numeric or negative is not usage. It is dropped, not coerced
 *   to 0, because a 0 is indistinguishable from a real free call and would read
 *   as "we measured this" in the stats view.
 *
 * `estimateTokenUsage` exists only for a core that reports nothing at all (agy
 * prints bare prose). Its output is flagged `estimated` all the way to the
 * dashboard — a marked approximation is useful, an unmarked one is a lie.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Reasoning ("thinking") tokens, when the core counts them apart from
   * `outputTokens`. Output-billed spend — a core that reports them separately
   * (opencode's `tokens.reasoning`) was contributing nothing to the ledger
   * while they were dropped. Never folded INTO `outputTokens`: a counter karst
   * rewrites can no longer be compared with what the provider reports.
   */
  reasoningTokens: number;
  /** Input tokens served from a prompt cache, when the core distinguishes them. */
  cacheReadTokens: number;
  /** Input tokens written INTO a prompt cache. */
  cacheWriteTokens: number;
  /** Provider-reported total when it gave one, else the sum of the four above. */
  totalTokens: number;
  /** Model the core said it used; null when the envelope did not name one. */
  model: string | null;
  /** True only when nothing was reported and the counts are `estimateTokens`. */
  estimated: boolean;
}

/** Rough characters-per-token for the estimate fallback. Deliberately crude. */
const CHARS_PER_TOKEN = 4;

const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens'] as const;
const OUTPUT_KEYS = [
  'output_tokens',
  'outputTokens',
  'completion_tokens',
  'completionTokens',
] as const;
const REASONING_KEYS = [
  'reasoning_tokens',
  'reasoningTokens',
  'reasoning_output_tokens',
  'reasoningOutputTokens',
  'output_reasoning_tokens',
  'reasoning',
] as const;
const CACHE_READ_KEYS = [
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'cached_input_tokens',
  'cachedInputTokens',
  'cache_read_tokens',
] as const;
const CACHE_WRITE_KEYS = [
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cache_write_tokens',
] as const;
const TOTAL_KEYS = ['total_tokens', 'totalTokens'] as const;

/** Keys whose value is a usage object. `total_*` ones are a running tally. */
const USAGE_KEYS = ['usage', 'token_usage', 'tokenUsage'] as const;
const CUMULATIVE_USAGE_KEYS = ['total_token_usage', 'totalTokenUsage'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A count is a finite, non-negative number. Anything else is not a count. */
function count(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** One usage object read into counts; null when it carried no usable number. */
function readCounts(record: Record<string, unknown>): Counts | null {
  const input = count(record, INPUT_KEYS);
  const output = count(record, OUTPUT_KEYS);
  const reasoning = count(record, REASONING_KEYS);
  const cacheRead = count(record, CACHE_READ_KEYS);
  const cacheWrite = count(record, CACHE_WRITE_KEYS);
  const total = count(record, TOTAL_KEYS);
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return null;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: reasoning ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    ...(total !== undefined ? { total } : {}),
  };
}

interface Counts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total?: number;
}

interface Found {
  counts: Counts;
  cumulative: boolean;
}

/** The model id an envelope names, wherever the core happens to put it. */
function readModel(record: Record<string, unknown>): string | null {
  const direct = record['model'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  // Claude reports per-model usage keyed BY model id and names it nowhere else.
  const perModel = asRecord(record['modelUsage'] ?? record['model_usage']);
  const first = perModel ? Object.keys(perModel)[0] : undefined;
  return first && first.trim() !== '' ? first.trim() : null;
}

/** Every usage object inside one parsed event, plus that event's model. */
function scanEvent(record: Record<string, unknown>): { found: Found[]; model: string | null } {
  const found: Found[] = [];
  for (const key of USAGE_KEYS) {
    const nested = asRecord(record[key]);
    const counts = nested ? readCounts(nested) : null;
    if (counts) found.push({ counts, cumulative: false });
  }
  for (const key of CUMULATIVE_USAGE_KEYS) {
    const nested = asRecord(record[key]);
    const counts = nested ? readCounts(nested) : null;
    if (counts) found.push({ counts, cumulative: true });
  }
  return { found, model: readModel(record) };
}

/**
 * Parse either encoding into events. A whole-document envelope is ONE event;
 * JSONL is one per parseable line, and an unparseable line (a stream cut
 * mid-write) is skipped rather than failing the read — losing the counts of a
 * truncated run is exactly what this module exists to prevent.
 */
function events(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const whole = asRecord(JSON.parse(trimmed));
    return whole ? [whole] : [];
  } catch {
    // Not a whole document — fall through to the line-by-line read.
  }
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      const event = asRecord(JSON.parse(line));
      if (event) out.push(event);
    } catch {
      // Not JSONL (or a truncated final line) — the parseable lines still count.
    }
  }
  return out;
}

/**
 * Read the token counts a headless run reported on stdout. Returns null when
 * nothing structured reported any — the caller decides whether that is worth an
 * estimate, and null is never stored as a row of zeroes.
 */
export function extractTokenUsage(stdout: string): TokenUsage | null {
  const parsed = events(stdout);
  if (parsed.length === 0) return null;

  const perEvent: Found[] = [];
  let model: string | null = null;
  for (const event of parsed) {
    const { found, model: named } = scanEvent(event);
    perEvent.push(...found);
    if (model === null && named !== null) model = named;
  }
  if (perEvent.length === 0) return null;

  // A running tally is authoritative on its own: the last one IS the run's
  // total, and adding the earlier ones to it would count the same tokens twice.
  const cumulative = perEvent.filter((f) => f.cumulative);
  const contributing = cumulative.length > 0 ? [cumulative[cumulative.length - 1]!] : perEvent;

  const summed = contributing.reduce<Counts>(
    (acc, { counts }) => ({
      input: acc.input + counts.input,
      output: acc.output + counts.output,
      reasoning: acc.reasoning + counts.reasoning,
      cacheRead: acc.cacheRead + counts.cacheRead,
      cacheWrite: acc.cacheWrite + counts.cacheWrite,
      ...(counts.total !== undefined ? { total: (acc.total ?? 0) + counts.total } : {}),
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  );

  return {
    inputTokens: summed.input,
    outputTokens: summed.output,
    reasoningTokens: summed.reasoning,
    cacheReadTokens: summed.cacheRead,
    cacheWriteTokens: summed.cacheWrite,
    totalTokens:
      summed.total ??
      summed.input + summed.output + summed.reasoning + summed.cacheRead + summed.cacheWrite,
    model,
    estimated: false,
  };
}

/**
 * Carry the counts a FAILED run had already reported out through its rejection.
 *
 * A 429 arrives after the provider has counted the input, and a run that dies
 * mid-stream still burned everything up to the cut. The adapter's contract is a
 * rejection, so without this the most expensive calls — the ones that failed
 * late — would be the only ones missing from the ledger. The property is
 * non-enumerable so the error still serializes and logs exactly as before.
 */
export function attachUsage<E extends Error>(error: E, usage: TokenUsage | null): E {
  if (usage === null) return error;
  Object.defineProperty(error, 'usage', {
    value: usage,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Read back what `attachUsage` carried; null for any other thrown value. */
export function usageFromError(error: unknown): TokenUsage | null {
  if (typeof error !== 'object' || error === null) return null;
  const usage = (error as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const candidate = usage as Partial<TokenUsage>;
  return typeof candidate.totalTokens === 'number' ? (usage as TokenUsage) : null;
}

/** Crude character-count estimate. Never 0 for text that has content. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return Math.ceil(trimmed.length / CHARS_PER_TOKEN);
}

/**
 * The last resort, for a core that reports nothing. Flagged `estimated` so the
 * stats view can say so — these numbers must never be presented as measured.
 */
export function estimateTokenUsage(prompt: string, completion: string): TokenUsage {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = estimateTokens(completion);
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens,
    model: null,
    estimated: true,
  };
}
