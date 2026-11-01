// `npm run test:ui:docker -- <view>`: THE scoped pre-UAT check for a webview change.
//
// (a) the screenshot projects scoped to the view, then
// (b) the FULL authoritative layout run. Ledger keys are global, so a scoped
//     layout run would read every other entry as STALE: the verdict only counts
//     from a full run. A grep-scoped test:visual:docker run is NOT a layout pass.
//
// Both parts go through dockerGate.mjs (docker, or the baseline sandbox).

import { spawnSync } from 'node:child_process';
import { ALL_VIEWS, gateGrep, readSettingsSections } from './uiViews.mjs';

/** The two parts, in order. `env` is merged over the caller's environment. */
export function planScopedRun(view, settingsSections) {
  if (!ALL_VIEWS.includes(view)) {
    throw new Error(`unknown view "${view}"; expected one of: ${ALL_VIEWS.join(', ')}`);
  }
  const grep = gateGrep({ all: false, views: [view] }, settingsSections);
  return [
    { name: 'visual', script: 'test:visual:screens:docker', env: { KARST_UI_GREP: grep } },
    { name: 'layout', script: 'test:layout:docker', env: { KARST_UI_GREP: '' } },
  ];
}

/** One summary line per executed part; the exit code is non-zero if any part failed. */
export function summarize(results) {
  const lines = results.map((r) => `test:ui:docker [${r.name}] ${r.status === 0 ? 'PASS' : `FAIL (exit ${r.status})`}`);
  const status = results.find((r) => r.status !== 0)?.status ?? 0;
  return { lines, status };
}

function main(argv) {
  const view = argv[0];
  if (!view) {
    console.error(`usage: npm run test:ui:docker -- <view>   (views: ${ALL_VIEWS.join(', ')})`);
    return 2;
  }
  let plan;
  try {
    plan = planScopedRun(view, readSettingsSections());
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  // Both parts always run: a visual failure must not hide the layout verdict.
  const results = plan.map((part) => {
    const run = spawnSync('npm', ['run', '-s', part.script], {
      stdio: 'inherit',
      env: { ...process.env, ...part.env },
    });
    return { name: part.name, status: run.status ?? 1 };
  });
  const { lines, status } = summarize(results);
  for (const line of lines) console.error(line);
  return status;
}

if (process.argv[1] && process.argv[1].endsWith('uiScopedRun.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
