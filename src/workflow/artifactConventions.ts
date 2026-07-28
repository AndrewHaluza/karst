/**
 * Strict, host-agnostic interpolation for Git and GitHub artifact conventions.
 *
 * Unlike the UI label renderer, an invalid token must never silently disappear
 * into public metadata. Manifest loading validates templates up front; rendering
 * repeats that guard for direct callers and rejects a blank final artifact.
 */

export type ArtifactConventionName =
  | 'commitMessage'
  | 'pullRequestTitle'
  | 'pullRequestDescription';

export interface ArtifactTemplateContext {
  id: number;
  key: string;
  title: string;
  repo: string;
  /** Conventional-commit type: the ticket's, else `conventions.defaultType`, else `feat`. */
  type: string;
  /** Conventional-commit scope: the repository's `scope:`, else its manifest name. */
  scope: string;
  description?: string;
}

const COMMON_VARIABLES = ['title', 'key', 'id', 'repo', 'type', 'scope'] as const;
const VARIABLES: Record<ArtifactConventionName, ReadonlySet<string>> = {
  commitMessage: new Set(COMMON_VARIABLES),
  pullRequestTitle: new Set(COMMON_VARIABLES),
  pullRequestDescription: new Set([...COMMON_VARIABLES, 'description']),
};

const TOKEN = /\{([^{}]*)\}/g;

/**
 * Validate one template's syntax and artifact-specific variable vocabulary.
 * Literal braces are intentionally unsupported: there is no escaping contract.
 */
export function validateArtifactTemplate(
  field: ArtifactConventionName,
  template: string,
): void {
  if (template.trim() === '') {
    throw new Error(`${field} template must not be blank`);
  }

  const allowed = VARIABLES[field];
  let remainder = '';
  let lastIndex = 0;
  for (const match of template.matchAll(TOKEN)) {
    remainder += template.slice(lastIndex, match.index);
    const token = match[1]!;
    if (!allowed.has(token)) {
      throw new Error(`${field} contains unsupported variable "{${token}}"`);
    }
    lastIndex = match.index! + match[0].length;
  }
  remainder += template.slice(lastIndex);
  if (remainder.includes('{') || remainder.includes('}')) {
    throw new Error(`${field} contains malformed template braces`);
  }
}

/** Whether rendering this body requires generated pull-request prose. */
export function usesDescription(template: string): boolean {
  return template.includes('{description}');
}

/** Render a validated template once; substituted values are never rescanned. */
export function renderArtifactTemplate(
  field: ArtifactConventionName,
  template: string,
  context: ArtifactTemplateContext,
): string {
  validateArtifactTemplate(field, template);
  const values: Record<string, string> = {
    id: String(context.id),
    key: context.key,
    title: context.title,
    repo: context.repo,
    type: context.type,
    scope: context.scope,
    description: context.description ?? '',
  };
  const rendered = template.replace(TOKEN, (_match, token: string) => values[token]!);
  if (rendered.trim() === '') {
    throw new Error(`${field} rendered to a blank value`);
  }
  return rendered;
}
