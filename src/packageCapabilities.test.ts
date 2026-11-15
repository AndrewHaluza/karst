import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package.json workspace trust', () => {
  it('declares the extension unsupported in an untrusted workspace', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      capabilities?: { untrustedWorkspaces?: { supported?: unknown; description?: unknown } };
    };
    expect(pkg.capabilities?.untrustedWorkspaces).toEqual({
      supported: false,
      description: 'Karst runs commands from karst.yml and launches coding agents.',
    });
  });
});
