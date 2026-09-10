import { describe, it, expect } from 'vitest';
import { classifyFailure, failureText, type FailureClass } from './failureClass.js';

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

  it('classifies a usage limit as transient (K5)', () => {
    const error = new Error(
      'Claude usage limit reached (HTTP 429). Retry once the limit resets.',
    );
    expect(classifyFailure(error)).toBe('transient');
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
