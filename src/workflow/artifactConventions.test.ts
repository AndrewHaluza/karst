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
  type: 'feat',
  scope: 'web',
  description: 'Adds indexed search.',
  provider: 'claude',
  model: 'claude-sonnet-5',
  approach: 'rpi',
  sessionId: 'sess_1',
};

describe('artifact convention validation', () => {
  it('allows the common variables for every artifact', () => {
    const template = '{title} {key} {id} {repo} {type} {scope}';
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

  it('allows implementation metadata only in pull-request descriptions', () => {
    const template = '{provider} {model} {approach} {sessionId}';
    expect(() => validateArtifactTemplate('pullRequestDescription', template)).not.toThrow();
    expect(() => validateArtifactTemplate('commitMessage', '{provider}')).toThrow(
      /commitMessage.*\{provider\}/,
    );
    expect(() => validateArtifactTemplate('pullRequestTitle', '{sessionId}')).toThrow(
      /pullRequestTitle.*\{sessionId\}/,
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

  it('renders the implementation metadata with empty values falling back via default', () => {
    expect(
      renderArtifactTemplate(
        'pullRequestDescription',
        'Agent: {provider}\nModel: {model}\nApproach: {approach}\nSession: {sessionId}',
        context,
      ),
    ).toBe('Agent: claude\nModel: claude-sonnet-5\nApproach: rpi\nSession: sess_1');
    expect(
      renderArtifactTemplate(
        'pullRequestDescription',
        '{provider|default:n/a} {model|default:n/a} {approach|default:n/a} {sessionId|default:n/a}',
        { ...context, provider: undefined, model: undefined, approach: undefined, sessionId: undefined },
      ),
    ).toBe('n/a n/a n/a n/a');
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

  it('renders a conventional-commit subject from type and scope', () => {
    expect(
      renderArtifactTemplate('commitMessage', '{type}({scope}): {title} [{key}]', context),
    ).toBe('feat(web): Add search [PROJ-42]');
  });

  it('detects whether generated description prose is required', () => {
    expect(usesDescription('## Summary\n{description}')).toBe(true);
    expect(usesDescription('{title}: description')).toBe(false);
  });

  it('deduplicates a leading ## Summary heading when the template already starts with one', () => {
    const template = '## Summary\n{description}\n\nTicket: {key}';
    const desc = '## Summary\n\nReal content here.';
    const result = renderArtifactTemplate('pullRequestDescription', template, {
      ...context,
      description: desc,
    });
    expect(result).not.toMatch(/^## Summary\n## Summary/);
    const summaryCount = (result.match(/^## Summary$/gm) ?? []).length;
    expect(summaryCount).toBe(1);
  });

  it('preserves a leading ## Summary heading when the template does not start with one', () => {
    const template = '{description}\n\nTicket: {key}';
    const desc = '## Summary\n\nReal content here.';
    const result = renderArtifactTemplate('pullRequestDescription', template, {
      ...context,
      description: desc,
    });
    expect(result).toMatch(/^## Summary\n\nReal content here\./);
  });

  it('does not strip ## Summary from a description without a leading heading', () => {
    const template = '## Summary\n{description}\n\nTicket: {key}';
    const desc = 'Just a summary line.';
    const result = renderArtifactTemplate('pullRequestDescription', template, {
      ...context,
      description: desc,
    });
    expect(result).toMatch(/^## Summary\nJust a summary line\./);
    expect(result).not.toMatch(/^## Summary\n## Summary/);
  });
});

describe('placeholder transforms', () => {
  it('renders the distinguishing tail of a look-alike ticket key', () => {
    expect(
      renderArtifactTemplate('commitMessage', '{type}: {title} [{key|slice:-4}]', {
        ...context,
        key: '869e82530',
      }),
    ).toBe('feat: Add search [2530]');
    expect(
      renderArtifactTemplate('commitMessage', '{type}: {title} [{key|slice:-4}]', {
        ...context,
        key: '869e820e2',
      }),
    ).toBe('feat: Add search [20e2]');
  });

  it('applies a chain left to right', () => {
    expect(
      renderArtifactTemplate('pullRequestTitle', '{title|truncate:8|upper}', context),
    ).toBe('ADD SEA…');
  });

  it('validates the variable of a transformed placeholder', () => {
    expect(() => validateArtifactTemplate('commitMessage', '{nope|upper}')).toThrow(
      /commitMessage contains unsupported variable "\{nope\}"/,
    );
  });

  it('rejects an unknown transform, naming the placeholder', () => {
    expect(() => validateArtifactTemplate('commitMessage', '{key|slize:-4}')).toThrow(
      /commitMessage contains unknown transform "slize" in "\{key\|slize:-4\}"/,
    );
  });

  it('rejects a malformed argument, naming the placeholder and the reason', () => {
    expect(() => validateArtifactTemplate('pullRequestTitle', '{title|truncate:0}')).toThrow(
      /pullRequestTitle has an invalid "truncate" argument in "\{title\|truncate:0\}": width must be a positive integer/,
    );
  });

  it('an empty description with a default never renders blank', () => {
    expect(
      renderArtifactTemplate('pullRequestDescription', '{description|default:No summary.}', {
        ...context,
        description: '',
      }),
    ).toBe('No summary.');
  });

  it('detects a transformed {description} as still requiring generated prose', () => {
    expect(usesDescription('## Summary\n{description|trim}')).toBe(true);
    expect(usesDescription('{title|default:description}')).toBe(false);
  });

  it('renders templates without transforms byte-identically', () => {
    for (const template of [
      '{type}({scope}): {title} [{key}]',
      '## Summary\n{description}\n\nTicket: {key}\nRepository: {repo}',
      '[{key}] {title}',
      '{title}',
      'no placeholders at all',
    ]) {
      expect(renderArtifactTemplate('pullRequestDescription', template, context)).toBe(
        template.replace(/\{(\w+)\}/g, (_m, name: string) =>
          String(
            {
              id: context.id,
              key: context.key,
              title: context.title,
              repo: context.repo,
              type: context.type,
              scope: context.scope,
              description: context.description ?? '',
            }[name],
          ),
        ),
      );
    }
  });
});
