import { describe, expect, it } from 'vitest';
import {
  checkClaudeInstall,
  claudeLinkProbe,
  claudeRealTarget,
  CLAUDE_LINK_CHECK_ID,
  isKarstOpencode2DataHome,
  isUnder,
  type ClaudeLinkLookups,
  type ClaudeLinkProbe,
} from './claudeInstallCheck.js';

const KARST_ROOT = '/Users/me/Library/Application Support/Cursor/User/globalStorage/karst.karst';

function probe(overrides: Partial<ClaudeLinkProbe> = {}): ClaudeLinkProbe {
  return {
    linkPath: '/Users/me/.local/bin/claude',
    resolvedPath: '/Users/me/.local/share/claude/versions/2.1.296',
    linkTarget: undefined,
    karstRoot: KARST_ROOT,
    suggestedTarget: undefined,
    ...overrides,
  };
}

describe('checkClaudeInstall', () => {
  it('is ok when no claude is installed', () => {
    const c = checkClaudeInstall(probe({ linkPath: '', resolvedPath: undefined }));
    expect(c).toMatchObject({ id: CLAUDE_LINK_CHECK_ID, area: 'tools', status: 'ok' });
  });

  it('is ok when claude resolves to the user\'s own install', () => {
    const c = checkClaudeInstall(probe());
    expect(c.status).toBe('ok');
    expect(c.fix).toBeUndefined();
  });

  it('is ok for a broken link that does not point into karst storage', () => {
    const c = checkClaudeInstall(
      probe({ resolvedPath: undefined, linkTarget: '/nowhere/claude' }),
    );
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('broken link');
  });

  it('is ok for a sibling dir that merely shares the storage prefix', () => {
    const c = checkClaudeInstall(
      probe({ resolvedPath: `${KARST_ROOT}-other/opencode2/data/claude/versions/2.1.296` }),
    );
    expect(c.status).toBe('ok');
  });

  it('warns when the global link resolves into karst storage, naming both paths', () => {
    const resolved = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;
    const c = checkClaudeInstall(
      probe({ resolvedPath: resolved, suggestedTarget: '/Users/me/.local/share/claude/versions/2.1.296' }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/Users/me/.local/bin/claude');
    expect(c.detail).toContain(resolved);
  });

  // The state karst cleanup leaves behind: `~/.local/bin/claude` is now a
  // DANGLING link into removed karst storage. `realpath` cannot read it, but the
  // check must still connect the breakage to karst (the medium UAT finding).
  it('warns when a DANGLING link points into karst storage', () => {
    const target = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;
    const c = checkClaudeInstall(
      probe({ resolvedPath: undefined, linkTarget: target, suggestedTarget: '/Users/me/.local/share/claude/versions/2.1.296' }),
    );
    expect(c.status).toBe('warn');
    expect(c.detail).toContain(target);
    expect(c.detail).toContain('GONE');
    expect(c.detail).toContain('cleanup');
  });

  it('reports the exact relink command and never auto-fixes', () => {
    const resolved = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;
    const c = checkClaudeInstall(
      probe({ resolvedPath: resolved, suggestedTarget: '/Users/me/.local/share/claude/versions/2.1.296' }),
    );
    const fix = c.fix;
    expect(fix?.tier).toBe('report');
    expect(fix?.tier === 'report' ? fix.nextStep : '').toContain(
      'ln -sfn /Users/me/.local/share/claude/versions/2.1.296 /Users/me/.local/bin/claude',
    );
  });

  it('falls back to reinstall guidance when no real install was found', () => {
    const resolved = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;
    const c = checkClaudeInstall(probe({ resolvedPath: resolved }));
    const fix = c.fix;
    expect(c.status).toBe('warn');
    expect(fix?.tier).toBe('report');
    expect(fix?.tier === 'report' ? fix.nextStep : '').toContain('claude install');
  });

  it('does not flag a blank karst root', () => {
    expect(checkClaudeInstall(probe({ karstRoot: '' })).status).toBe('ok');
  });
});

describe('claudeRealTarget', () => {
  const KARST_DATA = `${KARST_ROOT}/opencode2/data`;

  it('maps the isolated data dir back to the user\'s own', () => {
    expect(
      claudeRealTarget(`${KARST_DATA}/claude/versions/2.1.296`, '/Users/me/.local/share'),
    ).toBe('/Users/me/.local/share/claude/versions/2.1.296');
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
  });

  it('is false for a blank root', () => {
    expect(isUnder('/anything', '')).toBe(false);
  });
});

describe('isKarstOpencode2DataHome', () => {
  it('matches karst\'s isolated opencode2 data dir, whatever the storage root', () => {
    expect(isKarstOpencode2DataHome('/a/gs/karst.karst/opencode2/data')).toBe(true);
    expect(isKarstOpencode2DataHome('/b/other/opencode2/data/')).toBe(true);
    expect(isKarstOpencode2DataHome('/home/u/.local/share')).toBe(false);
    expect(isKarstOpencode2DataHome('/a/opencode2/config')).toBe(false);
  });
});

describe('claudeLinkProbe', () => {
  const HOME = '/home/u';
  const LINK = `${HOME}/.local/bin/claude`;
  const KARST_ROOT = '/private/var/gs/karst.karst';
  const KARST_LINK = `${KARST_ROOT}/opencode2/data/claude/versions/2.1.296`;
  const REAL_TARGET = `${HOME}/.local/share/claude/versions/2.1.296`;

  /**
   * A fake machine. `files` are paths `existsSync` resolves; `symlinks` are
   * directory entries that `lstat` sees and `readlink` reports — including
   * DANGLING ones, whose target is absent from `files`.
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
      files: [KARST_LINK, REAL_TARGET, KARST_ROOT],
      symlinks: { [LINK]: KARST_LINK, '/var/gs/karst.karst': KARST_ROOT },
    }));
    expect(p.linkPath).toBe(LINK);
    expect(p.resolvedPath).toBe(KARST_LINK);
    expect(p.karstRoot).toBe(KARST_ROOT); // canonicalized `/var` → `/private/var`
    expect(p.suggestedTarget).toBe(REAL_TARGET);
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('detects a DANGLING home link into missing karst storage', () => {
    // KARST_LINK is NOT in `files`: karst cleaned its dir, so the link dangles.
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [REAL_TARGET, KARST_ROOT],
      symlinks: { [LINK]: KARST_LINK, '/var/gs/karst.karst': KARST_ROOT },
    }));
    expect(p.linkPath).toBe(LINK);
    expect(p.resolvedPath).toBeUndefined();
    expect(p.linkTarget).toBe(KARST_LINK);
    expect(p.suggestedTarget).toBe(REAL_TARGET);
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('normalizes a dangling target written through a symlinked storage ancestor', () => {
    // The link stores the RAW `/var/...` target; the db root canonicalizes to
    // `/private/var/...`. The dangling target must still prefix-match.
    const rawTarget = '/var/gs/karst.karst/opencode2/data/claude/versions/2.1.296';
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [REAL_TARGET, KARST_ROOT],
      symlinks: { [LINK]: rawTarget, '/var/gs/karst.karst': KARST_ROOT },
    }));
    expect(p.linkTarget).toBe(KARST_LINK); // canonicalized via the existing ancestor
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('ignores an XDG_DATA_HOME that points back into karst storage', () => {
    const rawKarstData = '/var/gs/karst.karst/opencode2/data';
    const p = claudeLinkProbe('/var/gs/karst.karst/karst.db', fake({
      files: [KARST_LINK, REAL_TARGET, KARST_ROOT, `${KARST_ROOT}/opencode2/data`],
      symlinks: {
        [LINK]: KARST_LINK,
        '/var/gs/karst.karst': KARST_ROOT,
        [rawKarstData]: `${KARST_ROOT}/opencode2/data`,
      },
      env: { XDG_DATA_HOME: rawKarstData },
    }));
    expect(p.suggestedTarget).toBe(REAL_TARGET);
  });

  // The low UAT finding: the inherited XDG_DATA_HOME belongs to a DIFFERENT
  // karst storage than the doctor's own `--db`, so the db-root guard misses it.
  it('ignores an XDG_DATA_HOME that is another karst storage\'s opencode2 data dir', () => {
    const otherStorage = '/Users/me/other/gs/karst.karst/opencode2/data';
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: [`/gs/karst.karst/opencode2/data/claude/versions/2.1.296`, REAL_TARGET, otherStorage],
      symlinks: { [LINK]: '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { XDG_DATA_HOME: otherStorage },
    }));
    expect(p.suggestedTarget).toBe(REAL_TARGET);
  });

  it('honors a user XDG_DATA_HOME outside karst storage', () => {
    const customData = `${HOME}/custom/data`;
    const customTarget = `${HOME}/custom/data/claude/versions/2.1.296`;
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      files: [LINK, '/gs/karst.karst', customTarget],
      symlinks: { [LINK]: '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
      env: { XDG_DATA_HOME: customData },
    }));
    expect(p.suggestedTarget).toBe(customTarget);
  });

  it('has no suggested target when the user has no other install', () => {
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({
      symlinks: { [LINK]: '/gs/karst.karst/opencode2/data/claude/versions/2.1.296' },
    }));
    expect(p.suggestedTarget).toBeUndefined();
    expect(checkClaudeInstall(p).status).toBe('warn');
  });

  it('falls back to PATH when ~/.local/bin/claude is absent', () => {
    const onPath = '/opt/homebrew/bin/claude';
    const p = claudeLinkProbe('/gs/karst.karst/karst.db', fake({ files: [onPath], onPath }));
    expect(p.linkPath).toBe(onPath);
    expect(p.resolvedPath).toBe(onPath);
    expect(checkClaudeInstall(p).status).toBe('ok');
  });
});
