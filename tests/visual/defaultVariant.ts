import type { ViewId } from './corpora.js';

/**
 * The registered variant (tests/visual/variants.ts) that a spec opens when it checks the default page of a view,
 * not a named state (@ui:VISUAL-VARIANTS). Dashboard `pending` and settings `minimal` hold the corpora that
 * FOCUS_COUNT_RATCHET and CONTRAST_RATCHET were measured on; settings `populated` uses REALISTIC_SETTINGS.
 */
export const DEFAULT_VARIANT: Readonly<Record<ViewId, string>> = {
  dashboard: 'pending',
  usage: 'populated',
  resources: 'populated',
  serverLogs: 'populated',
  sidebar: 'populated',
  diffs: 'populated',
  settings: 'minimal',
  ticketForm: 'populated',
  gettingStarted: 'populated',
};
