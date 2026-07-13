import { describe, it, expect } from 'vitest';
import { expandEnvTokens } from './spin.js';

describe('expandEnvTokens', () => {
  const env = { PORT: '4001', HOST: '127.0.0.1' };

  it('expands ${VAR} braced tokens', () => {
    expect(expandEnvTokens('npm run dev -- --port ${PORT} --strictPort', env)).toBe(
      'npm run dev -- --port 4001 --strictPort',
    );
  });

  it('expands $VAR bare tokens', () => {
    expect(expandEnvTokens('serve --host $HOST --port $PORT', env)).toBe(
      'serve --host 127.0.0.1 --port 4001',
    );
  });

  it('leaves a token-free command untouched', () => {
    expect(expandEnvTokens('npm run dev', env)).toBe('npm run dev');
  });

  it('expands an unknown token to empty string (shell-like)', () => {
    expect(expandEnvTokens('run --x ${MISSING}', env)).toBe('run --x ');
  });
});
