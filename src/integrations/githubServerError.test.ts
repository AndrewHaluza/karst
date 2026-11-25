import { describe, it, expect } from 'vitest';
import { GITHUB_SERVER_ERROR_PATTERNS, isGitHubServerError } from './githubServerError.js';

describe('isGitHubServerError', () => {
  // Texts quoted from the failed ship runs of T1356.
  it.each([
    'gh pr create failed in /w: GraphQL: Something went wrong while executing your query. Please include `C1A4:2F7E` when reporting this issue.',
    'gh pr create failed in /w: HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Time-out',
    '504 Gateway Timeout',
    'HTTP 500: Internal Server Error',
  ])('is true for %s', (text) => {
    expect(isGitHubServerError(text)).toBe(true);
  });

  it.each([
    'a pull request for branch "x" into branch "y" already exists',
    'No commits between develop and karst/x',
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    'HTTP 422: Validation Failed',
    'HTTP 404: Not Found',
    'could not run gh',
    'HTTP 5021',
    '',
  ])('is false for %s', (text) => {
    expect(isGitHubServerError(text)).toBe(false);
  });

  it('is a closed list of 5 patterns', () => {
    expect(GITHUB_SERVER_ERROR_PATTERNS).toHaveLength(5);
  });
});
