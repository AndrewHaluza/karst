// Gate for the UI driver (arch:UATHOST-02). Plain JS: run.mjs runs before `dist` is guaranteed and must not import the TS steps module.
export const UI_STEP_TYPES = ['click', 'type', 'press', 'read'];
/** Chromium debugging port. It is published by nothing: `docker.mjs` passes no `-p`, so it stays inside the container. */
export const UI_CDP_PORT = 9222;

/** True when the steps JSON (a bare array or `{steps}`) holds at least one UI step. Malformed input is false: the host's parseSteps reports it. */
export function scriptHasUiStep(json) {
  const list = Array.isArray(json) ? json : json?.steps;
  return Array.isArray(list) && list.some((s) => s !== null && typeof s === 'object' && UI_STEP_TYPES.includes(s.type));
}

/** What a run adds for a UI script: the CDP port flag, the channel env, and whether to start the driver. No UI step adds nothing. */
export function uiHostPlan(hasUi, socketPath) {
  if (!hasUi) return { enabled: false, launchArgs: [], testsEnv: {} };
  return {
    enabled: true,
    launchArgs: [`--remote-debugging-port=${UI_CDP_PORT}`],
    testsEnv: { UAT_UI_SOCKET: socketPath },
  };
}

/** Lines of `after` not in `before` and the reverse; order kept, duplicates dropped. */
export function diffLines(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    textAdded: [...new Set(after.filter((l) => !b.has(l)))],
    textRemoved: [...new Set(before.filter((l) => !a.has(l)))],
  };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
