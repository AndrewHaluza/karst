import { describe, it, expect } from 'vitest';
import {
  describeHeadlessFailure,
  describePermissionDenial,
  headlessFailureError,
  isPermissionDenialDetail,
  isQuotaExhausted,
  isUsageLimitFailure,
  QUOTA_PHRASES,
  UsageLimitError,
  usageLimitReason,
} from './cliFailure.js';

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

  it('reads a plain-text 429 on stderr as a RATE limit, not a quota (K11)', () => {
    const message = describeHeadlessFailure({
      tool: 'Codex',
      exitCode: 1,
      stdout: '',
      stderr: 'stream error: exceeded retry limit, last status: 429; retrying not possible\n',
    });
    expect(message).toContain('Codex rate limited');
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

  it('says "rate limited" when the CLI gave no prose for a bare 429 (K11)', () => {
    const message = describeHeadlessFailure({
      tool: 'Claude',
      exitCode: 1,
      stdout: JSON.stringify({ is_error: true, api_error_status: 429 }),
      stderr: '',
    });
    expect(message).toContain('Claude rate limited');
    expect(message).toContain('HTTP 429');
    expect(message).not.toContain('usage limit reached');
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

const AGY_DENIAL =
  'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';

describe('describePermissionDenial', () => {
  it('names the denied permission and the allow-rule fix', () => {
    const message = describePermissionDenial('Antigravity', AGY_DENIAL);
    expect(message).toContain('Antigravity');
    expect(message).toContain('"command"');
    expect(message).toContain('permissions.allow');
    expect(message).toContain('~/.gemini/antigravity-cli/settings.json');
  });

  it('is null for ordinary prose, even prose that mentions headless mode', () => {
    expect(describePermissionDenial('Antigravity', '[]')).toBeNull();
    expect(describePermissionDenial('Antigravity', 'headless mode is fine')).toBeNull();
    expect(describePermissionDenial('Antigravity', '')).toBeNull();
  });

  it('falls back to a generic permission name when none is quoted', () => {
    const message = describePermissionDenial(
      'Antigravity',
      'tool(s) required approval that headless mode cannot prompt for, so they were auto-denied.',
    );
    expect(message).toContain('a tool permission');
  });
});

describe('QUOTA_PHRASES / isQuotaExhausted / headlessFailureError', () => {
  it('flags the allowance wording every provider uses, and not the transient rate-limit forms', () => {
    for (const phrase of [
      'quota exceeded',
      'quota_exceeded',
      'insufficient_quota',
      'RESOURCE_EXHAUSTED',
      'usage limit reached',
      'monthly spend limit',
      'out of credits',
      'payment required',
      'credit balance',
    ]) {
      expect(QUOTA_PHRASES.test(phrase), phrase).toBe(true);
    }
    // `limit reached` matches "Rate limit reached" — a transient rate limit
    // must NOT read as quota (UAT caught this).
    for (const transient of [
      '429 Too Many Requests',
      'rate limit exceeded',
      'rate limit reached',
      'too many requests',
    ]) {
      expect(QUOTA_PHRASES.test(transient), transient).toBe(false);
    }
  });

  it('treats a quota-worded envelope as exhausted and a bare 429 as not', () => {
    expect(isQuotaExhausted({ tool: 'Claude', exitCode: 1, stdout: CLAUDE_429, stderr: '' })).toBe(
      true,
    );
    expect(
      isQuotaExhausted({
        tool: 'Codex',
        exitCode: 1,
        stdout: '',
        stderr: 'stream error: exceeded retry limit, last status: 429; retrying not possible',
      }),
    ).toBe(false);
  });

  it('does not read a run\'s stdout prose as quota evidence (K11)', () => {
    // No envelope, empty stderr: stdout is the model's ANSWER. A model that
    // writes "quota exceeded" must not make us park a healthy-looking run.
    expect(
      isQuotaExhausted({
        tool: 'Claude',
        exitCode: 1,
        stdout: 'The quota exceeded handler lives in src/foo.ts.',
        stderr: '',
      }),
    ).toBe(false);
    // The same phrase on stderr (where a CLI reports a fault) IS evidence.
    expect(
      isQuotaExhausted({
        tool: 'Claude',
        exitCode: 1,
        stdout: '',
        stderr: 'Error: quota exceeded for this account',
      }),
    ).toBe(true);
  });

  it('does not read a non-error stdout JSON result as quota evidence (K11)', () => {
    // A model that answers with structured JSON carrying a `result`/`message`
    // must not turn that text into quota evidence unless the envelope is an
    // ERROR document (UAT observed this).
    expect(
      isQuotaExhausted({
        tool: 'Claude',
        exitCode: 1,
        stdout: JSON.stringify({ result: 'quota exceeded in src/foo.ts' }),
        stderr: '',
      }),
    ).toBe(false);
    // The SAME text in an ERROR envelope IS the provider speaking.
    expect(
      isQuotaExhausted({
        tool: 'Claude',
        exitCode: 1,
        stdout: JSON.stringify({ is_error: true, result: 'quota exceeded' }),
        stderr: '',
      }),
    ).toBe(true);
  });

  it('types a structured quota CODE or HTTP 402 even without the wording (K11)', () => {
    expect(
      isQuotaExhausted({
        tool: 'OpenCode',
        exitCode: 1,
        stdout: JSON.stringify({ error: { type: 'insufficient_quota' } }),
        stderr: '',
      }),
    ).toBe(true);
    expect(
      isQuotaExhausted({
        tool: 'Claude',
        exitCode: 1,
        stdout: JSON.stringify({ api_error_status: 402 }),
        stderr: '',
      }),
    ).toBe(true);
  });

  it('returns a typed UsageLimitError for quota, carrying tool/provider/model/status/detail', () => {
    const error = headlessFailureError({
      tool: 'Claude',
      provider: 'claude',
      model: 'claude-sonnet-5',
      exitCode: 1,
      stdout: CLAUDE_429,
      stderr: '',
    });
    expect(error).toBeInstanceOf(UsageLimitError);
    const limit = error as UsageLimitError;
    expect(limit.name).toBe('UsageLimitError');
    expect(limit.tool).toBe('Claude');
    expect(limit.provider).toBe('claude');
    expect(limit.model).toBe('claude-sonnet-5');
    expect(limit.status).toBe(429);
    expect(limit.detail).toContain('monthly spend limit');
    // The sentence is unchanged from `describeHeadlessFailure`.
    expect(error.message).toBe(
      describeHeadlessFailure({ tool: 'Claude', exitCode: 1, stdout: CLAUDE_429, stderr: '' }),
    );
  });

  it('returns a plain Error with the unchanged sentence for a non-quota failure', () => {
    const error = headlessFailureError({
      tool: 'Codex',
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
    });
    expect(error).not.toBeInstanceOf(UsageLimitError);
    expect(error.message).toBe('Codex failed (exit 1): boom');
  });

  it('names the core and model in the park reason (K11)', () => {
    expect(usageLimitReason('claude', 'claude-sonnet-5')).toBe('usage limit — claude claude-sonnet-5');
    expect(usageLimitReason('codex')).toBe('usage limit — codex');
    expect(usageLimitReason('codex', null)).toBe('usage limit — codex');
  });

  it('returns a plain Error for a bare 429 with no quota wording', () => {
    const error = headlessFailureError({
      tool: 'Codex',
      provider: 'codex',
      exitCode: 1,
      stdout: '',
      stderr: 'stream error: exceeded retry limit, last status: 429; retrying not possible',
    });
    expect(error).not.toBeInstanceOf(UsageLimitError);
    // Still the rate-limit sentence `describeHeadlessFailure` produced before.
    expect(error.message).toContain('Codex rate limited');
  });
});

describe('isPermissionDenialDetail', () => {
  it('recognizes the sentence describePermissionDenial produces', () => {
    const message = describePermissionDenial('Antigravity', AGY_DENIAL)!;
    expect(isPermissionDenialDetail(message)).toBe(true);
  });

  it('is false for every other failure detail, including ones that name permissions', () => {
    expect(isPermissionDenialDetail('Claude failed (exit 1): Invalid API key')).toBe(false);
    expect(isPermissionDenialDetail('Codex usage limit reached — out of quota.')).toBe(false);
    // The raw notice alone is NOT the stored sentence; a run detail is what
    // describePermissionDenial produced.
    expect(isPermissionDenialDetail(AGY_DENIAL)).toBe(false);
    expect(isPermissionDenialDetail('')).toBe(false);
  });
});
