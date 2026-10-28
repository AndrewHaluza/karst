import { describe, it, expect } from 'vitest';
import { resolveInstallToken } from './approachGithubToken.js';

describe('resolveInstallToken', () => {
  it('uses the VS Code session token first', async () => {
    expect(await resolveInstallToken(async () => 'vs', { GH_TOKEN: 'e' })).toBe('vs');
  });
});
