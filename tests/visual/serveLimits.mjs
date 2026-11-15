// Limits and log format shared by tests/visual/serve.mjs and playwright.config.ts.
// A plain .mjs module, because serve.mjs runs under bare node.

// Limit for the fixture step (writeFixtures.ts) in serve.mjs.
export const FIXTURE_TIMEOUT_MS = 60_000;

// Limit for the whole webServer start: bundles + fixtures + listen. It must exceed FIXTURE_TIMEOUT_MS.
export const WEB_SERVER_TIMEOUT_MS = 120_000;

// The webServer stdout mode. Playwright drops the webServer stdout by default. With 'pipe', the step lines
// of serve.mjs (`Fixture views: ...`, `visual server: <step> <ms>`) reach the gate log.
export const WEB_SERVER_STDOUT = 'pipe';

// One stable line per start step, for example `visual server: fixtures 23140 ms`.
export function formatStepTiming(step, durationMs) {
  return `visual server: ${step} ${Math.round(durationMs)} ms`;
}
