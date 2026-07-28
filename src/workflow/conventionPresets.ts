import type { ArtifactConventions } from '../manifest/types.js';

/**
 * Ready-made convention sets Settings offers as a starting point.
 *
 * A preset is a PROPOSAL: applying one fills the settings draft, which the user
 * reviews (with live previews) and saves — nothing here is ever written to a
 * manifest on its own. Absent conventions keep Karst's historical behavior, so
 * the presets exist to make the recommended shape one click away rather than to
 * change what an unconfigured project does.
 *
 * The webview cannot import TypeScript, so `webview.html` mirrors these values;
 * `webview.test.ts` pins the mirror against this module.
 */
export interface ConventionPreset {
  id: string;
  label: string;
  description: string;
  conventions: Required<Pick<
    ArtifactConventions,
    'branchName' | 'commitMessage' | 'pullRequestTitle' | 'pullRequestDescription'
  >>;
}

export const CONVENTION_PRESETS: ConventionPreset[] = [
  {
    id: 'conventional',
    label: 'Conventional Commits',
    description: "type(scope) subjects, ticket key appended — the recommended default.",
    conventions: {
      branchName: 'karst/{type}/{slug}',
      commitMessage: '{type}({scope}): {title} [{key}]',
      pullRequestTitle: '{type}({scope}): {title}',
      pullRequestDescription: '## Summary\n{description}\n\nTicket: {key}\nRepository: {repo}',
    },
  },
  {
    id: 'ticket-prefixed',
    label: 'Ticket-prefixed',
    description: 'Ticket key leads every artifact; no conventional type.',
    conventions: {
      branchName: '{key}-{slug}',
      commitMessage: '[{key}] {title}',
      pullRequestTitle: '[{key}] {title}',
      pullRequestDescription: '## Summary\n{description}\n\nTicket: {key}',
    },
  },
  {
    id: 'plain',
    label: 'Plain',
    description: 'Title only — closest to Karst\'s behavior with no conventions set.',
    conventions: {
      branchName: 'karst/{slug}',
      commitMessage: '{title}',
      pullRequestTitle: '{title}',
      pullRequestDescription: '{description}',
    },
  },
];

/** The preset Settings offers first. */
export const RECOMMENDED_PRESET_ID = 'conventional';

export function findPreset(id: string): ConventionPreset | undefined {
  return CONVENTION_PRESETS.find((p) => p.id === id);
}
