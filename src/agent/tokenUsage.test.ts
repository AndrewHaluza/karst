import { describe, it, expect } from 'vitest';
import {
  estimateTokenUsage,
  estimateTokens,
  extractTokenUsage,
  type TokenUsage,
} from './tokenUsage.js';

/** A verbatim-shaped `claude -p --output-format json` envelope. */
const CLAUDE_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 4210,
  num_turns: 1,
  result: 'A PR body.',
  session_id: 'sess-1',
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 120,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 900,
    output_tokens: 45,
  },
  modelUsage: { 'claude-opus-4-5-20251101': { inputTokens: 120, outputTokens: 45 } },
});

/** A verbatim-shaped `codex exec --json` stream. */
const CODEX_JSONL = [
  '{"type":"thread.started","thread_id":"th_1"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":25}}',
].join('\n');

describe('extractTokenUsage', () => {
  it('reads the provider numbers out of a whole-document JSON envelope', () => {
    const usage = extractTokenUsage(CLAUDE_ENVELOPE);
    expect(usage).toEqual<TokenUsage>({
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 0,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
      totalTokens: 1095,
      model: 'claude-opus-4-5-20251101',
      estimated: false,
    });
  });

  it('reads usage out of a JSONL stream where it is never the first line', () => {
    const usage = extractTokenUsage(CODEX_JSONL);
    expect(usage?.inputTokens).toBe(200);
    expect(usage?.outputTokens).toBe(25);
    expect(usage?.cacheReadTokens).toBe(50);
    expect(usage?.totalTokens).toBe(275);
    expect(usage?.estimated).toBe(false);
  });

  it('sums usage across the turns of one JSONL run', () => {
    const stream = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}',
    ].join('\n');
    const usage = extractTokenUsage(stream);
    expect(usage?.inputTokens).toBe(17);
    expect(usage?.outputTokens).toBe(5);
    expect(usage?.totalTokens).toBe(22);
  });

  it('prefers a cumulative total over summing, so a running tally is not double counted', () => {
    const stream = [
      '{"type":"token_count","total_token_usage":{"input_tokens":10,"output_tokens":2}}',
      '{"type":"token_count","total_token_usage":{"input_tokens":30,"output_tokens":9}}',
    ].join('\n');
    const usage = extractTokenUsage(stream);
    expect(usage?.inputTokens).toBe(30);
    expect(usage?.outputTokens).toBe(9);
  });

  it('honors a provider-reported total instead of re-deriving one', () => {
    const usage = extractTokenUsage(
      '{"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":111}}',
    );
    expect(usage?.totalTokens).toBe(111);
  });

  it('returns null when nothing structured reported usage', () => {
    expect(extractTokenUsage('')).toBeNull();
    expect(extractTokenUsage('plain agent prose, no envelope at all')).toBeNull();
    expect(extractTokenUsage('{"type":"result","result":"hi","session_id":"s"}')).toBeNull();
  });

  it('ignores non-numeric and negative counts rather than storing them', () => {
    expect(extractTokenUsage('{"usage":{"input_tokens":"lots","output_tokens":-5}}')).toBeNull();
  });

  it('survives a truncated stream — the parseable lines still count', () => {
    const stream = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_toke',
    ].join('\n');
    expect(extractTokenUsage(stream)?.inputTokens).toBe(10);
  });
});

describe('estimateTokenUsage', () => {
  it('marks its numbers as an estimate', () => {
    const usage = estimateTokenUsage('a'.repeat(400), 'b'.repeat(40));
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(10);
    expect(usage.totalTokens).toBe(110);
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('never estimates a zero-length text as a token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });

  it('rounds a partial token up — a one-character prompt is not free', () => {
    expect(estimateTokens('x')).toBe(1);
  });
});

describe('extractTokenUsage — reasoning tokens', () => {
  it('never scans a generic `reasoning_tokens` key — cores disagree on subset vs disjoint semantics', () => {
    // Codex follows the OpenAI convention where a flattened `reasoning_tokens`
    // is a SUBSET of `output_tokens`; opencode reports it disjoint and owns
    // that mapping itself (see opencode.ts's mapTokens). Summing it here for
    // every core would double-count a Codex reasoning-model call.
    const usage = extractTokenUsage(
      JSON.stringify({
        usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 400 },
      }),
    );
    expect(usage?.reasoningTokens).toBe(0);
    expect(usage?.totalTokens).toBe(120);
  });
});
