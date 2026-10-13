import { describe, expect, it } from 'vitest';
import {
  checkClaudeInstall,
  claudeCandidatePaths,
  claudeLinkProbe,
  claudeRealTarget,
  CLAUDE_LINK_CHECK_ID,
  isKarstOpencode2DataPath,
  isUnder,
  type ClaudeLinkLookups,
  type ClaudeLinkProbe,
} from './claudeInstallCheck.js';

const KARST_ROOT = '/Users/me/Library/Application Support/Cursor/User/globalStorage/karst.karst';
const LEAKED = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;

function candidate(path: string, overrides: Partial<ClaudeLinkProbe['candidates'][number]> = {}) {
  return { path, resolvedPath: path, linkTarget: undefined, ...overrides };
}

function probe(overrides: Partial<ClaudeLinkProbe> = {}): ClaudeLinkProbe {
  return {
    candidates: [candidate('/Users/me/.local/share/claude/versions/2.1.296')],
    karstRoot: KARST_ROOT,
    suggestedTarget: undefined,
    ...overrides,
  };
}

describe('checkClaudeInstall', () => {
  it('is ok when no claude is installed', () => {
    const c = checkClaudeInstall(probe({ candidates: [] }));
    expect(c).toMatchObject({ id: CLAUDE_LINK_CHECK_ID, area: 'tools', status: 'ok' });
    expect(c.detail).toContain('no');
  });

  it('is ok when claude resolves to the user\'s own install', () => {
    const c = checkClaudeInstall(probe());
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('is ok for a broken link that does not point into karst storage', () => {
    const c = checkClaudeInstall(
      probe({ candidates: [candidate('/Users/me/.local/bin/claude', { resolvedPath: undefined, linkTarget: '/nowhere/claude' })] }),
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('broken link');
  });

  it('is ok for a sibling dir that merely shares the storage prefix', () => {
    const c = checkClaudeInstall(
      probe({ candidates: [candidate(`${KARST_ROOT}-other/claude/versions/2.1.296`)] }),
    );
    expect(c.status).toBe('ok');
  });

  it('warns when the resolved target is under this install\'s storage', () => {
    const c = checkClaudeInstall(
      probe({ candidates: [candidate(LEAKED, { path: '/Users/me/.local/bin/claude' })] }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain(LEAKED);
  });

  // The medium finding: a leak written by a SIBLING karst install (another
  // editor's globalStorage) still breaks `claude` machine-wide, and cleanup by
  // THAT install is what removes the target.
  it('warns when the target is in ANOTHER karst install\'s storage', () => {
    const sibling = '/Users/me/Library/Application Support/Code/User/globalStorage/karst.karst/opencode2/data/claude/versions/6.6.6';
    const c = checkClaudeInstall(
      probe({ candidates: [candidate(sibling, { path: '/Users/me/.local/bin/claude' })] }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain(sibling);
  });

  // The state karst cleanup leaves behind: a DANGLING link into removed storage.
  it('warns when a DANGLING link points into karst storage', () => {
    const c = checkClaudeInstall(
      probe({
        candidates: [candidate('/Users/me/.local/bin/claude', { resolvedPath: undefined, linkTarget: LEAKED })],
      }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain(LEAKED);
    expect(c.detail).toContain('GONE');
    expect(c.detail).toContain('cleanup');
  });

  // A healthy first candidate must not hide a leaking LATER one (low finding).
  it('warns when a later candidate leaks even if the first is healthy', () => {
    const c = checkClaudeInstall(
      probe({
        candidates: [
          candidate('/Users/me/.local/share/claude/versions/2.1.296'),
          candidate(LEAKED, { path: '/usr/local/bin/claude' }),
        ],
      }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/usr/local/bin/claude');
  });

  it('reports the relink command, shell-quoted, and never auto-fixes', () => {
    const c = checkClaudeInstall(
      probe({
        candidates: [candidate(LEAKED, { path: '/Users/me/.local/bin/claude' })],
        suggestedTarget: '/Users/me/.local/share/claude/versions/2.1.296',
      }),
    );
    const fix = c.fix;
    expect(fix?.tier).toBe('report');
    expect(fix?.tier === 'report' ? fix.nextStep : '').toContain(
      "ln -sfn '/Users/me/.local/share/claude/versions/2.1.296' '/Users/me/.local/bin/claude'",
    );
  });

  it('quotes a path that contains a space', () => {
    const c = checkClaudeInstall(
      probe({
        candidates: [candidate(LEAKED, { path: '/Users/me/uat space/home/.local/bin/claude' })],
        suggestedTarget: '/Users/me/uat space/home/.local/share/claude/versions/2.1.296',
      }),
    );
    const fix = c.fix;
    expect(fix?.tier === 'report' ? fix.nextStep : '').toContain(
      "'/Users/me/uat space/home/.local/bin/claude'",
    );
  });

  it('falls back to reinstall guidance when no real install was found', () => {
    const c = checkClaudeInstall(
      probe({ candidates: [candidate(LEAKED, { path: '/Users/me/.local/bin/claude' })] }),
    );
    const fix = c.fix;
    expect(c.status).toBe('warn');
    expect(fix?.tier).toBe('report');
    expect(fix?.tier === 'report' ? fix.nextStep : '').toContain('claude install');
  });
});

describe('claudeRealTarget', () => {
  it('maps the isolated data dir back to the user\'s own', () => {
    expect(claudeRealTarget(LEAKED, '/Users/me/.local/share')).toBe(
      '/Users/me/.local/share/claude/versions/2.1.296',
    );
  });

  it('returns undefined for a path with no claude/versions tail', () => {
    expect(claudeRealTarget('/opt/claude', '/Users/me/.local/share')).toBeUndefined();
  });
});

describe('isUnder', () => {
  it('is true for the root itself and its children, false for a filename sibling', () => {
    expect(isUnder('/gs/opencode2', '/gs/opencode2')).toBe(true);
    expect(isUnder('/gs/opencode2/data', '/gs/opencode2')).toBe(true);
    expect(isUnder('/gs/opencode2', '/gs/opencode2/')).toBe(true);
    expect(isUnder('/gs/opencode2-other/data', '/gs/opencode2')).toBe(false);
    expect(isUnder('/anything', '')).toBe(false);
  });
});

describe('isKarstOpencode2DataPath', () => {
  it('matches karst\'s isolated opencode2 data dir OR a path under it', () => {
    expect(isKarstOpencode2DataPath('/a/gs/karst.karst/opencode2/data')).toBe(true);
    expect(isKarstOpencode2DataPath('/b/other/opencode2/data/')).toBe(true);
    expect(isKarstOpencode2DataPath('/a/gs/karst.karst/opencode2/data/claude/versions/1')).toBe(true);
    expect(isKarstOpencode2DataPath('/home/u/.local/share')).toBe(false);
    expect(isKarstOpencode2DataPath('/a/opencode2/config')).toBe(false);
    expect(isKarstOpencode2DataPath('/a/opencode2/datax/claude')).toBe(false);
    expect(isKarstOpencode2DataPath('/a/myopencode2/data')).toBe(false);
  });
});

describe('claudeCandidatePaths', () => {
  it('lists the home link, the PATH resolution, then each distinct PATH entry', () => {
    const paths = claudeCandidatePaths(
      '/home/u',
      { PATH: '/usr/local/bin:/home/u/.local/bin' },
      () => '/opt/claude',
    );
    expect(paths).toEqual([
      '/home/u/.local/bin/claude',
      '/opt/claude',
      '/usr/local/bin/claude',
      '/home/u/.local/bin/claude',
    ].filter((p, i, a) => a.indexOf(p) === i));
  });

  it('tolerates a missing PATH', () => {
    expect(claudeCandidatePaths('/home/u', {}, () => undefined)).toEqual(['/home/u/.local/bin/claude']);
  });
});

describe('claudeLinkProbe', () => {
  const HOME = '/home/u';
  const LINK = `${HOME}/.local/bin/claude`;
  const ROOT = '/private/var/gs/karst.karst';
  const KARST_LINK = `${ROOT}/opencode2/data/claude/versions/2.1.296`;
  const REAL_TARGET = `${HOME}/.local/share/claude/versions/2.1.296`;

  /**
   * A fake machine. `files` are paths `existsSync` resolves; `symlinks` are
   * directory entries `lstat` sees and `readlink` reports — including DANGLING
   * ones, whose target is absent from `files`.
   */
  function fake(opts: {
    files?: readonly string[];
    symlinks?: Record<string, string>;
    env?: Record<string, string | undefined>;
    onPath?: string;
  }): ClaudeLinkLookups {
    const files = new Set(opts.files ?? []);
    const symlinks = opts.symlinks ?? {};
    const exists = (p: string): boolean =>
      files.has(p) || (symlinks[p] !== undefined && exists(symlinks[p]!));
    const realpath = (p: string): string | undefined => {
      const target = symlinks[p];
      if (target !== undefined) return exists(target) ? realpath(target) : undefined;
      return files.has(p) ? p : undefined;
    };
    return {
      homeDir: HOME,
      pathExists: exists,
      linkExists: (p) => files.has(p) || symlinks[p] !== undefined,
      readLink: (p) => symlinks[p],
      realpath,
      resolveCommand: () => opts.onPath,
      env: opts.env ?? {},
    };
  }

  it('uses ~/.local/bin/claude first and maps a leak to the user\'s own install', () => {
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [KARST_LINK, REAL_TARGET, ROOT],
      symlinks: { [LINK]: KARST_LINK, '/var/gs/karst.karst': ROOT },
    }));
    expect(p.candidates[0]?.path).toBe(LINK);
    expect(p.candidates[0]?.resolvedPath).toBe(KARST_LINK);
    expect(p.karstRoot).toBe(ROOT); // canonicalized `/var` → `/private/var`
    expect(p.suggestedTarget).toBe(REAL_TARGET);
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('detects a DANGLING home link into missing karst storage', () => {
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [REAL_TARGET, ROOT],
      symlinks: { [LINK]: KARST_LINK, '/var/gs/karst.karst': ROOT },
    }));
    expect(p.candidates[0]?.resolvedPath).toBeUndefined();
    expect(p.candidates[0]?.linkTarget).toBe(KARST_LINK);
    expect(p.suggestedTarget).toBe(REAL_TARGET);
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('normalizes a dangling target written through a symlinked storage ancestor', () => {
    const rawTarget = '/var/gs/karst.karst/opencode2/data/claude/versions/2.1.296';
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [REAL_TARGET, ROOT],
      symlinks: { [LINK]: rawTarget, '/var/gs/karst.karst': ROOT },
    }));
    expect(p.candidates[0]?.linkTarget).toBe(KARST_LINK);
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('flags a leak into a SIBLING karst storage that is not under the db root', () => {
    const sibling = '/Users/me/Code/User/globalStorage/karst.karst/opencode2/data/claude/versions/6.6.6';
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: [LINK, '/gs/karst.karst'],
      symlinks: { [LINK]: sibling },
    }));
    expect(p.karstRoot).toBe('/gs/karst.karst');
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('sees a leaking PATH entry that shadows a healthy home link', () => {
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: [`/gs/karst.karst/opencode2/data/claude/versions/2.1.296`, LINK],
      symlinks: { '/bad/bin/claude': '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { PATH: '/bad/bin:/usr/bin' },
    }));
    // The home link exists (healthy) but the earlier PATH entry leaks.
    expect(p.candidates.map((c) => c.path)).toContain('/bad/bin/claude');
    const c = checkClaudeInstall(p);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/bad/bin/claude');
  });

  it('sees a DANGLING PATH entry that `which` would skip', () => {
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: ['/gs/karst.karst'],
      symlinks: { '/bad/bin/claude': '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { PATH: '/bad/bin:/usr/bin' },
    }));
    const c = checkClaudeInstall(p);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/bad/bin/claude');
  });

  it('ignores an XDG_DATA_HOME that points back into karst storage', () => {
    const rawKarstData = '/var/gs/karst.karst/opencode2/data';
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [KARST_LINK, REAL_TARGET, ROOT, `${ROOT}/opencode2/data`],
      symlinks: {
        [LINK]: KARST_LINK,
        '/var/gs/karst.karst': ROOT,
        [rawKarstData]: `${ROOT}/opencode2/data`,
      },
      env: { XDG_DATA_HOME: rawKarstData },
    }));
    expect(p.suggestedTarget).toBe(REAL_TARGET);
  });

  it('ignores an XDG_DATA_HOME belonging to a DIFFERENT karst storage', () => {
    const otherStorage = '/Users/me/other/gs/karst.karst/opencode2/data';
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: ['/gs/karst.karst/opencode2/data/claude/versions/2.1.296', REAL_TARGET, otherStorage],
      symlinks: { [LINK]: '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { XDG_DATA_HOME: otherStorage },
    }));
    expect(p.suggestedTarget).toBe(REAL_TARGET);
  });

  it('honors a user XDG_DATA_HOME outside karst storage', () => {
    const customData = `${HOME}/custom/data`;
    const customTarget = `${HOME}/custom/data/claude/versions/2.1.296`;
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: [LINK, '/gs/karst.karst', customTarget, '/gs/karst.karst/opencode2/data/claude/versions/2.1.296'],
      symlinks: { [LINK]: '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { XDG_DATA_HOME: customData },
    }));
    expect(p.suggestedTarget).toBe(customTarget);
  });

  it('has no candidates when nothing resolves', () => {
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({}));
    expect(p.candidates).toEqual([]);
    expect(checkClaudeInstall(p).status).toBe('ok');
  });
});
