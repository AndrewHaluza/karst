import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sbxName } from './sbxName.js';

describe('sbxName', () => {
  it('is stable across calls', () => {
    const a = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'claude' });
    expect(a).toBe(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'claude' }));
    expect(a).toMatch(/^karst-[0-9a-f]{8}-7-claude$/);
  });

  it('differs across projects with the same ticket', () => {
    expect(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'codex' })).not.toBe(
      sbxName({ projectRoot: '/p/two', ticketId: 7, core: 'codex' }),
    );
  });

  it.each(['../x', 'a b', 'Claude', 'x'.repeat(60)])('rejects unsafe core %j', (core) => {
    expect(() => sbxName({ projectRoot: '/p', ticketId: 1, core })).toThrow(/sbx name/);
  });

  it('rejects a non-positive or fractional ticket id', () => {
    expect(() => sbxName({ projectRoot: '/p', ticketId: 0, core: 'claude' })).toThrow(/sbx name/);
    expect(() => sbxName({ projectRoot: '/p', ticketId: 1.5, core: 'claude' })).toThrow(/sbx name/);
  });

  it.each(['null', '', 'gemini', 'unknown'])('rejects the non-sandbox core %j', (core) => {
    expect(() => sbxName({ projectRoot: '/p', ticketId: 7, core })).toThrow(/not a sandbox core/);
  });

  it('canonicalizes agy to antigravity for container and sandbox naming', () => {
    const agyName = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'agy' });
    const antiName = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'antigravity' });
    expect(agyName).toBe(antiName);
    expect(agyName).toMatch(/^karst-[0-9a-f]{8}-7-antigravity$/);
  });
});

describe('sbxName installId (remote, T1399)', () => {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

  it('hashes the bare project root when installId is omitted, exactly as before', () => {
    expect(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode' })).toBe(`karst-${digest('/p/one')}-7-opencode`);
    expect(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode' })).toBe(
      sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode' }),
    );
  });

  it('hashes projectRoot NUL installId when one is set', () => {
    const id = 'a'.repeat(32);
    expect(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode', installId: id })).toBe(
      `karst-${digest(`/p/one\0${id}`)}-7-opencode`,
    );
  });

  it('keeps two hosts with the SAME project path on one VM apart, and never changes the local name', () => {
    const a = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode', installId: 'a'.repeat(32) });
    const b = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode', installId: 'b'.repeat(32) });
    expect(a).not.toBe(b);
    expect(a).not.toBe(sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'opencode' }));
  });
});
