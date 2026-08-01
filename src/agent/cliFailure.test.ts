import { describe, it, expect } from 'vitest';
import { describeHeadlessFailure, isUsageLimitFailure } from './cliFailure.js';

/** Verbatim `claude -p --output-format json` envelope for a 429 (from 869ea499g). */
const CLAUDE_429 = JSON.stringify({
  is_error: true,
  duration_api_ms: 3141,
  num_turns: 2,
  stop_reason: 'stop_sequence',
  session_id: '8c069030-4051-4f75-bf9e-d4148dcbccf6',
  total_cost_usd: 0.2177436,
  usage: { input_tokens: 2, cache_creation_input_tokens: 35094 },
  modelUsage: { 'claude-sonnet-5': { inputTokens: 2, costUSD: 0.2177436 } },
  permission_denials: [],
  terminal_reason: 'api_error',
  subtype: 'success',
  api_error_status: 429,
  result:
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
  type: 'result',
  duration_ms: 4273,
});

describe('describeHeadlessFailure — usage limits', () => {
  it('renders a claude 429 envelope as one sentence, not the JSON blob', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: CLAUDE_429,
      stderr: '',
    });
    expect(message).toContain('Claude usage limit reached');
    expect(message).toContain("You've hit your monthly spend limit");
    expect(message).toContain('claude.ai/settings/usage');
    // The envelope's machinery must not reach the user.
    expect(message).not.toContain('session_id');
    expect(message).not.toContain('cache_creation_input_tokens');
    expect(message).not.toContain('{');
  });

  it('tells the user what to do next', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: CLAUDE_429,
      stderr: '',
    });
    expect(message).toMatch(/retry/i);
  });

  it('reads a codex JSONL error event', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 1,
      stdout:
        '{"type":"session.created","session_id":"s1"}\n' +
        '{"type":"error","message":"You have hit your usage limit. Try again in 3 hours."}\n',
      stderr: '',
    });
    expect(message).toBe(
      'Codex usage limit reached — You have hit your usage limit. Try again in 3 hours. ' +
        'Retry once the limit resets, or switch the ticket to another model or agent core.',
    );
  });

  it('reads a plain-text 429 on stderr', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 1,
      stdout: '',
      stderr: 'stream error: exceeded retry limit, last status: 429; retrying not possible\n',
    });
    expect(message).toContain('Codex usage limit reached');
    expect(message).toContain('last status: 429');
  });

  it('reads a quota-exhausted stderr with no status code', () => {
    const message = describeHeadlessFailure({
      tool: 'Antigravity',
      exitCode: 1,
      stdout: '',
      stderr:
        'panic: something else\nError: RESOURCE_EXHAUSTED: Quota exceeded for metric generate_requests\n',
    });
    expect(message).toContain('Antigravity usage limit reached');
    // The matched line, not the whole dump.
    expect(message).toContain('Quota exceeded for metric generate_requests');
    expect(message).not.toContain('panic:');
  });

  it('says the limit was hit even when the CLI gave no prose', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: JSON.stringify({ is_error: true, api_error_status: 429 }),
      stderr: '',
    });
    expect(message).toContain('Claude usage limit reached');
    expect(message).toContain('HTTP 429');
  });

  it('collapses a multi-line limit message onto one line', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: JSON.stringify({
        api_error_status: 429,
        result: '5-hour limit reached.\n\nYour limit resets at 4pm.',
      }),
      stderr: '',
    });
    expect(message).toContain('5-hour limit reached. Your limit resets at 4pm.');
    expect(message).not.toContain('\n');
  });
});

describe('describeHeadlessFailure — other failures', () => {
  it('unwraps a non-limit JSON envelope to its human message', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: JSON.stringify({
        is_error: true,
        session_id: 'sess-1',
        result: 'Invalid API key · Please run /login',
      }),
      stderr: '',
    });
    expect(message).toBe('Claude failed (exit 1): Invalid API key · Please run /login');
  });

  it('unwraps a nested error object', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 2,
      stdout: '',
      stderr: JSON.stringify({ error: { type: 'invalid_request_error', message: 'model not found' } }),
    });
    expect(message).toBe('Codex failed (exit 2): model not found');
  });

  it('keeps unparseable output verbatim', () => {
    const message = describeHeadlessFailure({
      tool: 'Antigravity',
      exitCode: 1,
      stdout: '',
      stderr: 'agy: command failed in an unstructured way',
    });
    expect(message).toBe('Antigravity failed (exit 1): agy: command failed in an unstructured way');
  });

  it('prefers stderr but falls back to stdout', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 1,
      stdout: 'only stdout said anything',
      stderr: '   ',
    });
    expect(message).toBe('Codex failed (exit 1): only stdout said anything');
  });

  it('says so when the CLI printed nothing at all', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 137,
      stdout: '',
      stderr: '',
    });
    expect(message).toBe('Claude failed (exit 137): no output.');
  });

  it('truncates a runaway diagnostic', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 1,
      stdout: '',
      stderr: 'x'.repeat(20_000),
    });
    expect(message.length).toBeLessThan(9_000);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('isUsageLimitFailure', () => {
  it('is true for a rate-limited run and false for an ordinary failure', () => {
    expect(isUsageLimitFailure({ tool: 'Claude', exitCode: 1, stdout: CLAUDE_429, stderr: '' })).toBe(
      true,
    );
    expect(
      isUsageLimitFailure({ tool: 'Claude', exitCode: 1, stdout: '', stderr: 'boom' }),
    ).toBe(false);
  });

  it('does not mistake an unrelated number for a status code', () => {
    expect(
      isUsageLimitFailure({
        tool: 'Codex',
        exitCode: 1,
        stdout: '',
        stderr: 'parse error at src/foo.ts:429:12',
      }),
    ).toBe(false);
  });
});
