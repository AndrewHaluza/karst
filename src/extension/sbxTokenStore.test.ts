import { describe, expect, it } from 'vitest';
import type { SecretStore } from './secretStore.js';
import { getSbxToken, hasSbxToken, removeSbxToken, sbxTokenEligibility, sbxTokenKey, setSbxToken, validateSbxToken } from './sbxTokenStore.js';

const TOKEN = 'sk-ant-oat01-abcdefghijkl';
function memory(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k), store: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
}

describe('sbx token store', () => {
  it('keys a token by core and account name', () => {
    expect(sbxTokenKey('claude', 'work')).toBe('karst.sbx.token.claude.work');
  });

  it('stores a trimmed token and reads it back per account', async () => {
    const s = memory();
    await setSbxToken(s, 'claude', 'work', `  ${TOKEN}\n`);
    expect(s.map.get('karst.sbx.token.claude.work')).toBe(TOKEN);
    expect(await getSbxToken(s, 'claude', 'work')).toBe(TOKEN);
    expect(await hasSbxToken(s, 'claude', 'work')).toBe(true);
    expect(await hasSbxToken(s, 'claude', 'other')).toBe(false);
    expect(await getSbxToken(s, 'claude', 'other')).toBeUndefined();
  });

  it('refuses a token without the subscription prefix and stores nothing', async () => {
    const s = memory();
    await expect(setSbxToken(s, 'claude', 'work', 'sk-ant-api03-abcdefghijkl')).rejects.toThrow(/sk-ant-oat01-/);
    expect(s.map.size).toBe(0);
  });

  it('removes a token and is idempotent', async () => {
    const s = memory();
    await setSbxToken(s, 'claude', 'work', TOKEN);
    await removeSbxToken(s, 'claude', 'work');
    await removeSbxToken(s, 'claude', 'work');
    expect(s.map.size).toBe(0);
  });

  it('validates the token shape', () => {
    expect(validateSbxToken(TOKEN)).toBeNull();
    expect(validateSbxToken(` ${TOKEN} `)).toBeNull();
    expect(validateSbxToken('sk-ant-oat01-short')).toMatch(/not valid/);
    expect(validateSbxToken('sk-ant-oat01-abc def ghijk')).toMatch(/not valid/);
    expect(validateSbxToken('')).toMatch(/must start/);
  });

  it('allows folder and managed accounts only', () => {
    const base = { dir: '/d' };
    expect(sbxTokenEligibility('claude', 'a', { kind: 'subscription', source: 'folder', ...base })).toBeNull();
    expect(sbxTokenEligibility('claude', 'a', { kind: 'subscription', source: 'managed', ...base })).toBeNull();
    expect(sbxTokenEligibility('claude', 'a', { kind: 'subscription', source: 'command', command: 'x', ...base })).toMatch(/command account/);
    expect(sbxTokenEligibility('claude', 'default', undefined)).toMatch(/global sbx secret/);
    expect(sbxTokenEligibility('claude', 'ghost', undefined)).toMatch(/does not exist/);
    expect(sbxTokenEligibility('codex', 'a', { kind: 'subscription', source: 'folder', ...base })).toMatch(/Only claude/);
  });
});
