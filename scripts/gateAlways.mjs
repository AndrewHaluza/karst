// Tests that `vitest related` cannot reach from a changed file (@arch:GATE-REPEAT): they read built
// *.webview.js bundles, scan the source tree, or enforce a ratchet. A narrowed first pass adds them,
// per vitest config. `any` runs for every code diff (source-tree scanners and ratchets read src outside src/ui
// too); `ui` runs only when the diff holds a src/ui path (bundle readers, webview architecture tests).

/** Test files by config. A file must match the config's include and exclude. */
export const ALWAYS_RUN = {
  unit: {
    any: [
      'src/extension/ops/placementRule.test.ts',
      'src/extension/ops/ratchet.test.ts',
      'src/extension/toastSeam.ratchet.test.ts',
      'src/extension/stallCommandsRemoved.test.ts',
      'src/model/entityId.ratchet.test.ts',
      'src/workflow/graphBoundary.test.ts',
      'src/agent/bridge/fsCalls.conformance.test.ts',
      'src/context/hostGitFree.test.ts',
    ],
    ui: [
      'src/model/dashboardAppInjector.test.ts',
      'src/model/resourcesAppInjector.test.ts',
      'src/model/settingsAppInjector.test.ts',
      'src/model/sidebarAppInjector.test.ts',
      'src/model/agentPicker.test.ts',
      'src/model/agentPicker.dom.test.ts',
      'src/model/agentPicker.staged.dom.test.ts',
      'src/ui/settings/webview.shell.test.ts',
      'src/ui/dashboard/serverLogsSurface.test.ts',
      'src/ui/webviewSendContract.test.ts',
      'src/ui/dashboard/app/architecture.test.ts',
      'src/ui/resources/app/architecture.test.ts',
      'src/ui/settings/app/architecture.test.ts',
      'src/ui/sidebar/app/architecture.test.ts',
    ],
  },
  integration: {
    any: [],
    ui: ['src/ui/measure-floors.integration.test.ts', 'src/ui/runtimeConformance.render.integration.test.ts'],
  },
};

const INTEGRATION_CONFIG = 'vitest.integration.config.ts';

/** The ALWAYS files for this gate's vitest args and changed paths: `any` for a code diff, plus `ui` when a path is under src/ui. */
export function alwaysFiles(args, paths) {
  if (paths.length === 0) return [];
  const set = ALWAYS_RUN[args.includes(INTEGRATION_CONFIG) ? 'integration' : 'unit'];
  return paths.some((p) => p.startsWith('src/ui/')) ? [...set.any, ...set.ui] : [...set.any];
}
