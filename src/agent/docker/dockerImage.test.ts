import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AGY_VERSION,
  containerBinary,
  DOCKER_CORES,
  imageBuildArgs,
  OPENCODE_IMAGE,
  OPENCODE_IMAGE_REVISION,
  OPENCODE_V1_VERSION,
  OPENCODE_V2_VERSION,
  opencodeImageTag,
  PLAYWRIGHT_VERSION,
} from './dockerImage.js';

describe('dockerImage', () => {
  it('derives the tag from both pinned versions, the Playwright release and the revision', () => {
    expect(opencodeImageTag('1.19.0', '2.0.27')).toBe('karst/opencode-sandbox:1.19.0-2.0.27-pw1.63.0-r4');
    expect(OPENCODE_IMAGE_REVISION).toBe('r4');
    expect(OPENCODE_IMAGE).toBe(opencodeImageTag(OPENCODE_V1_VERSION, OPENCODE_V2_VERSION));
    expect(AGY_VERSION).toBe('1.4.6');
  });

  it('pins the same Playwright release the repository tests with', () => {
    // The visual baselines are recorded with THIS browser build, so the
    // sandbox that runs a repository's gates has to ship the same one. The
    // two constants are written down twice (the image and package.json);
    // this is what keeps them from drifting.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@playwright/test']).toBe(PLAYWRIGHT_VERSION);
  });

  it('builds the image from a Dockerfile whose defaults are the same pins', () => {
    // The Dockerfile ships in the image's build context, and the build passes
    // the versions as args — but the defaults are what a MANUAL build uses, so
    // they have to be the same pins. The base image tag reads the same
    // argument, so the rendering environment the baselines belong to and the
    // browser inside it cannot drift apart.
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../sandbox/opencode/Dockerfile', import.meta.url)),
      'utf8',
    );
    expect(dockerfile).toContain(`ARG PW=${PLAYWRIGHT_VERSION}`);
    expect(dockerfile).toContain(`ARG OC1=${OPENCODE_V1_VERSION}`);
    expect(dockerfile).toContain(`ARG OC2=${OPENCODE_V2_VERSION}`);
    expect(dockerfile).toContain('FROM mcr.microsoft.com/playwright:v${PW}-noble AS baseline');
  });

  it('carries what a repository’s gates need: lsof, a git identity, a reaping init', () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../sandbox/opencode/Dockerfile', import.meta.url)),
      'utf8',
    );
    // The port-conflict/server-identity path cannot name a listener without it.
    expect(dockerfile).toMatch(/apt-get install[^\n]*\blsof\b/);
    // A scratch repo a gate commits into has no identity of its own.
    expect(dockerfile).toContain('git config --system user.name');
    expect(dockerfile).toContain('git config --system user.email');
  });

  it('copies the baseline fonts AFTER the browser install, and wipes first', () => {
    // `playwright install --with-deps` apt-installs THIS distro's font packages
    // (bookworm's Liberation 1.07 vs noble's 2.1.5) over whatever was copied
    // before it, so a font copy that precedes it makes the sweep diff the
    // distro instead of the page. The copy must also REPLACE the trees (COPY
    // merges, and a distro-only face would survive beside the baseline's).
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../sandbox/opencode/Dockerfile', import.meta.url)),
      'utf8',
    );
    const install = dockerfile.indexOf('playwright install --with-deps');
    const wipe = dockerfile.indexOf('rm -rf /usr/share/fonts');
    const fonts = dockerfile.indexOf('COPY --from=baseline /usr/share/fonts');
    const rules = dockerfile.indexOf('COPY --from=baseline /etc/fonts');
    expect(install).toBeGreaterThan(-1);
    expect(wipe).toBeGreaterThan(install);
    expect(fonts).toBeGreaterThan(wipe);
    expect(rules).toBeGreaterThan(wipe);
    expect(dockerfile.indexOf('fc-cache -f')).toBeGreaterThan(rules);
  });

  it('refuses a version that is not a plain semver (it becomes an image tag)', () => {
    expect(() => opencodeImageTag('latest', '2.0.27')).toThrow(/unpinned/);
    expect(() => opencodeImageTag('1.19.0', '2.0.27;rm')).toThrow(/unpinned/);
  });

  it('builds with the pinned versions as build args, context last (argv array)', () => {
    expect(imageBuildArgs('/ext/dist/sandbox/opencode')).toEqual([
      'build', '--tag', OPENCODE_IMAGE,
      '--build-arg', `OC1=${OPENCODE_V1_VERSION}`,
      '--build-arg', `OC2=${OPENCODE_V2_VERSION}`,
      '--build-arg', `PW=${PLAYWRIGHT_VERSION}`,
      '--build-arg', `AGY=${AGY_VERSION}`,
      '/ext/dist/sandbox/opencode',
    ]);
  });

  it('keeps a context path with spaces as one argument', () => {
    expect(imageBuildArgs('/a b/c').at(-1)).toBe('/a b/c');
  });

  it('maps each core to its launcher inside the image', () => {
    expect(DOCKER_CORES).toEqual(['opencode', 'opencode2', 'antigravity', 'agy']);
    expect(containerBinary('opencode')).toBe('opencode1');
    expect(containerBinary('opencode2')).toBe('opencode2');
    expect(containerBinary('antigravity')).toBe('agy');
    expect(containerBinary('agy')).toBe('agy');
  });

  it('Dockerfile downloads pinned agy, verifies sha512, and pre-creates node-owned gemini dirs', () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL('../../../sandbox/opencode/Dockerfile', import.meta.url)),
      'utf8',
    );
    expect(dockerfile).toContain('ARG AGY=1.4.6');
    expect(dockerfile).toContain('https://storage.googleapis.com/antigravity-public/antigravity-cli/');
    expect(dockerfile).toContain('0daa84244922bd648f940d44dfc33ace8c26217cd710ff116902eb8708829a0cfe70640f0d6b480243442881c9aeb4a905a9aa7887dd8a70159aa0f1a4f98a8f');
    expect(dockerfile).toContain('4e1244b8b8c1280552f59c1b24b76a9245db9c80032aec6db28fb86033d6088abc30a90dad432d2b246c28fdd87d82abb48727d5ff88ba1d5d4ec76b33348e7d');
    expect(dockerfile).toContain('/usr/local/bin/agy');
    expect(dockerfile).toContain('/home/node/.gemini/antigravity-cli');
    expect(dockerfile).toContain('/home/node/.gemini/config');
  });
});
