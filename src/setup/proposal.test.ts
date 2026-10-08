import { describe, it, expect } from 'vitest';
import {
  MAX_SETUP_REASON,
  MAX_SETUP_YAML_BYTES,
  validateSetupProposal,
} from './proposal.js';

function ok(raw: unknown) {
  const r = validateSetupProposal(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.value;
}

describe('validateSetupProposal', () => {
  it('accepts a manifest proposal and strips control characters from the summary', () => {
    const v = ok({
      kind: 'manifest',
      targetPath: '/ws/.karst/karst.yml',
      yaml: 'id: x\nrepositories: {}\n',
      summary: 'detected\u0000 2 repos',
    });
    expect(v).toEqual({
      kind: 'manifest',
      targetPath: '/ws/.karst/karst.yml',
      yaml: 'id: x\nrepositories: {}\n',
      summary: 'detected 2 repos',
    });
  });

  it('rejects an unknown kind', () => {
    expect(validateSetupProposal({ kind: 'nope' })).toEqual({
      ok: false,
      reason: "kind must be 'manifest' or 'change'",
    });
  });

  it('rejects a non-object', () => {
    expect(validateSetupProposal('x').ok).toBe(false);
    expect(validateSetupProposal(null).ok).toBe(false);
    expect(validateSetupProposal([]).ok).toBe(false);
  });

  it('rejects a manifest proposal with a missing or extra key', () => {
    expect(
      validateSetupProposal({ kind: 'manifest', targetPath: '/a', yaml: 'x' }).ok,
    ).toBe(false);
    expect(
      validateSetupProposal({ kind: 'manifest', targetPath: '/a', yaml: 'x', summary: 's', extra: 1 }).ok,
    ).toBe(false);
  });

  it('rejects a control character in targetPath and an empty path', () => {
    expect(
      validateSetupProposal({ kind: 'manifest', targetPath: '/a\u0000b', yaml: 'x', summary: 's' }).ok,
    ).toBe(false);
    expect(
      validateSetupProposal({ kind: 'manifest', targetPath: '  ', yaml: 'x', summary: 's' }).ok,
    ).toBe(false);
  });

  it('rejects an oversize yaml', () => {
    const big = 'x'.repeat(MAX_SETUP_YAML_BYTES + 1);
    expect(validateSetupProposal({ kind: 'manifest', targetPath: '/a', yaml: big, summary: 's' }).ok).toBe(false);
  });

  it('accepts a command change and a patch change', () => {
    expect(
      ok({ kind: 'change', repo: 'web', reason: 'deps missing', command: 'npm ci' }),
    ).toEqual({ kind: 'change', repo: 'web', reason: 'deps missing', command: 'npm ci' });
    expect(
      ok({ kind: 'change', repo: 'web', reason: 'env', patch: '--- /dev/null\n+++ b/.env\n' }),
    ).toEqual({ kind: 'change', repo: 'web', reason: 'env', patch: '--- /dev/null\n+++ b/.env\n' });
  });

  it('rejects a change with neither command nor patch', () => {
    expect(validateSetupProposal({ kind: 'change', repo: 'web', reason: 'x' }).ok).toBe(false);
  });

  it('rejects a change carrying BOTH a command and a patch (never silently drops one)', () => {
    expect(
      validateSetupProposal({ kind: 'change', repo: 'web', reason: 'x', command: 'npm ci', patch: 'p' }).ok,
    ).toBe(false);
  });

  it('rejects a change with an empty reason, a bad repo name, or an oversize reason', () => {
    expect(validateSetupProposal({ kind: 'change', repo: 'web', reason: '   ', command: 'x' }).ok).toBe(false);
    expect(validateSetupProposal({ kind: 'change', repo: 'a b', reason: 'x', command: 'y' }).ok).toBe(false);
    expect(
      validateSetupProposal({ kind: 'change', repo: 'web', reason: 'x'.repeat(MAX_SETUP_REASON + 1), command: 'y' }).ok,
    ).toBe(false);
  });

  it('rejects . and .. as repo names (they resolve outside the workspace root)', () => {
    expect(validateSetupProposal({ kind: 'change', repo: '.', reason: 'x', command: 'y' }).ok).toBe(false);
    expect(validateSetupProposal({ kind: 'change', repo: '..', reason: 'x', command: 'y' }).ok).toBe(false);
  });

  it('rejects an extra key on a change proposal', () => {
    expect(
      validateSetupProposal({ kind: 'change', repo: 'web', reason: 'x', command: 'y', extra: 1 }).ok,
    ).toBe(false);
  });
});
