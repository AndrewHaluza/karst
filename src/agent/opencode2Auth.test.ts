import { describe, expect, it } from 'vitest';
import { OPENCODE2_AUTH_LIST_ARGS, opencode2HasCredentials } from './opencode2Auth.js';

describe('opencode2HasCredentials', () => {
  it('reads the empty-store line as NO credentials (live 2.0.27)', () => {
    expect(opencode2HasCredentials('No authenticated integrations\n')).toBe(false);
  });

  it('reads a stored-credential row as credentials present', () => {
    expect(opencode2HasCredentials('OpenCode Go  some-label  stored\n')).toBe(true);
  });

  it('ignores the blank lines around the answer', () => {
    expect(opencode2HasCredentials('\n\nNo authenticated integrations\n\n')).toBe(false);
  });

  it('matches the answer whatever its case', () => {
    expect(opencode2HasCredentials('no authenticated integrations')).toBe(false);
  });

  it('treats an unreadable stream as credentials present (fail-open)', () => {
    // Only an exit code is trustworthy then; an unreadable probe must never
    // become a false "you are not signed in".
    expect(opencode2HasCredentials('')).toBe(true);
  });

  it('pins the one command whose output names credentials', () => {
    expect(OPENCODE2_AUTH_LIST_ARGS).toEqual(['auth', 'list', '--standalone']);
  });
});
