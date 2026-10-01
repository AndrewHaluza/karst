/**
 * The convention-preview sample and the per-field fallback copy (NDL-126 §8.3).
 *
 * The preview has to answer "what will ship look like?", and the honest answer
 * needs values. These are DISPLAY values, not workflow facts: nothing in the host
 * consumes them, so they live with the tab rather than in `workflow/`. What the
 * tab does consume — the variable vocabularies (`BRANCH_VARIABLES`,
 * `COMMON_CONVENTION_VARIABLES`), the transform names, the presets and the
 * default PR description — is IMPORTED from its TS source (R-X1).
 *
 * An UNKNOWN variable stays LITERAL in the preview, because the host reports it
 * as an error and blanking it here would hide which one is wrong.
 */
import { parseTokenBody } from '../../../../template/token.js';
import { applyTransforms } from '../../../../template/transforms.js';

/** The values every convention preview renders from. */
export const CONVENTION_SAMPLE: Readonly<Record<string, string>> = {
  title: 'add login',
  key: 'PROJ-142',
  id: '142',
  repo: 'frontend',
  type: 'feat',
  scope: 'web',
  slug: 'proj-142-add-login',
  description: 'Adds the requested login flow.',
  provider: 'claude',
  model: 'claude-sonnet-5',
  approach: 'rpi',
  sessionId: 'sess_2b1e9c7a',
};

/** The one-line "what ships if you leave this blank" copy per field. */
export const CONVENTION_FALLBACKS = {
  branchName: 'Default: karst/{type}/{slug} → karst/feat/proj-142-add-login',
  commitMessage: 'Default: resolved ticket title',
  pullRequestTitle: 'Default: resolved ticket title',
  pullRequestDescription:
    'Default: generated summary plus agent metadata (provider, model, approach, session)',
} as const;

export type ConventionField = keyof typeof CONVENTION_FALLBACKS;

/**
 * Render `template` against the sample. An empty template yields the field's
 * fallback copy rather than a blank line, because a blank preview reads as a bug.
 */
export function previewConvention(field: ConventionField, template: string): string {
  if (template.trim() === '') return CONVENTION_FALLBACKS[field];
  return template.replace(/\{([^{}]*)\}/g, (match, body: string) => {
    const token = parseTokenBody(body);
    if (!Object.prototype.hasOwnProperty.call(CONVENTION_SAMPLE, token.variable)) return match;
    return applyTransforms(CONVENTION_SAMPLE[token.variable], token.transforms);
  });
}
