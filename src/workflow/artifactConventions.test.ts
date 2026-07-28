import { describe, expect, it } from 'vitest';
import {
  renderArtifactTemplate,
  usesDescription,
  validateArtifactTemplate,
  type ArtifactTemplateContext,
} from './artifactConventions.js';

const context: ArtifactTemplateContext = {
  id: 42,
  key: 'PROJ-42',
  title: 'Add search',
  repo: 'frontend',
  description: 'Adds indexed search.',
};

describe('artifact convention validation', () => {
  it('allows the common variables for every artifact', () => {
    const template = '{title} {key} {id} {repo}';
    expect(() => validateArtifactTemplate('commitMessage', template)).not.toThrow();
    expect(() => validateArtifactTemplate('pullRequestTitle', template)).not.toThrow();
    expect(() => validateArtifactTemplate('pullRequestDescription', template)).not.toThrow();
  });

  it('allows description only in pull-request descriptions', () => {
    expect(() =>
      validateArtifactTemplate('pullRequestDescription', '{description}'),
    ).not.toThrow();
    expect(() => validateArtifactTemplate('commitMessage', '{description}')).toThrow(
      /commitMessage.*\{description\}/,
    );
    expect(() => validateArtifactTemplate('pullRequestTitle', '{description}')).toThrow(
      /pullRequestTitle.*\{description\}/,
    );
  });

  it('rejects blank, unknown, and malformed templates with the field name', () => {
    expect(() => validateArtifactTemplate('commitMessage', '  \n ')).toThrow(/commitMessage.*blank/);
    expect(() => validateArtifactTemplate('pullRequestTitle', '{ticket}')).toThrow(
      /pullRequestTitle.*\{ticket\}/,
    );
    expect(() => validateArtifactTemplate('pullRequestDescription', 'Summary: {title')).toThrow(
      /pullRequestDescription.*malformed/,
    );
    expect(() => validateArtifactTemplate('commitMessage', 'fix: title}')).toThrow(
      /commitMessage.*malformed/,
    );
  });
});

describe('artifact convention rendering', () => {
  it('globally replaces repeated variables while preserving multiline whitespace', () => {
    expect(
      renderArtifactTemplate(
        'pullRequestDescription',
        '  # {title}\n\n{description}\n\n{repo}: {key} / {key} ({id})  ',
        context,
      ),
    ).toBe(
      '  # Add search\n\nAdds indexed search.\n\nfrontend: PROJ-42 / PROJ-42 (42)  ',
    );
  });

  it('does not rescan braces introduced by a replacement value', () => {
    expect(
      renderArtifactTemplate('commitMessage', 'feat({repo}): {title}', {
        ...context,
        title: 'Keep {repo} literal',
      }),
    ).toBe('feat(frontend): Keep {repo} literal');
  });

  it('rejects a result that becomes blank', () => {
    expect(() =>
      renderArtifactTemplate(
        'pullRequestDescription',
        '{description}',
        { ...context, description: '' },
      ),
    ).toThrow(/pullRequestDescription.*blank/);
  });

  it('detects whether generated description prose is required', () => {
    expect(usesDescription('## Summary\n{description}')).toBe(true);
    expect(usesDescription('{title}: description')).toBe(false);
  });
});
