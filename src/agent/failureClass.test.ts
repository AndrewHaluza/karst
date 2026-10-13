import { describe, it, expect } from 'vitest';
import { classifyFailure, failureText, isTimedOutFailure, type FailureClass } from './failureClass.js';
import { UsageLimitError } from './cliFailure.js';

describe('failureText', () => {
  it('returns String(error) when error is not an Error', () => {
    expect(failureText('boom')).toBe('boom');
  });

  it('returns String(error) for null', () => {
    expect(failureText(null)).toBe('null');
  });

  it('walks the cause chain', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    expect(failureText(outer)).toBe('outer\ninner');
  });

  it('caps at 8192 characters', () => {
    const msg = 'x'.repeat(20000);
    expect(failureText(new Error(msg))).toHaveLength(8192);
  });

  it('handles non-Error causes', () => {
    const outer = new Error('outer', { cause: 'string cause' });
    expect(failureText(outer)).toBe('outer\nstring cause');
  });
});

describe('classifyFailure', () => {
  it('classifies the real opencode 400 incident as model-rejected', () => {
    const error = new Error(
      'opencode reported an error: {"name":"APIError","data":{"message":"Bad Request: {\\"object\\":\\"error\\",\\"model\\":\\"deepseek-v4-flash\\"}","statusCode":400,"isRetryable":false}}',
    );
    expect(classifyFailure(error)).toBe('model-rejected');
  });

  it('classifies an AbortError as aborted', () => {
    const error = Object.assign(new Error('headless agent run aborted'), {
      name: 'AbortError',
    });
    expect(classifyFailure(error)).toBe('aborted');
  });

  it('classifies an AbortError with 503 in the message as aborted (precedence)', () => {
    const error = Object.assign(new Error('headless agent run aborted 503'), {
      name: 'AbortError',
    });
    expect(classifyFailure(error)).toBe('aborted');
  });

  it('classifies a timeout as fatal (K3)', () => {
    const error = new Error('headless agent run timed out after 3600000ms');
    expect(classifyFailure(error)).toBe('fatal');
  });

  it('isTimedOutFailure recognizes the spawner name and the wrapped sentence (T663)', () => {
    expect(isTimedOutFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimedOutFailure(new Error('headless agent run timed out after 60000ms'))).toBe(true);
    expect(isTimedOutFailure(Object.assign(new Error('headless agent run aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isTimedOutFailure(new Error('spawn ENOENT'))).toBe(false);
  });

  it('does NOT read quota wording from a plain Error — only the typed error is usage-limited (K11)', () => {
    // The adapter's own sentence for a BARE 429 says "rate limited", and its
    // quota sentence says "usage limit reached". Neither is trusted as a
    // classification signal: the ADAPTER decides, by throwing the typed
    // `UsageLimitError`. A text rule here read transient rate limits as quota
    // (UAT caught exactly that), so quota wording alone stays a limit → transient.
    expect(
      classifyFailure(
        new Error('Claude rate limited (HTTP 429). Retry once the limit resets.'),
      ),
    ).toBe('transient');
    expect(
      classifyFailure(new Error('Codex usage limit reached — Try again in 3 hours.')),
    ).toBe('transient');
    expect(classifyFailure(new Error('provider said: insufficient_quota'))).toBe('transient');
  });

  it('classifies a typed UsageLimitError as usage-limited (K11)', () => {
    const error = new UsageLimitError('Claude usage limit reached — out of credits.', {
      tool: 'Claude',
      provider: 'claude',
    });
    expect(classifyFailure(error)).toBe('usage-limited');
  });

  it('keeps a bare 429 / rate-limit wording transient (K5)', () => {
    expect(
      classifyFailure(new Error('OpenCode failed (exit 1): 429 Too Many Requests')),
    ).toBe('transient');
    expect(classifyFailure(new Error('codex: rate limit exceeded, try again later'))).toBe(
      'transient',
    );
    expect(classifyFailure(new Error('upstream said: too many requests'))).toBe('transient');
  });

  it('recognizes a typed UsageLimitError by name across a module boundary (K11)', () => {
    const error = new Error('out of credits');
    error.name = 'UsageLimitError';
    expect(classifyFailure(error)).toBe('usage-limited');
  });

  it('classifies a 503 upstream error as transient', () => {
    const error = new Error(
      'OpenCode failed (exit 1): upstream error: 503 Service Unavailable',
    );
    expect(classifyFailure(error)).toBe('transient');
  });

  it('classifies ECONNRESET as transient', () => {
    const error = new Error('Codex failed (exit 1): read ECONNRESET');
    expect(classifyFailure(error)).toBe('transient');
  });

  it('classifies "unknown model" as model-rejected', () => {
    const error = new Error('unknown model "gpt-9"');
    expect(classifyFailure(error)).toBe('model-rejected');
  });

  it('classifies 401 as fatal', () => {
    const error = new Error('Claude failed (exit 1): 401 Unauthorized');
    expect(classifyFailure(error)).toBe('fatal');
  });

  it('does not match 404 in a file path as an HTTP status (negative lookaround)', () => {
    const error = new Error('Claude failed (exit 2): TypeError at src/foo.ts:404:12');
    expect(classifyFailure(error)).toBe('fatal');
  });

  it('does not match 503 in a file path as an HTTP status', () => {
    const error = new Error(
      'Claude failed (exit 2): assertion failed in src/bar.ts:503:1',
    );
    expect(classifyFailure(error)).toBe('fatal');
  });

  it('classifies a non-Error value as fatal', () => {
    expect(classifyFailure('boom')).toBe('fatal');
  });

  it('classifies a chained 503 cause as transient', () => {
    const error = new Error('review lane failed', {
      cause: new Error('503 upstream'),
    });
    expect(classifyFailure(error)).toBe('transient');
  });

  it('returns fatal when the 503 is past the 8 KB bound', () => {
    const msg = 'x'.repeat(20000) + ' 503 ';
    expect(classifyFailure(new Error(msg))).toBe('fatal');
  });
});
