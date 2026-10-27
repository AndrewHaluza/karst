import { describe, it, expect } from 'vitest';
import type { Manifest } from '../manifest/types.js';
import {
  KARST_SETUP_SESSION_ENV,
  setupAddDirs,
  setupInstructions,
  setupKickoff,
} from './instructions.js';

const manifest = {
  baselineBranch: 'main',
  repositories: {
    web: { repoPath: '/w/web', hasMigrations: false, baselineBranch: 'develop' },
    docs: { repoPath: '/w/docs', hasMigrations: false, enabled: false },
  },
} as unknown as Pick<Manifest, 'baselineBranch' | 'repositories'>;

describe('setupInstructions', () => {
  const text = setupInstructions({ title: 'Onboard', manifest });

  it('names the session and the no-edit rule', () => {
    expect(text).toContain('karst SETUP session: "Onboard"');
    expect(text).toMatch(/CANNOT edit repository files/);
  });

  it('documents discovery, validate, propose, propose-change and the verify loop', () => {
    expect(text).toContain('setup discover');
    expect(text).toContain('manifest validate --file');
    expect(text).toContain('manifest propose --file');
    expect(text).toContain('setup propose-change');
    expect(text).toMatch(/spins the baseline services/);
    expect(text).toContain('setup verify');
    expect(text).toContain('setup check');
    expect(text).toMatch(/End the session ONLY when it reports ok/);
  });

  it('states the process rules a check cannot enforce', () => {
    expect(text).toContain('the host is the only writer of karst.yml');
    expect(text).toContain('setup status');
    expect(text).toContain('`applied`');
    expect(text).toMatch(/at most ONE retry/);
    expect(text).toContain('propose-change --file');
    expect(text).not.toContain("printf '%s'");
    expect(text).toContain('`path` overrides `repo`');
    expect(text).toContain('path: "."');
    expect(text).toContain('manifest show --active');
    expect(text).toContain('cookbook');
  });

  it('states the never-assume-develop rule and the no-placeholder rule', () => {
    expect(text).toMatch(/NEVER assume develop/);
    expect(text).toMatch(/never invent a placeholder/);
  });

  it('states the minimal-diff / keep-id rule and the monorepo one-main-service rule', () => {
    expect(text).toMatch(/MINIMAL edit/);
    expect(text).toMatch(/NEVER change `id`/);
    expect(text).toMatch(/one main service/);
  });

  it('lists only enabled repositories with their resolved base branch', () => {
    expect(text).toContain('- web: /w/web (base develop)');
    expect(text).not.toContain('/w/docs');
  });

  it('handles no manifest', () => {
    const none = setupInstructions({ title: 'T', manifest: undefined });
    expect(none).toContain('(none — there is no karst.yml yet)');
  });
});

describe('setupAddDirs', () => {
  it('dedupes enabled repository paths', () => {
    expect(setupAddDirs(manifest)).toEqual(['/w/web']);
    expect(setupAddDirs(undefined)).toEqual([]);
  });
});

describe('setupKickoff / env name', () => {
  it('is empty by default and trims a provided message', () => {
    expect(setupKickoff()).toBe('');
    expect(setupKickoff('  hi  ')).toBe('hi');
    expect(KARST_SETUP_SESSION_ENV).toBe('KARST_SETUP_SESSION');
  });
});
