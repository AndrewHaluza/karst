import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  containerBinary,
  imageBuildArgs,
  OPENCODE_IMAGE,
  OPENCODE_V1_VERSION,
  OPENCODE_V2_VERSION,
  opencodeImageTag,
  PLAYWRIGHT_VERSION,
} from './dockerImage.js';

describe('dockerImage', () => {
  it('derives the tag from both pinned versions, the Playwright release and the revision', () => {
    expect(opencodeImageTag('1.19.0', '2.0.27')).toBe('karst/opencode-sandbox:1.19.0-2.0.27-pw1.63.0-r2');
    expect(OPENCODE_IMAGE).toBe(opencodeImageTag(OPENCODE_V1_VERSION, OPENCODE_V2_VERSION));
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
      '/ext/dist/sandbox/opencode',
    ]);
  });

  it('keeps a context path with spaces as one argument', () => {
    expect(imageBuildArgs('/a b/c').at(-1)).toBe('/a b/c');
  });

  it('maps each core to its launcher inside the image', () => {
    expect(containerBinary('opencode')).toBe('opencode1');
    expect(containerBinary('opencode2')).toBe('opencode2');
  });
});
