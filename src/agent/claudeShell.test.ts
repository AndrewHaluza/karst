import { describe, it, expect } from 'vitest';
import { claudeShellEnv } from './claudeShell.js';

const zsh = { SHELL: '/bin/zsh', PATH: '/opt/homebrew/bin:/usr/bin' };

describe('claudeShellEnv', () => {
  it('prefers a bash found on PATH', () => {
    const r = claudeShellEnv(zsh, 'darwin', (p) => p === '/opt/homebrew/bin/bash');
    expect(r).toEqual({ CLAUDE_CODE_SHELL: '/opt/homebrew/bin/bash' });
  });
  it('falls back to /bin/bash', () => {
    expect(claudeShellEnv(zsh, 'darwin', () => false)).toEqual({ CLAUDE_CODE_SHELL: '/bin/bash' });
  });
  it('does nothing off darwin, for a non-zsh shell, on opt-out, or when the user set the key', () => {
    expect(claudeShellEnv(zsh, 'linux', () => true)).toEqual({});
    expect(claudeShellEnv({ ...zsh, SHELL: '/bin/bash' }, 'darwin', () => true)).toEqual({});
    expect(claudeShellEnv({ ...zsh, KARST_CLAUDE_SHELL: 'off' }, 'darwin', () => true)).toEqual({});
    expect(claudeShellEnv({ ...zsh, CLAUDE_CODE_SHELL: '/bin/zsh' }, 'darwin', () => true)).toEqual({});
  });
  it('handles a missing SHELL and PATH', () => {
    expect(claudeShellEnv({}, 'darwin', () => true)).toEqual({});
  });
});
