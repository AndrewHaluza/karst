/**
 * Click-feedback timing shared by the vanilla runtime ([[designRuntime]]) and
 * the React `useHostMutation` hook, so both surfaces show the same thing for
 * the same reply latency (UI-R11, SG-19).
 */

/** A spinner stays hidden until the reply is this late — near-instant work never flickers. */
export const SPINNER_DELAY_MS = 400;

/** Once a spinner is visible it stays at least this long. */
export const SPINNER_MIN_VISIBLE_MS = 500;

/** Tier 3 (`confirm`): how long the in-place check stays. */
export const CONFIRM_DWELL_MS = 1200;

export type ClickTier = 'view' | 'mutation' | 'confirm';
