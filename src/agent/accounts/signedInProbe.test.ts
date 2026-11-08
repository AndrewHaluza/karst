import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileSignedInProbe, createSignedInProbe } from './signedInProbe.js';

function probe(files: Record<string, unknown>) {
  return createSignedInProbe({
    home: '/h',
    defaultDir: (c) => (c === 'opencode' ? '/h/.local/share/opencode' : `/h/.${c}`),
    exists: async (p) => p in files,
    readJson: async (p) => files[p],
  });
}

describe('signed-in probe', () => {
  it('finds the credential file of a stored account', async () => {
    expect(await probe({ '/w/.credentials.json': {} })('claude', '/w')).toBe(true);
    expect(await probe({ '/w/auth.json': {} })('codex', '/w')).toBe(true);
    expect(await probe({ '/w/opencode/auth.json': {} })('opencode', '/w')).toBe(true);
  });

  it('reads the oauth marker of .claude.json in the account folder, and in the home for default', async () => {
    expect(await probe({ '/w/.claude.json': { oauthAccount: {} } })('claude', '/w')).toBe(true);
    expect(await probe({ '/h/.claude.json': { oauthAccount: {} } })('claude', '/h/.claude')).toBe(true);
    expect(await probe({ '/h/.claude.json': { oauthAccount: {} } })('claude', '/w')).toBe(false);
    expect(await probe({ '/w/.claude.json': { other: 1 } })('claude', '/w')).toBe(false);
    expect(await probe({ '/w/.claude.json': null })('claude', '/w')).toBe(false);
  });

  it('says not signed in for a stored folder with no credential, unknown for default', async () => {
    expect(await probe({})('codex', '/w')).toBe(false);
    expect(await probe({})('codex', '/h/.codex')).toBeUndefined();
    expect(await probe({})('claude', '/h/.claude')).toBeUndefined();
  });

  it('cannot tell for a core with no known credential file or no folder', async () => {
    expect(await probe({})('antigravity', '/w')).toBeUndefined();
    expect(await probe({})('opencode2', '/w')).toBeUndefined();
    expect(await probe({})('claude', undefined)).toBeUndefined();
  });
});

describe('file signed-in probe', () => {
  it('reads real files and treats a bad or missing file as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'probe-'));
    try {
      const probe = createFileSignedInProbe(root, (c) => join(root, `.${c}`));
      await writeFile(join(root, '.claude.json'), '{"oauthAccount":{}}');
      expect(await probe('claude', join(root, '.claude'))).toBe(true);
      await writeFile(join(root, '.claude.json'), '{not json');
      expect(await probe('claude', join(root, '.claude'))).toBeUndefined();
      await writeFile(join(root, 'auth.json'), '{}');
      expect(await probe('codex', root)).toBe(true);
      expect(await probe('codex', join(root, 'nowhere'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
