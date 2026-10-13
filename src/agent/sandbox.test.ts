import { describe, expect, it } from 'vitest';
import {
  SANDBOX_NETWORK_ALLOWLIST,
  formatSandboxMode,
  refuseUnsandboxedBypass,
  resolveSandbox,
  worktreeGitCommonDir,
} from './sandbox.js';
import { SUPPORTED, unsupported } from './surfaces.js';

const NO = unsupported('this core has no enforced OS-level sandbox at all');

describe('resolveSandbox (AC-30: fail closed)', () => {
  it('is prompted with a reason when the manifest did not opt in', () => {
    const e = resolveSandbox({ requested: false, surface: SUPPORTED, platform: 'darwin', cwd: '/wt' });
    expect(e).toEqual({ mode: 'prompted', reason: 'sandbox not enabled (agentSandbox: false)' });
  });

  it('fails closed with the core reason when the core cannot sandbox', () => {
    const e = resolveSandbox({ requested: true, surface: NO, platform: 'darwin', cwd: '/wt' });
    expect(e).toEqual({ mode: 'prompted', reason: `core cannot sandbox: ${NO.supported ? '' : NO.reason}` });
  });

  it('fails closed on a platform without an OS sandbox', () => {
    const e = resolveSandbox({ requested: true, surface: SUPPORTED, platform: 'win32', cwd: 'C:\\wt' });
    expect(e).toEqual({ mode: 'prompted', reason: 'platform win32 has no supported OS sandbox' });
  });

  it.each(['darwin', 'linux'] as const)('sandboxes on %s with worktree + git dir writable', (platform) => {
    const e = resolveSandbox({ requested: true, surface: SUPPORTED, platform, cwd: '/wt', gitCommonDir: '/repo/.git' });
    expect(e).toEqual({
      mode: 'sandboxed',
      policy: { writableRoots: ['/wt', '/repo/.git'], allowedDomains: SANDBOX_NETWORK_ALLOWLIST },
    });
  });

  it('omits the git dir when none is known', () => {
    const e = resolveSandbox({ requested: true, surface: SUPPORTED, platform: 'linux', cwd: '/wt' });
    expect(e.mode === 'sandboxed' && e.policy.writableRoots).toEqual(['/wt']);
  });
});

describe('SANDBOX_NETWORK_ALLOWLIST', () => {
  it('names provider APIs and package registries only', () => {
    expect(SANDBOX_NETWORK_ALLOWLIST).toContain('api.anthropic.com');
    expect(SANDBOX_NETWORK_ALLOWLIST).toContain('api.openai.com');
    expect(SANDBOX_NETWORK_ALLOWLIST).toContain('registry.npmjs.org');
    expect(SANDBOX_NETWORK_ALLOWLIST).toContain('pypi.org');
    expect(SANDBOX_NETWORK_ALLOWLIST.some((d) => d.includes('*'))).toBe(false);
  });
});

describe('formatSandboxMode', () => {
  it('renders sandboxed and prompted-with-reason', () => {
    expect(formatSandboxMode({ mode: 'sandboxed', policy: { writableRoots: ['/wt'], allowedDomains: [] } })).toBe(
      'sandboxed (write: /wt)',
    );
    expect(formatSandboxMode({ mode: 'prompted', reason: 'x' })).toBe('prompted (x)');
  });
});

describe('refuseUnsandboxedBypass', () => {
  it('drops bypassPermissions and logs why', () => {
    const lines: string[] = [];
    expect(refuseUnsandboxedBypass('agy', 'bypassPermissions', (m) => lines.push(m))).toBeUndefined();
    expect(lines).toEqual([
      '[agent:agy] refused permissionMode bypassPermissions: no enforced sandbox on this run (AC-30)',
    ]);
  });

  it('passes every other mode through untouched and silent', () => {
    const lines: string[] = [];
    expect(refuseUnsandboxedBypass('claude', 'acceptEdits', (m) => lines.push(m))).toBe('acceptEdits');
    expect(refuseUnsandboxedBypass('claude', undefined, (m) => lines.push(m))).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe('worktreeGitCommonDir', () => {
  const files: Record<string, string> = {
    '/wt/.git': 'gitdir: /repo/.git/worktrees/wt\n',
    '/repo/.git/worktrees/wt/commondir': '../..\n',
  };
  const read = (p: string): string => {
    const v = files[p];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };

  it('resolves a linked worktree to its shared git dir', () => {
    expect(worktreeGitCommonDir('/wt', read)).toBe('/repo/.git');
  });

  it('returns undefined for a plain checkout or unreadable file', () => {
    expect(worktreeGitCommonDir('/other', read)).toBeUndefined();
    expect(worktreeGitCommonDir('/x', () => 'not a gitdir line')).toBeUndefined();
  });

  it('uses the gitdir itself when there is no commondir file', () => {
    expect(worktreeGitCommonDir('/wt', (p) => (p === '/wt/.git' ? 'gitdir: /g' : read(p)))).toBe('/g');
  });
});
