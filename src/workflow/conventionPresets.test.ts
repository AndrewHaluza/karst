import { describe, expect, it } from 'vitest';
import {
  CONVENTION_PRESETS,
  DEFAULT_PR_DESCRIPTION_TEMPLATE,
  RECOMMENDED_PRESET_ID,
  findPreset,
} from './conventionPresets.js';
import {
  renderArtifactTemplate,
  usesDescription,
  validateArtifactTemplate,
} from './artifactConventions.js';
import { validateBranchTemplate } from '../runtime/branchName.js';
import { validateManifest } from '../manifest/schema.js';

describe('convention presets', () => {
  it('offers the recommended preset', () => {
    expect(findPreset(RECOMMENDED_PRESET_ID)).toBeDefined();
    expect(findPreset('nope')).toBeUndefined();
    expect(new Set(CONVENTION_PRESETS.map((p) => p.id)).size).toBe(CONVENTION_PRESETS.length);
  });

  // A preset the loader would reject is worse than no preset: the user applies
  // it, hits Save, and gets a validation error for a value they never typed.
  it('every preset passes the validators it will be checked against', () => {
    for (const preset of CONVENTION_PRESETS) {
      const c = preset.conventions;
      expect(() => validateBranchTemplate(c.branchName), preset.id).not.toThrow();
      expect(() => validateArtifactTemplate('commitMessage', c.commitMessage)).not.toThrow();
      expect(() => validateArtifactTemplate('pullRequestTitle', c.pullRequestTitle)).not.toThrow();
      expect(() =>
        validateArtifactTemplate('pullRequestDescription', c.pullRequestDescription),
      ).not.toThrow();
    }
  });

  it('every preset loads as part of a manifest', () => {
    for (const preset of CONVENTION_PRESETS) {
      expect(() =>
        validateManifest({
          host: 'localhost',
          portRange: [4000, 4999],
          baselineBranch: 'develop',
          repositories: { web: { repoPath: '/repo' } },
          conventions: preset.conventions,
        }),
        preset.id,
      ).not.toThrow();
    }
  });

  // The default template is what an unconfigured project's PRs open with, so it
  // must validate exactly like a hand-written one and carry the metadata the
  // ticket asked for: implementation agent provider, model, approach, session id.
  it('the default PR description template validates, uses {description}, and renders the metadata', () => {
    expect(() => validateArtifactTemplate('pullRequestDescription', DEFAULT_PR_DESCRIPTION_TEMPLATE)).not.toThrow();
    expect(usesDescription(DEFAULT_PR_DESCRIPTION_TEMPLATE)).toBe(true);
    const rendered = renderArtifactTemplate(
      'pullRequestDescription',
      DEFAULT_PR_DESCRIPTION_TEMPLATE,
      {
        id: 7,
        key: 'PROJ-7',
        title: 'Add search',
        repo: 'web',
        type: 'feat',
        scope: 'web',
        description: 'Adds search.',
        provider: 'codex',
        model: 'sol',
        approach: 'rpi',
        sessionId: 'sess-9',
      },
    );
    expect(rendered).toContain('Adds search.');
    expect(rendered).toContain('Agent: codex');
    expect(rendered).toContain('Model: sol');
    expect(rendered).toContain('Approach: rpi');
    expect(rendered).toContain('Session: sess-9');
  });
});
