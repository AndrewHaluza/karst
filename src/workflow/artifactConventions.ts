/**
 * Strict, host-agnostic interpolation for Git and GitHub artifact conventions.
 *
 * Unlike the UI label renderer, an invalid token must never silently disappear
 * into public metadata. Manifest loading validates templates up front; rendering
 * repeats that guard for direct callers and rejects a blank final artifact.
 */

import { hasVariable, parseTemplateTokens, parseTokenBody } from '../template/token.js';
import { applyTransforms, validateTemplateTransforms } from '../template/transforms.js';

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
  /** Implementation agent core (session-then-ticket-then-manifest precedence). */
  provider?: string;
  /** Implementation model (per-ticket override, else the manifest default). */
  model?: string;
  /** The approach the implementation ran under. */
  approach?: string;
  /** The agent session id that implemented the ticket. */
  sessionId?: string;
}

const COMMON_VARIABLES = ['title', 'key', 'id', 'repo', 'type', 'scope'] as const;
// The description template is the only artifact that can name the agent that
// implemented the work — provider/model/approach/sessionId are per-ticket facts
// with no meaning on a commit subject or a PR title.
const DESCRIPTION_VARIABLES = ['description', 'provider', 'model', 'approach', 'sessionId'] as const;
const VARIABLES: Record<ArtifactConventionName, ReadonlySet<string>> = {
  commitMessage: new Set(COMMON_VARIABLES),
  pullRequestTitle: new Set(COMMON_VARIABLES),
  pullRequestDescription: new Set([...COMMON_VARIABLES, ...DESCRIPTION_VARIABLES]),
};

const TOKEN = /\{([^{}]*)\}/g;

/**
 * Validate one template's syntax, artifact-specific variable vocabulary, and any
 * placeholder transforms. Literal braces are intentionally unsupported: there is
 * no escaping contract.
 */
export function validateArtifactTemplate(
  field: ArtifactConventionName,
  template: string,
): void {
  if (template.trim() === '') {
    throw new Error(`${field} template must not be blank`);
  }

  const allowed = VARIABLES[field];
  const tokens = parseTemplateTokens(template);
  let remainder = '';
  let lastIndex = 0;
  for (const token of tokens) {
    remainder += template.slice(lastIndex, token.index);
    if (!allowed.has(token.variable)) {
      throw new Error(`${field} contains unsupported variable "{${token.variable}}"`);
    }
    lastIndex = token.index + token.raw.length;
  }
  remainder += template.slice(lastIndex);
  if (remainder.includes('{') || remainder.includes('}')) {
    throw new Error(`${field} contains malformed template braces`);
  }
  validateTemplateTransforms(field, tokens);
}

/**
 * Whether rendering this body requires generated pull-request prose. Parsed
 * rather than string-matched: `{description|trim}` still needs the summary, and
 * a substring check would silently skip the generation call.
 */
export function usesDescription(template: string): boolean {
  return hasVariable(template, 'description');
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
    provider: context.provider ?? '',
    model: context.model ?? '',
    approach: context.approach ?? '',
    sessionId: context.sessionId ?? '',
  };
  const rendered = template.replace(TOKEN, (_match, body: string) => {
    const { variable, transforms } = parseTokenBody(body);
    return applyTransforms(values[variable]!, transforms);
  });
  if (rendered.trim() === '') {
    throw new Error(`${field} rendered to a blank value`);
  }
  return rendered;
}
