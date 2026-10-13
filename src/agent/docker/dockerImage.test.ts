import { describe, expect, it } from 'vitest';
import {
  containerBinary,
  imageBuildArgs,
  OPENCODE_IMAGE,
  OPENCODE_V1_VERSION,
  OPENCODE_V2_VERSION,
  opencodeImageTag,
} from './dockerImage.js';

describe('dockerImage', () => {
  it('derives the tag from both pinned versions', () => {
    expect(opencodeImageTag('1.19.0', '2.0.27')).toBe('karst/opencode-sandbox:1.19.0-2.0.27');
    expect(OPENCODE_IMAGE).toBe(opencodeImageTag(OPENCODE_V1_VERSION, OPENCODE_V2_VERSION));
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
