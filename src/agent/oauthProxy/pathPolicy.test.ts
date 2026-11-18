import { describe, expect, it } from 'vitest';
import { checkRequestTarget } from './pathPolicy.js';

describe('checkRequestTarget', () => {
  it.each([
    '/v1/messages', '/v1/messages?beta=true', '/v1/messages/count_tokens?beta=true',
    '/v1/messages/cache_touch', '/v1/complete', '/v1/models', '/v1/models/claude-opus-4',
    '/v1/messages/batches', '/v1/messages/batches/msgbatch_01/results',
  ])('allows %s', (target) => {
    expect(checkRequestTarget(target)).toEqual({ ok: true, path: target.split('?')[0] });
  });

  it.each([
    ['http://api.anthropic.com/v1/messages', 'absolute'],
    ['https://evil.test/v1/messages', 'absolute'],
    ['//evil.test/v1/messages', 'absolute'],
    ['api.anthropic.com:443', 'absolute'],
    ['*', 'absolute'],
    ['/v1/../api/oauth/usage', 'traversal'],
    ['/v1/messages/..', 'traversal'],
    ['/v1/%2e%2e/x', 'encoded'],
    ['/v1/messages%2Fx', 'encoded'],
    ['/v1/messages%5cx', 'encoded'],
    ['/v1\\messages', 'encoded'],
    ['/v1/messages%00', 'encoded'],
    ['/api/oauth/profile', 'path'],
    ['/v1/code/sessions/', 'path'],
    ['/v1/files', 'path'],
    ['/', 'path'],
    ['/v1/messagesX', 'path'],
    ['/v1/messages//x', 'path'],
  ])('refuses %s as %s', (target, reason) => {
    expect(checkRequestTarget(target)).toEqual({ ok: false, reason });
  });
});
