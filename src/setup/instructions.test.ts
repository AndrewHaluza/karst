import { describe, it, expect } from 'vitest';
import type { Manifest } from '../manifest/types.js';
import { sessionCliEnv } from '../agent/cliEnv.js';
import { parseGlobalFlags } from '../cli/main.js';
import { parseSetupCheckArgs } from '../cli/setupCheck.js';
import { parseSetupVerifyArgs } from '../cli/setupVerify.js';
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

  it('has the graphWorkspace step: propose a block only for a gap, nothing for a fit', () => {
    expect(text).toContain('graphDeps');
    expect(text).toContain('graphWorkspace: { link?, setup?, setupWhen? }');
    expect(text).toMatch(/"gap"[\s\S]*one-line reason/);
    expect(text).toMatch(/"fits", propose nothing/);
  });

  it('replaces the free steps with the checklist loop and gives the skip to the user', () => {
    expect(text).toContain('setup checklist --db "$KARST_DB" --manifest "$KARST_MANIFEST"');
    expect(text).toContain('setup checklist');
    expect(text).toMatch(/Take each `todo` item in order/);
    expect(text).toMatch(/confirm it with `[^`]*setup status`/);
    expect(text).toMatch(/End the session ONLY when no required item is `todo`/);
    expect(text).toContain('setup skip');
    expect(text).toMatch(/Only the user skips an item/);
    expect(text).toMatch(/same list/);
  });

  it('names the session and the no-edit rule', () => {
    expect(text).toContain('karst SETUP session: "Onboard"');
    expect(text).toMatch(/CANNOT edit repository files/);
  });

  it('documents discovery, validate, propose, propose-change and the verify loop', () => {
    expect(text).toContain('setup discover');
    expect(text).toContain('setup set-<section>');
    expect(text).toContain('add-repo');
    expect(text).toContain('setup fix <item code>');
    expect(text).toContain('setup propose-change');
    expect(text).toMatch(/spins the baseline services/);
    expect(text).toContain('setup verify');
    expect(text).toContain('setup check');
    expect(text).toMatch(/End the session ONLY when it reports ok/);
  });

  it('tells the agent to give values to typed tools, never a proposal format', () => {
    expect(text).toMatch(/do NOT write YAML, a patch or a proposal file/);
    expect(text).toMatch(/a key set to null removes that key/);
    expect(text).toContain('karst schema setup <tool>');
    expect(text).toMatch(/ONE popup/);
    expect(text).toContain('setup withdraw <op id>');
    expect(text).toMatch(/NEVER change `id` unless this is the first setup/);
  });

  it('limits the fix loop to fails the commands can fix and says a protected field is settable', () => {
    expect(text).toMatch(/Fix each fail that these commands can fix/);
    expect(text).toMatch(/protected field is settable through the typed tools/);
  });

  it('routes a retired or legacy key warning to setup fix and forbids propose-change on .karst/', () => {
    expect(text).toMatch(/retired or legacy key[^.]*setup fix/);
    expect(text).toMatch(/Never use propose-change on \.karst\//);
  });

  it('prints setup verify and setup check with their required flags', () => {
    const flags = '--db "$KARST_DB" --manifest "$KARST_MANIFEST"';
    expect(text).toContain(`setup verify ${flags}`);
    expect(text).toContain(`setup check ${flags}`);
    expect(text).toContain(`setup checklist ${flags}`);
  });

  it.each([
    ['check', parseSetupCheckArgs],
    ['verify', parseSetupVerifyArgs],
  ] as const)('the printed setup %s line passes argument parsing in a setup session env', (verb, parse) => {
    const env = sessionCliEnv({ cliEntry: '/x/cli.js', dbPath: '/d/karst.db', manifestPath: '/w/karst.yml' });
    const line = text.split('\n').find((l) => l.includes(`setup ${verb} --db`));
    expect(line).toBeDefined();
    const argv = line!
      .slice(line!.indexOf(`setup ${verb}`))
      .split('`')[0]!
      .trim()
      .split(/\s+/)
      .map((a) => a.replace(/^"\$(\w+)"$/, (_m, name: string) => env[name] ?? `<unset ${name}>`));
    const flags = parseGlobalFlags(argv);
    expect(flags.db).toBe('/d/karst.db');
    expect(flags.manifest).toBe('/w/karst.yml');
    expect(() => parse(flags.rest)).not.toThrow();
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
